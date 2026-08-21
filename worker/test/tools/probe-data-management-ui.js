// OWNER DATA MANAGEMENT — browser/API correlation probe.
//
// This checks the new destructive-data control from both directions without
// ever executing a deletion against a scenario database. The Owner gets a
// reachable, labelled control and a five-scope preview; General Manager and
// Admin are denied by BOTH the DOM and the live API. An invalid server-side
// purge request proves a forged browser request cannot skip confirmation.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function browserSession(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u) => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    set('login-username', u); set('login-pin', '1234');
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, username);
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  // Let the post-login dashboard render settle before changing the hash. The
  // router deliberately discards stale renders; navigating in that same tick
  // races its initial dashboard request and can leave a test on Loading….
  await sl(2400);
  await page.evaluate(() => { location.hash = '#/plan'; });
  // My Plan fetches permissions, VAT, WHT, plan use and (for an Owner) data
  // management independently. A fixed short pause races slower local D1/edge
  // responses and can inspect the old dashboard DOM instead of the plan. Wait
  // for the actual screen heading, then give its Owner-only card time to paint.
  await page.waitForFunction(() => /My Plan|Cashier Spending Allowance|Client Plan/.test((document.getElementById('view') || document.body).innerText), { timeout: 25000 });
  await sl(1800);
  return { ctx, page };
}

async function apiLogin(username) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin: '1234' }),
  });
  const body = await r.json();
  return { status: r.status, ...body };
}
async function api(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, body: json };
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    console.log('\n=== OWNER: CONTROL, MODES AND MOBILE GEOMETRY ===');
    const owner = await browserSession(browser, 'owner');
    const ownerControl = await owner.page.evaluate(() => {
      const b = document.getElementById('owner-data-management');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      return { present: true, text: b.textContent.trim(), left: r.left, right: r.right, width: r.width, viewport: innerWidth };
    });
    check('Owner sees the data-management trigger on My Plan', ownerControl.present && /Review data-management options/i.test(ownerControl.text), JSON.stringify(ownerControl));
    check('Owner data-management trigger fits a 390px phone', ownerControl.present && ownerControl.left >= 0 && ownerControl.right <= ownerControl.viewport && ownerControl.width >= 44, JSON.stringify(ownerControl));

    await owner.page.click('#owner-data-management');
    await owner.page.waitForSelector('#dm-mode', { timeout: 10000 });
    const modal = await owner.page.evaluate(() => ({
      title: document.querySelector('.modal h2') && document.querySelector('.modal h2').textContent.trim(),
      options: [...document.querySelectorAll('#dm-mode option')].map((o) => ({ value: o.value, label: o.textContent.trim() })),
      hasExportAck: !!document.getElementById('dm-preview'),
      overflows: document.documentElement.scrollWidth > innerWidth,
    }));
    check('Owner modal names the irreversible data-management decision', /Owner Data Management/i.test(modal.title || ''), JSON.stringify(modal));
    check('Owner modal offers period, all-business, both continuity and full-team scopes',
      modal.options.map((o) => o.value).join(',') === 'PERIOD,ALL_BUSINESS_DATA,CLEAR_OPERATIONAL_KEEP_ACCOUNTING,CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK,FULL_SETUP_RESET', JSON.stringify(modal.options));
    check('Owner modal has no horizontal overflow on phone', !modal.overflows, JSON.stringify(modal));

    await owner.page.select('#dm-mode', 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK');
    const continuityHelp = await owner.page.evaluate(() => ({
      detail: document.getElementById('dm-mode-help').innerText,
      protected: document.getElementById('dm-mode-retains').innerText,
    }));
    check('stock-continuity choice explains both deleted operations and protected stock/accounting', /in-stock batches/i.test(continuityHelp.detail) && /current in-stock batches/i.test(continuityHelp.protected), JSON.stringify(continuityHelp));

    await owner.page.select('#dm-mode', 'PERIOD');
    const periodInputs = await owner.page.evaluate(() => ({ start: !!document.getElementById('dm-start'), end: !!document.getElementById('dm-end'), shown: document.getElementById('dm-period').style.display !== 'none' }));
    check('period scope reveals both inclusive date inputs', periodInputs.start && periodInputs.end && periodInputs.shown, JSON.stringify(periodInputs));
    await owner.page.$eval('#dm-start', (el) => { el.value = '2000-01-01'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await owner.page.$eval('#dm-end', (el) => { el.value = new Date().toISOString().slice(0, 10); el.dispatchEvent(new Event('input', { bubbles: true })); });
    await owner.page.click('#dm-preview-button');
    await owner.page.waitForFunction(() => /Preview: Delete selected period|Cannot run yet|records currently match/i.test(document.getElementById('dm-preview').innerText), { timeout: 15000 });
    const preview = await owner.page.$eval('#dm-preview', (el) => el.innerText);
    check('preview is a live server response before any delete button is enabled', /records currently match|Cannot run yet/i.test(preview), preview.slice(0, 180));
    await owner.ctx.close();

    console.log('\n=== MANAGER / ADMIN: NO FRONT-END DOOR ===');
    for (const username of ['c.gm', 'admin']) {
      const s = await browserSession(browser, username);
      const present = await s.page.evaluate(() => !!document.getElementById('owner-data-management'));
      check(`${username} does not receive the Owner data-management trigger`, !present, `present=${present}`);
      await s.ctx.close();
    }

    console.log('\n=== SERVER: ROLE AND CONFIRMATION BOUNDARIES ===');
    // Browser Owner session is closed, so this sign-in does not displace a
    // still-active test context under the one-active-session policy.
    const o = await apiLogin('owner');
    const gm = await apiLogin('c.gm');
    const admin = await apiLogin('admin');
    const ownerStatus = await api(o.token, 'GET', '/api/data-management/status');
    const gmStatus = await api(gm.token, 'GET', '/api/data-management/status');
    const adminStatus = await api(admin.token, 'GET', '/api/data-management/status');
    check('Owner API can read data-management status', ownerStatus.status === 200 && Array.isArray(ownerStatus.body.modes), `status=${ownerStatus.status}`);
    check('General Manager API is refused the destructive endpoint', gmStatus.status === 403 && gmStatus.body.code === 'OWNER_DATA_MANAGEMENT_REQUIRED', JSON.stringify(gmStatus.body));
    check('Admin/support API is refused the destructive endpoint', adminStatus.status === 403 && adminStatus.body.code === 'OWNER_DATA_MANAGEMENT_REQUIRED', JSON.stringify(adminStatus.body));
    const rejected = await api(o.token, 'POST', '/api/data-management/purge', {
      mode: 'FULL_SETUP_RESET', confirmation: 'not the required phrase', export_confirmed: true, retention_acknowledged: true,
    });
    check('server rejects a forged purge without the exact typed phrase', rejected.status === 400 && /Type exactly/i.test(rejected.body && rejected.body.error), JSON.stringify(rejected.body));
  } finally {
    await browser.close();
  }
  console.log(`\nDATA-MANAGEMENT UI PROBE: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
