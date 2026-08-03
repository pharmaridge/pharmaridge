// LIVE PROBE — USER TRANSFER & PROMOTION (Bugs 74, 75)
//
// Covers the full "move a person" surface the client asked to be audited:
//   STAFF -> Branch Manager -> General Manager -> back down
//   Branch A -> Branch B
// and the effect of each on attendance, tills, history attribution, billing
// seats, live sessions and role labels.
//
// Requires a FRESH server: bash test/devserver.sh 9001
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
async function req(method, path, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; const t = await r.text();
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const login = async (u, p = '1234') => (await req('POST', '/api/auth/login', { body: { username: u, pin: p } })).body?.token;

(async () => {
  console.log('=== TRANSFER & PROMOTION PROBE ===');
  console.log('BASE=' + BASE);
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e) {
    console.log('server not reachable: ' + e.message + '\nRun: bash test/devserver.sh 9001');
    process.exit(3);
  }

  const owner = await login('owner');
  const admin = await login('admin');
  if (!owner) { console.log('cannot login owner'); process.exit(3); }
  const branches = (await req('GET', '/api/branches', { token: owner })).body;
  const lagos = branches.find(b => /lagos/i.test(b.name));
  const minna = branches.find(b => /minna/i.test(b.name));
  const uOf = async (username) => ((await req('GET', '/api/users', { token: owner })).body || []).find(u => u.username === username);

  // ---------------------------------------------------------------
  console.log('\n--- A. THE OLD REFUSALS NOW POINT AT THE REAL ACTION ---');
  // The general edit route must still refuse, so a transfer cannot bypass the
  // invariants, but it must name the endpoint that works (Bug 75).
  let staff = await uOf('lagos.staff');
  let r = await req('PUT', '/api/users/' + staff.id, { token: owner, body: { branch_id: minna.id } });
  ok('PUT branch_id still refused (transfer invariants must not be bypassed)', r.status === 400, String(r.status));
  ok('...and it names the transfer endpoint instead of impossible advice',
    r.body && r.body.code === 'USE_TRANSFER_ENDPOINT' && /transfer/i.test(r.body.transfer_endpoint || ''),
    JSON.stringify(r.body).slice(0, 140));
  ok('...and no longer claims history would be corrupted',
    r.body && !/Deactivate this account and create/i.test(r.body.error || ''), String(r.body && r.body.error).slice(0, 90));

  // BUG 108 CHANGED THE SHAPE OF A TRANSFER, AND THIS PROBE HAD TO FOLLOW.
  //
  // A transfer is now STAGED and applied only when the person confirms — so
  // every assertion below about "they are now at Minna" would otherwise be
  // testing a request that had not happened yet. That is not a regression:
  // it is the fix for a cashier being moved out from under their own offline
  // work (see AUDIT-REPORT Bug 108).
  //
  // This helper raises the transfer and then completes it AS THE PERSON,
  // which is the real path a pharmacy takes. It returns the final user row so
  // the existing checks read exactly as they did before. Where a transfer is
  // expected to be REFUSED outright, callers still use req() directly — the
  // refusal happens at staging time, before anything is written.
  async function transferAndConfirm(userId, body, token, confirmAs) {
    const staged = await req('POST', '/api/users/' + userId + '/transfer', { token, body });
    if (staged.status !== 200 || !staged.body || !staged.body.pending_transfer) return staged;
    const pid = staged.body.pending_transfer.id;
    // Confirm as the person being moved when we can sign in as them;
    // otherwise force it through as the owner (both are supported paths).
    let done;
    if (confirmAs) {
      const tok = await login(confirmAs);
      done = await req('POST', '/api/users/transfers/pending/' + pid + '/confirm', { token: tok, body: {} });
    } else {
      done = await req('POST', '/api/users/transfers/pending/' + pid + '/force', { token: owner, body: {} });
    }
    return done;
  }

  // ---------------------------------------------------------------
  console.log('\n--- B. BRANCH A -> BRANCH B (a real move, one account) ---');
  r = await req('POST', '/api/users/' + staff.id + '/transfer', { token: owner, body: { branch_id: minna.id } });
  ok('a transfer with no reason is refused', r.status === 400 && r.body.code === 'TRANSFER_REASON_REQUIRED', String(r.status) + ' ' + String(r.body && r.body.code));

  r = await transferAndConfirm(staff.id, { branch_id: minna.id, reason: 'Covering the Minna counter from August' }, owner, 'lagos.staff');
  ok('Lagos -> Minna succeeds', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
  ok('the person keeps the SAME user id', r.body && r.body.id === staff.id);
  ok('the person keeps the SAME username (no second identity)', r.body && r.body.username === 'lagos.staff');
  ok('they are now at Minna', r.body && r.body.branch_id === minna.id);
  ok('role label still "Staff"', r.body && r.body.role_label === 'Staff', String(r.body && r.body.role_label));

  const list = (await req('GET', '/api/users', { token: owner })).body;
  ok('still exactly ONE row for this human (the two-identity split is gone)',
    list.filter(u => u.full_name === 'Bisi Adewale').length === 1,
    'rows=' + list.filter(u => u.full_name === 'Bisi Adewale').length);

  // ---------------------------------------------------------------
  console.log('\n--- C. HISTORY STAYS ANCHORED TO THE OLD BRANCH ---');
  // The whole justification of the old refusal. Verify by making a real sale
  // BEFORE a move and re-reading it after.
  const back = await transferAndConfirm(staff.id, { branch_id: lagos.id, reason: 'Returning to Lagos counter' }, owner, 'lagos.staff');
  ok('moved back to Lagos', back.status === 200);
  const stok = await login('lagos.staff');
  const stock = (await req('GET', '/api/stock?branch_id=' + lagos.id, { token: stok })).body;
  const prods = (await req('GET', '/api/products', { token: stok })).body;
  const pmap = new Map((prods || []).map(p => [p.id, p]));
  const batch = (stock || []).find(s => s.quantity_remaining > 2 && s.selling_price_per_unit > 0
    && pmap.get(s.product_id) && !pmap.get(s.product_id).is_controlled);
  const tills = (await req('GET', '/api/till?branch_id=' + lagos.id, { token: owner })).body;
  if (!(tills || []).some(t => t.status === 'OPEN')) {
    await req('POST', '/api/till/open', { token: stok, body: { branch_id: lagos.id, opening_cash: 0 } });
  }
  const sale = await req('POST', '/api/sales', {
    token: stok,
    body: {
      branch_id: lagos.id,
      items: [{ product_id: batch.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
      payments: [{ method: 'CASH', amount: batch.selling_price_per_unit }],
    },
  });
  ok('a sale is recorded at Lagos before the move', sale.status === 201, sale.status + ' ' + JSON.stringify(sale.body).slice(0, 120));
  const saleId = sale.body && sale.body.id;

  // close the till so the open-till guard does not block the move
  const openTill = ((await req('GET', '/api/till?branch_id=' + lagos.id, { token: owner })).body || []).find(t => t.status === 'OPEN');
  if (openTill) {
    await req('POST', '/api/till/' + openTill.id + '/close', { token: owner, body: { counted_closing_cash: 0, force_reason: 'probe: settling before transfer' } });
  }
  r = await transferAndConfirm(staff.id, { branch_id: minna.id, reason: 'Permanent move to Minna' }, owner, 'lagos.staff');
  ok('transferred to Minna after trading at Lagos', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 140));

  const afterSale = (await req('GET', '/api/sales/' + saleId, { token: owner })).body;
  ok('the Lagos sale is STILL a Lagos sale', afterSale && afterSale.branch_id === lagos.id, String(afterSale && afterSale.branch_id));
  ok('the Lagos sale is STILL attributed to them by name', afterSale && afterSale.served_by_name === 'Bisi Adewale', String(afterSale && afterSale.served_by_name));
  const tb = (await req('GET', '/api/gl/trial-balance', { token: owner })).body;
  const dr = (tb || []).reduce((a, x) => a + Number(x.total_debits || 0), 0);
  const cr = (tb || []).reduce((a, x) => a + Number(x.total_credits || 0), 0);
  ok('the books still balance after the move', Math.abs(dr - cr) < 0.005, dr + ' vs ' + cr);

  // scoping follows the LIVE row, immediately
  const stok2 = await login('lagos.staff');
  r = await req('GET', '/api/sales/' + saleId, { token: stok2 });
  ok('they can no longer read their OLD branch\'s sale (scoped to the new branch)', r.status === 403, String(r.status));

  // ---------------------------------------------------------------
  console.log('\n--- D. PROMOTION LADDER: STAFF -> BRANCH MGR -> GENERAL MGR ---');
  r = await transferAndConfirm(staff.id, { role: 'MANAGER', branch_id: minna.id, reason: 'Promoted to run the Minna branch' }, owner, 'lagos.staff');
  ok('STAFF -> Branch Manager succeeds', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 140));
  ok('role_label derived as "Branch Manager"', r.body && r.body.role_label === 'Branch Manager', String(r.body && r.body.role_label));

  const bmTok = await login('lagos.staff');
  r = await req('GET', '/api/users', { token: bmTok });
  ok('the new Branch Manager can reach manager-only endpoints', r.status === 200, String(r.status));
  const seen = (r.body || []).filter(u => u.branch_id && u.branch_id !== minna.id);
  ok('...but only sees their OWN branch\'s people', seen.length === 0, 'foreign rows=' + seen.length);

  r = await transferAndConfirm(staff.id, { branch_id: null, reason: 'Promoted to General Manager, org-wide' }, owner, 'lagos.staff');
  ok('Branch Manager -> General Manager (clear branch) succeeds', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 140));
  ok('role_label derived as "General Manager"', r.body && r.body.role_label === 'General Manager', String(r.body && r.body.role_label));
  ok('branch_id is now null', r.body && r.body.branch_id === null);

  const gmTok = await login('lagos.staff');
  const lagosStock = (await req('GET', '/api/stock?branch_id=' + lagos.id, { token: gmTok })).body;
  const minnaStock = (await req('GET', '/api/stock?branch_id=' + minna.id, { token: gmTok })).body;
  ok('the General Manager now sees BOTH branches', (lagosStock || []).length > 0 && (minnaStock || []).length > 0);
  r = await req('PUT', '/api/settings/vat', { token: gmTok, body: { vat_rate: 7.5 } });
  ok('...but still cannot do owner-only things', r.status === 403, String(r.status));

  // ---------------------------------------------------------------
  console.log('\n--- E. AUTHORITY LIMITS ON THE TRANSFER ITSELF ---');
  r = await req('POST', '/api/users/' + staff.id + '/transfer', { token: gmTok, body: { role: 'STAFF', branch_id: lagos.id, reason: 'demote myself' } });
  ok('nobody can transfer THEMSELVES', r.status === 403 && r.body.code === 'SELF_TRANSFER_FORBIDDEN', r.status + ' ' + String(r.body && r.body.code));

  const lmgr = await uOf('lagos.mgr');
  const lmTok = await login('lagos.mgr');
  const minnaStaff = await uOf('minna.staff');
  r = await req('POST', '/api/users/' + minnaStaff.id + '/transfer', { token: lmTok, body: { branch_id: lagos.id, reason: 'poach into my branch' } });
  ok('a Branch Manager cannot transfer someone OUT of another branch', r.status === 403 && r.body.code === 'BRANCH_SCOPE_VIOLATION', r.status + ' ' + String(r.body && r.body.code));

  // TRAP 18 — seed the fixture instead of conditionally skipping. These two
  // are the escalation checks that matter most on this endpoint, so they must
  // never be allowed to quietly not run.
  let lagosStaff2 = (await req('GET', '/api/users', { token: owner })).body.find(u => u.branch_id === lagos.id && u.role === 'STAFF' && u.is_active);
  if (!lagosStaff2) {
    const seeded = await req('POST', '/api/users', { token: owner, body: { branch_id: lagos.id, full_name: 'Scope Fixture', username: 'scope.fixture', pin: '1111', role: 'STAFF' } });
    lagosStaff2 = { id: seeded.body.id };
  }
  ok('fixture present for the branch-scope escalation checks', !!(lagosStaff2 && lagosStaff2.id));
  r = await req('POST', '/api/users/' + lagosStaff2.id + '/transfer', { token: lmTok, body: { branch_id: minna.id, reason: 'push into another branch' } });
  ok('a Branch Manager cannot push someone INTO another branch', r.status === 403 && r.body.code === 'BRANCH_SCOPE_VIOLATION', r.status + ' ' + String(r.body && r.body.code));
  r = await req('POST', '/api/users/' + lagosStaff2.id + '/transfer', { token: lmTok, body: { role: 'OWNER', reason: 'escalate' } });
  ok('a manager cannot promote anyone to OWNER (no lateral takeover)', r.status === 403, r.status + ' ' + String(r.body && r.body.code));
  // ...and the escalation must not work in two steps either: promote to
  // MANAGER (allowed for a manager? no — canAssignRole permits MANAGER) and
  // then rely on that account to reach OWNER. Verify the first hop's limits.
  r = await req('POST', '/api/users/' + lagosStaff2.id + '/transfer', { token: lmTok, body: { role: 'MANAGER', branch_id: null, reason: 'make them org-wide' } });
  ok('a Branch Manager cannot create an ORG-WIDE manager (escaping their own scope)',
    r.status === 403, r.status + ' ' + String(r.body && r.body.code));

  const ownerRow = await uOf('owner');
  r = await req('POST', '/api/users/' + ownerRow.id + '/transfer', { token: admin, body: { role: 'MANAGER', reason: 'demote the only owner' } });
  ok('the LAST owner cannot be demoted away (Bug 70 invariant holds on the new path)',
    r.status === 400 && r.body.code === 'LAST_OWNER_PROTECTED', r.status + ' ' + String(r.body && r.body.code));

  r = await req('POST', '/api/users/' + staff.id + '/transfer', { token: owner, body: { role: 'STAFF', branch_id: null, reason: 'invalid combo' } });
  ok('STAFF with no branch is refused with a readable error',
    r.status === 400 && r.body.code === 'INVALID_ROLE_BRANCH_COMBINATION', r.status + ' ' + String(r.body && r.body.code));

  // ---------------------------------------------------------------
  console.log('\n--- F. AN OPEN TILL BLOCKS A BRANCH MOVE ---');
  const cashier = await req('POST', '/api/users', { token: owner, body: { branch_id: lagos.id, full_name: 'Till Holder', username: 'till.holder', pin: '1111', role: 'STAFF' } });
  const cashierId = cashier.body.id;
  const cTok = await login('till.holder', '1111');
  const openRes = await req('POST', '/api/till/open', { token: cTok, body: { branch_id: lagos.id, opening_cash: 1500 } });
  ok('cashier opens a till at Lagos', openRes.status === 201, String(openRes.status));
  r = await req('POST', '/api/users/' + cashierId + '/transfer', { token: owner, body: { branch_id: minna.id, reason: 'move while holding cash' } });
  ok('moving them is BLOCKED while they hold an open till',
    r.status === 409 && r.body.code === 'OPEN_TILL_BLOCKS_TRANSFER', r.status + ' ' + String(r.body && r.body.code));
  await req('POST', '/api/till/' + openRes.body.id + '/close', { token: owner, body: { counted_closing_cash: 1500, force_reason: 'settling before transfer' } });
  r = await req('POST', '/api/users/' + cashierId + '/transfer', { token: owner, body: { branch_id: minna.id, reason: 'move after settling cash' } });
  ok('...and allowed once the till is settled', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 120));

  // ---------------------------------------------------------------
  // SECTION G FIXTURE NOTE (BUG 108).
  //
  // This section builds its own `till.holder` account and walks it through
  // several transfers earlier in the file. Bug 108 turned a transfer into a
  // two-step operation, which changed the ORDER those fixtures reach their
  // states, and the section's later assumptions about that account no longer
  // hold on every run.
  //
  // THE APPLICATION BEHAVIOUR IS CORRECT AND WAS VERIFIED DIRECTLY: clocking
  // a cashier in, staging a transfer, and confirming it returns
  // shift_auto_closed = true, closes the shift at the OLD branch (with its
  // clock_out_at set), and moves the person — all confirmed against the live
  // server. probe-syncgaps.js now owns that guarantee with checks written for
  // the two-step flow.
  //
  // Left in place rather than deleted so the fixture drift is visible and
  // someone can re-sequence it properly; not silently rewritten to pass.
  console.log('\n--- G. AN OPEN SHIFT IS CLOSED AT THE OLD BRANCH, NOT CARRIED OVER ---');
  const mTok = await login('till.holder', '1111');
  // FIXTURE DRIFT, NOW FIXED (this section previously failed 8 checks).
  //
  // Earlier sections move `till.holder` around, and Bug 108 made a transfer a
  // TWO-STEP operation, which changed the order those moves complete in. By
  // the time section G ran, the account was already at Lagos — so "move them
  // to Lagos" was a no-op and the API correctly returned 400 NO_CHANGE. The
  // eight failures that followed were all consequences of that one wrong
  // assumption, not of anything the application did.
  //
  // Read where they ACTUALLY are and move them somewhere else, rather than
  // hard-coding a destination that an earlier section may already have used.
  // An earlier section may have left a transfer AWAITING_CONFIRMATION for this
  // account, and only one may be open per person (Bug 108). Clear it, or this
  // section's own transfer is refused 409 for a reason that has nothing to do
  // with what it is testing.
  {
    const openReqs = (await req('GET', '/api/users/transfers/pending', { token: owner })).body || [];
    for (const pr of (Array.isArray(openReqs) ? openReqs : [])) {
      if (pr.user_id === cashierId) {
        await req('POST', `/api/users/transfers/pending/${pr.id}/cancel`, { token: owner, body: {} });
      }
    }
  }
  const holderNow = ((await req('GET', '/api/users', { token: owner })).body || [])
    .find(u => u.id === cashierId);
  const shiftBranch = holderNow && holderNow.branch_id === lagos.id ? lagos.id : minna.id;
  const moveTo = shiftBranch === lagos.id ? minna.id : lagos.id;
  const ci = await req('POST', '/api/attendance/clock-in', { token: mTok, body: { branch_id: shiftBranch } });
  ok('they clock in at their current branch', ci.status === 201, String(ci.status) + ' ' + String(ci.body && ci.body.code));
  r = await transferAndConfirm(cashierId, { branch_id: moveTo, reason: 'moved mid-shift' }, owner, null);
  ok('the transfer succeeds with a shift open', r.status === 200, String(r.status));
  ok('...and reports that it closed the shift', r.body && r.body.transfer && r.body.transfer.shift_auto_closed === true, String(JSON.stringify(r.body && r.body.transfer)).slice(0, 160));
  const attRows = (await req('GET', '/api/attendance', { token: owner })).body;
  const theShift = (attRows || []).find(a => a.id === ci.body.id);
  ok('the shift is closed', theShift && !!theShift.clock_out_at, String(theShift && theShift.clock_out_at));
  ok('...and stays recorded against the OLD branch (payroll evidence intact)', theShift && theShift.branch_id === shiftBranch, String(theShift && theShift.branch_id));
  const cTok2 = await login('till.holder', '1111');
  const ci2 = await req('POST', '/api/attendance/clock-in', { token: cTok2, body: { branch_id: moveTo } });
  ok('they can immediately clock in at the NEW branch', ci2.status === 201, ci2.status + ' ' + String(ci2.body && ci2.body.code));

  // ---------------------------------------------------------------
  console.log('\n--- H. BUG 74: A DEPARTING EMPLOYEE\'S SHIFT CAN BE CLOSED ---');
  r = await req('PUT', '/api/users/' + cashierId, { token: owner, body: { is_active: false } });
  ok('deactivating a clocked-in employee succeeds', r.status === 200, String(r.status));
  const attRows2 = (await req('GET', '/api/attendance', { token: owner })).body;
  const stranded = (attRows2 || []).find(a => a.id === ci2.body.id);
  ok('their open shift is AUTO-CLOSED by the deactivation (was: on duty forever)',
    stranded && !!stranded.clock_out_at, 'clock_out_at=' + String(stranded && stranded.clock_out_at));
  ok('...recorded as a manager intervention, not a self clock-out',
    stranded && !!stranded.force_closed_by, 'force_closed_by=' + String(stranded && stranded.force_closed_by));
  ok('...with a stated reason', stranded && /deactivated/i.test(stranded.force_closed_reason || ''), String(stranded && stranded.force_closed_reason));

  // reinstatement must not be blocked by a stale open shift
  await req('PUT', '/api/users/' + cashierId, { token: owner, body: { is_active: true } });
  const reTok = await login('till.holder', '1111');
  const reCi = await req('POST', '/api/attendance/clock-in', { token: reTok, body: { branch_id: lagos.id } });
  ok('a reinstated employee can clock in again (was: ALREADY_CLOCKED_IN forever)',
    reCi.status === 201, reCi.status + ' ' + String(reCi.body && reCi.body.code));

  // manual force clock-out
  r = await req('POST', '/api/attendance/' + reCi.body.id + '/force-clock-out', { token: owner, body: {} });
  ok('force clock-out demands a reason', r.status === 400 && r.body.code === 'FORCE_CLOCKOUT_REASON_REQUIRED', r.status + ' ' + String(r.body && r.body.code));
  r = await req('POST', '/api/attendance/' + reCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'Cashier went home without clocking out' } });
  ok('a manager can force clock-out someone who forgot', r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  ok('...and it is attributed to the manager', r.body && !!r.body.force_closed_by);
  r = await req('POST', '/api/attendance/' + reCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'try again' } });
  ok('a second force clock-out on the same shift is refused', r.status === 400, String(r.status));

  // self force-clock-out is not a back door around Bug 71's principle
  const ownerCi = await req('POST', '/api/attendance/clock-in', { token: owner, body: { branch_id: lagos.id } });
  if (ownerCi.status === 201) {
    r = await req('POST', '/api/attendance/' + ownerCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'close my own shift the easy way' } });
    ok('nobody can force clock-out THEMSELVES', r.status === 403 && r.body.code === 'SELF_FORCE_CLOCKOUT_FORBIDDEN', r.status + ' ' + String(r.body && r.body.code));
    await req('POST', '/api/attendance/' + ownerCi.body.id + '/clock-out', { token: owner, body: {} });
  }

  // backdating rules
  const bTok = await login('till.holder', '1111');
  const bCi = await req('POST', '/api/attendance/clock-in', { token: bTok, body: { branch_id: lagos.id } });
  if (bCi.status === 201) {
    r = await req('POST', '/api/attendance/' + bCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'backdate before start', clock_out_at: '2020-01-01 08:00:00' } });
    ok('a clock-out BEFORE the clock-in is refused (no negative hours)', r.status === 400 && r.body.code === 'INVALID_CLOCK_OUT_TIME', r.status + ' ' + String(r.body && r.body.code));
    r = await req('POST', '/api/attendance/' + bCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'future', clock_out_at: '2099-01-01 08:00:00' } });
    ok('a clock-out in the FUTURE is refused (no paying for unworked time)', r.status === 400 && r.body.code === 'INVALID_CLOCK_OUT_TIME', r.status + ' ' + String(r.body && r.body.code));
    r = await req('POST', '/api/attendance/' + bCi.body.id + '/force-clock-out', { token: owner, body: { reason: 'Left at 6pm without clocking out' } });
    ok('a valid force clock-out still works', r.status === 200, String(r.status));
  }

  // deletion must close the shift too — permanent, so unrecoverable otherwise
  const dRes = await req('POST', '/api/users', { token: owner, body: { branch_id: lagos.id, full_name: 'Deleted Soul', username: 'deleted.soul', pin: '1111', role: 'STAFF' } });
  const dTok = await login('deleted.soul', '1111');
  const dCi = await req('POST', '/api/attendance/clock-in', { token: dTok, body: { branch_id: lagos.id } });
  await req('DELETE', '/api/users/' + dRes.body.id, { token: owner });
  const attRows3 = (await req('GET', '/api/attendance', { token: owner })).body;
  const dRow = (attRows3 || []).find(a => a.id === (dCi.body && dCi.body.id));
  ok('DELETING an account also closes its open shift', dRow && !!dRow.clock_out_at, 'clock_out_at=' + String(dRow && dRow.clock_out_at));

  // ---------------------------------------------------------------
  console.log('\n--- I. THE TRANSFER AUDIT TRAIL ---');
  const hist = await req('GET', '/api/users/' + staff.id + '/assignment-history', { token: owner });
  ok('assignment history is readable', hist.status === 200 && Array.isArray(hist.body), String(hist.status));
  ok('...and records every move made in this probe', (hist.body || []).length >= 4, 'rows=' + (hist.body || []).length);
  const h0 = (hist.body || [])[0];
  ok('...naming who made the change', h0 && !!h0.changed_by_name, String(h0 && h0.changed_by_name));
  ok('...with the reason given', h0 && (h0.reason || '').length >= 4, String(h0 && h0.reason));
  ok('...and both the old and new role labels', h0 && !!h0.from_role_label && !!h0.to_role_label, JSON.stringify(h0 && { f: h0.from_role_label, t: h0.to_role_label }));
  const staffTokH = await login('minna.staff');
  const hs = await req('GET', '/api/users/' + staff.id + '/assignment-history', { token: staffTokH });
  ok('a cashier cannot read someone\'s assignment history', hs.status === 403, String(hs.status));

  // ---------------------------------------------------------------
  console.log('\n--- J. BILLING SEATS ARE NOT DOUBLE-COUNTED BY A TRANSFER ---');
  const plan = (await req('GET', '/api/dashboard/plan', { token: owner })).body;
  const usersNow = (await req('GET', '/api/users', { token: owner })).body;
  const activeCount = (usersNow || []).filter(u => u.is_active && u.role !== 'ADMIN').length;
  // TRAP 18 — a probe that SKIPS is a probe that lies. The first version of
  // this section guarded on `plan.staff_used`, a field that does not exist
  // (the real shape is plan.staff.used), so the seat assertion never ran and
  // the section reported green having checked nothing. Asserted unconditionally
  // now, against the shape verified live.
  ok('plan usage is readable', !!(plan && plan.staff && plan.staff.used !== undefined), JSON.stringify(plan).slice(0, 160));
  ok('a transferred person consumes exactly ONE seat, not two',
    Number(plan.staff.used) === activeCount, 'plan=' + JSON.stringify(plan.staff) + ' activeNonAdmin=' + activeCount);
  // The old deactivate-and-recreate workaround left the closed account behind
  // AND created a new one. Prove the seat count did not drift upward across
  // all the moves this probe performed.
  ok('...and the seat count matches the number of real people',
    Number(plan.staff.used) === (usersNow || []).filter(u => u.is_active).length,
    'plan=' + plan.staff.used);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
})();
