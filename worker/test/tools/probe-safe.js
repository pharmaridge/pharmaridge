// BRANCH SAFE — cash held at a branch outside the counter drawer.
//
// Bug 96 stopped a CASH expense exceeding the till, which is right: a cash box
// cannot hold negative money. But on its own that made a routine transaction
// impossible — a branch buying a N50,000 delivery out of a drawer floating
// N25,000. The safe is the counterpart that makes the legitimate version work.
//
// Everything below is asserted against MEASURED state (safe balance, drawer
// expectation, GL account movement), never a status code alone.
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
const tb = async (tok) => {
  const rows = L((await req('GET', '/api/gl/trial-balance', { token: tok })).body);
  const m = { BRANCH_SAFE: { dr: 0, cr: 0 }, CASH: { dr: 0, cr: 0 }, ACCOUNTS_PAYABLE: { dr: 0, cr: 0 } };
  rows.forEach(r => { m[r.account_code] = { dr: Number(r.total_debits || 0), cr: Number(r.total_credits || 0) }; });
  m.__dr = rows.reduce((s, r) => s + Number(r.total_debits || 0), 0);
  m.__cr = rows.reduce((s, r) => s + Number(r.total_credits || 0), 0);
  return m;
};
const safeOf = async (tok, b) => Number((await req('GET', `/api/safe?branch_id=${b}`, { token: tok })).body.safe_balance);

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;
  const admin = (await login('admin')).body.token;

  const branches = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active);
  const users = L((await req('GET', '/api/users', { token: owner })).body);
  // Use the ordinary fresh-seed roles rather than scenario-only c.* accounts,
  // so this financial probe can run in isolation like every other full-domain
  // audit. Each login happens exactly once: a second login now correctly
  // displaces the first device session.
  const mgr1row = users.find(u => u.username === 'lagos.mgr');
  const home = branches.find(b => b.id === (mgr1row && mgr1row.branch_id)) || branches[0];
  const other = branches.find(b => b.id !== home.id);
  const gmLogin = await login('manager');
  const branchManagerLogin = await login('lagos.mgr');
  const staffLogin = await login('lagos.staff');
  const gm = gmLogin.body && gmLogin.body.token;
  const bmgr = branchManagerLogin.body && branchManagerLogin.body.token;
  const staff = staffLogin.body && staffLogin.body.token;
  if (!home || !other) { bad('need two active branches'); console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
  ok(`fixture: branch manager pinned to ${home.name}; second branch ${other.name}`);

  // ---- A. WHO MAY MOVE THE SAFE ------------------------------------------
  console.log('\n=== A. AUTHORISATION (client decision) ===');
  const dep = (tok, bid, amt = 1000) => req('POST', '/api/safe/movements',
    { token: tok, body: { branch_id: bid, entry_type: 'DEPOSIT', amount: amt, reason: 'authorisation probe deposit' } });

  if ((await dep(owner, other.id)).status === 201) ok('the OWNER can move any branch\'s safe');
  else bad('the OWNER cannot move a safe');
  if ((await dep(gm, other.id)).status === 201) ok('a GENERAL MANAGER (org-wide) can move any branch\'s safe');
  else bad('a General Manager cannot move a safe');
  if ((await dep(bmgr, home.id)).status === 201) ok('a BRANCH MANAGER can move their OWN branch\'s safe');
  else bad('a Branch Manager cannot move their own safe');

  const crossBranch = await dep(bmgr, other.id);
  if (crossBranch.status === 403 && crossBranch.body.code === 'BRANCH_SCOPE_VIOLATION') ok('...but NOT another branch\'s safe');
  else bad(`a Branch Manager moved another branch's safe: ${crossBranch.status}`);

  const byStaff = await dep(staff, home.id);
  if (byStaff.status === 403 && byStaff.body.code === 'SAFE_REQUIRES_MANAGER') ok('a CASHIER cannot move the safe');
  else bad(`a cashier moved the safe: ${byStaff.status} ${JSON.stringify(byStaff.body).slice(0, 80)}`);

  const byVendor = await dep(admin, home.id);
  if (byVendor.status === 403 && byVendor.body.code === 'VENDOR_CANNOT_MOVE_CASH') ok('the VENDOR support seat cannot move a client\'s cash');
  else bad(`vendor admin moved client cash: ${byVendor.status}`);

  // A cashier must still be able to SEE it — they need to know whether a
  // purchase can be funded before troubling a manager.
  const staffRead = await req('GET', `/api/safe?branch_id=${home.id}`, { token: staff });
  if (staffRead.status === 200 && staffRead.body.safe_balance != null) ok('a cashier CAN read the safe balance');
  else bad(`a cashier cannot read the safe balance: ${staffRead.status}`);

  // ---- B. EVERY MOVEMENT IS ACCOUNTED FOR --------------------------------
  console.log('\n=== B. THE LEDGER AND THE GL AGREE ===');
  const before = await safeOf(owner, home.id);
  const glBefore = await tb(owner);
  const d = await req('POST', '/api/safe/movements', { token: owner,
    body: { branch_id: home.id, entry_type: 'DEPOSIT', amount: 200000, reason: 'Owner float for the month' } });
  if (d.status === 201 && near(d.body.safe_balance, before + 200000)) ok(`deposit of N200,000 lands: balance N${before} -> N${d.body.safe_balance}`);
  else bad(`deposit returned ${d.status}, balance ${d.body && d.body.safe_balance} (expected ${before + 200000})`);
  const glAfter = await tb(owner);
  if (near(glAfter.BRANCH_SAFE.dr - glBefore.BRANCH_SAFE.dr, 200000)) ok('Branch Safe DEBITED N200,000 in the ledger');
  else bad(`Branch Safe debit moved by ${glAfter.BRANCH_SAFE.dr - glBefore.BRANCH_SAFE.dr}`);
  if (near(glAfter.__dr, glAfter.__cr)) ok('books balance after the deposit');
  else bad(`books unbalanced: ${glAfter.__dr} vs ${glAfter.__cr}`);

  const noReason = await req('POST', '/api/safe/movements', { token: owner,
    body: { branch_id: home.id, entry_type: 'DEPOSIT', amount: 100, reason: 'x' } });
  if (noReason.status === 400 && noReason.body.code === 'SAFE_REASON_REQUIRED') ok('a movement with no real reason is refused');
  else bad(`reasonless movement returned ${noReason.status}`);

  // ---- C. THE SAFE CANNOT GO NEGATIVE ------------------------------------
  console.log('\n=== C. THE SAFE OBEYS THE SAME RULE AS THE DRAWER ===');
  const bal = await safeOf(owner, home.id);
  const over = await req('POST', '/api/safe/movements', { token: owner,
    body: { branch_id: home.id, entry_type: 'WITHDRAWAL', amount: bal + 50000, reason: 'deliberate overdraw' } });
  if (over.status === 400 && over.body.code === 'SAFE_INSUFFICIENT_FUNDS') ok(`withdrawing more than the safe holds (N${bal}) is refused`);
  else bad(`overdraw returned ${over.status} ${JSON.stringify(over.body).slice(0, 90)}`);
  if (near(await safeOf(owner, home.id), bal)) ok('...and the balance is unchanged by the refused attempt');
  else bad('a refused withdrawal still moved the balance');

  // ---- D. THE POINT OF THE FEATURE ---------------------------------------
  console.log('\n=== D. BUYING ABOVE THE DRAWER (the reason the safe exists) ===');
  // Establish what the drawer holds, so "more than the drawer" is measured.
  let till = L((await req('GET', '/api/till?branch_id=' + home.id, { token: owner })).body).find(t => t.status === 'OPEN');
  if (!till) {
    const opened = await req('POST', '/api/till/open', { token: owner, body: { branch_id: home.id, opening_cash: 5000 } });
    till = opened.body;
  }
  const drawer = Number((await req('GET', `/api/till/${till.id}/expected`, { token: owner })).body.expected_closing_cash);
  const bigAmount = Math.round(drawer + 50000);
  ok(`the drawer holds N${drawer.toFixed(2)}; testing a N${bigAmount} payment`);

  // From CASH: correctly refused (Bug 96's guard, still in force).
  const asCash = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: home.id, category: 'RENT', amount: bigAmount, description: 'rent', paid_by_method: 'CASH' } });
  if (asCash.status === 400 && asCash.body.code === 'CASH_EXPENSE_EXCEEDS_DRAWER') ok('...as CASH it is still refused (Bug 96 guard intact)');
  else bad(`a cash expense above the drawer returned ${asCash.status} — Bug 96 has regressed`);
  // Case-INSENSITIVE: the refusal reads "Take the rest from the branch safe",
  // which is the right register for a cashier. Pinning the upper-case token
  // was testing my own wording, not the behaviour.
  if (asCash.body && /safe/i.test(String(asCash.body.error))) ok('...and the refusal now points at the SAFE as the alternative');
  else bad('the refusal does not mention the safe');

  // From SAFE: allowed, and the money comes off the reserve, not the drawer.
  const safeBefore = await safeOf(owner, home.id);
  const glB = await tb(owner);
  const asSafe = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: home.id, category: 'RENT', amount: bigAmount, description: 'quarterly rent', paid_by_method: 'SAFE' } });
  if (asSafe.status === 201) ok('...as SAFE it is accepted — the branch can buy above its drawer');
  else bad(`safe-funded expense returned ${asSafe.status} ${JSON.stringify(asSafe.body).slice(0, 110)}`);
  const safeAfter = await safeOf(owner, home.id);
  if (near(safeBefore - safeAfter, bigAmount)) ok(`the safe fell by exactly N${bigAmount}`);
  else bad(`safe moved by ${(safeBefore - safeAfter).toFixed(2)}, expected ${bigAmount}`);
  const drawerAfter = Number((await req('GET', `/api/till/${till.id}/expected`, { token: owner })).body.expected_closing_cash);
  if (near(drawerAfter, drawer)) ok('...and the DRAWER is untouched — the two pots stay separate');
  else bad(`the drawer moved from ${drawer} to ${drawerAfter} for a safe-funded expense`);
  const glA = await tb(owner);
  if (near(glA.BRANCH_SAFE.cr - glB.BRANCH_SAFE.cr, bigAmount)) ok('Branch Safe CREDITED in the ledger, not Cash');
  else bad(`Branch Safe credit moved by ${glA.BRANCH_SAFE.cr - glB.BRANCH_SAFE.cr}, expected ${bigAmount}`);
  if (near(glA.CASH.cr, glB.CASH.cr)) ok('...and Cash on Hand was NOT credited');
  else bad(`Cash was credited ${glA.CASH.cr - glB.CASH.cr} for a safe-funded expense`);
  if (near(glA.__dr, glA.__cr)) ok('books balance after the safe-funded expense');
  else bad(`books unbalanced: ${glA.__dr} vs ${glA.__cr}`);

  // ---- E. PAYING A SUPPLIER FROM THE SAFE --------------------------------
  console.log('\n=== E. PAYING A DELIVERY FROM THE SAFE ===');
  let bals = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
    .filter(x => Number(x.balance_owed) > 0);
  // A fresh seed legitimately has no supplier debt. Create a real credit
  // receipt instead of treating an absent fixture as a product failure.
  if (!bals.length) {
    const suppliers = L((await req('GET', '/api/suppliers', { token: owner })).body);
    let supplier = suppliers[0];
    if (!supplier) {
      const made = await req('POST', '/api/suppliers', { token: owner, body: {
        name: `Safe Settlement Supplier ${Date.now()}`, phone: '08030000000', address: 'Audit depot' } });
      supplier = made.body;
    }
    const products = L((await req('GET', '/api/products', { token: owner })).body);
    const product = products.find(p => p.dispensing_type !== 'POM' && !p.is_controlled) || products[0];
    if (supplier && product) {
      const po = await req('POST', '/api/purchase-orders', { token: owner, body: {
        branch_id: home.id, supplier_id: supplier.id,
        items: [{ product_id: product.id, quantity_ordered: 20, expected_unit_cost: 100 }] } });
      if (po.status === 201) {
        await req('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner, body: {
          on_credit: true,
          batches: [{ product_id: product.id, quantity_received: 20, cost_price_per_unit: 100,
            selling_price_per_unit: 150, batch_no: `SAFE-${Date.now()}`, expiry_date: '2030-12-31' }] } });
      }
    }
    bals = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
      .filter(x => Number(x.balance_owed) > 0);
  }
  const debt = bals.find(x => x.branch_id === home.id) || bals[0];
  if (!debt) { bad('could not create supplier debt fixture to settle'); }
  else {
    const payBranch = debt.branch_id;
    // Make sure that branch's safe can fund it.
    await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: payBranch, entry_type: 'DEPOSIT', amount: Number(debt.balance_owed) + 10000,
      reason: 'Float to settle a supplier' } });
    const sBefore = await safeOf(owner, payBranch);
    const part = Math.round(Number(debt.balance_owed) / 2 * 100) / 100;
    const pay = await req('POST', `/api/creditors/${debt.supplier_id}/payments`, { token: owner, body: {
      branch_id: payBranch, amount: part, paid_by_method: 'SAFE', notes: 'Delivery paid from the safe' } });
    if (pay.status === 201) ok(`a supplier payment of N${part} from the SAFE is accepted`);
    else bad(`safe supplier payment returned ${pay.status} ${JSON.stringify(pay.body).slice(0, 110)}`);
    const sAfter = await safeOf(owner, payBranch);
    if (near(sBefore - sAfter, part)) ok('...and the safe fell by exactly that amount');
    else bad(`safe moved by ${(sBefore - sAfter).toFixed(2)}, expected ${part}`);
    const after = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
      .find(x => x.supplier_id === debt.supplier_id && x.branch_id === payBranch);
    if (after && near(Number(debt.balance_owed) - Number(after.balance_owed), part)) ok('...and the supplier balance fell by the same amount');
    else bad(`supplier balance did not fall correctly (was ${debt.balance_owed}, now ${after && after.balance_owed})`);
    const glS = await tb(owner);
    if (near(glS.__dr, glS.__cr)) ok('books balance after the safe-funded supplier payment');
    else bad(`books unbalanced: ${glS.__dr} vs ${glS.__cr}`);
  }

  // ---- F. MOVING CASH BETWEEN THE DRAWER AND THE SAFE --------------------
  console.log('\n=== F. SWEEPING THE DRAWER INTO THE SAFE ===');
  const sweepBefore = await safeOf(owner, home.id);
  const sweep = await req('POST', '/api/safe/movements', { token: owner, body: {
    branch_id: home.id, entry_type: 'TILL_TRANSFER', amount: 3000, reason: 'End-of-day sweep from the drawer' } });
  if (sweep.status === 201 && near(await safeOf(owner, home.id), sweepBefore + 3000)) ok('a positive TILL_TRANSFER moves cash INTO the safe');
  else bad(`sweep returned ${sweep.status}, balance ${await safeOf(owner, home.id)} (expected ${sweepBefore + 3000})`);
  const topUp = await req('POST', '/api/safe/movements', { token: owner, body: {
    branch_id: home.id, entry_type: 'TILL_TRANSFER', amount: -1500, reason: 'Topping the drawer back up for change' } });
  if (topUp.status === 201 && near(await safeOf(owner, home.id), sweepBefore + 1500)) ok('a negative TILL_TRANSFER moves cash back OUT to the drawer');
  else bad(`top-up returned ${topUp.status}, balance ${await safeOf(owner, home.id)}`);

  // ---- G. THE HISTORY IS AUDITABLE ---------------------------------------
  console.log('\n=== G. EVERY MOVEMENT NAMES A PERSON AND A REASON ===');
  const hist = (await req('GET', `/api/safe/${home.id}/movements`, { token: owner })).body;
  const rows = L(hist.movements);
  if (rows.length) ok(`${rows.length} movements recorded`);
  else bad('no movement history');
  if (rows.every(r => r.reason && String(r.reason).trim().length >= 4)) ok('every movement carries a reason');
  else bad('a movement has no reason');
  if (rows.every(r => r.recorded_by)) ok('every movement names who recorded it');
  else bad('a movement has no recorded_by');
  const funded = rows.filter(r => r.entry_type === 'EXPENSE_PAID' || r.entry_type === 'SUPPLIER_PAID');
  if (funded.length && funded.every(r => r.source_id)) ok('safe-funded payments link back to what they paid for');
  else if (!funded.length) bad('no EXPENSE_PAID/SUPPLIER_PAID rows were written');
  else bad('a safe-funded payment has no source_id');

  // The balance must equal the sum of its own history — an append-only ledger
  // whose reported balance can drift is worse than no ledger.
  const summed = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  if (near(summed, await safeOf(owner, home.id))) ok('the reported balance equals the sum of the ledger');
  else bad(`balance ${await safeOf(owner, home.id)} does not equal the ledger sum ${summed.toFixed(2)}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
