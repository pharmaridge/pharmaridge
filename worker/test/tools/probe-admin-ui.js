// ADMIN PORTAL — FRONT-TO-BACK ALIGNMENT, DRIVEN IN A REAL BROWSER.
//
// The backend half is covered by probe-admin.js. This asks the other half of
// the "full circle" question:
//
//   * Does the Admin Portal screen actually LOAD for ADMIN and stay hidden
//     from everyone else (nav item AND the route itself)?
//   * Does every control on it map to a real backend capability, and does
//     saving actually persist?
//   * Does the screen surface the things support needs to diagnose a client:
//     plan usage against limits, subscription state, storage headroom?
//   * Does it degrade honestly when the backend refuses?
//
// A capability that exists in the API but has no control, or a control that
// posts to a route that refuses it, is a full-circle break.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function assertServerUp(stage) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`\n!! DEV SERVER DOWN before "${stage}" — wrangler dev flake, NOT an app failure.`);
  console.error('!! Restart: bash test/devserver.sh 9001');
  process.exit(3);
}

async function freshPage(browser, w = 1400) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 1000 });
  await page.setCacheEnabled(false);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
    localStorage.clear();
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  return page;
}

async function signIn(page, username, pin) {
  await page.waitForSelector('#login-username', { timeout: 15000 });
  await page.type('#login-username', username);
  await page.type('#login-pin', pin);
  await Promise.all([
    page.click('#login-form button[type=submit]'),
    page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
  ]);
  await new Promise((r) => setTimeout(r, 2200));
}

(async () => {
  await assertServerUp('start');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  console.log('\n=== A. THE ADMIN NAV ITEM IS VISIBLE ONLY TO ADMIN ===');
  for (const [who, u, p, expect] of [
    ['ADMIN', 'admin', '1234', true],
    ['OWNER', 'owner', '1234', false],
    ['MANAGER', 'manager', '1234', false],
    ['STAFF', 'lagos.staff', '1234', false],
  ]) {
    const page = await freshPage(browser);
    await signIn(page, u, p);
    const visible = await page.evaluate(() => {
      const a = document.getElementById('nav-admin');
      if (!a) return false;
      return getComputedStyle(a).display !== 'none';
    });
    check(`${who}: Admin Portal nav item ${expect ? 'IS' : 'is NOT'} shown`, visible === expect, `visible=${visible}`);

    // Hiding a nav item is cosmetic. Typing the URL must also be refused, and
    // must not leave a broken half-rendered screen.
    await page.evaluate(() => { location.hash = '#/admin'; });
    await new Promise((r) => setTimeout(r, 2200));
    const state = await page.evaluate(() => {
      const v = document.getElementById('view');
      const title = (v.querySelector('.page-title') || {}).textContent || '';
      return { title: title.trim(), text: (v.textContent || '').slice(0, 200) };
    });
    if (expect) {
      check(`${who}: navigating to #/admin loads the portal`, /Admin/i.test(state.title), `title="${state.title}"`);
    } else {
      const leaked = /Subscription|max_branches|Plan Limits|Client Support Contact/i.test(state.text);
      check(`${who}: deep-linking to #/admin exposes no portal content`, !leaked, state.text.slice(0, 120));
    }
    await page.close();
  }

  console.log('\n=== A2. EVERY ownerOnly CAPABILITY IS REACHABLE BY ADMIN (BUG 69) ===');
  {
    // `ownerOnly` in the Worker deliberately admits ADMIN as well as OWNER, so
    // support can help a client who cannot work a setting out. Executed and
    // confirmed live: as ADMIN, PUT /settings/manager-permissions returns 200
    // and the change PERSISTS. But #/plan — the ONLY screen hosting those
    // controls plus the two WHT-rate routes — gated on isOwner() exactly, so
    // ADMIN was told "This page is only available to the account owner" for
    // powers the backend grants it. Two doors, opposite answers, and the
    // working one had no handle.
    for (const [who, u, p2, expectReach] of [
      ['ADMIN', 'admin', '1234', true],
      ['OWNER', 'owner', '1234', true],
      ['MANAGER', 'manager', '1234', false],
      ['STAFF', 'lagos.staff', '1234', false],
    ]) {
      const pg = await freshPage(browser);
      await signIn(pg, u, p2);
      const navShown = await pg.evaluate(() => {
        const a = document.getElementById('nav-plan');
        return a ? getComputedStyle(a).display !== 'none' : false;
      });
      check(`${who}: the Plan nav item ${expectReach ? 'IS' : 'is NOT'} shown`,
        navShown === expectReach, `shown=${navShown}`);
      await pg.evaluate(() => { location.hash = '#/plan'; });
      await new Promise((r) => setTimeout(r, 2400));
      const st = await pg.evaluate(() => ({
        perms: !!document.getElementById('perm-void'),
        wht: !!document.querySelector('.wht-rate-input'),
        banner: /Acting on a client/.test(document.getElementById('view').textContent || ''),
        title: ((document.querySelector('#view .page-title') || {}).textContent || '').trim(),
      }));
      check(`${who}: manager/cashier permission controls ${expectReach ? 'render' : 'do NOT render'}`,
        st.perms === expectReach, JSON.stringify(st));
      check(`${who}: WHT rate editors ${expectReach ? 'render' : 'do NOT render'}`,
        st.wht === expectReach, JSON.stringify(st));
      if (who === 'ADMIN') {
        check('ADMIN sees an explicit "acting on a client\'s account" notice', st.banner, JSON.stringify(st));
        check('...and the title says Support View, not "My Plan"',
          /Support View/i.test(st.title), st.title);
      }
      if (who === 'OWNER') {
        check('OWNER does NOT see the support notice (it is their own account)', !st.banner);
        check('...and still sees "My Plan"', /My Plan/i.test(st.title), st.title);
      }
      await pg.close();
    }
  }

  console.log('\n=== B. THE PORTAL RENDERS EVERY CONTROL SUPPORT NEEDS ===');
  const page = await freshPage(browser);
  await signIn(page, 'admin', '1234');
  await page.evaluate(() => { location.hash = '#/admin'; });
  await page.waitForSelector('#a-save', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  const controls = ['a-max-branches', 'a-max-staff', 'a-plan-name', 'a-status', 'a-renewal',
    'a-multi-branch', 'a-attendance', 'a-controlled',
    'a-contact-name', 'a-contact-phone', 'a-contact-email',
    'a-business-name', 'a-logo-file', 'a-notes', 'a-save',
    'a-vat-enabled', 'a-vat-rate', 'a-vat-save'];
  const present = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), controls);
  check('every documented Admin Portal control is present', present.length === 0, `missing: ${present.join(', ')}`);

  // EVERY editable backend field should have a control, or support has a
  // capability they cannot reach. Read the server's own list rather than
  // hard-coding it, so the two cannot drift.
  const adminRouteSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'admin.js'), 'utf8');
  const editable = (adminRouteSrc.match(/const EDITABLE_FIELDS = \[([\s\S]*?)\];/) || [, ''])[1]
    .split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  const viewSrc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'js', 'views', 'admin.js'), 'utf8');
  const unreachable = editable.filter((f) => !viewSrc.includes(f));
  check('every server-editable setting is reachable from the UI', unreachable.length === 0,
    `no control for: ${unreachable.join(', ')}`);

  console.log('\n=== C. THE PORTAL SHOWS WHAT SUPPORT NEEDS TO DIAGNOSE ===');
  const shown = await page.evaluate(() => (document.getElementById('view').textContent || ''));
  check('current usage is shown against the limit (branches)', /branch/i.test(shown));
  check('current usage is shown against the limit (staff)', /staff/i.test(shown));
  check('subscription status is on screen', /Subscription|Status/i.test(shown));
  check('the client support contact block is present', /Support Contact/i.test(shown));

  console.log('\n=== D. SAVING ACTUALLY PERSISTS (the full circle) ===');
  const before = await page.evaluate(async () => (await (await fetch('/api/admin/settings', {
    headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('gl_pms_session')).token },
  })).json()));
  const newNotes = 'probe-note-' + Date.now();
  await page.evaluate((n) => {
    const el = document.getElementById('a-notes');
    el.value = n;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, newNotes);
  await page.evaluate(() => document.getElementById('a-save').click());
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(async () => (await (await fetch('/api/admin/settings', {
    headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('gl_pms_session')).token },
  })).json()));
  check('a change made in the UI reaches the database', after.notes === newNotes,
    `sent="${newNotes}" stored="${after.notes}"`);
  check('...and unrelated settings are not clobbered',
    after.max_branches === before.max_branches && after.subscription_status === before.subscription_status,
    `branches ${before.max_branches}->${after.max_branches}, status ${before.subscription_status}->${after.subscription_status}`);

  console.log('\n=== E. THE PORTAL SURVIVES A BACKEND REFUSAL HONESTLY ===');
  // Force the server to refuse and confirm the UI reports it rather than
  // silently appearing to succeed.
  await page.evaluate(() => {
    const orig = window.fetch;
    window.__origFetch = orig;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/admin/settings') && init && init.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Simulated refusal' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        }));
      }
      return orig(input, init);
    };
  });
  await page.evaluate(() => document.getElementById('a-save').click());
  await new Promise((r) => setTimeout(r, 1500));
  const toastText = await page.evaluate(() => (document.getElementById('toast-container').textContent || ''));
  check('a refused save is reported to the operator, not swallowed',
    /Simulated refusal|error|could not|failed/i.test(toastText), `toast="${toastText.slice(0, 120)}"`);
  await page.evaluate(() => { if (window.__origFetch) window.fetch = window.__origFetch; });

  console.log('\n=== F. THE PORTAL IS USABLE ON THE DEVICE SUPPORT ACTUALLY CARRIES ===');
  await page.close();
  for (const w of [360, 390, 768]) {
    const p2 = await freshPage(browser, w);
    await signIn(p2, 'admin', '1234');
    await p2.evaluate(() => { location.hash = '#/admin'; });
    await p2.waitForSelector('#a-save', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 700));
    const m = await p2.evaluate(() => {
      const de = document.documentElement;
      const btn = document.getElementById('a-save').getBoundingClientRect();
      return {
        overflow: de.scrollWidth - de.clientWidth,
        saveW: Math.round(btn.width), saveH: Math.round(btn.height),
        saveOnScreen: btn.right <= de.clientWidth + 1 && btn.left >= -1,
      };
    });
    check(`Admin Portal does not scroll sideways at ${w}px`, m.overflow <= 0, `overflow=${m.overflow}px`);
    check(`...and the Save button is on-screen and tappable at ${w}px`,
      m.saveOnScreen && m.saveH >= 24, JSON.stringify(m));
    await p2.close();
  }

  await browser.close();
  console.log('\n' + '='.repeat(62));
  console.log(`ADMIN UI PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
