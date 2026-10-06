// TURSO PROVIDER CANARY — runs the real Worker routes with
// DATABASE_PROVIDER=TURSO. It requires temporary, terminal-only rehearsal
// credentials created by the runner; nothing here contains a credential.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9002';
const ADMIN_USERNAME = process.env.REHEARSAL_ADMIN_USERNAME;
const ADMIN_PIN = process.env.REHEARSAL_ADMIN_PIN;
const OWNER_PIN = process.env.REHEARSAL_OWNER_PIN;
const STAFF_PIN = process.env.REHEARSAL_STAFF_PIN;

let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
const list = (value) => Array.isArray(value) ? value : ((value && value.results) || []);
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: response.status, body: json };
}
async function login(username, pin) {
  const response = await api('POST', '/api/auth/login', { body: { username, pin } });
  if (response.status !== 200 || !response.body || !response.body.token) throw new Error(`Login failed (${response.status})`);
  return response.body;
}

(async () => {
  if (![ADMIN_USERNAME, ADMIN_PIN, OWNER_PIN, STAFF_PIN].every(Boolean)) throw new Error('Temporary rehearsal credentials are required.');
  console.log('=== TURSO PROVIDER ROUTE CANARY ===');
  const health = await api('GET', '/api/health');
  check('Turso-backed Worker health route responds', health.status === 200 && health.body && health.body.ok === true, JSON.stringify(health.body));

  const admin = await login(ADMIN_USERNAME, ADMIN_PIN);
  check('temporary Admin signs in through the Turso-backed auth route', admin.user && admin.user.role === 'ADMIN');
  const id = suffix();
  const ownerUsername = `owner-${id.toLowerCase()}`;
  const ownerCreate = await api('POST', '/api/users', { token: admin.token, body: {
    full_name: 'Turso Rehearsal Owner', username: ownerUsername, pin: OWNER_PIN, role: 'OWNER', job_title: 'Owner',
  } });
  check('Admin can create a Client Owner on Turso', ownerCreate.status === 201 && ownerCreate.body && ownerCreate.body.role === 'OWNER', JSON.stringify(ownerCreate.body));
  const owner = await login(ownerUsername, OWNER_PIN);

  const branchCreate = await api('POST', '/api/branches', { token: owner.token, body: {
    name: `Turso Rehearsal Branch ${id}`, license_type: 'PHARMACY', address: 'Synthetic rehearsal only', phone: '08000000000',
  } });
  check('Owner can create a branch through the Turso provider', branchCreate.status === 201 && branchCreate.body && branchCreate.body.id, JSON.stringify(branchCreate.body));
  const branchId = branchCreate.body && branchCreate.body.id;
  const staffUsername = `staff-${id.toLowerCase()}`;
  const staffCreate = await api('POST', '/api/users', { token: owner.token, body: {
    full_name: 'Turso Rehearsal Staff', username: staffUsername, pin: STAFF_PIN, role: 'STAFF', branch_id: branchId, job_title: 'Sales Attendant',
  } });
  check('Owner can create branch-scoped Staff through the Turso provider', staffCreate.status === 201 && staffCreate.body && staffCreate.body.role === 'STAFF', JSON.stringify(staffCreate.body));
  const staff = await login(staffUsername, STAFF_PIN);

  const supplier = await api('POST', '/api/suppliers', { token: owner.token, body: {
    name: `Turso Rehearsal Supplier ${id}`, phone: '08000000001', address: 'Synthetic rehearsal only',
  } });
  check('Owner can create a supplier through the Turso provider', supplier.status === 201 && supplier.body && supplier.body.id, JSON.stringify(supplier.body));
  const barcode = `INT-${id}`;
  const product = await api('POST', '/api/products', { token: owner.token, body: {
    name: `Turso Rehearsal Drink ${id}`, retail_category: 'FOOD_DRINKS', category: 'Rehearsal', base_unit: 'bottle',
    units_per_pack: 10, packs_per_carton: 2, dispensing_type: 'OTC', reorder_level: 0,
    primary_barcode: barcode, primary_barcode_unit_type: 'BASE_UNIT',
  } });
  check('Owner can create a barcoded product through the Turso provider', product.status === 201 && product.body && product.body.id, JSON.stringify(product.body));

  const purchaseOrder = await api('POST', '/api/purchase-orders', { token: owner.token, body: {
    branch_id: branchId, supplier_id: supplier.body && supplier.body.id,
    items: [{ product_id: product.body && product.body.id, quantity_ordered: 20, expected_unit_cost: 5 }],
  } });
  check('purchase order records on Turso', purchaseOrder.status === 201 && purchaseOrder.body && purchaseOrder.body.id, JSON.stringify(purchaseOrder.body));
  const receive = await api('POST', `/api/purchase-orders/${purchaseOrder.body && purchaseOrder.body.id}/receive`, { token: owner.token, body: {
    batches: [{ product_id: product.body && product.body.id, quantity_received: 20, cost_price_per_unit: 5, selling_price_per_unit: 12, pack_price: 110, batch_no: `TURSO-${id}`, expiry_date: '2031-12-31' }],
  } });
  check('stock receiving and accounting post on Turso', receive.status === 200 || receive.status === 201, JSON.stringify(receive.body));

  const till = await api('POST', '/api/till/open', { token: staff.token, body: { branch_id: branchId, opening_cash: 1000 } });
  check('Staff can open a till on Turso', till.status === 201 && till.body && till.body.id, JSON.stringify(till.body));
  const lookup = await api('GET', `/api/products/barcode/${barcode}`, { token: staff.token });
  check('barcode lookup uses the Turso provider', lookup.status === 200 && lookup.body && lookup.body.id === product.body.id && lookup.body.barcode_unit_type === 'BASE_UNIT', JSON.stringify(lookup.body));
  const sale = await api('POST', '/api/sales', { token: staff.token, body: {
    branch_id: branchId, items: [{ product_id: product.body && product.body.id, unit_type: 'BASE_UNIT', quantity: 1, barcode_value: barcode }], payments: [{ method: 'CASH', amount: 12 }],
  } });
  check('barcode sale completes on Turso', sale.status === 201 && sale.body && Number(sale.body.total) === 12, JSON.stringify(sale.body));
  const receipt = await api('GET', `/api/sales/${sale.body && sale.body.id}`, { token: owner.token });
  check('receipt preserves the barcode trace on Turso', receipt.status === 200 && receipt.body && receipt.body.items[0] && receipt.body.items[0].barcode_value === barcode, JSON.stringify(receipt.body && receipt.body.items));
  const trial = await api('GET', '/api/gl/trial-balance', { token: owner.token });
  const totals = list(trial.body).reduce((sum, row) => ({ dr: sum.dr + Number(row.total_debits || 0), cr: sum.cr + Number(row.total_credits || 0) }), { dr: 0, cr: 0 });
  check('Turso rehearsal sale leaves the books exactly balanced', trial.status === 200 && Math.abs(totals.dr - totals.cr) < 0.005, JSON.stringify(totals));

  console.log(`\nTURSO PROVIDER ROUTE CANARY: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
