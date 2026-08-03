const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const OUT = '/home/user';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const mode of ['light', 'dark']) {
    // Login screen.
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await page.setCacheEnabled(false);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
      if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      localStorage.clear();
    });
    await page.evaluate((m) => localStorage.setItem('gl_pms_theme', m), mode);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-username');
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: `${OUT}/shot-${mode}-login.png` });

    // Log in, then capture the key screens.
    await page.type('#login-username', 'manager');
    await page.type('#login-pin', '1234');
    await Promise.all([
      page.click('#login-form button[type=submit]'),
      page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
    ]);
    await new Promise((r) => setTimeout(r, 3000));
    await page.screenshot({ path: `${OUT}/shot-${mode}-dashboard.png` });

    for (const [hash, name] of [['#/pos','pos'],['#/stock','stock'],['#/accounting','accounting'],['#/sync','sync']]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await new Promise((r) => setTimeout(r, 2600));
      await page.screenshot({ path: `${OUT}/shot-${mode}-${name}.png` });
    }
    await page.close();

    // Mobile, drawer open.
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setCacheEnabled(false);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate((m) => { localStorage.clear(); localStorage.setItem('gl_pms_theme', m); }, mode);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-username');
    await page.type('#login-username', 'manager');
    await page.type('#login-pin', '1234');
    await Promise.all([
      page.click('#login-form button[type=submit]'),
      page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
    ]);
    await new Promise((r) => setTimeout(r, 2600));
    await page.screenshot({ path: `${OUT}/shot-${mode}-mobile.png` });
    await page.evaluate(() => window.App._setNav(true));
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: `${OUT}/shot-${mode}-mobile-nav.png` });
    await page.close();
  }

  await browser.close();
  console.log('screenshots written');
})();
