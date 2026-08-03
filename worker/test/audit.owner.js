// OWNER (PHARMACY PROPRIETOR) — FULL-CIRCLE AUDIT.
//
// The OWNER is the person who actually pays for this product. Everything they
// need has to work, and the things that protect them from their own staff — and
// from their own mistakes — have to hold.
//
// Four questions, in order of what a client would care about:
//
//   1. CAN THE OWNER SEE EVERYTHING THEY OWN? Money across every branch, the
//      books, the debts, who worked when. An owner who cannot see a branch's
//      cash has no reason to trust the product.
//   2. CAN THE OWNER CONTROL THEIR OWN BUSINESS? Manager/cashier permissions,
//      tax position, prices, staff. These are the levers they bought.
//   3. CAN THE OWNER BE LOCKED OUT OF THEIR OWN BUSINESS? By a manager, by a
//      mistake, or by the last-admin problem. This is unrecoverable damage.
//   4. IS THE OWNER PROTECTED FROM THEIR OWN STAFF? A manager must not be able
//      to promote themselves, take the owner's account, or quietly widen their
//      own powers.
//
// Everything is executed against a live server with real tokens.
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
async function api(method, path, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
}

(async () => {
  const O = await login('owner', '1234');
  const M = await login('manager', '1234');
  const LM = await login('lagos.mgr', '1234');
  const S = await login('lagos.staff', '1234');
  const A = await login('admin', '1234');
  const tO = O.token, tM = M.token, tLM = LM.token, tS = S.token, tA = A.token;

  const branches = (await api('GET', '/api/branches', { token: tO })).body;
  const branch = branches.find((b) => b.is_active);

  console.log('\n=== A. THE OWNER SEES EVERYTHING THEY OWN ===');
  check('OWNER signs in', O.status === 200 && !!tO, `status=${O.status}`);
  check('the role reads "Owner", not a raw enum', O.user.role_label === 'Owner', String(O.user.role_label));
  check('the owner is org-wide, never pinned to one branch', !O.user.branch_id, String(O.user.branch_id));

  // An owner who cannot see a branch's money has no reason to trust this.
  const orgWide = (await api('GET', '/api/dashboard/summary', { token: tO })).body;
  check('the dashboard defaults to the ORGANISATION total', orgWide.scope && orgWide.scope.all_branches === true,
    JSON.stringify(orgWide.scope));
  let drillOk = true;
  for (const b of branches) {
    const r = await api('GET', `/api/dashboard/summary?branch_id=${b.id}`, { token: tO });
    if (r.status !== 200) { drillOk = false; note(`drill-down into ${b.name} -> ${r.status}`); }
  }
  check('the owner can drill into EVERY branch they own', drillOk, `${branches.length} branches`);

  const ownerReads = [
    ['/api/gl/trial-balance', 'trial balance'],
    ['/api/gl/balance-sheet', 'balance sheet'],
    ['/api/gl/profit-loss?start_date=2000-01-01&end_date=2999-12-31', 'profit & loss'],
    ['/api/gl/journal-entries', 'journal entries'],
    ['/api/gl/chart-of-accounts', 'chart of accounts'],
    ['/api/dashboard/branches-breakdown', 'per-branch money'],
    ['/api/dashboard/void-audit', 'void audit (who reversed what)'],
    ['/api/dashboard/unreconciled-cash', 'cash with no till session'],
    ['/api/dashboard/license-expiry-alerts', 'licence renewals'],
    ['/api/dashboard/plan', 'plan usage'],
    ['/api/customers', 'debtors'],
    ['/api/suppliers', 'creditors'],
    ['/api/expenses', 'expenses'],
    ['/api/wht/entries', 'withholding tax register'],
    ['/api/sales', 'sales history'],
    ['/api/stock', 'stock'],
    ['/api/attendance', 'attendance'],
    ['/api/till', 'till sessions'],
    ['/api/sync/overview', 'sync health'],
    ['/api/users', 'staff list'],
  ];
  for (const [p, label] of ownerReads) {
    const r = await api('GET', p, { token: tO });
    check(`owner can read ${label}`, r.status === 200, `${p} -> ${r.status}`);
  }

  console.log('\n=== B. THE OWNER CONTROLS THEIR OWN BUSINESS ===');
  // These are the levers the owner is actually paying for.
  const perms0 = (await api('GET', '/api/settings/manager-permissions', { token: tO })).body;
  const flip = await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { managers_can_void_sales: !perms0.managers_can_void_sales },
  });
  check('owner can change what MANAGERS may do', flip.status === 200, `status=${flip.status}`);
  const permsAfter = (await api('GET', '/api/settings/manager-permissions', { token: tO })).body;
  check('...and the change actually persists',
    permsAfter.managers_can_void_sales === !perms0.managers_can_void_sales,
    `${perms0.managers_can_void_sales} -> ${permsAfter.managers_can_void_sales}`);

  // THE POINT of that lever: it must actually bite on a real manager.
  //
  // The first run of this probe skipped this check because the seeded database
  // has no completed sale — which would have quietly left the single most
  // important owner control untested. Make one instead of hoping for one.
  async function ensureCompletedSale() {
    const existing = (await api('GET', '/api/sales', { token: tO })).body;
    const el = Array.isArray(existing) ? existing : (existing.results || []);
    const found = el.find((x) => x.status === 'COMPLETED');
    if (found) return found;
    const stk = (await api('GET', `/api/stock?branch_id=${S.user.branch_id}`, { token: tO })).body;
    // Skip prescription-only / controlled lines: the app CORRECTLY refuses to
    // sell those without prescriber details (422 "is prescription-only (POM)"),
    // which is a safety control working, not a defect. My first attempt picked
    // one and read the refusal as a blocker.
    //
    // `is_controlled` lives on the PRODUCT, not on the stock row, so the stock
    // payload alone cannot answer this — cross-reference the two.
    const stkList = (Array.isArray(stk) ? stk : stk.results || []);
    const prods = (await api('GET', '/api/products', { token: tO })).body;
    const prodList = Array.isArray(prods) ? prods : (prods.results || []);
    const safeIds = new Set(prodList.filter((p2) => !p2.is_controlled).map((p2) => p2.id));
    const b = stkList.find((x) => Number(x.quantity_remaining) > 2 && safeIds.has(x.product_id));
    if (!b) return null;
    await api('POST', '/api/till/open', { token: tS, body: { branch_id: S.user.branch_id, opening_float: 1000 } });
    const unit = Number(b.selling_price_per_unit);
    const mk = await api('POST', '/api/sales', {
      token: tS,
      body: {
        branch_id: S.user.branch_id,
        items: [{ product_id: b.product_id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
      },
    });
    if (mk.status !== 201) { note(`could not create a sale for the void-lever test: ${mk.status} ${JSON.stringify(mk.body).slice(0, 80)}`); return null; }
    return mk.body && (mk.body.sale || mk.body);
  }

  if (permsAfter.managers_can_void_sales === false) {
    const done = await ensureCompletedSale();
    if (done && done.id) {
      const mgrVoid = await api('POST', `/api/sales/${done.id}/void`, { token: tM, body: { reason: 'owner-probe' } });
      check('...and a manager is REFUSED the power the owner withdrew',
        mgrVoid.status === 403, `status=${mgrVoid.status} ${JSON.stringify(mgrVoid.body).slice(0, 80)}`);

      // ...and restoring the permission must restore the capability, or the
      // lever is a one-way switch that quietly breaks the manager's job.
      await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { managers_can_void_sales: true } });
      const mgrVoid2 = await api('POST', `/api/sales/${done.id}/void`, { token: tM, body: { reason: 'owner-probe restored' } });
      check('...and re-granting it restores the manager\'s ability to void',
        mgrVoid2.status === 200, `status=${mgrVoid2.status} ${JSON.stringify(mgrVoid2.body).slice(0, 80)}`);
    } else { note('no sale could be created for the void-lever test'); }
  }
  await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { managers_can_void_sales: !!perms0.managers_can_void_sales },
  });

  const vat0 = (await api('GET', '/api/settings/vat', { token: tO })).body;
  const vatSet = await api('PUT', '/api/settings/vat', { token: tO, body: { vat_enabled: true, vat_rate_percent: 7.5 } });
  check('owner controls their own VAT position', vatSet.status === 200, `status=${vatSet.status}`);
  await api('PUT', '/api/settings/vat', { token: tO, body: { vat_enabled: !!vat0.vat_enabled, vat_rate_percent: vat0.vat_rate_percent } });

  const rates = (await api('GET', '/api/wht/rates', { token: tO })).body;
  if (Array.isArray(rates) && rates.length) {
    const r0 = rates[0];
    const setRate = await api('PUT', `/api/wht/rates/${encodeURIComponent(r0.code)}`, {
      token: tO, body: { rate_percent: Number(r0.rate_percent) },
    });
    check('owner controls their own withholding-tax rates', setRate.status === 200, `status=${setRate.status}`);
  }

  const mkStaff = await api('POST', '/api/users', {
    token: tO,
    body: { full_name: 'Owner Probe Cashier', username: `owner-probe-${Date.now()}`, pin: '4321', role: 'STAFF', branch_id: branch.id },
  });
  check('owner can hire staff', mkStaff.status === 201, `status=${mkStaff.status} ${JSON.stringify(mkStaff.body).slice(0, 80)}`);
  const hired = mkStaff.body;
  if (hired && hired.id) {
    const deact = await api('PUT', `/api/users/${hired.id}`, { token: tO, body: { is_active: false } });
    check('...and dismiss them', deact.status === 200, `status=${deact.status}`);
    const gone = await login(hired.username, '4321');
    check('...and the dismissal takes effect immediately', gone.status === 401, `login status=${gone.status}`);
  }

  const mkMgr = await api('POST', '/api/users', {
    token: tO,
    body: { full_name: 'Owner Probe Manager', username: `owner-probe-mgr-${Date.now()}`, pin: '4321', role: 'MANAGER' },
  });
  check('owner can appoint a manager', mkMgr.status === 201, `status=${mkMgr.status}`);
  const newMgr = mkMgr.body;

  console.log('\n=== C. THE OWNER CANNOT BE LOCKED OUT OF THEIR OWN BUSINESS ===');
  // This is unrecoverable damage, so it is the most important section here.
  const users = (await api('GET', '/api/users', { token: tO })).body;
  const owners = users.filter((u) => u.role === 'OWNER' && u.is_active);
  note(`active OWNER accounts in this deployment: ${owners.length}`);

  // 1. A manager must never be able to remove the owner.
  const ownerRow = users.find((u) => u.role === 'OWNER');
  const mgrKill = await api('DELETE', `/api/users/${ownerRow.id}`, { token: tM });
  check('a MANAGER cannot delete the owner', mgrKill.status === 403, `status=${mgrKill.status}`);
  const mgrDeact = await api('PUT', `/api/users/${ownerRow.id}`, { token: tM, body: { is_active: false } });
  check('a MANAGER cannot deactivate the owner', mgrDeact.status === 403, `status=${mgrDeact.status}`);
  const mgrReset = await api('POST', `/api/users/${ownerRow.id}/reset-pin`, { token: tM, body: { new_pin: '9999' } });
  check('a MANAGER cannot reset the owner\'s PIN (account takeover)',
    mgrReset.status === 403 || mgrReset.status === 404, `status=${mgrReset.status}`);

  // 2. THE LAST-OWNER PROBLEM. The lockout guard counts MANAGER and OWNER
  //    TOGETHER. With a manager present the count is >1, so the guard does not
  //    fire — which means the only OWNER could be removed while managers
  //    remain. A manager cannot then restore owner-only settings (VAT, manager
  //    permissions, WHT rates): those are ownerOnly. The business would be
  //    permanently unable to change its own tax position.
  if (owners.length === 1) {
    const selfDeact = await api('PUT', `/api/users/${ownerRow.id}`, { token: tO, body: { is_active: false } });
    if (selfDeact.status === 200) {
      // Reproduced: restore immediately, then report.
      await api('PUT', `/api/users/${ownerRow.id}`, { token: tA, body: { is_active: true } });
      check('the LAST owner cannot deactivate themselves', false,
        'the lockout guard counts MANAGER+OWNER together, so a surviving manager '
        + 'lets the only OWNER be removed — and no manager can restore VAT / manager '
        + 'permissions / WHT rates, which are ownerOnly');
    } else {
      check('the LAST owner cannot deactivate themselves', true, `status=${selfDeact.status}`);
    }

    const selfDelete = await api('DELETE', `/api/users/${ownerRow.id}`, { token: tO });
    if (selfDelete.status === 204) {
      await api('PUT', `/api/users/${ownerRow.id}`, { token: tA, body: { is_active: true } });
      note('LAST OWNER WAS DELETABLE — restored via the support seat');
      check('the LAST owner cannot delete themselves', false,
        'same guard gap as above, but permanent: is_deleted = 1');
    } else {
      check('the LAST owner cannot delete themselves', true, `status=${selfDelete.status}`);
    }
  } else {
    note('more than one OWNER present — last-owner guard not exercised on this dataset');
  }

  // 3. Owner-only settings must remain reachable after any staffing change.
  const stillOwns = await api('PUT', '/api/settings/vat', {
    token: tO, body: { vat_enabled: !!vat0.vat_enabled, vat_rate_percent: vat0.vat_rate_percent },
  });
  check('owner-only settings are still reachable by the owner', stillOwns.status === 200, `status=${stillOwns.status}`);

  console.log('\n=== D. THE OWNER IS PROTECTED FROM THEIR OWN STAFF ===');
  const selfPromote = await api('PUT', `/api/users/${M.user.id}`, { token: tM, body: { role: 'OWNER' } });
  check('a MANAGER cannot promote themselves to OWNER', selfPromote.status >= 400,
    `status=${selfPromote.status} ${JSON.stringify(selfPromote.body).slice(0, 80)}`);
  const mkOwner = await api('POST', '/api/users', {
    token: tM, body: { full_name: 'Sneaky', username: `sneak-${Date.now()}`, pin: '4321', role: 'OWNER' },
  });
  check('a MANAGER cannot create a second OWNER account', mkOwner.status >= 400, `status=${mkOwner.status}`);
  const branchMgrOwner = await api('POST', '/api/users', {
    token: tLM, body: { full_name: 'Sneaky2', username: `sneak2-${Date.now()}`, pin: '4321', role: 'OWNER' },
  });
  check('a BRANCH manager cannot create an OWNER either', branchMgrOwner.status >= 400, `status=${branchMgrOwner.status}`);

  // A manager must not be able to widen their OWN powers.
  const mgrWidens = await api('PUT', '/api/settings/manager-permissions', {
    token: tM, body: { managers_can_void_sales: true },
  });
  check('a MANAGER cannot change what managers are allowed to do', mgrWidens.status === 403, `status=${mgrWidens.status}`);
  const mgrVat = await api('PUT', '/api/settings/vat', { token: tM, body: { vat_enabled: true, vat_rate_percent: 99 } });
  check('a MANAGER cannot change the pharmacy\'s tax position', mgrVat.status === 403, `status=${mgrVat.status}`);
  const staffPerms = await api('PUT', '/api/settings/manager-permissions', {
    token: tS, body: { staff_can_void_sales: true },
  });
  check('a CASHIER cannot widen their own powers', staffPerms.status === 403, `status=${staffPerms.status}`);

  console.log('\n=== E. THE OWNER CANNOT SILENTLY BREAK THEIR OWN BOOKS ===');
  // The owner is powerful, but the accounting invariants protect them from
  // themselves as much as from staff.
  const sales2 = (await api('GET', '/api/sales', { token: tO })).body;
  const l2 = Array.isArray(sales2) ? sales2 : (sales2.results || []);
  const anySale = l2[0];
  if (anySale) {
    const edit = await api('PUT', `/api/sales/${anySale.id}`, { token: tO, body: { total_amount: 1 } });
    check('even the OWNER cannot edit a recorded sale', edit.status >= 400, `status=${edit.status}`);
    const del = await api('DELETE', `/api/sales/${anySale.id}`, { token: tO });
    check('even the OWNER cannot delete a recorded sale', del.status >= 400, `status=${del.status}`);
  }
  const badVat = await api('PUT', '/api/settings/vat', { token: tO, body: { vat_enabled: true, vat_rate_percent: 900 } });
  check('a nonsense VAT rate is refused even from the owner', badVat.status === 400, `status=${badVat.status}`);
  const negWindow = await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { staff_void_window_minutes: -5 },
  });
  check('a negative void window is refused (it would disable the check)', negWindow.status === 400, `status=${negWindow.status}`);
  const hugeCap = await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { staff_adjustment_max_units: 999999 },
  });
  check('an unbounded staff write-off cap is refused', hugeCap.status === 400, `status=${hugeCap.status}`);

  const tb = (await api('GET', '/api/gl/trial-balance', { token: tO })).body;
  const sum = (Array.isArray(tb) ? tb : []).reduce((a, r) => {
    a.d += Number(r.total_debits || 0); a.c += Number(r.total_credits || 0); return a;
  }, { d: 0, c: 0 });
  check('the books are balanced after everything this probe did',
    Math.abs(Math.round((sum.d - sum.c) * 100) / 100) < 0.005,
    `debits=${sum.d.toFixed(2)} credits=${sum.c.toFixed(2)}`);

  console.log('\n=== E2. THE OWNER\'S OWN ACTIONS ARE ATTRIBUTED TO THEM ===');
  {
    // An owner who serves at the counter is a real employee (unlike the vendor
    // seat), so selling is legitimate — but it must be recorded against them
    // by name, or the void-rate and cash-accountability reports are fiction.
    const sl = (await api('GET', '/api/sales', { token: tO })).body;
    const rows = Array.isArray(sl) ? sl : (sl.results || []);
    const mine = rows.find((r) => r.served_by === O.user.id);
    if (mine) {
      // NOTE the field is `served_by` / `served_by_name`, not `sold_by` — I
      // guessed the latter first and read the resulting `None` as a missing
      // attribution. It was my wrong field name, not a gap.
      check('a sale served by the owner records WHO served it', !!mine.served_by, String(mine.served_by));
      check('...by name, not just an opaque id', !!mine.served_by_name, String(mine.served_by_name));
    } else {
      note('owner has served no sale in this dataset — attribution not exercised');
    }
    const va = (await api('GET', '/api/dashboard/void-audit', { token: tO })).body;
    check('the void-rate report names each person, including the owner',
      Array.isArray(va) && va.every((r) => !!r.user_full_name),
      JSON.stringify(va).slice(0, 120));
  }

  console.log('\n=== F. THE OWNER IS NOT THE VENDOR ===');
  const portal = await api('GET', '/api/admin/settings', { token: tO });
  check('the owner cannot open the vendor Admin Portal', portal.status === 403, `status=${portal.status}`);
  const selfUpgrade = await api('PUT', '/api/admin/settings', { token: tO, body: { max_branches: 999 } });
  check('...and cannot raise their own plan limits', selfUpgrade.status === 403, `status=${selfUpgrade.status}`);
  const selfUnsuspend = await api('PUT', '/api/admin/settings', { token: tO, body: { subscription_status: 'ACTIVE' } });
  check('...and cannot set their own subscription status', selfUnsuspend.status === 403, `status=${selfUnsuspend.status}`);

  // Cleanup: remove the manager this probe appointed.
  if (newMgr && newMgr.id) await api('DELETE', `/api/users/${newMgr.id}`, { token: tO });

  console.log('\n' + '='.repeat(62));
  console.log(`OWNER PROBE: ${pass} passed, ${fail} failed`);
  if (notes.length) { console.log('\nOBSERVATIONS:'); notes.forEach((n) => console.log('  - ' + n)); }
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
