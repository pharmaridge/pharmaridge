// BARCODE FLOW AUDIT — product registration → receiving → exact scanner lookup
// → POS sale → immutable sale/receipt trace → stock and GL reconciliation.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const BASE_BARCODE = '4006381333931'; // valid EAN-13
const PACK_BARCODE = '5901234123457'; // valid EAN-13
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: response.status, body: json };
}
async function login(username) { const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } }); if (r.status !== 200) throw new Error(`Cannot login ${username}`); return r.body; }

(async () => {
  console.log('=== BARCODE: PRODUCT → STOCK → POS → RECEIPT/GL AUDIT ===');
  const owner = await login('owner');
  const staff = await login('lagos.staff');
  const branch = list((await api('GET', '/api/branches', { token: owner.token })).body).find((b) => /lagos/i.test(b.name));
  let supplier = list((await api('GET', '/api/suppliers', { token: owner.token })).body)[0];
  if (!supplier) supplier = (await api('POST', '/api/suppliers', { token: owner.token, body: { name: `Barcode Supplier ${suffix()}`, phone: '08030001111', address: 'Barcode audit depot' } })).body;
  const product = await api('POST', '/api/products', { token: owner.token, body: {
    name: `Barcode Drink ${suffix()}`, retail_category: 'FOOD_DRINKS', category: 'Cold Drink', base_unit: 'bottle', units_per_pack: 10, packs_per_carton: 2,
    primary_barcode: BASE_BARCODE, primary_barcode_unit_type: 'BASE_UNIT', primary_barcode_label: 'Single bottle', dispensing_type: 'OTC', reorder_level: 0,
  } });
  check('product can register a validated primary EAN barcode atomically', product.status === 201, JSON.stringify(product.body));
  if (product.status !== 201) throw new Error('barcode product creation failed');
  const pack = await api('POST', `/api/products/${product.body.id}/barcodes`, { token: owner.token, body: { barcode: PACK_BARCODE, unit_type: 'PACK', label: '10-bottle pack' } });
  check('a product can register a separate pack barcode', pack.status === 201 && pack.body.unit_type === 'PACK', JSON.stringify(pack.body));
  const duplicate = await api('POST', `/api/products/${product.body.id}/barcodes`, { token: owner.token, body: { barcode: PACK_BARCODE, unit_type: 'PACK' } });
  check('duplicate active barcode is refused', duplicate.status === 409 && duplicate.body.code === 'BARCODE_ALREADY_REGISTERED', JSON.stringify(duplicate.body));
  const generated = await api('POST', `/api/products/${product.body.id}/barcodes/generate`, { token: owner.token, body: { unit_type: 'CARTON', label: 'Internal carton label' } });
  check('the app generates and persists a unique Code-128-printable internal barcode', generated.status === 201 && /^PRD-[A-F0-9]{16}$/.test(generated.body.barcode || '') && generated.body.unit_type === 'CARTON', JSON.stringify(generated.body));
  const generatedDuplicate = await api('POST', `/api/products/${product.body.id}/barcodes`, { token: owner.token, body: { barcode: generated.body && generated.body.barcode, unit_type: 'CARTON' } });
  check('database-unique generated barcode cannot be registered a second time', generatedDuplicate.status === 409 && generatedDuplicate.body.code === 'BARCODE_ALREADY_REGISTERED', JSON.stringify(generatedDuplicate.body));
  const invalid = await api('POST', `/api/products/${product.body.id}/barcodes`, { token: owner.token, body: { barcode: '4006381333932', unit_type: 'BASE_UNIT' } });
  check('invalid numeric GS1 check digit is refused', invalid.status === 400 && invalid.body.code === 'INVALID_BARCODE', JSON.stringify(invalid.body));
  const details = await api('GET', `/api/products/${product.body.id}`, { token: owner.token });
  check('product detail lists manually registered and generated barcode units', details.status === 200 && list(details.body.barcodes).length === 3 && list(details.body.barcodes).some((b) => b.is_primary), JSON.stringify(details.body.barcodes));
  const baseLookup = await api('GET', `/api/products/barcode/${BASE_BARCODE}`, { token: staff.token });
  const packLookup = await api('GET', `/api/products/barcode/${PACK_BARCODE}`, { token: staff.token });
  check('base barcode lookup returns the product and BASE_UNIT', baseLookup.status === 200 && baseLookup.body.id === product.body.id && baseLookup.body.barcode_unit_type === 'BASE_UNIT', JSON.stringify(baseLookup.body));
  check('pack barcode lookup returns the product and PACK', packLookup.status === 200 && packLookup.body.id === product.body.id && packLookup.body.barcode_unit_type === 'PACK', JSON.stringify(packLookup.body));

  const po = await api('POST', '/api/purchase-orders', { token: owner.token, body: { branch_id: branch.id, supplier_id: supplier.id, items: [{ product_id: product.body.id, quantity_ordered: 20, expected_unit_cost: 5 }] } });
  const received = await api('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner.token, body: { batches: [{ product_id: product.body.id, quantity_received: 20, cost_price_per_unit: 5, selling_price_per_unit: 12, pack_price: 110, batch_no: `BAR-${suffix()}`, expiry_date: '2031-12-31' }] } });
  check('barcoded product is received through the standard PO workflow', received.status === 200 || received.status === 201, `status=${received.status}`);
  const batchBefore = list((await api('GET', `/api/stock?branch_id=${branch.id}&product_id=${product.body.id}`, { token: owner.token })).body)[0];
  const till = await api('GET', `/api/till/current?branch_id=${branch.id}`, { token: staff.token });
  if (!till.body || !till.body.id) await api('POST', '/api/till/open', { token: staff.token, body: { branch_id: branch.id, opening_cash: 1000 } });
  const sale = await api('POST', '/api/sales', { token: staff.token, body: { branch_id: branch.id, items: [{ product_id: product.body.id, unit_type: 'PACK', quantity: 1, barcode_value: PACK_BARCODE }], payments: [{ method: 'CASH', amount: 110 }] } });
  check('scanned pack sale completes using the stored pack unit/price', sale.status === 201 && Number(sale.body.total) === 110, JSON.stringify(sale.body));
  const batchAfter = list((await api('GET', `/api/stock?branch_id=${branch.id}&product_id=${product.body.id}`, { token: owner.token })).body)[0];
  check('scanned pack removes exactly ten base units', batchBefore && batchAfter && Number(batchBefore.quantity_remaining) - Number(batchAfter.quantity_remaining) === 10, JSON.stringify({ batchBefore, batchAfter }));
  const receipt = await api('GET', `/api/sales/${sale.body.id}`, { token: owner.token });
  check('receipt preserves scanned barcode and retail category snapshot', receipt.status === 200 && receipt.body.items[0].barcode_value === PACK_BARCODE && receipt.body.items[0].retail_category === 'FOOD_DRINKS', JSON.stringify(receipt.body.items));
  const mismatch = await api('POST', '/api/sales', { token: staff.token, body: { branch_id: branch.id, items: [{ product_id: product.body.id, unit_type: 'BASE_UNIT', quantity: 1, barcode_value: PACK_BARCODE }], payments: [{ method: 'CASH', amount: 12 }] } });
  check('barcode/product unit mismatch is refused before recording a sale', mismatch.status === 400 && mismatch.body.code === 'BARCODE_PRODUCT_UNIT_MISMATCH', JSON.stringify(mismatch.body));
  const trial = await api('GET', '/api/gl/trial-balance', { token: owner.token });
  const totals = list(trial.body).reduce((sum, row) => ({ dr: sum.dr + Number(row.total_debits || 0), cr: sum.cr + Number(row.total_credits || 0) }), { dr: 0, cr: 0 });
  check('barcode sale keeps the books exactly balanced', trial.status === 200 && Math.abs(totals.dr - totals.cr) < 0.005, JSON.stringify(totals));
  console.log(`\nBARCODE FLOW AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
