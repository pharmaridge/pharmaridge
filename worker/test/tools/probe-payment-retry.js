// BUG 101 — RETRYING A PAYMENT PAID IT TWICE.
//
// PharmaRidge is offline-first and sells over Nigerian mobile networks, so a
// request that times out and is retried is ORDINARY, not exceptional. The
// idempotency middleware existed and was well built — it simply had never been
// applied to most of the routes that move money.
//
// Live-reproduced with the SAME Idempotency-Key sent twice:
//   safe deposit      N5,000 -> the safe rose N10,000
//   supplier payment  N200   -> the balance fell N400
//   debtor repayment  N100   -> the balance fell N200
//
// Nothing here trusts a status code: every case is asserted against the
// BALANCE that moved.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;
const key = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function req(m, p, { token, body, idem } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  if (idem) h['Idempotency-Key'] = idem;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j, replay: r.headers.get('Idempotent-Replay') === 'true' };
}
const login = async (u) => await req('POST', '/api/auth/login', { body: { username: u, pin: '1234' } });
const L = b => (Array.isArray(b) ? b : []);

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;
  const branch = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active)[0];
  const bid = branch.id;

  const safe = async () => Number((await req('GET', `/api/safe/${bid}/movements`, { token: owner })).body.safe_balance);
  const books = async () => {
    const r = L((await req('GET', '/api/gl/trial-balance', { token: owner })).body);
    return { dr: r.reduce((a, x) => a + Number(x.total_debits || 0), 0), cr: r.reduce((a, x) => a + Number(x.total_credits || 0), 0) };
  };
  await req('POST', '/api/safe/movements', { token: owner, body: {
    branch_id: bid, entry_type: 'DEPOSIT', amount: 300000, reason: 'Float for the retry probe' } });
  ok(`fixture ready at ${branch.name}`);

  // ---- A. THE SAFE -------------------------------------------------------
  console.log('\n=== A. A RETRIED SAFE DEPOSIT MUST NOT DEPOSIT TWICE ===');
  {
    const before = await safe();
    const k = key('safe');
    const first = await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 5000, reason: 'Retried deposit' } });
    const second = await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 5000, reason: 'Retried deposit' } });
    const moved = (await safe()) - before;
    if (near(moved, 5000)) ok(`the safe rose N5,000, not N10,000 (actual N${moved.toFixed(2)})`);
    else bad(`the safe rose N${moved.toFixed(2)} — a retry deposited twice`);
    if (first.status === 201 && second.status === 201) ok('both calls answer 201, so the caller never sees a spurious error');
    else bad(`retry statuses were ${first.status}/${second.status}`);
    if (second.replay) ok('...and the second is marked Idempotent-Replay');
    else bad('the replay is not flagged, so a client cannot tell it was deduplicated');
  }
  {
    // A withdrawal is the dangerous direction: a doubled retry empties the safe.
    const before = await safe();
    const k = key('safew');
    await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'WITHDRAWAL', amount: 2500, reason: 'Retried withdrawal' } });
    await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'WITHDRAWAL', amount: 2500, reason: 'Retried withdrawal' } });
    const moved = before - (await safe());
    if (near(moved, 2500)) ok(`a retried WITHDRAWAL removed N2,500 once (actual N${moved.toFixed(2)})`);
    else bad(`a retried withdrawal removed N${moved.toFixed(2)}`);
  }

  // ---- B. SUPPLIERS ------------------------------------------------------
  console.log('\n=== B. A RETRIED SUPPLIER PAYMENT ===');
  {
    const owedOf = async (sid) => {
      const row = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
        .find(x => x.supplier_id === sid && x.branch_id === bid);
      return row ? Number(row.balance_owed) : 0;
    };
    const debt = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
      .find(x => x.branch_id === bid && Number(x.balance_owed) > 1000);
    if (!debt) bad('no supplier debt at this branch to test with');
    else {
      // FUND THE DRAWER FIRST, AND CHECK THE FIRST PAYMENT SUCCEEDED.
      //
      // A supplier payment comes out of the till, and this probe never
      // provisioned one. Run after anything that spends cash, the FIRST
      // payment was refused with CASH_EXPENSE_EXCEEDS_DRAWER and the balance
      // moved N0 — which this then reported as "the supplier was paid twice",
      // the exact opposite of what happened. A probe that misdiagnoses its
      // own setup failure as a product defect is worse than no probe.
      // Ensure a till is OPEN before funding it — an earlier probe may have
      // closed it, and a TILL_TRANSFER with no open session moves nothing the
      // drawer can spend.
      await req('POST', '/api/till/open', { token: owner, body: { branch_id: bid, opening_cash: 5000 } });
      await req('POST', '/api/safe/movements', { token: owner, body: {
        branch_id: bid, entry_type: 'DEPOSIT', amount: 40000, reason: 'retry probe: fund the safe' } });
      await req('POST', '/api/safe/movements', { token: owner, body: {
        branch_id: bid, entry_type: 'TILL_TRANSFER', amount: -20000, reason: 'retry probe: fund the drawer' } });

      const before = await owedOf(debt.supplier_id);
      const k = key('sup');
      const first = await req('POST', `/api/creditors/${debt.supplier_id}/payments`, { token: owner, idem: k, body: {
        branch_id: bid, amount: 500, notes: 'Retried supplier payment' } });
      if (first.status >= 400) bad(`the first supplier payment was refused: ${first.status} ${String(first.body && first.body.error).slice(0, 90)}`);
      else ok('the first supplier payment is accepted');
      await req('POST', `/api/creditors/${debt.supplier_id}/payments`, { token: owner, idem: k, body: {
        branch_id: bid, amount: 500, notes: 'Retried supplier payment' } });
      const moved = before - (await owedOf(debt.supplier_id));
      if (near(moved, 500)) ok(`the supplier balance fell N500 once (actual N${moved.toFixed(2)})`);
      else bad(`the supplier balance fell N${moved.toFixed(2)} — the supplier was paid twice`);
    }
  }

  // ---- C. DEBTORS --------------------------------------------------------
  console.log('\n=== C. A RETRIED CUSTOMER REPAYMENT ===');
  {
    const withDebt = [];
    for (const c of L((await req('GET', `/api/customers?branch_id=${bid}`, { token: owner })).body)) {
      const b = Number((await req('GET', `/api/customers/${c.id}/balance`, { token: owner })).body.balance_owed || 0);
      if (b > 300) { withDebt.push({ c, b }); break; }
    }
    if (!withDebt.length) bad('no customer with a debt large enough to test with');
    else {
      const { c, b } = withDebt[0];
      const bal = async () => Number((await req('GET', `/api/customers/${c.id}/balance`, { token: owner })).body.balance_owed || 0);
      const k = key('deb');
      await req('POST', `/api/customers/${c.id}/payments`, { token: owner, idem: k, body: { branch_id: bid, amount: 150 } });
      await req('POST', `/api/customers/${c.id}/payments`, { token: owner, idem: k, body: { branch_id: bid, amount: 150 } });
      const moved = b - (await bal());
      if (near(moved, 150)) ok(`the customer's debt fell N150 once (actual N${moved.toFixed(2)})`);
      else bad(`the customer's debt fell N${moved.toFixed(2)} — the repayment counted twice`);
    }
  }

  // ---- D. STOCK ----------------------------------------------------------
  console.log('\n=== D. RETRIES THAT WOULD DUPLICATE STOCK ===');
  {
    const stock = L((await req('GET', `/api/stock?branch_id=${bid}`, { token: owner })).body)
      .filter(s => s.quantity_remaining > 20);
    if (!stock.length) bad('no stock to test an adjustment against');
    else {
      const line = stock[0];
      const qtyOf = async () => {
        const s = L((await req('GET', `/api/stock?branch_id=${bid}`, { token: owner })).body).find(x => x.id === line.id);
        return s ? Number(s.quantity_remaining) : null;
      };
      const before = await qtyOf();
      const k = key('adj');
      await req('POST', '/api/adjustments', { token: owner, idem: k, body: {
        branch_id: bid, stock_batch_id: line.id, quantity_change: -3,
        adjustment_type: 'DAMAGE', reason: 'Retried write-off of a dropped bottle' } });
      await req('POST', '/api/adjustments', { token: owner, idem: k, body: {
        branch_id: bid, stock_batch_id: line.id, quantity_change: -3,
        adjustment_type: 'DAMAGE', reason: 'Retried write-off of a dropped bottle' } });
      const moved = before - (await qtyOf());
      if (moved === 3) ok('a retried stock write-off removed 3 units once, not 6');
      else bad(`a retried write-off removed ${moved} units`);
    }
  }

  // ---- E. THE KEY MUST STILL BE HONEST -----------------------------------
  console.log('\n=== E. IDEMPOTENCY MUST NOT SWALLOW REAL WORK ===');
  {
    const before = await safe();
    await req('POST', '/api/safe/movements', { token: owner, idem: key('u1'), body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 1200, reason: 'First genuine deposit' } });
    await req('POST', '/api/safe/movements', { token: owner, idem: key('u2'), body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 1300, reason: 'Second genuine deposit' } });
    const moved = (await safe()) - before;
    if (near(moved, 2500)) ok('two DIFFERENT keys deposit twice, as they must');
    else bad(`two distinct deposits moved N${moved.toFixed(2)}, expected N2,500`);
  }
  {
    // Reusing one key for a DIFFERENT request must be refused, not replayed —
    // otherwise a client bug silently returns the wrong operation's result.
    const k = key('mix');
    await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 400, reason: 'Original request' } });
    const different = await req('POST', '/api/safe/movements', { token: owner, idem: k, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 9999, reason: 'A completely different request' } });
    if (different.status === 409) ok('reusing a key for a DIFFERENT request is refused (409), never replayed');
    else bad(`a mismatched replay returned ${different.status} — a client bug would get the wrong answer`);
  }
  {
    // No key at all must still work: most callers never send one.
    const before = await safe();
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 700, reason: 'No idempotency key at all' } });
    if (r.status === 201 && near((await safe()) - before, 700)) ok('a request with NO key still works normally');
    else bad(`a keyless request returned ${r.status}`);
  }

  // ---- F. THE BOOKS ------------------------------------------------------
  console.log('\n=== F. THE LEDGER SURVIVES ALL OF IT ===');
  {
    const g = await books();
    if (near(g.dr, g.cr)) ok(`books balance after every retry (N${g.dr.toFixed(2)} both sides)`);
    else bad(`books unbalanced: ${g.dr} vs ${g.cr}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
