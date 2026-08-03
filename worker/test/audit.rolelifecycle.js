// ROLE LIFECYCLE & TRANSITIONS — THE GAPS BETWEEN THE ROLES.
//
// Every previous pass audited a role in isolation: what an ADMIN, OWNER,
// MANAGER or STAFF may do while they ARE that thing. This audits the seams
// between them — the events that actually happen in a pharmacy over a year:
//
//   * A cashier is moved from Lagos to Minna.
//   * A cashier is promoted to manager.
//   * A General Manager is pinned to one branch (or a Branch Manager freed).
//   * Someone resigns and is replaced.
//   * A branch is closed while people are still assigned to it.
//
// The product deliberately refuses in-place role and branch edits, which is
// defensible — but a refusal is only defensible if the ALTERNATIVE it names
// actually works. That is what this probe checks: not just "is it refused",
// but "can the pharmacy still get the job done, and does the audit trail
// survive".
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function note(m) { notes.push(m); console.log('  ..   ' + m); }

async function login(username, pin) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  return { status: r.status, ...b };
}

// BUG 108 — a staff transfer is now STAGED and applied only when the person
// confirms it (see AUDIT-REPORT). Every assertion in this probe about "they
// are now at the new branch" therefore has to complete BOTH steps, or it is
// checking a request that has not happened yet.
//
// Confirms as the owner via the FORCE path rather than signing in as each
// mover: this probe creates throwaway accounts whose PINs it controls, but
// forcing keeps the helper independent of that and is an equally supported
// route. probe-syncgaps.js covers the staff-confirms path in full.
async function transferAndApply(userId, body, token) {
  const staged = await api('POST', `/api/users/${userId}/transfer`, { token, body });
  if (staged.status !== 200 || !staged.body || !staged.body.pending_transfer) return staged;
  const pid = staged.body.pending_transfer.id;
  return api('POST', `/api/users/transfers/pending/${pid}/force`, { token, body: {} });
}
async function api(method, path, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
}
const listOf = (x) => (Array.isArray(x) ? x : (x && x.results) || []);
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

(async () => {
  const O = await login('owner', '1234');
  const A = await login('admin', '1234');
  const tO = O.token, tA = A.token;
  const branches = listOf((await api('GET', '/api/branches', { token: tO })).body).filter((b) => b.is_active);
  const lagos = branches[0];
  const minna = branches[1];
  check('two active branches exist to move people between', !!lagos && !!minna,
    `${branches.length} active`);

  const prods = listOf((await api('GET', '/api/products', { token: tO })).body);
  const safeIds = new Set(prods.filter((p) => !p.is_controlled).map((p) => p.id));
  const batch = listOf((await api('GET', `/api/stock?branch_id=${lagos.id}`, { token: tO })).body)
    .find((s) => Number(s.quantity_remaining) > 5 && safeIds.has(s.product_id));

  console.log('\n=== A. MOVING A CASHIER BETWEEN BRANCHES (BUGS 73, 75) ===');
  // Hire someone at Lagos and give them real history, so the move is realistic.
  const u1 = `mover-${uniq()}`;
  const hired = await api('POST', '/api/users', {
    token: tO, body: { full_name: 'Moving Cashier', username: u1, pin: '4321', role: 'STAFF', branch_id: lagos.id },
  });
  check('a cashier can be hired at the first branch', hired.status === 201,
    `status=${hired.status} ${JSON.stringify(hired.body).slice(0, 90)}`);
  const mover = hired.body;

  let hadHistory = false;
  if (batch && mover && mover.id) {
    const tok = (await login(u1, '4321')).token;
    await api('POST', '/api/till/open', { token: tok, body: { branch_id: lagos.id, opening_float: 1000 } });
    const unitPrice = Number(batch.selling_price_per_unit);
    const s = await api('POST', '/api/sales', {
      token: tok,
      body: {
        branch_id: lagos.id,
        items: [{ product_id: batch.product_id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
      },
    });
    hadHistory = s.status === 201;
    check('...and records a real sale there', hadHistory, `status=${s.status}`);
  }

  // 1. The in-place edit is still refused — deliberately. A transfer carries
  //    invariants (open till, open shift, last-owner) that a general "edit
  //    user" call has no business enforcing, so the door stays shut here.
  const inPlace = await api('PUT', `/api/users/${mover.id}`, { token: tO, body: { branch_id: minna.id } });
  check('moving a cashier by editing branch_id is REFUSED', inPlace.status === 400,
    `status=${inPlace.status}`);
  check('...with a machine-readable code', inPlace.body && inPlace.body.code === 'USE_TRANSFER_ENDPOINT',
    JSON.stringify(inPlace.body).slice(0, 90));

  // 2. BUG 75. The refusal used to say "deactivate this account and create a
  //    new one" — advice that cannot be followed, because the username is held
  //    forever, and which split one human into two payroll identities. It now
  //    names a path that actually works.
  const advice = String((inPlace.body && inPlace.body.error) || '');
  check('...and the refusal names the action that actually works',
    /transfer/i.test(advice), advice.slice(0, 110));
  check('...and no longer tells them to deactivate and recreate',
    !/deactivate/i.test(advice), advice.slice(0, 110));
  check('...and points at the endpoint', /transfer/.test(String(inPlace.body && inPlace.body.transfer_endpoint || '')),
    String(inPlace.body && inPlace.body.transfer_endpoint));

  // 3. Cash first. The fixture above opened a till to record a sale, and the
  //    transfer correctly refuses to move someone who still holds a drawer at
  //    their current branch — assert that guard here rather than working around
  //    it, since it is exactly the real-world sequence (settle up, then move).
  const openTill = listOf((await api('GET', `/api/till?branch_id=${lagos.id}`, { token: tO })).body)
    .find((t) => t.status === 'OPEN' && t.opened_by === mover.id);
  if (openTill) {
    const blocked = await transferAndApply(mover.id, { branch_id: minna.id, reason: 'move while holding cash' }, tO);
    check('a cashier holding an OPEN till cannot be moved', blocked.status === 409
      && blocked.body.code === 'OPEN_TILL_BLOCKS_TRANSFER', `status=${blocked.status}`);
    await api('POST', `/api/till/${openTill.id}/close`, {
      token: tO, body: { counted_closing_cash: 0, force_reason: 'settling the drawer before the transfer' },
    });
  } else { note('no open till on the mover — the open-till guard was not exercised'); }

  // 4. Perform the real move and confirm every promise it makes.
  const noReason = await api('POST', `/api/users/${mover.id}/transfer`, { token: tO, body: { branch_id: minna.id } });
  check('a transfer without a reason is refused', noReason.status === 400
    && noReason.body.code === 'TRANSFER_REASON_REQUIRED', `status=${noReason.status}`);

  const moved = await transferAndApply(mover.id, { branch_id: minna.id, reason: 'Reassigned to the Minna counter' }, tO);
  check('the move COMPLETES', moved.status === 200,
    `status=${moved.status} ${JSON.stringify(moved.body).slice(0, 90)}`);
  check('...keeping the SAME account id (one human, one record)',
    moved.body && moved.body.id === mover.id);
  check('...and the SAME username (no second identity to reconcile)',
    moved.body && moved.body.username === u1, String(moved.body && moved.body.username));
  check('...pinned to the NEW branch',
    moved.body && moved.body.branch_id === minna.id, `branch=${moved.body && moved.body.branch_id}`);

  // Their original login still works — the whole point of keeping one account.
  const stillIn = await login(u1, '4321');
  check('...and their existing login still works after the move', stillIn.status === 200,
    `status=${stillIn.status}`);
  const newTok = stillIn.token;
  const newScope = (await api('GET', '/api/dashboard/summary', { token: newTok })).body;
  check('...and they now see the new branch, not the old one',
    newScope.scope && newScope.scope.branch_id === minna.id,
    JSON.stringify(newScope.scope));
  const oldBranchStock = listOf((await api('GET', `/api/stock?branch_id=${lagos.id}`, { token: newTok })).body)
    .filter((s) => s.branch_id === lagos.id);
  check('...and can no longer see their OLD branch\'s stock', oldBranchStock.length === 0,
    `${oldBranchStock.length} old-branch rows still visible`);

  // The move must be accountable.
  const hist = await api('GET', `/api/users/${mover.id}/assignment-history`, { token: tO });
  check('the move is recorded in assignment history', hist.status === 200 && listOf(hist.body).length >= 1,
    `status=${hist.status} rows=${listOf(hist.body).length}`);
  check('...with the reason that was given',
    /Minna counter/i.test(JSON.stringify(hist.body || '')), JSON.stringify(hist.body || '').slice(0, 120));

  // The username is still held against NEW account creation — unchanged rule.
  const sameName = await api('POST', '/api/users', {
    token: tO, body: { full_name: 'Someone Else', username: u1, pin: '4321', role: 'STAFF', branch_id: minna.id },
  });
  check('the username still cannot be taken by a different person', sameName.status === 409,
    `status=${sameName.status}`);

  console.log('\n=== B. THE HISTORY MUST SURVIVE THE MOVE ===');
  // This is why the username is held. If history evaporated, the whole
  // deactivate-and-recreate model would be indefensible.
  if (hadHistory) {
    const theirSales = listOf((await api('GET', '/api/sales', { token: tO })).body)
      .filter((s) => s.served_by === mover.id);
    check('their sales at the old branch are still there', theirSales.length > 0, `${theirSales.length} sales`);
    check('...still attributed to them BY NAME',
      theirSales.every((s) => !!s.served_by_name), JSON.stringify(theirSales[0] || {}).slice(0, 100));
    check('...and still under the OLD branch, where the money actually was',
      theirSales.every((s) => s.branch_id === lagos.id), 'history must not migrate with the person');
  } else { note('no sale was recorded — history-survival not exercised'); }

  console.log('\n=== C. PROMOTING A CASHIER TO MANAGER ===');
  const u3 = `promo-${uniq()}`;
  const cashier = await api('POST', '/api/users', {
    token: tO, body: { full_name: 'Promotion Candidate', username: u3, pin: '4321', role: 'STAFF', branch_id: lagos.id },
  });
  check('a cashier exists to promote', cashier.status === 201, `status=${cashier.status}`);
  const promote = await api('PUT', `/api/users/${cashier.body.id}`, { token: tO, body: { role: 'MANAGER' } });
  check('promoting via the general edit route is REFUSED', promote.status === 400, `status=${promote.status}`);
  check('...with a machine-readable code', promote.body && promote.body.code === 'USE_TRANSFER_ENDPOINT',
    JSON.stringify(promote.body).slice(0, 90));
  const promoAdvice = String((promote.body && promote.body.error) || '');
  check('...naming the action that works', /transfer/i.test(promoAdvice), promoAdvice.slice(0, 120));

  // BUG 75 — the promotion is now a real action on the SAME account.
  const promoted = await transferAndApply(cashier.body.id, { role: 'MANAGER', branch_id: lagos.id, reason: 'Promoted to run the Lagos branch' }, tO);
  check('the promotion COMPLETES on the same account', promoted.status === 200,
    `status=${promoted.status} ${JSON.stringify(promoted.body).slice(0, 90)}`);
  check('...keeping their original username', promoted.body && promoted.body.username === u3,
    String(promoted.body && promoted.body.username));
  check('...and is labelled Branch Manager (pinned, derived from branch_id)',
    promoted.body && promoted.body.role_label === 'Branch Manager',
    String(promoted.body && promoted.body.role_label));
  const promoTok = (await login(u3, '4321')).token;
  const canManage = await api('GET', '/api/users', { token: promoTok });
  check('...and the new manager really has manager powers', canManage.status === 200, `status=${canManage.status}`);

  console.log('\n=== D. GENERAL vs BRANCH MANAGER IS ALSO A BRANCH CHANGE ===');
  // Freeing a Branch Manager to org-wide (or pinning a General Manager) is a
  // branch_id edit, so it hits the same rule. That must be consistent.
  const freeUp = await api('PUT', `/api/users/${promoted.body.id}`, { token: tO, body: { branch_id: null } });
  check('un-pinning a Branch Manager via the edit route is refused the same way',
    freeUp.status === 400 && freeUp.body.code === 'USE_TRANSFER_ENDPOINT',
    `status=${freeUp.status} ${JSON.stringify(freeUp.body).slice(0, 90)}`);

  // ...and the transfer endpoint performs it, which is the promotion the
  // client specifically asked to be audited: Branch Manager -> General Manager.
  const toGm = await transferAndApply(promoted.body.id, { role: 'MANAGER', branch_id: null, reason: 'Promoted to General Manager' }, tO);
  check('Branch Manager -> General Manager COMPLETES', toGm.status === 200,
    `status=${toGm.status} ${JSON.stringify(toGm.body).slice(0, 90)}`);
  check('...and the label follows branch_id, with no role migration',
    toGm.body && toGm.body.role_label === 'General Manager' && toGm.body.branch_id === null,
    `${toGm.body && toGm.body.role_label} / ${toGm.body && toGm.body.branch_id}`);
  const gmTok2 = (await login(u3, '4321')).token;
  const bothBranches = listOf((await api('GET', `/api/stock?branch_id=${minna.id}`, { token: gmTok2 })).body)
    .filter((r) => r.branch_id === minna.id);
  check('...and they can now see a branch they were never pinned to', bothBranches.length > 0,
    `${bothBranches.length} rows`);

  // ...and back down again, which must also work.
  const backDown = await transferAndApply(promoted.body.id, { role: 'MANAGER', branch_id: minna.id, reason: 'Assigned to run Minna' }, tO);
  check('General Manager -> Branch Manager COMPLETES too', backDown.status === 200
    && backDown.body.role_label === 'Branch Manager',
    `status=${backDown.status} ${String(backDown.body && backDown.body.role_label)}`);
  const demoted = await transferAndApply(promoted.body.id, { role: 'STAFF', branch_id: minna.id, reason: 'Stepped back to the counter' }, tO);
  check('...and a demotion back to Staff completes', demoted.status === 200
    && demoted.body.role_label === 'Staff',
    `status=${demoted.status} ${String(demoted.body && demoted.body.role_label)}`);
  const demTok = (await login(u3, '4321')).token;
  const nowRefused = await api('GET', '/api/users', { token: demTok });
  check('...and their manager powers are gone immediately', nowRefused.status === 403,
    `status=${nowRefused.status}`);

  console.log('\n=== E. A CLOSED BRANCH CANNOT SWALLOW NEW PEOPLE ===');
  const temp = await api('POST', '/api/branches', {
    token: tO, body: { name: `Lifecycle Temp ${uniq()}`, address: 'x', phone: '080' },
  });
  if (temp.status === 201) {
    await api('PUT', `/api/branches/${temp.body.id}`, { token: tO, body: { is_active: false } });
    const intoClosed = await api('POST', '/api/users', {
      token: tO, body: { full_name: 'Ghost Hire', username: `ghost-${uniq()}`, pin: '4321', role: 'STAFF', branch_id: temp.body.id },
    });
    check('a cashier cannot be hired into a DEACTIVATED branch', intoClosed.status === 403,
      `status=${intoClosed.status} ${JSON.stringify(intoClosed.body).slice(0, 90)}`);
    check('...with a branch-inactive code', intoClosed.body && intoClosed.body.code === 'BRANCH_INACTIVE',
      JSON.stringify(intoClosed.body).slice(0, 90));
  } else { note(`could not create a temp branch: ${temp.status}`); }

  console.log('\n=== F. STAFF SLOTS ARE RETURNED, NOT LEAKED ===');
  // If a departed employee kept consuming a paid seat, a pharmacy would hit
  // its plan limit purely through staff turnover.
  const before = (await api('GET', '/api/admin/settings', { token: tA })).body.usage.staff_used;
  const u4 = `slot-${uniq()}`;
  const temp2 = await api('POST', '/api/users', {
    token: tO, body: { full_name: 'Slot Test', username: u4, pin: '4321', role: 'STAFF', branch_id: lagos.id },
  });
  const during = (await api('GET', '/api/admin/settings', { token: tA })).body.usage.staff_used;
  check('hiring consumes a staff slot', during === before + 1, `${before} -> ${during}`);
  await api('DELETE', `/api/users/${temp2.body.id}`, { token: tO });
  const after = (await api('GET', '/api/admin/settings', { token: tA })).body.usage.staff_used;
  check('...and removing them RETURNS it (turnover does not exhaust the plan)',
    after === before, `${during} -> ${after}, expected ${before}`);

  console.log('\n=== G. THE BOOKS SURVIVED ALL OF THIS ===');
  const tb = listOf((await api('GET', '/api/gl/trial-balance', { token: tO })).body);
  const sum = tb.reduce((a, r) => { a.d += Number(r.total_debits || 0); a.c += Number(r.total_credits || 0); return a; }, { d: 0, c: 0 });
  check('debits still equal credits after every transition',
    Math.abs(Math.round((sum.d - sum.c) * 100) / 100) < 0.005,
    `debits=${sum.d.toFixed(2)} credits=${sum.c.toFixed(2)}`);

  // Tidy up the accounts this probe created.
  for (const id of [moved.body && moved.body.id, promoted.body && promoted.body.id]) {
    if (id) await api('DELETE', `/api/users/${id}`, { token: tO });
  }

  console.log('\n' + '='.repeat(62));
  console.log(`LIFECYCLE PROBE: ${pass} passed, ${fail} failed`);
  if (notes.length) { console.log('\nOBSERVATIONS:'); notes.forEach((n) => console.log('  - ' + n)); }
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
