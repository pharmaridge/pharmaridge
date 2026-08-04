// BUG 102 — REVERSAL SYMMETRY: does undoing an action restore the world?
//
// Every audit so far tested that an action POSTS correctly. None asked the
// mirror question: after you undo it, is everything back where it started?
// That blind spot is what this probe exists to close, and it found a real one.
//
// A sale that could not give change creates a claim — the money stays in the
// drawer and the shop formally owes a named customer (Bug 95). Voiding that
// sale reversed the stock, the debtor ledger and the GL, but left the claim
// OUTSTANDING. Live-reproduced: the pharmacy owed N100 for a sale that no
// longer existed, and the customer could collect it on top of their refund.
//
// Everything below is asserted against MEASURED state before and after.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;

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

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;
  const staffRes = await login('lagos.staff');
  const staff = staffRes.body.token;
  const bid = staffRes.body.user.branch_id;

  // FEFO + non-POM fixture (traps #42/#63): a controlled or prescription-only
  // product refuses the sale, and FEFO fills from the earliest-expiry batch,
  // so the probe must choose a batch that IS its product's FEFO batch.
  const prods = L((await req('GET', '/api/products', { token: owner })).body);
  const pm = new Map(prods.map(p => [p.id, p]));
  const pickLine = async () => {
    const rows = L((await req('GET', `/api/stock?branch_id=${bid}`, { token: owner })).body)
      .filter(x => x.quantity_remaining > 5 && x.selling_price_per_unit > 0
        && pm.get(x.product_id) && pm.get(x.product_id).dispensing_type !== 'POM'
        && !pm.get(x.product_id).is_controlled);
    const byProduct = {};
    rows.forEach(x => { (byProduct[x.product_id] = byProduct[x.product_id] || []).push(x); });
    for (const pid of Object.keys(byProduct)) {
      const fefo = byProduct[pid].sort((a, b) =>
        String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999')))[0];
      if (fefo.quantity_remaining > 5) return fefo;
    }
    return null;
  };
  const line = await pickLine();
  if (!line) { bad('no sellable OTC batch to test with'); console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
  ok(`fixture: ${line.batch_no} at N${line.selling_price_per_unit}`);

  // Cash sales need the real drawer session that will later be reconciled.
  // A freshly-seeded branch has stock but no open till, so create one rather
  // than confusing the no-open-till safety guard with a reversal failure.
  const existingTills = L((await req('GET', `/api/till?branch_id=${bid}`, { token: owner })).body).filter(t => t.status === 'OPEN');
  for (const till of existingTills) {
    const expected = (await req('GET', `/api/till/${till.id}/expected`, { token: owner })).body;
    await req('POST', `/api/till/${till.id}/close`, { token: owner, body: {
      counted_closing_cash: expected.expected_closing_cash, force_reason: 'reversal probe fixture reset' } });
  }
  const opened = await req('POST', '/api/till/open', { token: staff, body: { branch_id: bid, opening_cash: 1000 } });
  if (opened.status === 201 || opened.status === 409) ok('fixture: a till is open for the cashier sales');
  else bad(`fixture till could not open: ${opened.status}`);

  const owedTotal = async () => Number((await req('GET', `/api/change-owed/summary?branch_id=${bid}`, { token: owner })).body.total_owed || 0);
  const qtyOf = async (id) => {
    const s = L((await req('GET', `/api/stock?branch_id=${bid}`, { token: owner })).body).find(x => x.id === id);
    return s ? Number(s.quantity_remaining) : null;
  };
  const books = async () => {
    const r = L((await req('GET', '/api/gl/trial-balance', { token: owner })).body);
    const m = { CHANGE_OWED_PAYABLE: { dr: 0, cr: 0 } };
    r.forEach(x => { m[x.account_code] = { dr: Number(x.total_debits || 0), cr: Number(x.total_credits || 0) }; });
    m.__dr = r.reduce((a, x) => a + Number(x.total_debits || 0), 0);
    m.__cr = r.reduce((a, x) => a + Number(x.total_credits || 0), 0);
    return m;
  };

  // ---- A. AN ORDINARY VOID RESTORES STOCK AND THE BOOKS ------------------
  console.log('\n=== A. AN ORDINARY VOID PUTS EVERYTHING BACK ===');
  {
    const q0 = await qtyOf(line.id);
    const sale = await req('POST', '/api/sales', { token: staff, body: {
      branch_id: bid, items: [{ product_id: line.product_id, quantity: 2, unit_type: 'BASE_UNIT' }],
      payments: [{ method: 'CASH', amount: 2 * line.selling_price_per_unit }] } });
    if (sale.status !== 201) { bad(`fixture sale refused: ${sale.status} ${JSON.stringify(sale.body).slice(0, 90)}`); }
    else {
      const q1 = await qtyOf(line.id);
      if (q1 === q0 - 2) ok(`the sale removed 2 units (${q0} -> ${q1})`);
      else bad(`the sale moved stock ${q0} -> ${q1}, expected -2`);
      const v = await req('POST', `/api/sales/${sale.body.id}/void`, { token: owner, body: { reason: 'reversal symmetry probe' } });
      const q2 = await qtyOf(line.id);
      if (v.status === 200 && q2 === q0) ok(`the void restored the stock exactly (${q2})`);
      else bad(`after void stock is ${q2}, expected ${q0} (void status ${v.status})`);
      const g = await books();
      if (near(g.__dr, g.__cr)) ok('books balance after the void');
      else bad(`books unbalanced: ${g.__dr} vs ${g.__cr}`);
    }
  }

  // ---- B. THE GAP THIS PROBE WAS WRITTEN FOR -----------------------------
  console.log('\n=== B. VOIDING A SALE THAT LEFT CHANGE OWED (Bug 102) ===');
  let collectedClaim = null;
  {
    const owed0 = await owedTotal();
    const g0 = await books();
    const sale = await req('POST', '/api/sales', { token: staff, body: {
      branch_id: bid, items: [{ product_id: line.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
      payments: [{ method: 'CASH', amount: line.selling_price_per_unit,
        cash_tendered: line.selling_price_per_unit + 100, change_owed: 100 }],
      change_owed_for: { name: 'Reversal Probe Customer', phone: '08000000001' } } });
    const claim = L(sale.body && sale.body.change_owed)[0];
    if (sale.status !== 201 || !claim) { bad(`could not create a sale with a change claim: ${sale.status}`); }
    else {
      const owed1 = await owedTotal();
      if (near(owed1 - owed0, 100)) ok(`the sale created a N100 claim (${claim.claim_code})`);
      else bad(`owed total moved N${(owed1 - owed0).toFixed(2)}, expected N100`);

      const v = await req('POST', `/api/sales/${sale.body.id}/void`, { token: owner, body: {
        reason: 'voiding a sale that left change owed' } });
      if (v.status === 200) ok('the sale voids successfully');
      else bad(`void returned ${v.status} ${JSON.stringify(v.body).slice(0, 90)}`);

      const owed2 = await owedTotal();
      if (near(owed2, owed0)) ok(`the claim is released — owed total back to N${owed2.toFixed(2)}`);
      else bad(`the shop still owes N${(owed2 - owed0).toFixed(2)} for a sale that no longer exists`);

      const after = L((await req('GET', `/api/change-owed?status=ALL&q=${claim.claim_code}`, { token: owner })).body)[0];
      if (after && after.status !== 'OUTSTANDING') ok(`the claim is no longer outstanding (${after.status})`);
      else bad(`the claim is still ${after ? after.status : 'MISSING'} — a customer could collect it`);
      if (after && /void/i.test(String(after.settled_notes || ''))) ok('...and the record says WHY it was cancelled');
      else bad('the cancelled claim does not explain itself');

      const g1 = await books();
      const liabReleased = (g1.CHANGE_OWED_PAYABLE.dr - g0.CHANGE_OWED_PAYABLE.dr);
      if (near(liabReleased, 100)) ok('Change Owed Payable was debited N100 — the liability is gone from the ledger too');
      else bad(`the liability account moved N${liabReleased.toFixed(2)}, expected N100`);
      if (near(g1.__dr, g1.__cr)) ok('books balance after voiding a sale with a claim');
      else bad(`books unbalanced: ${g1.__dr} vs ${g1.__cr}`);
    }
  }

  // ---- C. A CLAIM ALREADY COLLECTED MUST NOT BE REWRITTEN ----------------
  console.log('\n=== C. A CLAIM THE CUSTOMER ALREADY COLLECTED ===');
  {
    const sale = await req('POST', '/api/sales', { token: staff, body: {
      branch_id: bid, items: [{ product_id: line.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
      payments: [{ method: 'CASH', amount: line.selling_price_per_unit,
        cash_tendered: line.selling_price_per_unit + 100, change_owed: 100 }],
      change_owed_for: { name: 'Already Collected', phone: '08000000002' } } });
    const claim = L(sale.body && sale.body.change_owed)[0];
    if (!claim) { bad('could not create the already-collected fixture'); }
    else {
      const paid = await req('POST', `/api/change-owed/${claim.id}/settle`, { token: owner, body: { method: 'CASH_PAID' } });
      if (paid.status === 200) ok('the customer collects their N100 first');
      else bad(`settling the claim returned ${paid.status}`);
      const v = await req('POST', `/api/sales/${sale.body.id}/void`, { token: owner, body: {
        reason: 'voiding after the change was already collected' } });
      if (v.status === 200) ok('the sale still voids');
      else bad(`void returned ${v.status}`);
      const after = L((await req('GET', `/api/change-owed?status=ALL&q=${claim.claim_code}`, { token: owner })).body)[0];
      // The money REALLY left the drawer. Rewriting the record would make the
      // till short with nothing to explain it.
      if (after && after.status === 'SETTLED') ok('the collected claim stays SETTLED — the payout really happened and the record is preserved');
      else bad(`a collected claim was rewritten to ${after ? after.status : 'MISSING'} — the till would be short with no explanation`);
      const g = await books();
      if (near(g.__dr, g.__cr)) ok('books balance');
      else bad(`books unbalanced: ${g.__dr} vs ${g.__cr}`);
    }
  }

  // ---- D. VOIDING TWICE MUST NOT DOUBLE THE REVERSAL ---------------------
  console.log('\n=== D. VOIDING THE SAME SALE TWICE ===');
  {
    const q0 = await qtyOf(line.id);
    const sale = await req('POST', '/api/sales', { token: staff, body: {
      branch_id: bid, items: [{ product_id: line.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
      payments: [{ method: 'CASH', amount: line.selling_price_per_unit }] } });
    await req('POST', `/api/sales/${sale.body.id}/void`, { token: owner, body: { reason: 'first void' } });
    const second = await req('POST', `/api/sales/${sale.body.id}/void`, { token: owner, body: { reason: 'second void' } });
    const q2 = await qtyOf(line.id);
    if (second.status >= 400) ok(`a second void is refused (${second.status})`);
    else bad(`a second void returned ${second.status} — the reversal could be applied twice`);
    if (q2 === q0) ok(`stock returned to ${q0} once, not twice`);
    else bad(`stock is ${q2}, expected ${q0} — the void was applied twice`);
    const g = await books();
    if (near(g.__dr, g.__cr)) ok('books balance after the double-void attempt');
    else bad(`books unbalanced: ${g.__dr} vs ${g.__cr}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
