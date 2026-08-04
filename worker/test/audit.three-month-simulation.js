// THREE-MONTH SIMULATION AUDIT
// Validates that a 90-day operating history remains coherent across POS, VAT,
// WHT, change claims, debtors, creditors, till/safe, attendance, stock and GL.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function request(method, route, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, body: data };
}
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
async function login(username) {
  const r = await request('POST', '/api/auth/login', { body: { username, pin: '1234' } });
  if (r.status !== 200) throw new Error(`cannot log in as ${username}: ${r.status}`);
  return r.body.token;
}
const daysBetween = (a, b) => Math.abs(new Date(a.replace(' ', 'T') + 'Z') - new Date(b.replace(' ', 'T') + 'Z')) / 86400000;

(async () => {
  console.log('=== THREE-MONTH OPERATING HISTORY AUDIT ===');
  const owner = await login('owner');
  const manager = await login('manager');
  const staff = await login('lagos.staff');
  const admin = await login('admin');

  const sales = list((await request('GET', '/api/sales?limit=200', { token: owner })).body);
  const completed = sales.filter((s) => s.status === 'COMPLETED');
  const dates = completed.map((s) => s.created_at).filter(Boolean).sort();
  check('simulation contains at least 80 completed sales', completed.length >= 80, `completed=${completed.length}`);
  check('sales span at least 80 calendar days', dates.length > 1 && daysBetween(dates[0], dates[dates.length - 1]) >= 80, `${dates[0]} → ${dates[dates.length - 1]}`);
  check('VAT is extracted on simulated sales', completed.some((s) => Number(s.vat_amount || 0) > 0), 'no sale carried vat_amount');

  const wht = list((await request('GET', '/api/wht/entries', { token: owner })).body);
  check('WHT register contains monthly simulated deductions', wht.length >= 6, `entries=${wht.length}`);
  check('WHT rows preserve gross = net + tax', wht.every((r) => Math.round((Number(r.gross_amount) - Number(r.net_amount) - Number(r.wht_amount)) * 100) === 0), 'a WHT arithmetic row is inconsistent');

  const claims = list((await request('GET', '/api/change-owed?status=ALL', { token: owner })).body);
  check('change-owed history exists across the period', claims.length >= 5, `claims=${claims.length}`);
  check('every change claim has a seven-digit code', claims.every((c) => /^\d{7}$/.test(String(c.claim_code || ''))), 'invalid claim code found');

  const debtors = list((await request('GET', '/api/customers', { token: owner })).body);
  const customerBalances = await Promise.all(debtors.slice(0, 20).map((c) => request('GET', `/api/customers/${c.id}/balance`, { token: owner })));
  check('customer/credit activity exists', customerBalances.some((r) => Number(r.body && r.body.balance_owed || 0) > 0), 'no outstanding simulated customer balance');

  const creditors = list((await request('GET', '/api/creditors/balances', { token: owner })).body);
  check('supplier credit activity exists', creditors.some((r) => Number(r.balance_owed || 0) > 0), `creditor rows=${creditors.length}`);

  const branches = list((await request('GET', '/api/branches', { token: owner })).body);
  const tillRows = [];
  const safeMovementRows = [];
  for (const branch of branches) {
    tillRows.push(...list((await request('GET', `/api/till?branch_id=${branch.id}`, { token: owner })).body));
    const safe = await request('GET', `/api/safe/${branch.id}/movements`, { token: owner });
    safeMovementRows.push(...list(safe.body && safe.body.movements));
  }
  check('daily till history exists', tillRows.filter((t) => t.status === 'CLOSED').length >= 70, `closed=${tillRows.filter((t) => t.status === 'CLOSED').length}`);
  check('safe ledger records operating reserve movements', safeMovementRows.length >= 3, `movements=${safeMovementRows.length}`);

  const attendance = list((await request('GET', '/api/attendance', { token: owner })).body);
  check('attendance history exists through the period', attendance.length >= 5, `attendance=${attendance.length}`);
  check('closed shifts contain a clock-out time', attendance.filter((a) => a.clock_out_at).every((a) => a.clock_in_at), 'clock-out without clock-in');

  const transfers = list((await request('GET', '/api/transfers', { token: owner })).body);
  check('completed stock transfer exists', transfers.some((t) => t.status === 'RECEIVED'), `transfers=${transfers.length}`);

  const stock = list((await request('GET', '/api/stock', { token: owner })).body);
  check('stock remains non-negative after 90 days', stock.every((s) => Number(s.quantity_remaining) >= 0), 'negative stock row found');
  check('products remain available for receiving', list((await request('GET', '/api/products?q=para', { token: owner })).body).length > 0, 'product search returned no rows');

  const trial = list((await request('GET', '/api/gl/trial-balance', { token: owner })).body);
  const dr = trial.reduce((sum, row) => sum + Number(row.total_debits || 0), 0);
  const cr = trial.reduce((sum, row) => sum + Number(row.total_credits || 0), 0);
  check('three-month trial balance remains exact', Math.abs(dr - cr) < 0.005, `dr=${dr} cr=${cr}`);

  // Cross-role controls over the same data: UI audit covers the controls;
  // these API assertions prove the backend makes the same decision.
  const managerWht = await request('GET', '/api/wht/entries', { token: manager });
  const staffExpenses = await request('GET', '/api/expenses', { token: staff });
  const adminPlan = await request('GET', '/api/admin/settings', { token: admin });
  check('manager can inspect WHT records', managerWht.status === 200, `status=${managerWht.status}`);
  check('staff cannot browse every expense', staffExpenses.status === 403, `status=${staffExpenses.status}`);
  check('Admin can inspect live-sample plan controls', adminPlan.status === 200, `status=${adminPlan.status}`);

  console.log(`\nTHREE-MONTH SIMULATION AUDIT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((entry) => console.log(`  - ${entry}`));
    process.exit(1);
  }
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
