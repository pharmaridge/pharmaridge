// RETAIL CATEGORY UI PROBE — verifies Products, category-first POS selling and
// Sales History summary in the real browser, then correlates with API data.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: response.status, body: data };
}
async function loginApi(username) { const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } }); if (r.status !== 200) throw new Error(`Cannot login ${username}`); return r.body; }
async function loginPage(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((user) => {
    document.getElementById('login-username').value = user;
    document.getElementById('login-pin').value = '1234';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, username);
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sleep(1800);
}

(async () => {
  const owner = await loginApi('owner');
  const staff = await loginApi('lagos.staff');
  const branch = list((await api('GET', '/api/branches', { token: owner.token })).body).find((b) => /lagos/i.test(b.name));
  let supplier = list((await api('GET', '/api/suppliers', { token: owner.token })).body)[0];
  if (!supplier) {
    const created = await api('POST', '/api/suppliers', { token: owner.token, body: { name: `UI Category Supplier ${suffix()}`, phone: '08031110000', address: 'UI category depot' } });
    if (created.status !== 201) throw new Error(`Category supplier setup failed ${created.status}`);
    supplier = created.body;
  }
  const product = await api('POST', '/api/products', { token: owner.token, body: { name: `UI Category Drink ${suffix()}`, retail_category: 'FOOD_DRINKS', category: 'Cold Drink', dispensing_type: 'OTC', base_unit: 'bottle', units_per_pack: 1, reorder_level: 0 } });
  if (product.status !== 201) throw new Error(`Food product setup failed ${product.status}`);
  const po = await api('POST', '/api/purchase-orders', { token: owner.token, body: { branch_id: branch.id, supplier_id: supplier.id, items: [{ product_id: product.body.id, quantity_ordered: 10, expected_unit_cost: 50 }] } });
  const received = await api('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner.token, body: { batches: [{ product_id: product.body.id, quantity_received: 10, cost_price_per_unit: 50, selling_price_per_unit: 100, batch_no: `UI-CAT-${suffix()}`, expiry_date: '2031-12-31' }] } });
  if (!(received.status === 200 || received.status === 201)) throw new Error(`Food stock receipt failed ${received.status}`);
  const till = await api('GET', `/api/till/current?branch_id=${branch.id}`, { token: staff.token });
  if (!till.body || !till.body.id) await api('POST', '/api/till/open', { token: staff.token, body: { branch_id: branch.id, opening_cash: 1000 } });
  const foodSale = await api('POST', '/api/sales', { token: staff.token, body: { branch_id: branch.id, items: [{ product_id: product.body.id, quantity: 1, unit_type: 'BASE_UNIT' }], payments: [{ method: 'CASH', amount: 100 }] } });
  if (foodSale.status !== 201) throw new Error(`Food sale setup failed ${foodSale.status}`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const staffCtx = await browser.createBrowserContext(); const staffPage = await staffCtx.newPage(); await staffPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await loginPage(staffPage, 'lagos.staff');
    await staffPage.evaluate(() => { location.hash = '#/pos'; });
    await staffPage.waitForSelector('#pos-retail-category');
    const posCategories = await staffPage.$$eval('#pos-retail-category option', (options) => options.map((option) => ({ value: option.value, text: option.textContent.trim() })));
    check('mobile POS lists all four retail selling categories', ['PHARMACEUTICALS', 'FOOD_DRINKS', 'ACCESSORIES', 'BEAUTY_PERSONAL_CARE'].every((code) => posCategories.some((option) => option.value === code)), JSON.stringify(posCategories));
    await staffPage.select('#pos-retail-category', 'FOOD_DRINKS');
    const productSelector = `[data-product-id="${product.body.id}"]`;
    await staffPage.waitForSelector(productSelector, { timeout: 15000 });
    const foodResult = await staffPage.$eval(productSelector, (el) => el.innerText);
    check('category-first POS search shows the Food & Drinks item', foodResult.includes(product.body.name) && /Food & Drinks/.test(foodResult), foodResult);
    await staffPage.click(productSelector);
    await staffPage.waitForSelector('.cart-line');
    const cart = await staffPage.$eval('#pos-cart', (el) => el.innerText);
    check('cashier can add the category-filtered item to the POS cart', cart.includes(product.body.name), cart);
    await staffCtx.close();

    const ownerCtx = await browser.createBrowserContext(); const ownerPage = await ownerCtx.newPage(); await ownerPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await loginPage(ownerPage, 'owner');
    await ownerPage.evaluate(() => { location.hash = '#/products'; });
    await ownerPage.waitForSelector('#p-retail-category');
    const productForm = await ownerPage.evaluate(() => ({
      labels: [...document.querySelectorAll('#p-retail-category option')].map((option) => option.textContent.trim()),
      labelsOnForm: [...document.querySelectorAll('.form-row label')].map((label) => label.textContent.trim()),
    }));
    check('Product form provides the professional retail-category selector', ['Pharmaceuticals', 'Food & Drinks', 'Accessories', 'Beauty & Personal Care'].every((label) => productForm.labels.includes(label)), JSON.stringify(productForm));
    check('Product form keeps the optional therapeutic/item group distinct from retail category', productForm.labelsOnForm.some((label) => /Product Group/.test(label)), JSON.stringify(productForm));
    await ownerPage.evaluate(() => { location.hash = '#/sales'; });
    await ownerPage.waitForSelector('#sales-retail-category');
    await ownerPage.select('#sales-retail-category', 'FOOD_DRINKS');
    await ownerPage.waitForFunction(() => {
      const select = document.getElementById('sales-retail-category');
      const text = (document.getElementById('view') || document.body).innerText;
      return select && select.value === 'FOOD_DRINKS' && /Category Sales Summary/.test(text) && /Food & Drinks/.test(text);
    }, { timeout: 15000 });
    const salesView = await ownerPage.$eval('#view', (el) => el.innerText);
    check('Sales History category filter and category summary show the Food & Drinks sale', /Category Sales Summary/.test(salesView) && /Food & Drinks/.test(salesView) && /N100\.00/.test(salesView), salesView.slice(0, 800));
    const liveOwnerToken = await ownerPage.evaluate(() => JSON.parse(localStorage.getItem('gl_pms_session')).token);
    const history = await api('GET', `/api/sales?branch_id=${branch.id}&retail_category=FOOD_DRINKS`, { token: liveOwnerToken });
    check('browser category result agrees with server category history', history.status === 200 && list(history.body).some((sale) => sale.id === foodSale.body.id), JSON.stringify(history.body));
    await ownerCtx.close();
  } finally { await browser.close(); }
  console.log(`\nRETAIL CATEGORY UI PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
