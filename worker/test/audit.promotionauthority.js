// PROMOTION AUTHORITY MATRIX — General Manager vs Branch Manager.
//
// This locks the intended hierarchy from the real REST route through to the
// staged-transfer confirmation path:
//   Admin / Owner       may assign any pharmacy role (not ADMIN itself)
//   General Manager     may promote another employee to General Manager
//   Branch Manager      may promote inside their own branch only; never to an
//                       organisation-wide General Manager
//   Staff               have no user-management route
//   Nobody              may change their own role or create/assign ADMIN
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const unique = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;

async function login(username, pin = '1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, pin }) });
  const body = await r.json();
  return { status: r.status, ...body };
}
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, body: json };
}
async function transferAndForce(userId, token, body) {
  const staged = await api('POST', `/api/users/${userId}/transfer`, token, body);
  if (staged.status !== 200 || !staged.body || !staged.body.pending_transfer) return staged;
  return api('POST', `/api/users/transfers/pending/${staged.body.pending_transfer.id}/force`, token, {});
}

(async () => {
  const gm = await login('manager');
  const bm = await login('lagos.mgr');
  const owner = await login('owner');
  check('General Manager signs in', gm.status === 200 && gm.user.role_label === 'General Manager', `status=${gm.status}`);
  check('Branch Manager signs in', bm.status === 200 && bm.user.role_label === 'Branch Manager', `status=${bm.status}`);
  check('Owner signs in', owner.status === 200 && owner.user.role_label === 'Owner', `status=${owner.status}`);

  const branches = await api('GET', '/api/branches', gm.token);
  const active = (branches.body || []).filter((b) => b.is_active);
  const branch = active[0];
  check('fixture has an active branch for promotion checks', !!branch, `branches=${active.length}`);
  if (!branch) { process.exitCode = 1; return; }

  console.log('\n=== GENERAL MANAGER MAY APPOINT ANOTHER GENERAL MANAGER ===');
  const gmCandidate = await api('POST', '/api/users', gm.token, {
    full_name: 'General Manager Promotion Candidate', username: `gm-promo-${unique()}`,
    pin: 'PromotionCandidate-1', role: 'STAFF', branch_id: branch.id, job_title: 'Senior Cashier',
  });
  check('General Manager can create a staff promotion candidate', gmCandidate.status === 201, `status=${gmCandidate.status}`);
  if (gmCandidate.status === 201) {
    const promoted = await transferAndForce(gmCandidate.body.id, gm.token, {
      role: 'MANAGER', branch_id: null, reason: 'Appointed to oversee every branch',
    });
    check('General Manager can promote another employee to General Manager',
      promoted.status === 200 && promoted.body.role_label === 'General Manager' && !promoted.body.branch_id,
      `status=${promoted.status} ${JSON.stringify(promoted.body).slice(0, 130)}`);
    check('...and the promotion is recorded as a role/branch transition',
      promoted.body && promoted.body.transfer && promoted.body.transfer.to_role_label === 'General Manager',
      JSON.stringify(promoted.body && promoted.body.transfer));
  }

  console.log('\n=== BRANCH MANAGER REMAINS LIMITED TO THEIR BRANCH ===');
  const bmCandidate = await api('POST', '/api/users', bm.token, {
    full_name: 'Branch Promotion Candidate', username: `bm-promo-${unique()}`,
    pin: 'BranchCandidate-1', role: 'STAFF', branch_id: bm.user.branch_id, job_title: 'Sales Attendant',
  });
  check('Branch Manager can create staff in their own branch', bmCandidate.status === 201, `status=${bmCandidate.status}`);
  if (bmCandidate.status === 201) {
    const blocked = await api('POST', `/api/users/${bmCandidate.body.id}/transfer`, bm.token, {
      role: 'MANAGER', branch_id: null, reason: 'Attempt to make organisation-wide manager',
    });
    check('Branch Manager cannot promote someone to organisation-wide General Manager',
      blocked.status === 403 && blocked.body.code === 'BRANCH_SCOPE_VIOLATION',
      `status=${blocked.status} ${JSON.stringify(blocked.body)}`);
  }

  console.log('\n=== EVERY ROLE STILL HAS A HARD CEILING ===');
  const self = await api('POST', `/api/users/${gm.user.id}/transfer`, gm.token, {
    role: 'OWNER', branch_id: null, reason: 'Self promotion attempt',
  });
  check('General Manager cannot promote themselves to Owner', self.status === 403 && self.body.code === 'SELF_TRANSFER_FORBIDDEN',
    `status=${self.status} ${JSON.stringify(self.body)}`);
  const staff = await login('lagos.staff');
  const staffAttempt = await api('POST', `/api/users/${bm.user.id}/transfer`, staff.token, {
    role: 'MANAGER', branch_id: null, reason: 'Cashier promotion attempt',
  });
  check('Staff cannot use the transfer route to alter another role', staffAttempt.status === 403,
    `status=${staffAttempt.status} ${JSON.stringify(staffAttempt.body)}`);
  const adminAttempt = await api('POST', `/api/users/${gm.user.id}/transfer`, owner.token, {
    role: 'ADMIN', branch_id: null, reason: 'Attempt to assign vendor seat',
  });
  check('Owner cannot turn a pharmacy employee into a vendor Admin seat', adminAttempt.status === 403 || adminAttempt.status === 400,
    `status=${adminAttempt.status} ${JSON.stringify(adminAttempt.body)}`);

  console.log(`\nPROMOTION AUTHORITY AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
