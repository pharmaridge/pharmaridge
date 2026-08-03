// BROWSER PROBE — Transfer & Promote + force clock-out, driven in real Chromium.
//
// Source-reading is not proof (trap: "a documented guarantee that was never
// executed is not a guarantee"). This drives the ACTUAL UI: opens the modal,
// picks a role, submits, and re-reads the users table to confirm the change
// landed and is visible to the operator.
//
// Requires: bash test/devserver.sh 9001
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; fails.push(n); console.log('  ❌ ' + n + (d ? '  → ' + d : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, username, pin = '1234') {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  // Trusted input dies after login in headless Chrome, so set values directly
  // and dispatch the events the app listens for.
  await page.evaluate((u, p) => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('login-username', u);
    set('login-pin', p);
  }, username, pin);
  // It is a FORM submit, not a standalone button — my first version guessed
  // '#login-btn' and crashed. Read the markup, do not assume it.
  await page.evaluate(() => document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  // The login screen is HIDDEN, not removed — waiting for the form to vanish
  // times out even though login succeeded. Wait for the session instead, which
  // is the thing that actually signifies "logged in".
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('login-screen');
    return el && el.classList.contains('hidden');
  }, { timeout: 20000 });
}

(async () => {
  console.log('=== TRANSFER & PROMOTE — BROWSER PROBE ===');
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e) {
    console.log('server not reachable: ' + e.message + '\nRun: bash test/devserver.sh 9001');
    process.exit(3);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    // A stale service worker will serve the OLD bundle and every assertion
    // below would then be testing yesterday's code.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      if (navigator.serviceWorker) {
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const ks = await caches.keys();
        await Promise.all(ks.map((k) => caches.delete(k)));
      }
    });

    await login(page, 'owner');
    ok('owner signs in', true);

    await page.goto(BASE + '/#/users', { waitUntil: 'networkidle0' });
    await sleep(1200);

    // Pick a STAFF row explicitly. An earlier version matched "Bisi Adewale" by
    // name and a later one took the FIRST edit button — which is the org-wide
    // General Manager, for whom the Branch field is CORRECTLY hidden, so the
    // probe failed while the app was right. Select by the role we intend to
    // test, and assert we actually found one rather than skipping.
    const target = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const r = await fetch('/api/users', { headers: { authorization: 'Bearer ' + s.token } });
      const users = await r.json();
      const staff = (Array.isArray(users) ? users : []).find((u) => u.role === 'STAFF' && u.is_active);
      if (!staff) return null;
      const btn = document.querySelector(`[data-edit-user="${staff.id}"]`);
      return btn ? { id: staff.id, name: staff.full_name } : null;
    });
    ok('the Users screen lists a STAFF member with an Edit action', !!target, JSON.stringify(target));

    await page.evaluate((t) => document.querySelector(`[data-edit-user="${t.id}"]`).click(), target);
    await sleep(600);
    const hasTransferBtn = await page.evaluate(() => !!document.getElementById('eu-transfer'));
    ok('the Edit modal offers "Transfer & Promote"', hasTransferBtn);

    await page.evaluate(() => document.getElementById('eu-transfer').click());
    await sleep(900);
    const modal = await page.evaluate(() => ({
      hasRole: !!document.getElementById('tr-role'),
      hasBranch: !!document.getElementById('tr-branch'),
      hasReason: !!document.getElementById('tr-reason'),
      roles: [...document.querySelectorAll('#tr-role option')].map((o) => o.value),
      branchVisible: document.getElementById('tr-branch-row')
        && document.getElementById('tr-branch-row').style.display !== 'none',
    }));
    ok('the transfer modal opens with role, branch and reason', modal.hasRole && modal.hasBranch && modal.hasReason, JSON.stringify(modal));
    ok('...offering all four role choices', modal.roles.join(',') === 'STAFF,BRANCH_MANAGER,GENERAL_MANAGER,OWNER', modal.roles.join(','));
    ok('...with the Branch field shown for a Staff member', modal.branchVisible === true);

    // Choosing an org-wide role must hide the Branch field — that is how the
    // UI expresses branch_id = null without the operator knowing the schema.
    await page.select('#tr-role', 'GENERAL_MANAGER');
    await sleep(300);
    const hiddenForGm = await page.evaluate(() => document.getElementById('tr-branch-row').style.display === 'none');
    ok('choosing General Manager hides the Branch field', hiddenForGm);
    await page.select('#tr-role', 'BRANCH_MANAGER');
    await sleep(300);
    const shownForBm = await page.evaluate(() => document.getElementById('tr-branch-row').style.display !== 'none');
    ok('...and choosing Branch Manager shows it again', shownForBm);

    // Submitting with no reason must be stopped in the UI, before the round trip.
    await page.evaluate(() => document.getElementById('tr-save').click());
    await sleep(700);
    const stillOpen = await page.evaluate(() => !!document.getElementById('tr-role'));
    ok('submitting with no reason is refused in the UI', stillOpen);

    // Now perform a real promotion through the interface.
    await page.evaluate(() => {
      const el = document.getElementById('tr-reason');
      el.value = 'Promoted to run the Ikeja branch';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.getElementById('tr-save').click());
    await sleep(2500);

    const closed = await page.evaluate(() => !document.getElementById('tr-role'));
    ok('the modal closes on success', closed);

    const rowText = await page.evaluate((name) => {
      const tr = [...document.querySelectorAll('tr')].find((r) => new RegExp(name).test(r.textContent));
      return tr ? tr.textContent.replace(/\s+/g, ' ').trim() : null;
    }, target.name);
    ok('the users table now shows them as Branch Manager', /Branch Manager/.test(rowText || ''), String(rowText).slice(0, 140));

    // The change must be real on the server, not just painted.
    const serverRole = await page.evaluate(async (id) => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const r = await fetch('/api/users', { headers: { authorization: 'Bearer ' + s.token } });
      const j = await r.json();
      const u = j.find((x) => x.id === id);
      return u && { role: u.role, label: u.role_label, branch: u.branch_name };
    }, target.id);
    ok('...and the server agrees', serverRole && serverRole.role === 'MANAGER' && serverRole.label === 'Branch Manager', JSON.stringify(serverRole));

    // Re-opening the modal must show the move we just made.
    await page.evaluate((t) => document.querySelector(`[data-edit-user="${t.id}"]`).click(), target);
    await sleep(500);
    await page.evaluate(() => document.getElementById('eu-transfer').click());
    await sleep(1500);
    const histText = await page.evaluate(() => {
      const el = document.getElementById('tr-history');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    ok('the modal shows the previous change, with its reason', /Ikeja branch/.test(histText), histText.slice(0, 160));
    await page.keyboard.press('Escape');
    await sleep(400);

    // --- Force clock-out through the attendance screen ---
    const staffPage = await browser.newPage();
    await staffPage.setCacheEnabled(false);
    await login(staffPage, 'minna.staff');
    await staffPage.goto(BASE + '/#/attendance', { waitUntil: 'networkidle0' });
    await sleep(1000);
    // TRAP — the first version asserted only that the BUTTON WAS CLICKED, and
    // reported green while no shift was ever created (the clock-in path waits
    // on a geolocation callback that never fires in headless Chrome, so it
    // hung silently). Assert the OUTCOME: a shift must actually exist.
    // Geolocation is stubbed to fail fast, which is a legitimate real-world
    // case — it yields a NO_LOCATION shift, exactly what a manager reviews.
    await staffPage.evaluateOnNewDocument(() => {
      navigator.geolocation.getCurrentPosition = (_ok, err) => {
        if (err) err({ code: 1, message: 'denied for test' });
      };
    });
    await staffPage.reload({ waitUntil: 'networkidle0' });
    await staffPage.goto(BASE + '/#/attendance', { waitUntil: 'networkidle0' });
    await sleep(1200);
    await staffPage.evaluate(() => {
      const btn = document.getElementById('clock-in-btn');
      if (btn) btn.click();
    });
    await sleep(4000);
    const shiftExists = await staffPage.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const r = await fetch('/api/attendance/me/current', { headers: { authorization: 'Bearer ' + s.token } });
      const j = await r.json();
      return !!(j && j.id);
    });
    ok('a cashier clocks in from the UI (shift really created)', shiftExists === true, String(shiftExists));
    await staffPage.close();

    await page.goto(BASE + '/#/attendance', { waitUntil: 'networkidle0' });
    await sleep(1500);
    const endBtn = await page.evaluate(() => {
      const b = document.querySelector('[data-force-out]');
      return b ? { id: b.dataset.forceOut, name: b.dataset.name, text: b.textContent.trim() } : null;
    });
    ok('the manager sees an "End shift" action on an open shift', !!endBtn, JSON.stringify(endBtn));

    if (endBtn) {
      await page.evaluate(() => document.querySelector('[data-force-out]').click());
      await sleep(700);
      const fcoOpen = await page.evaluate(() => !!document.getElementById('fco-reason'));
      ok('...opening a modal that asks for a reason', fcoOpen);
      await page.evaluate(() => document.getElementById('fco-confirm').click());
      await sleep(700);
      ok('...refusing to submit without one', await page.evaluate(() => !!document.getElementById('fco-reason')));
      await page.evaluate(() => {
        const el = document.getElementById('fco-reason');
        el.value = 'Went home without clocking out; confirmed with the branch manager.';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.evaluate(() => document.getElementById('fco-confirm').click());
      await sleep(2500);
      ok('...and closing on success', await page.evaluate(() => !document.getElementById('fco-reason')));
      const marked = await page.evaluate(() => {
        const t = document.body.textContent.replace(/\s+/g, ' ');
        return /ended by manager/i.test(t);
      });
      ok('the shift now reads "ended by manager", not as a normal clock-out', marked);
    }

    // A self force-clock-out control must never be offered.
    const ownSelf = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('gl_pms_session'));
      const myId = s.user.id;
      const btns = [...document.querySelectorAll('[data-force-out]')];
      const r = await fetch('/api/attendance', { headers: { authorization: 'Bearer ' + s.token } });
      const rows = await r.json();
      return btns.some((b) => {
        const row = rows.find((x) => x.id === b.dataset.forceOut);
        return row && row.user_id === myId;
      });
    });
    ok('no "End shift" button is ever offered on your own shift', ownSelf === false);

    const realErrors = errors.filter((e) => !/favicon|manifest|Failed to load resource/i.test(e));
    ok('no uncaught JavaScript errors during the whole flow', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
})();
