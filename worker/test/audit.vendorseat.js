// ADMIN (VENDOR SUPPORT SEAT) — FULL-CIRCLE AUDIT
//
// The ADMIN role is PharmaRidge's OWN seat inside a client's deployment. It is
// the most commercially dangerous role in the product, because it is the only
// one whose holder is not the pharmacy: a support engineer, in someone else's
// books, with someone else's money on screen.
//
// Three things therefore have to be true at once, and they pull against each
// other:
//
//   1. SUPPORT MUST WORK. Every diagnostic and administrative action has to be
//      reachable, or support cannot do its job and the client is stuck.
//   2. THE VENDOR MUST NOT BECOME AN EMPLOYEE. ADMIN must never be able to
//      clock in, open a till, or record a sale — those are payroll, cash
//      custody and revenue records that cannot be explained to a client or to
//      a PCN inspector.
//   3. THE VENDOR MUST NOT OWN THE PHARMACY'S DECISIONS. Tax position and what
//      the owner permits their own managers to do belong to the client.
//
// Everything here is executed against a live server as a REAL ADMIN token.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const T = {};
async function login(username, pin) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(b)}`);
  return b;
}
async function api(method, path, { token, body, headers } = {}) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, body: j };
}

(async () => {
  const adminSess = await login('admin', '1234');
  const ownerSess = await login('owner', '1234');
  const mgrSess = await login('manager', '1234');
  const staffSess = await login('lagos.staff', '1234');
  T.admin = adminSess.token; T.owner = ownerSess.token;
  T.mgr = mgrSess.token; T.staff = staffSess.token;

  const branches = (await api('GET', '/api/branches', { token: T.admin })).body;
  const branch = branches.find((b) => b.is_active) || branches[0];

  console.log('\n=== A. THE SEAT IDENTIFIES ITSELF HONESTLY ===');
  check('ADMIN logs in', !!T.admin);
  check('role is ADMIN, not disguised as staff', adminSess.user.role === 'ADMIN', adminSess.user.role);
  check('the label names the VENDOR, so a client reading an audit trail knows who acted',
    adminSess.user.role_label === 'PharmaRidge Support', String(adminSess.user.role_label));
  check('the vendor seat is not pinned to a branch (org-wide by design)',
    !adminSess.user.branch_id, String(adminSess.user.branch_id));

  console.log('\n=== B. THE ADMIN PORTAL IS EXCLUSIVE TO ADMIN ===');
  for (const [who, tok] of [['OWNER', T.owner], ['MANAGER', T.mgr], ['STAFF', T.staff]]) {
    const g = await api('GET', '/api/admin/settings', { token: tok });
    check(`${who} cannot READ the Admin Portal`, g.status === 403, `status=${g.status}`);
    const p = await api('PUT', '/api/admin/settings', { token: tok, body: { max_branches: 99 } });
    check(`${who} cannot WRITE the Admin Portal`, p.status === 403, `status=${p.status}`);
  }
  const noTok = await api('GET', '/api/admin/settings', {});
  check('an unauthenticated caller cannot read it either', noTok.status === 401, `status=${noTok.status}`);

  console.log('\n=== C. SUPPORT CAN ACTUALLY DO ITS JOB (read the whole system) ===');
  // If any of these 403s, support is blind and the client is stuck.
  const reads = [
    ['/api/admin/settings', 'plan + subscription state'],
    ['/api/branches', 'branch list'],
    ['/api/users', 'user list'],
    ['/api/dashboard/summary', 'dashboard'],
    ['/api/dashboard/branches-breakdown', 'per-branch money'],
    ['/api/gl/trial-balance', 'trial balance'],
    ['/api/gl/profit-loss?start_date=2000-01-01&end_date=2999-12-31', 'P&L (dated)'],
    ['/api/gl/balance-sheet', 'balance sheet'],
    ['/api/gl/journal-entries', 'journal'],
    ['/api/sales', 'sales history'],
    ['/api/stock', 'stock'],
    ['/api/products', 'products'],
    ['/api/customers', 'customers'],
    ['/api/suppliers', 'suppliers'],
    ['/api/expenses', 'expenses'],
    ['/api/purchase-orders', 'purchase orders'],
    ['/api/transfers', 'transfers'],
    ['/api/stocktakes', 'stocktakes'],
    ['/api/attendance', 'attendance'],
    // NOTE: '/api/till' with NO trailing slash. Hono treats '/api/till/' as a
    // different, unregistered path and 404s it. My first run used
    // '/api/till/sessions' and read the 404 as a missing capability — it was
    // my wrong path, not a gap. The frontend already calls the correct form.
    ['/api/till', 'till history'],
    ['/api/sync/overview', 'sync health'],
    ['/api/sync/conflicts', 'sync conflicts'],
    ['/api/wht/entries', 'WHT register'],
    ['/api/settings/vat', 'VAT settings (read)'],
    ['/api/dashboard/plan', 'plan usage'],
    ['/api/health', 'health/config'],
  ];
  for (const [p, label] of reads) {
    const r = await api('GET', p, { token: T.admin });
    check(`support can read ${label}`, r.status === 200, `${p} -> ${r.status}`);
  }

  console.log('\n=== D. THE VENDOR MUST NOT BECOME AN EMPLOYEE ===');
  // Payroll, cash custody and revenue. A support engineer appearing in any of
  // these is a record the client cannot explain.
  const clockIn = await api('POST', '/api/attendance/clock-in', {
    token: T.admin, body: { branch_id: branch.id, device_id: 'probe' },
  });
  check('ADMIN cannot CLOCK IN (payroll record)', clockIn.status === 403,
    `status=${clockIn.status} ${JSON.stringify(clockIn.body).slice(0, 90)}`);
  check('...and the refusal explains why, not just "forbidden"',
    /not a member of this pharmacy/i.test(JSON.stringify(clockIn.body)),
    JSON.stringify(clockIn.body).slice(0, 120));
  check('...with a machine-readable code',
    clockIn.body && clockIn.body.code === 'VENDOR_SEAT_NOT_AN_EMPLOYEE', JSON.stringify(clockIn.body).slice(0, 90));

  const tillOpen = await api('POST', '/api/till/open', {
    token: T.admin, body: { branch_id: branch.id, opening_float: 1000 },
  });
  check('ADMIN cannot OPEN A TILL (cash custody)', tillOpen.status === 403, `status=${tillOpen.status}`);

  const stock = (await api('GET', `/api/stock?branch_id=${branch.id}`, { token: T.admin })).body;
  const batch = (Array.isArray(stock) ? stock : stock.results || []).find((s) => Number(s.quantity_remaining) > 2);
  const sale = await api('POST', '/api/sales', {
    token: T.admin,
    body: {
      branch_id: branch.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: Number(batch.selling_price_per_unit), cash_tendered: Number(batch.selling_price_per_unit) }],
    },
  });
  check('ADMIN cannot RECORD A SALE (revenue record)', sale.status === 403, `status=${sale.status}`);

  console.log('\n=== E. ...BUT SUPERVISORY SUPPORT ACTIONS STILL WORK ===');
  // The point of the seat. If these were blocked too, the guard would have
  // gone too far and support could not help.
  // An org-wide caller must name a branch — the route says so explicitly.
  const devices = await api('GET', `/api/attendance/devices?branch_id=${branch.id}`, { token: T.admin });
  check('support can read the device registry', devices.status === 200, `status=${devices.status}`);
  const voidAudit = await api('GET', '/api/dashboard/void-audit', { token: T.admin });
  check('support can read the void audit trail', voidAudit.status === 200, `status=${voidAudit.status}`);
  const unrec = await api('GET', '/api/dashboard/unreconciled-cash', { token: T.admin });
  check('support can read unreconciled cash', unrec.status === 200, `status=${unrec.status}`);

  console.log('\n=== F. THE VENDOR MUST NOT OWN THE PHARMACY\'S DECISIONS ===');
  // Tax position and manager permissions belong to the client. Critically,
  // a refusal must be LOUD: silently dropping the field and returning 200
  // would tell a support engineer they had changed a client's tax rate.
  for (const f of ['vat_enabled', 'vat_rate_percent', 'managers_can_void_sales',
    'managers_can_approve_expenses', 'managers_can_edit_prices']) {
    const r = await api('PUT', '/api/admin/settings', { token: T.admin, body: { [f]: 1 } });
    check(`Admin Portal refuses to set ${f}`, r.status === 400, `status=${r.status}`);
    check(`...naming it as client-owned`, r.body && r.body.code === 'CLIENT_OWNED_SETTING',
      JSON.stringify(r.body).slice(0, 110));
  }
  const typo = await api('PUT', '/api/admin/settings', { token: T.admin, body: { max_branchez: 4 } });
  check('a typo\'d field is refused, not silently ignored', typo.status === 400, `status=${typo.status}`);
  check('...and is reported as unknown rather than client-owned',
    typo.body && typo.body.code === 'UNKNOWN_SETTING', JSON.stringify(typo.body).slice(0, 110));
  const mixed = await api('PUT', '/api/admin/settings', { token: T.admin, body: { max_branches: 7, vat_rate_percent: 50 } });
  check('a MIX of valid and refused fields applies NEITHER (no half-save)', mixed.status === 400, `status=${mixed.status}`);
  const afterMixed = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  check('...verified: the valid half was not written', afterMixed.max_branches !== 7,
    `max_branches=${afterMixed.max_branches}`);

  console.log('\n=== G. THE SUBSCRIPTION LEVER ACTUALLY WORKS (the commercial one) ===');
  // This is how PharmaRidge gets paid. It must bite, and it must be
  // reversible, and it must never lock the client out of their own data.
  const before = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  const susp = await api('PUT', '/api/admin/settings', { token: T.admin, body: { subscription_status: 'SUSPENDED' } });
  check('support can SUSPEND a non-paying client', susp.status === 200, `status=${susp.status}`);

  const staffSale = await api('POST', '/api/sales', {
    token: T.staff,
    body: {
      branch_id: staffSess.user.branch_id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: Number(batch.selling_price_per_unit), cash_tendered: Number(batch.selling_price_per_unit) }],
    },
  });
  check('a SUSPENDED client cannot record new sales', staffSale.status === 403, `status=${staffSale.status}`);
  const stillRead = await api('GET', '/api/sales', { token: T.mgr });
  check('...but can still READ their own historical data (never hold data hostage)',
    stillRead.status === 200, `status=${stillRead.status}`);
  const stillLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'manager', pin: '1234' }),
  });
  const stillLoginBody = await stillLogin.json().catch(() => null);
  check('...and can still sign in (never lock the client out)', stillLogin.status === 200, `status=${stillLogin.status}`);
  // A successful second login now deliberately replaces the first device's
  // session. Continue this probe with the NEW token rather than treating the
  // one-session security boundary as a subscription regression.
  if (stillLoginBody && stillLoginBody.token) T.mgr = stillLoginBody.token;

  const reinstate = await api('PUT', '/api/admin/settings', {
    token: T.admin, body: { subscription_status: before.subscription_status || 'ACTIVE' },
  });
  check('support can REINSTATE the client', reinstate.status === 200, `status=${reinstate.status}`);
  const afterFix = await api('GET', '/api/dashboard/summary', { token: T.mgr });
  check('...and normal operation resumes', afterFix.status === 200, `status=${afterFix.status}`);

  console.log('\n=== H. THE VENDOR SEAT DOES NOT CONSUME A PAID STAFF SLOT ===');
  const plan = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  const users = (await api('GET', '/api/users', { token: T.admin })).body;
  const realStaff = users.filter((u) => ['STAFF', 'MANAGER', 'OWNER'].includes(u.role) && u.is_active);
  check('billing counts only pharmacy employees, not the support seat',
    plan.usage.staff_used === realStaff.length,
    `usage=${plan.usage.staff_used} realStaff=${realStaff.length} totalUsers=${users.length}`);

  console.log('\n=== I. PLAN LIMITS SET BY ADMIN ARE ENFORCED ON THE CLIENT ===');
  const cur = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  await api('PUT', '/api/admin/settings', { token: T.admin, body: { max_branches: 1 } });
  const extraBranch = await api('POST', '/api/branches', {
    token: T.owner, body: { name: 'Probe Overflow Branch', address: 'x', phone: '080' },
  });
  check('a branch beyond the ADMIN-set limit is refused', extraBranch.status === 403 || extraBranch.status === 400,
    `status=${extraBranch.status} ${JSON.stringify(extraBranch.body).slice(0, 90)}`);
  await api('PUT', '/api/admin/settings', { token: T.admin, body: { max_branches: cur.max_branches } });
  check('...and raising the limit again restores the capability',
    (await api('GET', '/api/admin/settings', { token: T.admin })).body.max_branches === cur.max_branches);

  console.log('\n=== J. FEATURE TOGGLES SET BY ADMIN REACH THE CLIENT ===');
  const s0 = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  await api('PUT', '/api/admin/settings', { token: T.admin, body: { attendance_module_enabled: false } });
  const attOff = await api('POST', '/api/attendance/clock-in', {
    token: T.staff, body: { branch_id: staffSess.user.branch_id, device_id: 'probe' },
  });
  check('disabling the attendance module actually blocks clock-in',
    attOff.status === 403 || attOff.status === 404,
    `status=${attOff.status} ${JSON.stringify(attOff.body).slice(0, 90)}`);
  await api('PUT', '/api/admin/settings', {
    token: T.admin, body: { attendance_module_enabled: !!s0.attendance_module_enabled },
  });
  check('...and re-enabling it restores the module',
    !!(await api('GET', '/api/admin/settings', { token: T.admin })).body.attendance_module_enabled === !!s0.attendance_module_enabled);

  console.log('\n=== K. WHITE-LABEL BRANDING IS VALIDATED, NOT TRUSTED ===');
  const badLogo = await api('PUT', '/api/admin/settings', {
    token: T.admin, body: { logo_data_url: 'javascript:alert(1)' },
  });
  check('a non-image logo payload is refused', badLogo.status === 400, `status=${badLogo.status}`);
  const svgLogo = await api('PUT', '/api/admin/settings', {
    token: T.admin, body: { logo_data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64') },
  });
  check('an SVG logo (script-capable) is refused', svgLogo.status === 400, `status=${svgLogo.status}`);
  const blankName = await api('PUT', '/api/admin/settings', { token: T.admin, body: { business_name: '   ' } });
  check('a blank business name is refused (pass null to clear)', blankName.status === 400, `status=${blankName.status}`);
  const longName = await api('PUT', '/api/admin/settings', { token: T.admin, body: { business_name: 'x'.repeat(200) } });
  check('an over-long business name is refused', longName.status === 400, `status=${longName.status}`);

  console.log('\n=== L. ADMIN ACTIONS ARE ATTRIBUTABLE ===');
  const attrib = (await api('GET', '/api/admin/settings', { token: T.admin })).body;
  check('settings record WHO last changed them', !!attrib.updated_by, String(attrib.updated_by));
  check('...and it is the admin account that just acted',
    attrib.updated_by === adminSess.user.id, `${attrib.updated_by} vs ${adminSess.user.id}`);
  check('...and WHEN', !!attrib.updated_at, String(attrib.updated_at));

  console.log('\n=== M. ADMIN CANNOT BE LOCKED OUT OF ITS OWN PORTAL BY A CLIENT ===');
  // An owner who could deactivate or demote the vendor seat could lock support
  // out of a deployment they are contractually responsible for.
  const adminRow = users.find((u) => u.role === 'ADMIN');
  check('the ADMIN row is visible to ADMIN itself', !!adminRow, 'support must be able to see its own seat');

  // The client must not even be able to SEE the vendor seat, let alone edit it.
  const ownerUsers = (await api('GET', '/api/users', { token: T.owner })).body;
  check('the vendor seat is hidden from the client\'s user list',
    !ownerUsers.some((u) => u.role === 'ADMIN'),
    `owner sees roles: ${[...new Set(ownerUsers.map((u) => u.role))].join(',')}`);
  check('...and ADMIN itself still sees it (support is not hidden from support)',
    users.some((u) => u.role === 'ADMIN'));

  if (adminRow) {
    // MY FIRST ASSERTION HERE WAS WRONG. I expected 403. The API returns 404
    // "User not found", and that is the BETTER answer: a 403 would confirm to
    // a curious owner that the account exists and is merely protected.
    // Returning 404 keeps the vendor seat invisible rather than merely locked,
    // which is the same reasoning that hides it from the list query.
    const demote = await api('PUT', `/api/users/${adminRow.id}`, {
      token: T.owner, body: { full_name: 'Hijacked' },
    });
    check('an OWNER cannot edit the vendor support account', demote.status === 404,
      `status=${demote.status} — 404 (not 403) is deliberate: it does not confirm the account exists`);
    const del = await api('DELETE', `/api/users/${adminRow.id}`, { token: T.owner });
    check('...nor delete it', del.status === 404, `status=${del.status}`);
    const reset = await api('POST', `/api/users/${adminRow.id}/reset-pin`, {
      token: T.owner, body: { new_pin: '9999' },
    });
    check('...nor reset its PIN (which would be a full takeover)',
      reset.status === 404 || reset.status === 403, `status=${reset.status}`);
    const stillWorks = await api('GET', '/api/admin/settings', { token: T.admin });
    check('...and support access still works afterwards', stillWorks.status === 200, `status=${stillWorks.status}`);
  }

  console.log('\n=== N. NOBODY CAN MINT A NEW ADMIN THROUGH USER MANAGEMENT ===');
  // If an OWNER could create an ADMIN, they could grant themselves the vendor
  // portal — including the subscription lever that decides whether they pay.
  for (const [who, tok] of [['OWNER', T.owner], ['MANAGER', T.mgr], ['ADMIN', T.admin]]) {
    const mk = await api('POST', '/api/users', {
      token: tok,
      body: { full_name: 'Probe Admin', username: `probe-admin-${Date.now()}-${who}`, pin: '4321', role: 'ADMIN' },
    });
    check(`${who} cannot create an ADMIN account through user management`,
      mk.status >= 400, `status=${mk.status} ${JSON.stringify(mk.body).slice(0, 90)}`);
  }
  // ...nor promote an existing user into one.
  const victim = users.find((u) => u.role === 'STAFF');
  if (victim) {
    const promote = await api('PUT', `/api/users/${victim.id}`, { token: T.owner, body: { role: 'ADMIN' } });
    check('an OWNER cannot promote a staff member to ADMIN', promote.status >= 400,
      `status=${promote.status} ${JSON.stringify(promote.body).slice(0, 90)}`);
  }

  console.log('\n' + '='.repeat(62));
  console.log(`ADMIN PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
