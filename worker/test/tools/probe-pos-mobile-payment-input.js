// MOBILE POS PAYMENT-INPUT STABILITY PROBE
//
// A tender/change input must keep its exact DOM node and focus through every
// digit. Rebuilding #pos-payments on input replaces the focused element and
// dismisses the mobile numeric keyboard. This probe drives a real mobile POS
// sale one character at a time, then completes it through the API/UI flow.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }

async function typeWithoutLosingFocus(page, selector, value, tag, afterDigit) {
  await page.focus(selector);
  await page.evaluate((sel, marker) => {
    const input = document.querySelector(sel);
    input.dataset.mobileFocusProbe = marker;
    window.__mobileFocusProbe = input;
  }, selector, tag);
  const states = [];
  for (const char of String(value)) {
    await page.keyboard.type(char);
    if (afterDigit) await afterDigit();
    states.push(await page.evaluate(() => {
      const original = window.__mobileFocusProbe;
      const current = document.querySelector(`[data-mobile-focus-probe="${original && original.dataset.mobileFocusProbe}"]`);
      return {
        originalConnected: !!(original && original.isConnected),
        sameElement: original === current,
        focused: document.activeElement === original,
        value: original && original.value,
      };
    }));
  }
  return states;
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      document.getElementById('login-username').value = 'lagos.staff';
      document.getElementById('login-username').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-pin').value = '1234';
      document.getElementById('login-pin').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
    await sleep(1800);
    await page.evaluate(async () => {
      const session = JSON.parse(localStorage.getItem('gl_pms_session'));
      const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
      const current = await (await fetch(`/api/till/current?branch_id=${session.user.branch_id}`, { headers })).json().catch(() => null);
      if (!current || !current.id) await fetch('/api/till/open', { method: 'POST', headers, body: JSON.stringify({ branch_id: session.user.branch_id, opening_cash: 1000 }) });
    });
    await page.evaluate(() => { location.hash = '#/pos'; });
    await page.waitForSelector('#pos-search');
    await page.type('#pos-search', 'Panadol');
    await page.waitForSelector('[data-product-id]');
    await page.click('[data-product-id]');
    await Promise.race([page.waitForSelector('.cart-line'), page.waitForSelector('[data-unit]')]);
    if (await page.$('[data-unit]')) { await page.click('[data-unit]'); await page.waitForSelector('.cart-line'); }
    const total = await page.$eval('#pos-totals .grand span:last-child', (el) => Number(String(el.textContent).replace(/[^0-9.]/g, '')));
    check('mobile POS has a positive total before payment entry', Number.isFinite(total) && total > 0, String(total));
    await page.$eval('[data-pay-amount="0"]', (input, amount) => {
      input.value = String(amount); input.dispatchEvent(new Event('input', { bubbles: true }));
    }, total);

    const tender = String(Math.ceil(total) + 100);
    const tenderStates = await typeWithoutLosingFocus(page, '[data-pay-tendered="0"]', tender, 'tender-field');
    check('cash-tendered input keeps the original focused element for every digit', tenderStates.length === tender.length && tenderStates.every((s) => s.originalConnected && s.sameElement && s.focused), JSON.stringify(tenderStates));
    check('cash-tendered input accepts the full number in one uninterrupted entry', tenderStates.at(-1).value === tender, JSON.stringify(tenderStates.at(-1)));

    const owed = '50';
    const owedStates = await typeWithoutLosingFocus(page, '[data-pay-owed="0"]', owed, 'owed-field', async () => {
      await page.waitForFunction(() => !document.getElementById('pos-change-owed-row').classList.contains('hidden'), { timeout: 5000 });
    });
    check('change-owed input keeps the original focused element while its customer fields appear', owedStates.length === owed.length && owedStates.every((s) => s.originalConnected && s.sameElement && s.focused), JSON.stringify(owedStates));
    check('change-owed input accepts the full number in one uninterrupted entry', owedStates.at(-1).value === owed, JSON.stringify(owedStates.at(-1)));
    const changeFieldsVisible = await page.$eval('#pos-change-owed-row', (el) => !el.classList.contains('hidden'));
    check('customer claim fields appear without replacing the change-owed input', changeFieldsVisible, String(changeFieldsVisible));

    await page.type('#pos-change-name', 'Mobile Input Customer');
    await page.click('#pos-checkout');
    await page.waitForSelector('#receipt-preview', { timeout: 20000 });
    const outcome = await page.evaluate(() => ({
      receipt: !!document.getElementById('receipt-preview'),
      errors: [...document.querySelectorAll('.toast.error')].map((el) => el.textContent),
      tender: document.querySelector('[data-pay-tendered="0"]'),
    }));
    check('mobile entry still completes a valid change-owed sale', outcome.receipt && outcome.errors.length === 0, JSON.stringify(outcome));
    check('no browser exception occurs during mobile payment input', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`\nMOBILE POS PAYMENT INPUT PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
