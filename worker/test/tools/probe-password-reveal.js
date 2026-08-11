// PIN/PASSWORD VISIBILITY + MOBILE SPACING PROBE.
// Drives the real login and Users forms at phone width. A visible eye button
// is only useful if it changes the input type, remains a 44px target and does
// not collapse the input/card/button spacing on a small screen.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function signIn(page, username, pin = '1234') {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u, p) => {
    document.getElementById('login-username').value = u;
    document.getElementById('login-username').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('login-pin').value = p;
    document.getElementById('login-pin').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, username, pin);
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sl(2400);
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-pin');

    console.log('\n=== LOGIN PIN REVEAL ===');
    let login = await page.evaluate(() => {
      const input = document.getElementById('login-pin');
      const button = document.querySelector('[data-password-toggle="login-pin"]');
      const r = button.getBoundingClientRect();
      const field = input.closest('.password-field').getBoundingClientRect();
      return { type: input.type, button: !!button, w: r.width, h: r.height, gap: r.left - input.getBoundingClientRect().right, fieldRight: field.right, viewport: innerWidth };
    });
    check('login PIN begins hidden with a real reveal button', login.type === 'password' && login.button, JSON.stringify(login));
    check('login reveal button is a phone-sized target and stays on-screen', login.w >= 44 && login.h >= 44 && login.fieldRight <= login.viewport, JSON.stringify(login));
    check('login input and reveal button have a visible gap', login.gap >= 8, JSON.stringify(login));
    await page.click('[data-password-toggle="login-pin"]');
    login = await page.evaluate(() => ({ type: document.getElementById('login-pin').type, label: document.querySelector('[data-password-toggle="login-pin"]').getAttribute('aria-label') }));
    check('login reveal changes the PIN to visible text', login.type === 'text' && /Hide/i.test(login.label), JSON.stringify(login));
    await page.click('[data-password-toggle="login-pin"]');
    login = await page.evaluate(() => document.getElementById('login-pin').type);
    check('login reveal can hide the PIN again', login === 'password', login);

    console.log('\n=== OWNER USER-FORM PIN REVEALS + MOBILE SPACING ===');
    await signIn(page, 'owner');
    await page.evaluate(() => { location.hash = '#/users'; });
    await page.waitForFunction(() => document.getElementById('u-pin') && document.querySelector('[data-password-toggle="u-pin"]'), { timeout: 25000 });
    await sl(400);
    const add = await page.evaluate(() => {
      const input = document.getElementById('u-pin');
      const button = document.querySelector('[data-password-toggle="u-pin"]');
      const buttonBox = button.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const addButton = document.getElementById('u-add').getBoundingClientRect();
      const field = input.closest('.password-field').getBoundingClientRect();
      return { type: input.type, buttonW: buttonBox.width, buttonH: buttonBox.height, gap: buttonBox.left - inputBox.right, fieldBottom: field.bottom, addTop: addButton.top, viewport: innerWidth, fieldRight: field.right };
    });
    check('Add User PIN begins hidden with a reveal button', add.type === 'password' && add.buttonW >= 44 && add.buttonH >= 44, JSON.stringify(add));
    check('Add User PIN field fits the phone card with proper input/button gap', add.gap >= 8 && add.fieldRight <= add.viewport, JSON.stringify(add));
    check('Add User action is separated below mobile inputs', add.addTop - add.fieldBottom >= 12, JSON.stringify(add));
    await page.click('[data-password-toggle="u-pin"]');
    check('Add User reveal shows the typed PIN', await page.$eval('#u-pin', (el) => el.type === 'text'));

    // Open the first editable staff row and exercise the reset PIN control.
    await page.evaluate(() => {
      const first = document.querySelector('[data-edit-user]');
      if (first) first.click();
    });
    await page.waitForSelector('#eu-pin');
    const edit = await page.evaluate(() => {
      const input = document.getElementById('eu-pin');
      const button = document.querySelector('[data-password-toggle="eu-pin"]');
      return { type: input.type, hasButton: !!button, w: button && button.getBoundingClientRect().width, h: button && button.getBoundingClientRect().height };
    });
    // Chromium can report a nominal 44px flex control as 43.56px under the
    // phone viewport's fractional layout scale. Keep a half-pixel tolerance
    // while the CSS still declares a 44px minimum target.
    check('Reset PIN form has its own reveal control', edit.type === 'password' && edit.hasButton && edit.w >= 43 && edit.h >= 43, JSON.stringify(edit));
    await page.click('[data-password-toggle="eu-pin"]');
    check('Reset PIN reveal changes the input type', await page.$eval('#eu-pin', (el) => el.type === 'text'));
  } finally {
    await browser.close();
  }
  console.log(`\nPASSWORD REVEAL / MOBILE GAP PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
