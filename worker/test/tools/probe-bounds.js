// BUG 103 — THERE WAS A FLOOR ON MONEY BUT NO CEILING, AND NONE ON TEXT.
//
// Every money guard in this codebase was written against sensible figures, so
// nobody had asked what a hostile or fat-fingered number does. Live-reproduced:
//
//   a safe deposit of 1e15 was ACCEPTED, and the branch safe then reported
//   N1,000,000,000,152,074.4 — a balance that has already lost precision,
//   because 1e15 naira is 1e17 kobo and JavaScript holds integers exactly only
//   to ~9.007e15. Adding one kobo to that figure is a silent no-op.
//
//   a 200,000-character reason was accepted and stored verbatim, then loaded
//   into every list that shows the movement — on a phone, over a mobile
//   connection, against a database with a 500 MB ceiling.
//
// The ceiling is a TYPO GUARD, not a policy: Nigeria's entire pharmaceutical
// market is on the order of N1.5 trillion a year, so a single entry above
// N10 billion is a mis-keyed amount, never a transaction.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

async function req(m, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const login = async (u) => await req('POST', '/api/auth/login', { body: { username: u, pin: '1234' } });
const L = b => (Array.isArray(b) ? b : []);
const MAX_MONEY = 10000000000;

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;
  const branch = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active)[0];
  const bid = branch.id;
  const safeBal = async () => Number((await req('GET', `/api/safe/${bid}/movements`, { token: owner })).body.safe_balance);
  ok(`fixture: ${branch.name}`);

  // ---- A. THE MONEY CEILING ---------------------------------------------
  console.log('\n=== A. AN ABSURD AMOUNT IS A TYPO, NOT A TRANSACTION ===');
  const before = await safeBal();
  for (const [label, amount] of [
    ['1e15 (a quadrillion naira)', 1e15],
    ['1e12 (a trillion)', 1e12],
    ['1e11 (a hundred billion)', 1e11],
  ]) {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount, reason: 'ceiling probe deposit' } });
    if (r.status === 400 && r.body.code === 'INVALID_MONEY_AMOUNT') ok(`${label} is refused`);
    else bad(`${label} returned ${r.status} — an absurd amount reached the ledger`);
  }
  if (Math.abs((await safeBal()) - before) < 0.005) ok('...and none of them moved the balance');
  else bad(`the safe moved by N${((await safeBal()) - before).toFixed(2)} on refused deposits`);
  {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: MAX_MONEY, reason: 'exactly at the ceiling' } });
    if (r.status === 201) ok(`N${MAX_MONEY.toLocaleString('en-NG')} exactly — the boundary itself — is allowed`);
    else bad(`the ceiling value itself was refused: ${r.status}`);
  }
  {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 5000, reason: 'an ordinary deposit' } });
    if (r.status === 201) ok('an ordinary N5,000 deposit still works');
    else bad(`a normal deposit broke: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }
  {
    // The message must tell a human what went wrong, not name a constant.
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 1e12, reason: 'wording check' } });
    if (r.body && /extra digit|mistake/i.test(String(r.body.error))) ok('the refusal suggests checking for an extra digit');
    else bad('the refusal does not explain itself in plain language');
  }

  // ---- B. THE FLOOR MUST STILL HOLD --------------------------------------
  console.log('\n=== B. THE EXISTING FLOOR IS UNCHANGED ===');
  for (const [label, amount] of [['0.001 (sub-kobo)', 0.001], ['0', 0]]) {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount, reason: 'floor probe' } });
    if (r.status === 400) ok(`${label} is still refused`);
    else bad(`${label} returned ${r.status}`);
  }
  {
    // A NEGATIVE amount is NOT an error on this route, and an earlier draft of
    // this probe wrongly reported it as one. The endpoint takes Math.abs()
    // deliberately: TILL_TRANSFER carries DIRECTION in the sign (positive
    // sweeps the drawer into the safe, negative tops the drawer back up), so
    // the verb decides the direction for DEPOSIT and WITHDRAWAL and the sign
    // is ignored. What matters is the OUTCOME — a negative DEPOSIT must still
    // deposit, never quietly withdraw.
    const b0 = await safeBal();
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: -500, reason: 'negative deposit probe' } });
    const moved = (await safeBal()) - b0;
    if (r.status === 201 && Math.abs(moved - 500) < 0.005) ok('a negative DEPOSIT still deposits (the verb sets direction, not the sign)');
    else bad(`a negative DEPOSIT returned ${r.status} and moved N${moved.toFixed(2)} — it must add N500, never remove it`);
  }

  // ---- C. THE CEILING IS SHARED, NOT PER-ROUTE ---------------------------
  console.log('\n=== C. EVERY MONEY ENDPOINT INHERITS IT ===');
  {
    const r = await req('POST', '/api/expenses', { token: owner, body: {
      branch_id: bid, category: 'RENT', amount: 1e15, description: 'ceiling probe', paid_by_method: 'TRANSFER' } });
    if (r.status === 400 && r.body.code === 'INVALID_MONEY_AMOUNT') ok('an expense of 1e15 is refused');
    else bad(`expense at 1e15 returned ${r.status}`);
  }
  {
    const debt = L((await req('GET', '/api/creditors/balances', { token: owner })).body).find(x => x.branch_id === bid);
    if (!debt) bad('no supplier balance at this branch to test with');
    else {
      const r = await req('POST', `/api/creditors/${debt.supplier_id}/payments`, { token: owner, body: {
        branch_id: bid, amount: 1e15 } });
      if (r.status === 400) ok('a supplier payment of 1e15 is refused');
      else bad(`supplier payment at 1e15 returned ${r.status}`);
    }
  }
  {
    const cust = L((await req('GET', `/api/customers?branch_id=${bid}`, { token: owner })).body)[0];
    if (cust) {
      const r = await req('POST', `/api/customers/${cust.id}/payments`, { token: owner, body: {
        branch_id: bid, amount: 1e15 } });
      if (r.status === 400) ok('a customer repayment of 1e15 is refused');
      else bad(`customer repayment at 1e15 returned ${r.status}`);
    }
  }

  // ---- D. UNBOUNDED TEXT --------------------------------------------------
  console.log('\n=== D. FREE TEXT HAS AN UPPER BOUND TOO ===');
  {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 100, reason: 'A'.repeat(200000) } });
    if (r.status === 400 && r.body.code === 'TEXT_TOO_LONG') ok('a 200,000-character reason is refused');
    else bad(`a 200,000-character reason returned ${r.status} — unbounded text reaches the database`);
  }
  {
    // Generous, not stingy: a manager pasting a paragraph must not be blocked.
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 100,
      reason: 'A paragraph of genuine explanatory context. '.repeat(14) } });
    if (r.status === 201) ok('a ~600-character genuine explanation is still accepted');
    else bad(`a reasonable long reason was refused: ${r.status} ${JSON.stringify(r.body).slice(0, 70)}`);
  }
  {
    const r = await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: bid, entry_type: 'DEPOSIT', amount: 100, reason: 'ok' } });
    if (r.status === 400 && r.body.code === 'SAFE_REASON_REQUIRED') ok('the minimum-length rule still applies');
    else bad(`a 2-character reason returned ${r.status}`);
  }

  // ---- E. THE BOOKS SURVIVE IT -------------------------------------------
  console.log('\n=== E. NOTHING ABSURD REACHED THE LEDGER ===');
  {
    const rows = L((await req('GET', '/api/gl/trial-balance', { token: owner })).body);
    const dr = rows.reduce((a, x) => a + Number(x.total_debits || 0), 0);
    const cr = rows.reduce((a, x) => a + Number(x.total_credits || 0), 0);
    if (Math.abs(dr - cr) < 0.005) ok(`books balance (N${dr.toFixed(2)} both sides)`);
    else bad(`books unbalanced: ${dr} vs ${cr}`);
    const absurd = rows.find(x => Math.abs(Number(x.total_debits || 0)) > MAX_MONEY * 10
      || Math.abs(Number(x.total_credits || 0)) > MAX_MONEY * 10);
    if (!absurd) ok('no ledger account holds an impossible figure');
    else bad(`${absurd.account_code} holds ${absurd.total_debits}/${absurd.total_credits}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
