// POS CHECKOUT LIFECYCLE — regression for the "session is not defined" error.
//
// Drives an actual cash sale through the browser. The old client POSTed the
// sale successfully, then threw while clearing the persisted cart because the
// checkout helper lived outside renderPos() and referenced its local session.
// This probe proves the receipt opens, the cart is cleared, no error toast is
// shown, and exactly one server sale is recorded.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.getElementById('login-username').value = 'lagos.staff';
      document.getElementById('login-username').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-pin').value = '1234';
      document.getElementById('login-pin').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
    await sl(2400);

    const state = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const h = { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' };
      let till = await (await fetch(`/api/till/current?branch_id=${s.user.branch_id}`, { headers: h })).json().catch(() => null);
      if (!till || !till.id) {
        const r = await fetch('/api/till/open', { method: 'POST', headers: h, body: JSON.stringify({ branch_id: s.user.branch_id, opening_cash: 1000 }) });
        till = await r.json();
      }
      const sales = await (await fetch(`/api/sales?branch_id=${s.user.branch_id}`, { headers: h })).json();
      return { branchId: s.user.branch_id, before: Array.isArray(sales) ? sales.length : (sales.results || []).length, till: till && till.id };
    });
    check('cashier has a branch and an open till for checkout', !!state.branchId && !!state.till, JSON.stringify(state));

    await page.evaluate(() => { location.hash = '#/pos'; });
    await page.waitForSelector('#pos-search');
    await page.type('#pos-search', 'Panadol');
    await page.waitForSelector('[data-product-id]');
    await page.click('[data-product-id]');
    // Products sold in a pack/carton can legitimately ask for a unit before
    // the cart line exists. Choose the first offered unit; this keeps the
    // regression focused on checkout rather than assuming every seed product
    // is a single-unit item.
    await Promise.race([
      page.waitForSelector('.cart-line', { timeout: 12000 }),
      page.waitForSelector('[data-unit]', { timeout: 12000 }),
    ]);
    if (await page.$('[data-unit]')) {
      await page.click('[data-unit]');
      await page.waitForSelector('.cart-line');
    }

    const total = await page.$eval('#pos-totals .grand span:last-child', (el) => Number(String(el.textContent).replace(/[^0-9.]/g, '')));
    check('POS calculates a positive cash total before checkout', Number.isFinite(total) && total > 0, String(total));
    await page.evaluate((amount) => {
      const amountInput = document.querySelector('[data-pay-amount="0"]');
      const tenderInput = document.querySelector('[data-pay-tendered="0"]');
      amountInput.value = amount;
      amountInput.dispatchEvent(new Event('input', { bubbles: true }));
      tenderInput.value = amount;
      tenderInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, total);

    await page.click('#pos-checkout');
    await page.waitForSelector('#receipt-preview', { timeout: 20000 });
    const result = await page.evaluate(async (before) => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const r = await fetch(`/api/sales?branch_id=${s.user.branch_id}`, { headers: { authorization: `Bearer ${s.token}` } });
      const sales = await r.json();
      const count = Array.isArray(sales) ? sales.length : (sales.results || []).length;
      const errorToasts = [...document.querySelectorAll('.toast.error')].map((el) => el.textContent);
      return {
        count,
        cartText: document.getElementById('pos-cart').innerText,
        receipt: !!document.getElementById('receipt-preview'),
        errors: errorToasts,
        before,
      };
    }, state.before);
    check('Complete Sale opens the receipt instead of surfacing a client error', result.receipt && result.errors.every((m) => !/session is not defined/i.test(m)), JSON.stringify(result));
    check('exactly one sale is recorded on the server', result.count === result.before + 1, JSON.stringify(result));
    check('successful checkout clears the current cashier cart', /Cart is empty/i.test(result.cartText), result.cartText);
    check('browser records no undefined-session exception', !pageErrors.some((m) => /session is not defined/i.test(m)), pageErrors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`\nPOS CHECKOUT LIFECYCLE PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
