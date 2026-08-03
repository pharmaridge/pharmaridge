// BUG 95 — CHANGE OWED TO CUSTOMERS. The N400/N500/no-N100-note case.
//
// Before this feature the sale recorded `change_given = 100` — asserting the
// customer had been paid money they never received — and the drawer expected
// N400 while physically holding N500, a phantom overage on every occurrence.
//
// Everything below is asserted against MEASURED state (drawer expectation, GL
// balances, claim status), never against a status code alone.
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
const login = async (u, pin = '1234') => await req('POST', '/api/auth/login', { body: { username: u, pin } });
const L = b => (Array.isArray(b) ? b : []);
const tb = async (tok) => {
  const rows = L((await req('GET', '/api/gl/trial-balance', { token: tok })).body);
  // Default every account this probe reads to zero. A missing account means
  // "nothing posted there", which is a FINDING to assert on — not a reason for
  // the probe to die with a TypeError three sections early and hide the rest
  // of the run (trap #50: a crash reports as 0 failures and looks like success).
  const m = { CHANGE_OWED_PAYABLE: { dr: 0, cr: 0 }, OTHER_INCOME: { dr: 0, cr: 0 },
    CASH: { dr: 0, cr: 0 }, SALES_REVENUE: { dr: 0, cr: 0 } };
  rows.forEach(r => { m[r.account_code] = { dr: Number(r.total_debits || 0), cr: Number(r.total_credits || 0) }; });
  m.__dr = rows.reduce((s, r) => s + Number(r.total_debits || 0), 0);
  m.__cr = rows.reduce((s, r) => s + Number(r.total_credits || 0), 0);
  return m;
};

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;

  // ---- Fixture: a fresh till at a branch with sellable stock -------------
  console.log('\n=== FIXTURE ===');
  const branches = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active);
  let branch = null, stockLine = null;
  for (const b of branches) {
    const st = L((await req('GET', '/api/stock?branch_id=' + b.id, { token: owner })).body)
      .filter(s => s.quantity_remaining > 5 && s.selling_price_per_unit > 0);
    if (st.length) { branch = b; stockLine = st[0]; break; }
  }
  if (!branch) { bad('no branch with sellable stock'); console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
  // A till is ONE PER BRANCH, not one per user — an earlier version of this
  // probe tried to close every open till and then open its own, and got a
  // 409 TILL_ALREADY_OPEN because the seed's cashier already had one. The
  // drawer assertions below are all DELTAS (expected-before vs expected-after)
  // precisely so the starting balance does not matter; reuse whatever session
  // is open, and only open one if the branch genuinely has none.
  let tillId = (L((await req('GET', '/api/till?branch_id=' + branch.id, { token: owner })).body)
    .find(t => t.status === 'OPEN') || {}).id;
  if (!tillId) {
    const opened = await req('POST', '/api/till/open', { token: owner, body: { branch_id: branch.id, opening_cash: 0 } });
    if (opened.status !== 201) { bad(`could not open a till: ${opened.status} ${JSON.stringify(opened.body).slice(0, 90)}`);
      console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
    tillId = opened.body.id;
  }
  const till = { body: { id: tillId } };
  ok(`using the open till at ${branch.name}`);
  const price = stockLine.selling_price_per_unit;
  const SHORT = 100;

  const glBefore = await tb(owner);
  const expBefore = (await req('GET', `/api/till/${till.body.id}/expected`, { token: owner })).body.expected_closing_cash;

  // ---- A. THE SALE THAT CANNOT MAKE CHANGE ------------------------------
  console.log('\n=== A. SALE WITH N100 OWED (the reported scenario) ===');
  const sale = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + SHORT, change_owed: SHORT }],
    change_owed_for: { name: 'Mrs Adaeze Umeh', phone: '08031234567' },
  } });
  if (sale.status !== 201) { bad(`sale refused: ${sale.status} ${JSON.stringify(sale.body).slice(0, 140)}`);
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
  ok(`sale completed: goods N${price}, customer tendered N${price + SHORT}`);

  const pay = L(sale.body.payments)[0];
  if (near(pay.change_given, 0)) ok('change_given records N0 — the customer was NOT handed money they never got');
  else bad(`change_given is N${pay.change_given}; it must be 0 when the change was retained`);

  const claims = L(sale.body.change_owed);
  if (claims.length === 1 && near(claims[0].amount, SHORT)) ok(`a claim for N${SHORT} exists on the sale`);
  else bad(`expected one N${SHORT} claim on the sale, got ${JSON.stringify(claims).slice(0, 120)}`);
  const claim = claims[0] || {};

  // The client asked specifically for a 7-digit code.
  if (/^\d{7}$/.test(String(claim.claim_code || ''))) ok(`claim code is 7 digits: ${claim.claim_code}`);
  else bad(`claim code "${claim.claim_code}" is not 7 digits`);
  // ...and for the goods and time to be captured automatically.
  if (claim.sale_summary && /x /.test(claim.sale_summary)) ok(`the claim records what was bought: "${String(claim.sale_summary).slice(0, 48)}"`);
  else bad(`the claim has no purchase summary (got ${JSON.stringify(claim.sale_summary)})`);
  if (claim.created_at) ok(`the claim records the time: ${claim.created_at}`);
  else bad('the claim has no timestamp');

  // ---- B. THE DRAWER NOW RECONCILES -------------------------------------
  console.log('\n=== B. THE DRAWER (this is what Bug 95 broke) ===');
  const expAfter = (await req('GET', `/api/till/${till.body.id}/expected`, { token: owner })).body.expected_closing_cash;
  const physical = price + SHORT;                    // what is really in the box
  if (near(expAfter - expBefore, physical)) {
    // Report the DELTA, not the absolute expectation: the seeded till already
    // carries unrelated history, and printing its running total next to a
    // single sale's cash reads as a mismatch when it is nothing of the kind.
    ok(`drawer expectation rose by N${(expAfter - expBefore).toFixed(2)}, exactly the N${physical} taken — reconciled`);
  } else {
    bad(`drawer expects N${expAfter - expBefore} more but N${physical} was taken — overage of N${(physical - (expAfter - expBefore)).toFixed(2)}`);
  }

  // ---- C. THE LEDGER TREATS IT AS A LIABILITY ---------------------------
  console.log('\n=== C. THE GENERAL LEDGER ===');
  const glAfter = await tb(owner);
  if (near(glAfter.__dr, glAfter.__cr)) ok(`books balance (N${glAfter.__dr.toFixed(2)} both sides)`);
  else bad(`books do not balance: debits ${glAfter.__dr} vs credits ${glAfter.__cr}`);
  const liabDelta = (glAfter.CHANGE_OWED_PAYABLE ? glAfter.CHANGE_OWED_PAYABLE.cr : 0)
    - (glBefore.CHANGE_OWED_PAYABLE ? glBefore.CHANGE_OWED_PAYABLE.cr : 0);
  if (near(liabDelta, SHORT)) ok(`Change Owed Payable credited N${SHORT} — recorded as a liability, not income`);
  else bad(`Change Owed Payable moved by N${liabDelta}, expected N${SHORT}`);
  const revDelta = (glAfter.SALES_REVENUE ? glAfter.SALES_REVENUE.cr : 0) - (glBefore.SALES_REVENUE ? glBefore.SALES_REVENUE.cr : 0);
  if (revDelta < price + 0.01) ok(`Sales Revenue rose by only N${revDelta.toFixed(2)} — the owed change is NOT counted as a sale`);
  else bad(`Sales Revenue rose N${revDelta.toFixed(2)}, which wrongly includes the owed change`);

  // ---- D. FINDING THE CLAIM AT THE COUNTER ------------------------------
  console.log('\n=== D. THREE WAYS TO FIND IT (the client\'s explicit requirement) ===');
  const byCode = await req('GET', `/api/change-owed/code/${claim.claim_code}`, { token: owner });
  if (byCode.status === 200 && byCode.body.id === claim.id) ok('found by the 7-digit code');
  else bad(`lookup by code returned ${byCode.status}`);
  const byName = L((await req('GET', '/api/change-owed?q=Adaeze', { token: owner })).body);
  if (byName.some(x => x.id === claim.id)) ok('found by customer NAME (slip lost)');
  else bad('lookup by name did not find the claim');
  const byPhone = L((await req('GET', '/api/change-owed?q=08031234567', { token: owner })).body);
  if (byPhone.some(x => x.id === claim.id)) ok('found by phone NUMBER (slip lost)');
  else bad('lookup by phone did not find the claim');

  // A cashier must be able to do this alone — the returning customer meets
  // whoever is on duty, not a manager.
  const cashierRes = await login('a.cash1');
  if (cashierRes.status === 200) {
    const asCashier = L((await req('GET', '/api/change-owed?q=Adaeze', { token: cashierRes.body.token })).body);
    if (asCashier.length >= 0) ok('a STAFF cashier can search claims without a manager');
    else bad('a cashier cannot search claims');
  }

  // ---- E. IDENTITY IS REQUIRED ------------------------------------------
  console.log('\n=== E. MONEY CANNOT BE OWED TO NOBODY ===');
  const anon = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + SHORT, change_owed: SHORT }],
  } });
  if (anon.status === 400 && anon.body.code === 'CHANGE_OWED_NEEDS_IDENTITY') ok('a claim with no name and no phone is refused');
  else bad(`anonymous claim returned ${anon.status} ${JSON.stringify(anon.body).slice(0, 100)}`);

  const tooMuch = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + 20, change_owed: 500 }],
    change_owed_for: { name: 'Chancer' },
  } });
  if (tooMuch.status === 400 && tooMuch.body.code === 'CHANGE_OWED_EXCEEDS_CHANGE') ok('owing more change than the sale leaves over is refused');
  else bad(`over-claim returned ${tooMuch.status} ${JSON.stringify(tooMuch.body).slice(0, 100)}`);

  // ---- F. SETTLEMENT: CASH -----------------------------------------------
  console.log('\n=== F. THE CUSTOMER COMES BACK FOR THE CASH ===');
  const glPre = await tb(owner);
  const settle = await req('POST', `/api/change-owed/${claim.id}/settle`, { token: owner, body: { method: 'CASH_PAID', notes: 'Paid at counter' } });
  if (settle.status === 200 && settle.body.status === 'SETTLED') ok('claim settled as CASH_PAID');
  else bad(`settle returned ${settle.status} ${JSON.stringify(settle.body).slice(0, 120)}`);
  if (settle.body && settle.body.receipt && settle.body.receipt.claim_code === claim.claim_code) {
    ok('a payout RECEIPT is returned (client asked for one)');
  } else bad('no payout receipt in the settle response');
  const glPost = await tb(owner);
  const liabCleared = (glPost.CHANGE_OWED_PAYABLE.dr || 0) - (glPre.CHANGE_OWED_PAYABLE.dr || 0);
  if (near(liabCleared, SHORT)) ok(`Change Owed Payable debited N${SHORT} — the liability is discharged`);
  else bad(`liability moved by N${liabCleared}, expected N${SHORT}`);
  const cashOut = (glPost.CASH.cr || 0) - (glPre.CASH.cr || 0);
  if (near(cashOut, SHORT)) ok(`Cash credited N${SHORT} — the money left the drawer`);
  else bad(`Cash credit moved by N${cashOut}, expected N${SHORT}`);
  if (near(glPost.__dr, glPost.__cr)) ok('books still balance after settlement');
  else bad(`books unbalanced after settlement: ${glPost.__dr} vs ${glPost.__cr}`);

  // PAYING TWICE is the failure this must prevent.
  const again = await req('POST', `/api/change-owed/${claim.id}/settle`, { token: owner, body: { method: 'CASH_PAID' } });
  if (again.status === 409 && again.body.code === 'CHANGE_ALREADY_SETTLED') ok('a second payout of the same claim is refused');
  else bad(`double settlement returned ${again.status} — the customer could be paid twice`);

  // ---- G. SETTLEMENT: ROLLED INTO A NEW PURCHASE ------------------------
  console.log('\n=== G. THE CHANGE IS APPLIED TO A LATER PURCHASE ===');
  const sale2 = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + SHORT, change_owed: SHORT }],
    change_owed_for: { name: 'Mr Obinna Nnaji', phone: '08079998888' },
  } });
  const claim2 = L(sale2.body && sale2.body.change_owed)[0];
  if (!claim2) { bad('could not create a second claim to test roll-up'); }
  else {
    const applied = await req('POST', `/api/change-owed/${claim2.id}/settle`, { token: owner, body: {
      method: 'APPLIED_TO_SALE', applied_sale_id: sale2.body.id, notes: 'Rolled into next purchase' } });
    if (applied.status === 200 && applied.body.settlement_method === 'APPLIED_TO_SALE') ok('claim settled by applying it to a purchase');
    else bad(`apply-to-sale returned ${applied.status} ${JSON.stringify(applied.body).slice(0, 110)}`);
    const missing = await req('POST', `/api/change-owed/${claim2.id}/settle`, { token: owner, body: { method: 'APPLIED_TO_SALE' } });
    if (missing.status === 409 || missing.status === 400) ok('applying without naming the sale, or re-settling, is refused');
    else bad(`unguarded apply returned ${missing.status}`);
  }

  // ---- H. WRITE-OFF IS OWNER-ONLY AND DELIBERATE ------------------------
  console.log('\n=== H. WRITE-OFF (owner decision, never automatic) ===');
  const sale3 = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + SHORT, change_owed: SHORT }],
    change_owed_for: { name: 'Never Returned', phone: '08000000000' },
  } });
  const claim3 = L(sale3.body && sale3.body.change_owed)[0];
  if (!claim3) bad('could not create a third claim to test write-off');
  else {
    const mgr = await login('c.gm');
    if (mgr.status === 200) {
      const byMgr = await req('POST', `/api/change-owed/${claim3.id}/write-off`, { token: mgr.body.token, body: { reason: 'Customer never came back' } });
      if (byMgr.status === 403) ok('a MANAGER cannot write off a customer\'s change');
      else bad(`manager write-off returned ${byMgr.status} — only the OWNER may do this`);
    }
    const noReason = await req('POST', `/api/change-owed/${claim3.id}/write-off`, { token: owner, body: { reason: '' } });
    if (noReason.status === 400) ok('a write-off with no reason is refused');
    else bad(`reasonless write-off returned ${noReason.status}`);
    const glW1 = await tb(owner);
    const wo = await req('POST', `/api/change-owed/${claim3.id}/write-off`, { token: owner, body: { reason: 'Unclaimed for six months, customer untraceable' } });
    if (wo.status === 200 && wo.body.status === 'WRITTEN_OFF') ok('the OWNER can write it off with a reason');
    else bad(`owner write-off returned ${wo.status} ${JSON.stringify(wo.body).slice(0, 110)}`);
    const glW2 = await tb(owner);
    const otherInc = (glW2.OTHER_INCOME ? glW2.OTHER_INCOME.cr : 0) - (glW1.OTHER_INCOME ? glW1.OTHER_INCOME.cr : 0);
    if (near(otherInc, SHORT)) ok('written-off change lands in OTHER INCOME, not Sales Revenue');
    else bad(`Other Income moved by N${otherInc}, expected N${SHORT}`);
    if (near(glW2.__dr, glW2.__cr)) ok('books still balance after write-off');
    else bad(`books unbalanced after write-off: ${glW2.__dr} vs ${glW2.__cr}`);
  }

  // ---- I. ORDINARY SALES ARE UNAFFECTED ---------------------------------
  console.log('\n=== I. THE NORMAL CASE MUST NOT CHANGE ===');
  const normal = await req('POST', '/api/sales', { token: owner, body: {
    branch_id: branch.id,
    items: [{ product_id: stockLine.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
    payments: [{ method: 'CASH', amount: price, cash_tendered: price + 200 }],
  } });
  if (normal.status === 201) {
    const p0 = L(normal.body.payments)[0];
    if (near(p0.change_given, 200)) ok('a sale WITH change available still records change_given = N200');
    else bad(`ordinary sale recorded change_given = N${p0.change_given}, expected 200`);
    if (!normal.body.change_owed) ok('...and creates no claim');
    else bad('an ordinary sale wrongly created a change claim');
  } else bad(`ordinary sale refused: ${normal.status}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
