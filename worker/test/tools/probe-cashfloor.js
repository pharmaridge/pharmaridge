// BUG 96 — A CASH EXPENSE MAY NOT EXCEED THE CASH IN THE DRAWER.
//
// Live-reproduced before the guard: a till opened with a N1,000 float, then a
// N50,000 RENT expense recorded as CASH. HTTP 201, and expected closing cash
// became -N49,000 — money a cash box cannot physically contain. The till then
// could not be closed by the normal path (closeTill rightly refuses a negative
// count), and forcing a count of 0 posted a fictitious N49,000 overage to
// CASH_OVER_SHORT — the single account an owner uses to detect till theft.
//
// The legitimate case behind it: pharmacies DO pay rent and salaries from a
// safe or bank. That is a TRANSFER, not cash out of the counter drawer.
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

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;

  const branch = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active)[0];
  if (!branch) { bad('no active branch'); console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }

  // A KNOWN, SMALL float so "more than the drawer holds" is unambiguous.
  for (const t of L((await req('GET', '/api/till?branch_id=' + branch.id, { token: owner })).body).filter(t => t.status === 'OPEN')) {
    const e = (await req('GET', `/api/till/${t.id}/expected`, { token: owner })).body;
    await req('POST', `/api/till/${t.id}/close`, { token: owner,
      body: { counted_closing_cash: Math.max(0, Number(e.expected_closing_cash) || 0), force_reason: 'cash-floor probe reset' } });
  }
  const till = await req('POST', '/api/till/open', { token: owner, body: { branch_id: branch.id, opening_cash: 1000 } });
  if (till.status !== 201) { bad(`could not open a till: ${till.status} ${JSON.stringify(till.body).slice(0, 90)}`);
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }
  ok(`fresh till at ${branch.name} with a N1,000 float`);

  console.log('\n=== A. THE OVERDRAW IS REFUSED ===');
  const big = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: branch.id, category: 'RENT', amount: 50000, description: 'rent', paid_by_method: 'CASH' } });
  if (big.status === 400 && big.body.code === 'CASH_EXPENSE_EXCEEDS_DRAWER') ok('a N50,000 CASH expense against a N1,000 drawer is refused');
  else bad(`overdraw returned ${big.status} ${JSON.stringify(big.body).slice(0, 120)}`);
  if (big.body && /transfer/i.test(String(big.body.error))) ok('...and the message names the alternative (record it as a TRANSFER)');
  else bad('the refusal does not tell the cashier what to do instead');

  console.log('\n=== B. LEGITIMATE SPENDING STILL WORKS ===');
  const small = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: branch.id, category: 'TRANSPORT', amount: 500, description: 'okada', paid_by_method: 'CASH' } });
  if (small.status === 201) ok('an affordable N500 CASH expense is accepted');
  else bad(`affordable cash expense returned ${small.status} ${JSON.stringify(small.body).slice(0, 110)}`);

  const transfer = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: branch.id, category: 'RENT', amount: 50000, description: 'rent paid from the safe', paid_by_method: 'TRANSFER' } });
  if (transfer.status === 201) ok('the same N50,000 recorded as TRANSFER is accepted — money from the safe is not blocked');
  else bad(`TRANSFER expense returned ${transfer.status} ${JSON.stringify(transfer.body).slice(0, 110)}`);

  console.log('\n=== C. THE DRAWER CAN NEVER GO NEGATIVE ===');
  const exp = (await req('GET', `/api/till/${till.body.id}/expected`, { token: owner })).body;
  const val = Number(exp.expected_closing_cash);
  if (val >= 0) ok(`expected closing cash is N${val.toFixed(2)} — not negative`);
  else bad(`expected closing cash is N${val} — a cash box cannot hold negative money`);
  // The TRANSFER must not have touched the drawer. Asserted as "the drawer did
  // not move by the transfer's N50,000" rather than as an absolute N500:
  // change-owed claims raised earlier in the same seeded branch are ALSO
  // retained cash and legitimately sit in this figure (the probe saw N600 for
  // exactly that reason — a N100 claim, correctly counted). Pinning an
  // absolute total assumes this probe is the only thing that ever touched the
  // till, which stopped being true once the seed grew (trap #62).
  if (val < 50000) ok(`...and the TRANSFER expense correctly did not touch the drawer (drawer N${val.toFixed(2)})`);
  else bad(`the drawer holds N${val.toFixed(2)} — the N50,000 TRANSFER appears to have been taken from it`);

  console.log('\n=== D. THE TILL CAN STILL BE CLOSED NORMALLY ===');
  const close = await req('POST', `/api/till/${till.body.id}/close`, { token: owner,
    body: { counted_closing_cash: val, force_reason: 'cash-floor probe' } });
  if (close.status === 200) ok('the till closes with the expected figure');
  else bad(`till close returned ${close.status} ${JSON.stringify(close.body).slice(0, 110)}`);
  const disc = close.body && Number(close.body.discrepancy);
  if (close.status === 200 && Math.abs(disc || 0) < 0.005) ok('...with ZERO discrepancy — no fictitious overage posted');
  else bad(`till closed with a discrepancy of ${disc} — a phantom figure would reach CASH_OVER_SHORT`);

  console.log('\n=== E. NO OPEN TILL MEANS NO DRAWER TO OVERDRAW ===');
  // An owner recording yesterday's expenses at a branch with no open session
  // must not be blocked — there is no drawer for the money to come out of.
  const later = await req('POST', '/api/expenses', { token: owner, body: {
    branch_id: branch.id, category: 'RENT', amount: 75000, description: 'rent, no session open', paid_by_method: 'CASH' } });
  if (later.status === 201) ok('with no till open, a cash expense is still allowed (nothing to overdraw)');
  else bad(`expense with no open till returned ${later.status} ${JSON.stringify(later.body).slice(0, 110)}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
