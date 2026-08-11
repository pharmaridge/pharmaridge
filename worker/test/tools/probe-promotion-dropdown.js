// PROMOTION DROPDOWN FRONT-END / BACK-END ALIGNMENT.
// Checks the exact role choices offered by the Transfer & Promote modal for
// Owner, General Manager and Branch Manager. The server-side authority matrix
// is exercised by audit.promotionauthority.js; this probe ensures no role is
// offered in the UI when the server would reject it.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function openTransfer(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u) => {
    for (const [id, value] of [['login-username', u], ['login-pin', '1234']]) {
      const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, username);
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sl(2400);
  await page.evaluate(() => { location.hash = '#/users'; });
  await page.waitForSelector('[data-edit-user]', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-edit-user]').click());
  await page.waitForSelector('#eu-transfer');
  await page.click('#eu-transfer');
  await page.waitForSelector('#tr-role');
  const options = await page.$$eval('#tr-role option', (els) => els.map((o) => o.value));
  return { ctx, page, options };
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const owner = await openTransfer(browser, 'owner');
    check('Owner promotion dropdown includes Staff, Branch Manager, General Manager and Owner',
      owner.options.join(',') === 'STAFF,BRANCH_MANAGER,GENERAL_MANAGER,OWNER', owner.options.join(','));
    await owner.ctx.close();

    const gm = await openTransfer(browser, 'manager');
    check('General Manager can appoint another General Manager but not an Owner',
      gm.options.includes('GENERAL_MANAGER') && !gm.options.includes('OWNER'), gm.options.join(','));
    await gm.ctx.close();

    const bm = await openTransfer(browser, 'lagos.mgr');
    check('Branch Manager sees only branch-scoped Staff/Branch Manager promotion choices',
      bm.options.join(',') === 'STAFF,BRANCH_MANAGER', bm.options.join(','));
    await bm.ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\nPROMOTION DROPDOWN PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
