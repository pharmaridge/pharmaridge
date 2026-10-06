// TURSO BROWSER/PWA AUDIT — runs only against the disposable local Worker
// that is configured with DATABASE_PROVIDER=TURSO by the rehearsal runner.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9002';
const USERNAME = process.env.REHEARSAL_ADMIN_USERNAME;
const PIN = process.env.REHEARSAL_ADMIN_PIN;

let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }

(async () => {
  if (!USERNAME || !PIN) throw new Error('Temporary rehearsal Admin credentials are required.');
  console.log('=== TURSO BROWSER / PWA AUDIT ===');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    const loginGeometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth, form: !!document.getElementById('login-form') }));
    check('mobile Turso login screen renders without horizontal overflow', loginGeometry.form && loginGeometry.scroll <= loginGeometry.viewport, JSON.stringify(loginGeometry));
    await page.evaluate(({ username, pin }) => {
      document.getElementById('login-username').value = username;
      document.getElementById('login-pin').value = pin;
      document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, { username: USERNAME, pin: PIN });
    await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const appGeometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth, page: !!document.querySelector('.topbar'), provider: location.origin }));
    check('mobile Turso app shell renders without horizontal overflow', appGeometry.page && appGeometry.scroll <= appGeometry.viewport, JSON.stringify(appGeometry));
    const pwa = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const cacheNames = await caches.keys();
      return { scope: registration.scope, cacheNames, barcodeSvg: window.BarcodeLabel && window.BarcodeLabel.svg('INT-PWA-AUDIT').includes('<svg') };
    });
    check('PWA registers a service worker with the v89 shell cache', !!pwa.scope && pwa.cacheNames.includes('pharmaridge-v89'), JSON.stringify(pwa));
    check('barcode label renderer is available in the real Turso PWA shell', pwa.barcodeSvg === true, JSON.stringify(pwa));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
    const offlineShell = await page.evaluate(() => !!document.getElementById('login-screen') || !!document.querySelector('.topbar'));
    check('cached PWA shell remains reachable offline after a Turso-backed launch', offlineShell, String(offlineShell));
    await page.setOfflineMode(false);
    check('no browser script error occurred in the Turso PWA flow', errors.length === 0, JSON.stringify(errors));
  } finally {
    await browser.close();
  }
  console.log(`\nTURSO BROWSER / PWA AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
