// SINGLE-ACTIVE-SESSION AUDIT.
//
// A pharmacy username identifies one accountable person. Two browsers acting
// under the same name make till, sales, attendance and void audit trails
// ambiguous, so a newer sign-in must displace the older one immediately.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function request(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = path.startsWith('/api/') ? path : `/api${path}`;
  const response = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, body: data };
}
async function login(username, pin = '1234') {
  return request('POST', '/api/auth/login', { body: { username, pin } });
}

(async () => {
  console.log('=== SINGLE ACTIVE SESSION / MULTI-DEVICE AUDIT ===');

  // OWNER: second device wins, first device is displaced.
  const ownerA = await login('owner');
  check('owner device A can sign in', ownerA.status === 200, `status=${ownerA.status}`);
  const ownerTokenA = ownerA.body && ownerA.body.token;
  const ownerAHealthy = await request('GET', '/users/me', { token: ownerTokenA });
  check('owner device A is active immediately after sign-in', ownerAHealthy.status === 200, `status=${ownerAHealthy.status}`);

  const ownerB = await login('owner');
  check('owner device B can sign in', ownerB.status === 200, `status=${ownerB.status}`);
  const ownerTokenB = ownerB.body && ownerB.body.token;
  const ownerAAfter = await request('GET', '/users/me', { token: ownerTokenA });
  const ownerBAfter = await request('GET', '/users/me', { token: ownerTokenB });
  check('owner device A is displaced by device B', ownerAAfter.status === 401 && ownerAAfter.body && ownerAAfter.body.code === 'SESSION_REPLACED', JSON.stringify(ownerAAfter.body));
  check('owner device B remains active', ownerBAfter.status === 200, `status=${ownerBAfter.status}`);

  // Explicit sign-out revokes only the caller's current session.
  const logout = await request('POST', '/auth/logout', { token: ownerTokenB, body: {} });
  check('server logout revokes the active owner session', logout.status === 200, `status=${logout.status}`);
  const ownerAfterLogout = await request('GET', '/users/me', { token: ownerTokenB });
  check('logged-out owner token cannot be reused', ownerAfterLogout.status === 401, `status=${ownerAfterLogout.status}`);

  // Different people retain independent sessions.
  const ownerC = await login('owner');
  const admin = await login('admin');
  const ownerCMe = await request('GET', '/users/me', { token: ownerC.body && ownerC.body.token });
  const adminMe = await request('GET', '/users/me', { token: admin.body && admin.body.token });
  check('different Owner and Admin accounts can both remain active', ownerCMe.status === 200 && adminMe.status === 200, `owner=${ownerCMe.status} admin=${adminMe.status}`);

  // STAFF: same rule, proving the fence applies to cashier accounts too.
  const staffA = await login('lagos.staff');
  const staffB = await login('lagos.staff');
  const staffAAfter = await request('GET', '/users/me', { token: staffA.body && staffA.body.token });
  const staffBAfter = await request('GET', '/users/me', { token: staffB.body && staffB.body.token });
  check('cashier device A is displaced by a second cashier sign-in', staffAAfter.status === 401 && staffAAfter.body && staffAAfter.body.code === 'SESSION_REPLACED', JSON.stringify(staffAAfter.body));
  check('cashier device B remains active', staffBAfter.status === 200, `status=${staffBAfter.status}`);

  // Concurrent login race: D1 UPSERT chooses one last session id. Exactly one
  // of the returned tokens may pass an authenticated call afterwards.
  const pair = await Promise.all([login('manager'), login('manager')]);
  const pairMe = await Promise.all(pair.map((entry) => request('GET', '/users/me', { token: entry.body && entry.body.token })));
  const activeCount = pairMe.filter((entry) => entry.status === 200).length;
  check('two concurrent manager logins leave exactly one active session', activeCount === 1, `active=${activeCount}, statuses=${pairMe.map((entry) => entry.status).join(',')}`);

  console.log(`\nSINGLE-SESSION AUDIT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((entry) => console.log(`  - ${entry}`));
    process.exit(1);
  }
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
