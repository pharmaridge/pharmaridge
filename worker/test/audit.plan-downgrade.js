// PLAN DOWNGRADE AUDIT — proves a 3-branch/4-staff client cannot be placed on
// a 2-branch/2-staff plan until the Owner reduces active usage, and verifies
// creation/reactivation cannot bypass the lower limits afterward.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: r.status, body: json };
}
async function login(username) { const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } }); if (r.status !== 200) throw new Error(`login ${username} failed`); return r.body; }

(async () => {
  console.log('=== PLAN DOWNGRADE / ACTIVE-CAPACITY AUDIT ===');
  const admin = await login('admin');
  const owner = await login('owner');
  const original = (await api('GET', '/api/admin/settings', { token: admin.token })).body;
  const usersBefore = list((await api('GET', '/api/users', { token: admin.token })).body);
  const decommissionFirst = usersBefore.find((u) => u.username === 'minna.staff' && u.is_active);
  const offOne = await api('PUT', `/api/users/${decommissionFirst.id}`, { token: owner.token, body: { is_active: false } });
  check('Owner can first reduce active staff usage from five to four', offOne.status === 200 && !offOne.body.is_active, `status=${offOne.status}`);
  const third = await api('POST', '/api/branches', { token: owner.token, body: { name: 'Downgrade Test Third Branch', address: 'Capacity test', phone: '08030000000' } });
  check('Owner can create a third active branch before downgrade', third.status === 201, `status=${third.status} ${JSON.stringify(third.body)}`);
  const atThreeAndFour = (await api('GET', '/api/admin/settings', { token: admin.token })).body;
  check('fixture is exactly three active branches and four active staff', atThreeAndFour.usage.branches_used === 3 && atThreeAndFour.usage.staff_used === 4, JSON.stringify(atThreeAndFour.usage));

  const rejected = await api('PUT', '/api/admin/settings', { token: admin.token, body: { max_branches: 2, max_staff: 2, subscription_plan: 'Too-small plan' } });
  check('Admin cannot lower 3 branches / 4 staff directly to 2 / 2', rejected.status === 409 && rejected.body.code === 'PLAN_DOWNGRADE_REQUIRES_REDUCTION', JSON.stringify(rejected.body));
  check('downgrade refusal says exactly what must be reduced', /close or deactivate at least 1 active branch/i.test(rejected.body.error || '') && /deactivate at least 2 active/i.test(rejected.body.error || ''), rejected.body.error);
  const unchanged = (await api('GET', '/api/admin/settings', { token: admin.token })).body;
  check('a refused downgrade saves no partial plan field', unchanged.max_branches === original.max_branches && unchanged.max_staff === original.max_staff && unchanged.subscription_plan === original.subscription_plan, JSON.stringify(unchanged));

  const multiBranchOff = await api('PUT', '/api/admin/settings', { token: admin.token, body: { multi_branch_enabled: false } });
  check('disabling multi-branch is also refused while three branches remain active', multiBranchOff.status === 409 && multiBranchOff.body.code === 'PLAN_DOWNGRADE_REQUIRES_REDUCTION', JSON.stringify(multiBranchOff.body));

  const closeThird = await api('PUT', `/api/branches/${third.body.id}`, { token: owner.token, body: { is_active: false } });
  check('Owner closes the surplus third branch', closeThird.status === 200 && !closeThird.body.is_active, `status=${closeThird.status}`);
  let activeUsers = list((await api('GET', '/api/users', { token: admin.token })).body).filter((u) => u.is_active && u.role !== 'OWNER' && u.role !== 'ADMIN');
  const reduceStaff = activeUsers.slice(0, 2);
  const offStaff = await Promise.all(reduceStaff.map((u) => api('PUT', `/api/users/${u.id}`, { token: owner.token, body: { is_active: false } })));
  check('Owner deactivates two operational accounts to reach two active staff', offStaff.every((r) => r.status === 200 && !r.body.is_active), offStaff.map((r) => r.status).join(','));
  const reduced = (await api('GET', '/api/admin/settings', { token: admin.token })).body;
  check('active usage is now exactly within a 2-branch / 2-staff plan', reduced.usage.branches_used === 2 && reduced.usage.staff_used === 2, JSON.stringify(reduced.usage));

  const accepted = await api('PUT', '/api/admin/settings', { token: admin.token, body: { max_branches: 2, max_staff: 2, subscription_plan: '2 branches / 2 staff' } });
  check('Admin can save the lower plan after Owner reduces active usage', accepted.status === 200 && accepted.body.max_branches === 2 && accepted.body.max_staff === 2, JSON.stringify(accepted.body));
  const blockedNewBranch = await api('POST', '/api/branches', { token: owner.token, body: { name: 'Over Limit Branch', address: 'No', phone: '08030000001' } });
  check('lower branch limit blocks a new branch', blockedNewBranch.status === 403 && blockedNewBranch.body.code === 'PLAN_LIMIT_EXCEEDED', JSON.stringify(blockedNewBranch.body));
  const blockedReopen = await api('PUT', `/api/branches/${third.body.id}`, { token: owner.token, body: { is_active: true } });
  check('lower branch limit also blocks reactivating the closed branch', blockedReopen.status === 403 && blockedReopen.body.code === 'PLAN_LIMIT_EXCEEDED', JSON.stringify(blockedReopen.body));
  const blockedNewStaff = await api('POST', '/api/users', { token: owner.token, body: { full_name: 'Over Limit Staff', username: `over-limit-${Date.now()}`, pin: '1234', role: 'STAFF', branch_id: list((await api('GET', '/api/branches', { token: owner.token })).body).find((b) => b.is_active).id } });
  check('lower staff limit blocks a new staff account', blockedNewStaff.status === 403 && blockedNewStaff.body.code === 'PLAN_LIMIT_EXCEEDED', JSON.stringify(blockedNewStaff.body));
  const blockedReactivate = await api('PUT', `/api/users/${decommissionFirst.id}`, { token: owner.token, body: { is_active: true } });
  check('lower staff limit also blocks reactivating a former staff account', blockedReactivate.status === 403 && blockedReactivate.body.code === 'PLAN_LIMIT_EXCEEDED', JSON.stringify(blockedReactivate.body));
  const finalSettings = (await api('GET', '/api/admin/settings', { token: admin.token })).body;
  check('final plan and usage agree with no over-cap active records', finalSettings.max_branches === 2 && finalSettings.max_staff === 2 && finalSettings.usage.branches_used === 2 && finalSettings.usage.staff_used === 2, JSON.stringify(finalSettings));

  console.log(`\nPLAN DOWNGRADE AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => { console.error('CRASH', err); process.exit(2); });
