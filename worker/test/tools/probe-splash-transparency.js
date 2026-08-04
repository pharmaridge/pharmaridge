// PWA SPLASH + TRANSPARENT LAUNCHER SURFACE PROBE.
//
// The first paint is normally too brief to inspect, so this browser probe
// delays the public branding request. It measures the actual rendered splash,
// not source text: dark green surface, no card/tile behind the transparent
// lockup, then the transparent login mark and bare mobile theme glyph.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (/\/api\/branding(?:\?|$)/.test(request.url())) setTimeout(() => request.continue(), 900);
      else request.continue();
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login-loading-logo', { timeout: 10000 });
    const splash = await page.evaluate(() => {
      const screen = document.getElementById('login-screen');
      const loading = document.querySelector('.login-loading');
      const wrap = document.querySelector('.login-loading-logo-wrap');
      const logo = document.querySelector('.login-loading-logo');
      return {
        loading: screen.classList.contains('is-loading'),
        screenBg: getComputedStyle(screen).backgroundColor,
        loadingBg: getComputedStyle(loading).backgroundColor,
        wrapBg: getComputedStyle(wrap).backgroundColor,
        wrapBorder: getComputedStyle(wrap).borderTopColor,
        wrapShadow: getComputedStyle(wrap).boxShadow,
        logoBg: getComputedStyle(logo).backgroundColor,
        logoSrc: logo.getAttribute('src'),
      };
    });
    check('first paint remains in the explicit loading state while branding loads', splash.loading, JSON.stringify(splash));
    check('first-paint splash uses the PharmaRidge deep-green system surface', splash.screenBg === 'rgb(10, 59, 44)', splash.screenBg);
    check('loader carrier has no coloured background tile', splash.loadingBg === 'rgba(0, 0, 0, 0)' && splash.wrapBg === 'rgba(0, 0, 0, 0)', JSON.stringify(splash));
    check('loader carrier has no border or shadow tile', splash.wrapShadow === 'none', JSON.stringify(splash));
    check('splash uses the transparent PharmaRidge PWA lockup', splash.logoBg === 'rgba(0, 0, 0, 0)' && /pharmaridge-pwa-logo\.png$/.test(splash.logoSrc), JSON.stringify(splash));

    await page.waitForSelector('#login-theme-toggle', { timeout: 15000 });
    await sl(200);
    const login = await page.evaluate(() => {
      const toggle = document.getElementById('login-theme-toggle');
      const stage = document.querySelector('.login-logo-stage-transparent');
      const mark = document.querySelector('.login-logo-product');
      return {
        toggleBg: getComputedStyle(toggle).backgroundColor,
        toggleBorder: getComputedStyle(toggle).borderTopColor,
        stageBg: stage ? getComputedStyle(stage).backgroundColor : null,
        stageShadow: stage ? getComputedStyle(stage).boxShadow : null,
        markBg: mark ? getComputedStyle(mark).backgroundColor : null,
        markSrc: mark && mark.getAttribute('src'),
      };
    });
    check('mobile login theme control is a bare transparent glyph', login.toggleBg === 'rgba(0, 0, 0, 0)', JSON.stringify(login));
    check('login mark carrier remains transparent', login.stageBg === 'rgba(0, 0, 0, 0)' && login.stageShadow === 'none' && login.markBg === 'rgba(0, 0, 0, 0)', JSON.stringify(login));
    check('login uses the transparent PharmaRidge mark', /pharmaridge-mark\.png$/.test(login.markSrc || ''), login.markSrc);
  } finally {
    await browser.close();
  }
  console.log(`\nSPLASH / TRANSPARENCY PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
