// Browser regression probe: sign-in spinner must exist only while an actual
// login request is in flight, and logout must rebuild a clean idle form.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-submit');

    // Delay only the login call so the transient state is observable without
    // changing production code or relying on a slow network.
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.__loginLifecycleOriginalFetch = original;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (url === '/api/auth/login') {
          return new Promise((resolve, reject) => setTimeout(() => original(input, init).then(resolve, reject), 600));
        }
        return original(input, init);
      };
    });
    await page.type('#login-username', 'not-a-real-user');
    await page.type('#login-pin', '1234');
    await page.click('#login-submit');
    await sleep(80);
    const loading = await page.$eval('#login-submit', (button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      loading: button.classList.contains('is-loading'),
      text: button.textContent.trim(),
      spinner: !!button.querySelector('.login-submit-spinner'),
    }));
    check('spinner is ON while login is actually loading', loading.disabled && loading.busy === 'true' && loading.loading && loading.spinner && /Signing in/.test(loading.text), JSON.stringify(loading));
    await page.waitForSelector('#login-error:not(.hidden)', { timeout: 5000 });
    const idleAfterFailure = await page.$eval('#login-submit', (button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      loading: button.classList.contains('is-loading'),
      text: button.textContent.trim(),
      spinner: !!button.querySelector('.login-submit-spinner'),
    }));
    check('spinner turns OFF after a failed login', !idleAfterFailure.disabled && idleAfterFailure.busy === 'false' && !idleAfterFailure.loading && !idleAfterFailure.spinner && idleAfterFailure.text === 'Sign in', JSON.stringify(idleAfterFailure));

    // Restore ordinary fetch, sign in, then explicitly exercise the logout
    // path that previously revealed the stale animated submit button.
    await page.evaluate(() => { window.fetch = window.__loginLifecycleOriginalFetch; });
    await page.$eval('#login-username', (input) => { input.value = ''; });
    await page.$eval('#login-pin', (input) => { input.value = ''; });
    await page.type('#login-username', 'admin');
    await page.type('#login-pin', '1234');
    await page.click('#login-submit');
    await page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 12000 });
    await page.click('#logout-btn');
    await page.waitForFunction(() => !document.getElementById('login-screen').classList.contains('hidden'), { timeout: 5000 });
    const idleAfterLogout = await page.$eval('#login-submit', (button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      loading: button.classList.contains('is-loading'),
      text: button.textContent.trim(),
      spinner: !!button.querySelector('.login-submit-spinner'),
    }));
    check('logout restores a clean non-spinning Sign in button', !idleAfterLogout.disabled && idleAfterLogout.busy === 'false' && !idleAfterLogout.loading && !idleAfterLogout.spinner && idleAfterLogout.text === 'Sign in', JSON.stringify(idleAfterLogout));
  } finally {
    await browser.close();
  }
  console.log(`\nLOGIN LIFECYCLE PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((entry) => console.log(`  - ${entry}`));
    process.exit(1);
  }
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
