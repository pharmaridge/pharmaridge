// INPUT GUIDANCE PROBE — checks that the app tells an operator not merely the
// field name, but the unit/source expected before a consequential write.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function go(page, hash, selector) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(selector, { timeout: 25000 });
  await sl(500);
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.getElementById('login-username').value = 'owner';
      document.getElementById('login-username').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-pin').value = '1234';
      document.getElementById('login-pin').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
    await sl(2400);

    console.log('\n=== PEOPLE / PRODUCT GUIDANCE ===');
    await go(page, '#/users', '#u-name');
    let guidance = await page.evaluate(() => ({
      name: document.getElementById('u-name').placeholder,
      username: document.getElementById('u-username').placeholder,
      title: document.getElementById('u-title').placeholder,
    }));
    check('Users fields explain name, unique username and job expectation', /full name/i.test(guidance.name) && /unique/i.test(guidance.username) && /pharmacist|sales attendant/i.test(guidance.title), JSON.stringify(guidance));

    await go(page, '#/products', '#p-units-per-pack');
    guidance = await page.evaluate(() => ({
      units: document.getElementById('p-units-per-pack').placeholder,
      carton: document.getElementById('p-packs-per-carton').placeholder,
      reorder: document.getElementById('p-reorder').placeholder,
      nafdac: document.getElementById('p-nafdac').placeholder,
    }));
    check('Product fields explain pack, carton, reorder and NAFDAC entries', /base units/i.test(guidance.units) && /packs/i.test(guidance.carton) && /alert/i.test(guidance.reorder) && /registration/i.test(guidance.nafdac), JSON.stringify(guidance));

    console.log('\n=== PURCHASE ORDER GUIDANCE ===');
    await go(page, '#/purchase-orders', '#po-notes');
    guidance = await page.evaluate(() => ({
      notes: document.getElementById('po-notes').placeholder,
      qty: document.querySelector('[data-item-qty]').placeholder,
      qtyHelp: document.querySelector('[data-item-qty]').closest('.form-row').innerText,
      cost: document.querySelector('[data-item-cost]').placeholder,
      costHelp: document.querySelector('[data-item-cost]').closest('.form-row').innerText,
    }));
    check('PO notes explain the order reference/instruction expected', /quotation|delivery|reference/i.test(guidance.notes), guidance.notes);
    check('PO quantity explicitly says base units, not cartons', /base units/i.test(guidance.qty) || /base units/i.test(guidance.qtyHelp), JSON.stringify(guidance));
    check('PO unit cost explains one base unit and total-line calculation', /one base unit/i.test(guidance.costHelp) && /quantity/i.test(guidance.costHelp), guidance.costHelp);

    console.log('\n=== CASH / STOCK MOVEMENT GUIDANCE ===');
    const transferBranch = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const rows = await (await fetch('/api/branches', { headers: { authorization: `Bearer ${s.token}` } })).json();
      return rows.find((b) => b.is_active).id;
    });
    await page.evaluate((id) => State.setViewBranch(id), transferBranch);
    await go(page, '#/till', '#till-counted');
    guidance = await page.evaluate(() => ({ counted: document.getElementById('till-counted').placeholder }));
    check('Till count field explains the physical drawer count', /physical cash counted/i.test(guidance.counted), guidance.counted);
    await go(page, '#/transfers', '#tr-qty');
    guidance = await page.evaluate(() => ({ qty: document.getElementById('tr-qty').placeholder }));
    check('Stock transfer quantity explains base units sent', /base units/i.test(guidance.qty), guidance.qty);
  } finally {
    await browser.close();
  }
  console.log(`\nINPUT GUIDANCE PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
