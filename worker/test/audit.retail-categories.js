// RETAIL CATEGORY / CATEGORY SALES HISTORY AUDIT
// Exercises pharmaceutical and non-pharmaceutical shelf categories through
// Products → PO/Receiving → POS sale → category sales history/reporting.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const categories = ['PHARMACEUTICALS', 'FOOD_DRINKS', 'ACCESSORIES', 'BEAUTY_PERSONAL_CARE'];
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: response.status, body: json };
}
async function login(username) { const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } }); if (r.status !== 200) throw new Error(`Cannot sign in as ${username}`); return r.body; }

(async () => {
  console.log('=== RETAIL CATEGORIES: PRODUCTS, POS AND SALES HISTORY ===');
  const owner = await login('owner');
  const staff = await login('lagos.staff');
  const branch = list((await api('GET', '/api/branches', { token: owner.token })).body).find((b) => /lagos/i.test(b.name));
  let supplier = list((await api('GET', '/api/suppliers', { token: owner.token })).body)[0];
  if (!supplier) {
    const created = await api('POST', '/api/suppliers', { token: owner.token, body: { name: `Category Supplier ${suffix()}`, phone: '08031110000', address: 'Category test depot' } });
    if (created.status !== 201) throw new Error(`Category supplier setup failed (${created.status})`);
    supplier = created.body;
  }
  if (!branch) throw new Error('Seed branch missing');
  const definitions = [
    ['PHARMACEUTICALS', 'Category Paracetamol', 'Analgesic', 50],
    ['FOOD_DRINKS', 'Category Water', 'Bottled Water', 60],
    ['ACCESSORIES', 'Category Face Mask', 'Personal Accessory', 20],
    ['BEAUTY_PERSONAL_CARE', 'Category Body Cream', 'Skin Care', 30],
  ];
  const products = {};
  for (const [retailCategory, name, group, price] of definitions) {
    const product = await api('POST', '/api/products', { token: owner.token, body: {
      name: `${name} ${suffix()}`, retail_category: retailCategory, category: group,
      dispensing_type: 'OTC', base_unit: retailCategory === 'FOOD_DRINKS' ? 'bottle' : 'piece', units_per_pack: 1, reorder_level: 0,
    } });
    check(`${retailCategory} product is accepted`, product.status === 201 && product.body.retail_category === retailCategory, JSON.stringify(product.body));
    if (product.status !== 201) continue;
    products[retailCategory] = { ...product.body, price };
    const po = await api('POST', '/api/purchase-orders', { token: owner.token, body: { branch_id: branch.id, supplier_id: supplier.id, items: [{ product_id: product.body.id, quantity_ordered: 20, expected_unit_cost: price / 2 }] } });
    const receive = await api('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner.token, body: { batches: [{ product_id: product.body.id, quantity_received: 20, cost_price_per_unit: price / 2, selling_price_per_unit: price, batch_no: `CAT-${retailCategory}-${suffix()}`, expiry_date: '2031-12-31' }] } });
    check(`${retailCategory} product is received as sellable stock`, receive.status === 200 || receive.status === 201, `status=${receive.status}`);
  }
  const invalid = await api('POST', '/api/products', { token: owner.token, body: { name: `Invalid ${suffix()}`, retail_category: 'TOYS', base_unit: 'piece', units_per_pack: 1 } });
  check('unknown retail categories are refused with an actionable code', invalid.status === 400 && invalid.body.code === 'INVALID_RETAIL_CATEGORY', JSON.stringify(invalid.body));

  for (const code of categories) {
    const filtered = await api('GET', `/api/products?retail_category=${code}`, { token: owner.token });
    check(`${code} product filter returns only its retail category`, filtered.status === 200 && list(filtered.body).some((p) => p.id === products[code].id) && list(filtered.body).every((p) => p.retail_category === code), JSON.stringify(filtered.body));
  }
  const foodStock = await api('GET', `/api/stock?branch_id=${branch.id}&retail_category=FOOD_DRINKS`, { token: owner.token });
  check('stock category filter returns the Food & Drinks batch', foodStock.status === 200 && list(foodStock.body).some((b) => b.product_id === products.FOOD_DRINKS.id) && list(foodStock.body).every((b) => b.retail_category === 'FOOD_DRINKS'), JSON.stringify(foodStock.body));

  const currentTill = await api('GET', `/api/till/current?branch_id=${branch.id}`, { token: staff.token });
  if (!currentTill.body || !currentTill.body.id) await api('POST', '/api/till/open', { token: staff.token, body: { branch_id: branch.id, opening_cash: 1000 } });
  const sell = async (lines) => api('POST', '/api/sales', { token: staff.token, body: {
    branch_id: branch.id,
    items: lines.map(([code, quantity]) => ({ product_id: products[code].id, quantity, unit_type: 'BASE_UNIT' })),
    payments: [{ method: 'CASH', amount: lines.reduce((sum, [code, quantity]) => sum + products[code].price * quantity, 0) }],
  } });
  const pharmacySale = await sell([['PHARMACEUTICALS', 1]]);
  const foodSale = await sell([['FOOD_DRINKS', 2]]);
  const beautySale = await sell([['BEAUTY_PERSONAL_CARE', 1]]);
  const mixedSale = await sell([['PHARMACEUTICALS', 1], ['ACCESSORIES', 1]]);
  check('pharmaceutical, food, beauty and mixed-category sales all complete', [pharmacySale, foodSale, beautySale, mixedSale].every((r) => r.status === 201), [pharmacySale, foodSale, beautySale, mixedSale].map((r) => r.status).join(','));

  const foodHistory = await api('GET', `/api/sales?branch_id=${branch.id}&retail_category=FOOD_DRINKS`, { token: owner.token });
  check('Food & Drinks sales history returns the food sale', foodHistory.status === 200 && list(foodHistory.body).some((sale) => sale.id === foodSale.body.id) && list(foodHistory.body).every((sale) => String(sale.retail_categories).includes('FOOD_DRINKS')), JSON.stringify(foodHistory.body));
  const accessoryHistory = await api('GET', `/api/sales?branch_id=${branch.id}&retail_category=ACCESSORIES`, { token: owner.token });
  check('mixed basket appears in Accessories sales history via its saved sale line', accessoryHistory.status === 200 && list(accessoryHistory.body).some((sale) => sale.id === mixedSale.body.id), JSON.stringify(accessoryHistory.body));
  const summary = await api('GET', `/api/sales/category-summary?branch_id=${branch.id}`, { token: owner.token });
  const byCategory = Object.fromEntries(list(summary.body).map((row) => [row.retail_category, row]));
  check('category summary separately totals all four categories', summary.status === 200 && categories.every((code) => byCategory[code])
    && Number(byCategory.PHARMACEUTICALS.gross_sales) === 100 && Number(byCategory.FOOD_DRINKS.gross_sales) === 120
    && Number(byCategory.ACCESSORIES.gross_sales) === 20 && Number(byCategory.BEAUTY_PERSONAL_CARE.gross_sales) === 30, JSON.stringify(byCategory));

  // Change the product category after the sale. Historical food sales must not
  // move into Beauty just because the product master was reclassified later.
  const reclassify = await api('PUT', `/api/products/${products.FOOD_DRINKS.id}`, { token: owner.token, body: { retail_category: 'BEAUTY_PERSONAL_CARE' } });
  check('a product may be reclassified for future POS use', reclassify.status === 200 && reclassify.body.retail_category === 'BEAUTY_PERSONAL_CARE', JSON.stringify(reclassify.body));
  const foodAfterEdit = await api('GET', `/api/sales/category-summary?branch_id=${branch.id}&retail_category=FOOD_DRINKS`, { token: owner.token });
  check('past Food & Drinks totals remain in Food history after later product reclassification', foodAfterEdit.status === 200 && list(foodAfterEdit.body).length === 1 && Number(foodAfterEdit.body[0].gross_sales) === 120, JSON.stringify(foodAfterEdit.body));
  const receipt = await api('GET', `/api/sales/${foodSale.body.id}`, { token: owner.token });
  check('receipt retains the Food & Drinks sale-line category snapshot', receipt.status === 200 && list(receipt.body.items).every((item) => item.retail_category === 'FOOD_DRINKS'), JSON.stringify(receipt.body.items));

  const trial = await api('GET', '/api/gl/trial-balance', { token: owner.token });
  const totals = list(trial.body).reduce((sum, row) => ({ dr: sum.dr + Number(row.total_debits || 0), cr: sum.cr + Number(row.total_credits || 0) }), { dr: 0, cr: 0 });
  check('all category sales remain double-entry balanced', trial.status === 200 && Math.abs(totals.dr - totals.cr) < 0.005, JSON.stringify(totals));
  console.log(`\nRETAIL CATEGORY AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
