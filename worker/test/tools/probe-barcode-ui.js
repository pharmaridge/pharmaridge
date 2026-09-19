// BARCODE UI PROBE — scanner-like Enter flow on phone POS plus product barcode
// registry management visibility in the real browser.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
function makeEan13(body) {
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(body[i]) * weight;
  return body + ((10 - (sum % 10)) % 10);
}
const barcodeSeed = String(Date.now() % 100000000000).padStart(11, '0');
const BASE_BARCODE = makeEan13(`2${barcodeSeed}`);
const PACK_BARCODE = makeEan13(`3${barcodeSeed}`);
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
async function api(method, path, { token, body } = {}) { const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`; const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; } return { status: r.status, body: data }; }
async function loginApi(username) { const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } }); if (r.status !== 200) throw new Error(`Cannot login ${username}`); return r.body; }
async function loginPage(page, username) { await page.goto(BASE, { waitUntil: 'networkidle0' }); await page.evaluate((user) => { document.getElementById('login-username').value = user; document.getElementById('login-pin').value = '1234'; document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }, username); await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 }); await new Promise((r) => setTimeout(r, 1600)); }

(async () => {
  const owner = await loginApi('owner'); const staff = await loginApi('lagos.staff');
  const branch = list((await api('GET', '/api/branches', { token: owner.token })).body).find((b) => /lagos/i.test(b.name));
  let supplier = list((await api('GET', '/api/suppliers', { token: owner.token })).body)[0];
  if (!supplier) supplier = (await api('POST', '/api/suppliers', { token: owner.token, body: { name: 'Barcode UI Supplier', phone: '08032221111', address: 'UI probe' } })).body;
  const product = await api('POST', '/api/products', { token: owner.token, body: { name: `Barcode UI Drink ${Date.now()}`, retail_category: 'FOOD_DRINKS', category: 'Cold Drink', base_unit: 'bottle', units_per_pack: 10, packs_per_carton: 2, dispensing_type: 'OTC', primary_barcode: BASE_BARCODE, primary_barcode_unit_type: 'BASE_UNIT' } });
  if (product.status !== 201) throw new Error(`Product setup ${product.status}`);
  await api('POST', `/api/products/${product.body.id}/barcodes`, { token: owner.token, body: { barcode: PACK_BARCODE, unit_type: 'PACK', label: 'Ten bottle pack' } });
  const po = await api('POST', '/api/purchase-orders', { token: owner.token, body: { branch_id: branch.id, supplier_id: supplier.id, items: [{ product_id: product.body.id, quantity_ordered: 20, expected_unit_cost: 5 }] } });
  await api('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner.token, body: { batches: [{ product_id: product.body.id, quantity_received: 20, cost_price_per_unit: 5, selling_price_per_unit: 12, pack_price: 110, batch_no: `BCUI-${Date.now()}`, expiry_date: '2031-12-31' }] } });
  const till = await api('GET', `/api/till/current?branch_id=${branch.id}`, { token: staff.token });
  if (!till.body || !till.body.id) await api('POST', '/api/till/open', { token: staff.token, body: { branch_id: branch.id, opening_cash: 1000 } });

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const staffCtx = await browser.createBrowserContext(); const staffPage = await staffCtx.newPage(); await staffPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await loginPage(staffPage, 'lagos.staff'); await staffPage.evaluate(() => { location.hash = '#/pos'; });
    await staffPage.waitForSelector('#pos-barcode');
    await staffPage.type('#pos-barcode', PACK_BARCODE); await staffPage.keyboard.press('Enter');
    await staffPage.waitForSelector('.cart-line');
    const cart = await staffPage.$eval('#pos-cart', (el) => el.innerText);
    const scannerFocus = await staffPage.evaluate(() => document.activeElement === document.getElementById('pos-barcode'));
    check('mobile POS scanner input adds the pack-barcode product directly to cart', cart.includes(product.body.name) && /pack/i.test(cart), cart);
    check('barcode field is ready for the next scanner input after a successful scan', scannerFocus, String(scannerFocus));
    await staffCtx.close();

    const ownerCtx = await browser.createBrowserContext(); const ownerPage = await ownerCtx.newPage(); await ownerPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await loginPage(ownerPage, 'owner'); await ownerPage.evaluate(() => { location.hash = '#/products'; });
    await ownerPage.waitForSelector(`[data-barcodes-product="${product.body.id}"]`);
    const browserErrors = [];
    ownerPage.on('pageerror', (error) => browserErrors.push(error.message));
    await ownerPage.click(`[data-barcodes-product="${product.body.id}"]`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const barcodeModal = await ownerPage.evaluate(() => ({
      text: (document.querySelector('.modal') || {}).innerText || '',
      toasts: [...document.querySelectorAll('.toast')].map((el) => el.innerText),
    }));
    check('Products screen exposes professional barcode registry management', /Barcodes/.test(barcodeModal.text) && /Single \/ base unit/.test(barcodeModal.text) && /Pack/.test(barcodeModal.text) && barcodeModal.text.includes(PACK_BARCODE) && barcodeModal.text.includes('Generate Internal Barcode') && browserErrors.length === 0, JSON.stringify({ barcodeModal, browserErrors }));
    await ownerPage.click('#pb-generate');
    await ownerPage.waitForFunction(() => /PRD-[A-F0-9]{16}/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 15000 });
    const generatedUiBarcode = await ownerPage.$eval('.modal', (el) => (el.innerText.match(/PRD-[A-F0-9]{16}/) || [])[0]);
    check('Generate Internal Barcode saves a unique internal label through the live UI', /^PRD-[A-F0-9]{16}$/.test(generatedUiBarcode || ''), generatedUiBarcode || 'not found');
    await ownerPage.evaluate(() => {
      window.__barcodePrintHtml = '';
      window.open = () => ({ document: { open() {}, write(html) { window.__barcodePrintHtml = html; }, close() {} }, set opener(_) {} });
    });
    await ownerPage.click('[data-print-barcode]');
    const printHtml = await ownerPage.evaluate(() => window.__barcodePrintHtml);
    check('Print sticker opens the external-printer print layout for a registered barcode', /@page \{ size: 58mm 40mm;/.test(printHtml) && printHtml.includes('window.print()'), printHtml ? printHtml.slice(0, 100) : 'no print output');
    await ownerCtx.close();
  } finally { await browser.close(); }
  console.log(`\nBARCODE UI PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
