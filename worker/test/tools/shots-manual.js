// SCREENSHOTS FOR THE ONBOARDING MANUAL.
//
// Deliberately NOT the comparison matrix this replaced. Each capture here shows
// a ROLE PERFORMING A STEP the manual describes — a cart mid-sale, the change
// claim on screen, the safe with money in it, the transfer modal open — because
// a manual illustrated with idle pages teaches nothing.
//
// Naming: <NN>-<role>-<action>[-<width>].png, numbered in the order the manual
// uses them, so the document generator can pick them up deterministically.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const OUT = process.env.SHOT_DIR || '/tmp/pharmaridge-manual-shots';
fs.mkdirSync(OUT, { recursive: true });
const sl = ms => new Promise(r => setTimeout(r, ms));

const DESKTOP = 1440, TABLET = 768, PHONE = 390;
const manifest = [];
// A guide caption can be correct while an inherited modal makes the screenshot
// wrong. Record image hashes too: if two different labelled captures render
// the same pixels, fail the capture rather than letting a repeated screen into
// the owner-facing PDF.
const screenshotHashes = new Map();
function assertUniqueScreenshot(file) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const earlier = screenshotHashes.get(digest);
  if (earlier) throw new Error(`duplicate screenshot pixels: ${path.basename(file)} repeats ${path.basename(earlier)}`);
  screenshotHashes.set(digest, file);
}

async function session(browser, username, { width = DESKTOP, theme = 'light' } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width, height: width < 500 ? 900 : 1150 });
  page.on('dialog', async d => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((t) => { try { localStorage.setItem('gl_pms_theme', t); } catch (e) {} }, theme);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate((u) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-username', u); set('login-pin', '1234');
  }, username);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sl(1600);
  return { ctx, page };
}

// CLIENT INSTRUCTION: "for every full screen snapshot a corresponding mobile
// view should be by its side".
//
// Every desktop capture therefore takes a PHONE companion of the same screen,
// in the same session, at the same moment — saved as <name>.m.png. The manual
// pairs them side by side.
//
// Done inside shot() rather than at the ~35 call sites for the same reason
// fig() was rewritten once before: a per-call-site change is a change somebody
// will forget on the next screen added. Here it is impossible to forget.
//
// The viewport is resized and restored around the companion shot, so the
// desktop page the caller is driving is left exactly as it was found — a
// screenshot helper that silently changes the caller's viewport would break
// every subsequent capture in that session.
const PHONE_COMPANION = 390;

async function shot(page, file, caption, { hash, wait = 2600, action, focus, mobile = true } = {}) {
  // A modal lives directly under <body>, outside Router's #view. Leaving an
  // Owner Data Management or Transfer dialog open therefore used to paint that
  // same dialog over every later route capture — Accounting, Users, Debtors
  // and Expenses all looked like the preceding modal even though their labels
  // were correct. Close inherited overlays BEFORE choosing the next route.
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove()));
  if (hash) {
    await page.evaluate(h => { location.hash = h; }, hash);
    // A fixed sleep can capture the previous view while an initial dashboard
    // render races a hash change. Wait for the intended nav state and nonempty
    // view before giving the page its normal data/render settling time.
    await page.waitForFunction((h) => {
      const view = document.getElementById('view');
      const nav = document.querySelector(`#sidebar a[href="${h}"]`);
      return !!(view && view.innerText.trim().length > 40 && (!nav || nav.classList.contains('active')));
    }, { timeout: 25000 }, hash);
    await sl(wait);
  }
  if (action) { try { await action(page); } catch (e) { console.log(`    (action skipped: ${e.message.slice(0, 70)})`); } }
  if (focus) { try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }, focus); await sl(500); } catch (e) {} }
  await sl(350);
  const p = path.join(OUT, file);
  await page.screenshot({ path: p, fullPage: false });
  assertUniqueScreenshot(p);
  const kb = Math.round(fs.statSync(p).size / 1024);
  console.log(`  ${file.padEnd(46)} ${String(kb).padStart(4)}KB  ${caption}`);

  let mobileFile = null;
  const vp = page.viewport();
  // Only worth doing for a capture that is actually WIDE. A shot already taken
  // at phone width is its own mobile view, and pairing it with itself would be
  // padding rather than information.
  if (mobile && vp && vp.width > 700) {
    try {
      await page.setViewport({ width: PHONE_COMPANION, height: 844 });
      await sl(900);
      // Re-run the action at phone width where one was given: a modal opened
      // on desktop does not survive a viewport change, and an empty phone
      // frame beside a populated desktop one teaches nothing.
      if (action) { try { await action(page); } catch (e) {} }
      if (focus) { try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }, focus); await sl(400); } catch (e) {} }
      await sl(500);
      mobileFile = file.replace(/\.png$/, '.m.png');
      const mobilePath = path.join(OUT, mobileFile);
      await page.screenshot({ path: mobilePath, fullPage: false });
      assertUniqueScreenshot(mobilePath);
      const mkb = Math.round(fs.statSync(mobilePath).size / 1024);
      console.log(`  ${('  \u21b3 ' + mobileFile).padEnd(46)} ${String(mkb).padStart(4)}KB  (phone companion)`);
    } catch (e) {
      console.log(`    (phone companion skipped: ${e.message.slice(0, 60)})`);
      mobileFile = null;
    } finally {
      await page.setViewport(vp);
      await sl(700);
    }
  }

  manifest.push({ file, caption, mobile: mobileFile });
  return p;
}

(async () => {
  try { const h = await fetch(BASE + '/api/health'); if (!h.ok) throw new Error('health ' + h.status); }
  catch (e) { console.log('server not reachable: ' + e.message); process.exit(3); }

  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    // ================= 00 — SHARED / SIGN IN ============================
    console.log('\n[00] Signing in');
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: DESKTOP, height: 1000 });
      await page.goto(BASE, { waitUntil: 'networkidle0' });
      await sl(1200);
      // shot() writes the paired phone view beside this desktop screen. Do not
      // capture a second standalone login-phone image: it is the same view and
      // belongs only once in the guide.
      await shot(page, '00-login-desktop.png', 'The sign-in screen — username and PIN, nothing else');
      await ctx.close();
    }

    // ================= 10 — OWNER ========================================
    console.log('\n[10] OWNER');
    {
      const { ctx, page } = await session(browser, 'owner');
      await shot(page, '10-owner-dashboard.png', 'The Owner dashboard — every branch at a glance', { hash: '#/dashboard', wait: 3600 });
      await shot(page, '11-owner-plan.png', 'My Plan — what you are paying for and what you are using', { hash: '#/plan', wait: 3000 });
      await shot(page, '11a-owner-data-management.png', 'Owner Data Management — preview before any permanent removal', {
        hash: '#/plan', wait: 3000, action: async (pg) => {
          await pg.evaluate(() => { const b = document.getElementById('owner-data-management'); if (b) b.click(); });
          await sl(900);
        } });
      await shot(page, '12-owner-accounting.png', 'Accounting — the books, kept automatically', { hash: '#/accounting', wait: 3600 });
      await shot(page, '13-owner-users.png', 'Users & Branches — everyone who can sign in', { hash: '#/users', wait: 3200 });
      await shot(page, '14-owner-transfer-modal.png', 'Transfer & Promote — moving a person, keeping one account', {
        hash: '#/users', wait: 2800, action: async (pg) => {
          await pg.evaluate(async () => {
            const s = JSON.parse(localStorage.getItem('gl_pms_session'));
            const r = await fetch('/api/users', { headers: { authorization: 'Bearer ' + s.token } });
            const us = await r.json();
            const t = us.find(u => u.role === 'STAFF' && u.is_active);
            const b = document.querySelector(`[data-edit-user="${t.id}"]`); if (b) b.click();
          });
          await sl(800);
          await pg.evaluate(() => { const b = document.getElementById('eu-transfer'); if (b) b.click(); });
          await sl(1000);
        } });
      await shot(page, '15-owner-customers-aging.png', 'Debtors and how old each debt is', { hash: '#/customers', wait: 3400 });
      await shot(page, '16-owner-expenses.png', 'Expenses — including what the safe paid for', { hash: '#/expenses', wait: 3000 });
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, 'owner', { theme: 'dark' });
      await shot(page, '17-owner-dashboard-dark.png', 'The same dashboard in dark mode, for a dim shop at 6am', { hash: '#/dashboard', wait: 3600 });
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, 'owner', { width: PHONE });
      // The Owner dashboard already has a phone companion next to its desktop
      // plate. Keep this phone-only capture for the distinct menu interaction.
      await shot(page, '19-owner-menu-phone.png', 'The menu on a phone', { hash: '#/dashboard', wait: 2400,
        action: async (pg) => { await pg.evaluate(() => { const b = document.getElementById('nav-toggle'); if (b) b.click(); }); await sl(800); } });
      await ctx.close();
    }

    // ================= 20 — GENERAL MANAGER ==============================
    console.log('\n[20] GENERAL MANAGER');
    {
      const { ctx, page } = await session(browser, 'c.gm');
      await shot(page, '20-gm-dashboard.png', 'A General Manager sees and runs every branch', { hash: '#/dashboard', wait: 3600 });
      await shot(page, '21-gm-stock.png', 'Stock across the whole estate, with expiry warnings', { hash: '#/stock', wait: 3000 });
      await shot(page, '22-gm-transfers.png', 'Moving stock between branches', { hash: '#/transfers', wait: 3000 });
      await shot(page, '23-gm-purchase-orders.png', 'Purchase orders and deliveries', { hash: '#/purchase-orders', wait: 3000 });
      await shot(page, '24-gm-attendance.png', 'Who clocked in, where, and for how long', { hash: '#/attendance', wait: 3000 });
      await ctx.close();
    }

    // ================= 30 — BRANCH MANAGER ===============================
    console.log('\n[30] BRANCH MANAGER');
    {
      const { ctx, page } = await session(browser, 'c.mgr1');
      await shot(page, '30-bm-dashboard.png', 'A Branch Manager sees only their own shop', { hash: '#/dashboard', wait: 3600 });
      await shot(page, '31-bm-till-and-safe.png', 'The till and the branch safe — two separate pots of cash',
        { hash: '#/till', wait: 3600, focus: '#safe-content' });
      await shot(page, '32-bm-safe-deposit.png', 'Recording money into the safe', {
        hash: '#/till', wait: 3200, action: async (pg) => {
          await pg.evaluate(() => {
            const t = document.getElementById('safe-type'); if (t) t.value = 'DEPOSIT';
            const a = document.getElementById('safe-amount'); if (a) { a.value = '50000'; a.dispatchEvent(new Event('input', { bubbles: true })); }
            const r = document.getElementById('safe-reason'); if (r) { r.value = 'Cash reserve for this month'; r.dispatchEvent(new Event('input', { bubbles: true })); }
            const el = document.getElementById('safe-content'); if (el) el.scrollIntoView({ block: 'center' });
          });
          await sl(700);
        } });
      await shot(page, '33-bm-users-scoped.png', 'A Branch Manager sees only their own staff', { hash: '#/users', wait: 3000 });
      await shot(page, '34-bm-safe-allowance.png',
        'Setting how much cashiers may take from the safe — 0 means no limit', { hash: '#/plan', wait: 3200 });
      await shot(page, '34b-bm-stocktake.png', 'Counting the shelves', { hash: '#/stocktake', wait: 3000 });
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, 'c.mgr1', { width: TABLET });
      await shot(page, '35-bm-till-tablet.png', 'The till on a tablet', { hash: '#/till', wait: 3400 });
      await ctx.close();
    }

    // ================= 40 — CASHIER / STAFF ==============================
    console.log('\n[40] CASHIER (STAFF)');
    {
      const { ctx, page } = await session(browser, 'a.cash1');
      await shot(page, '40-cashier-pos-empty.png', 'The Point of Sale, ready for the next customer', { hash: '#/pos', wait: 3200 });
      await shot(page, '41-cashier-pos-search.png', 'Finding a product by name', {
        hash: '#/pos', wait: 2800, action: async (pg) => {
          await pg.evaluate(() => { const s = document.getElementById('pos-search');
            if (s) { s.value = 'Amoxil'; s.dispatchEvent(new Event('input', { bubbles: true })); } });
          await sl(2000);
        } });
      await shot(page, '42-cashier-change-owed.png', 'When there is no change: recording what the shop owes', {
        hash: '#/pos', wait: 2800, action: async (pg) => {
          await pg.evaluate(() => {
            const owed = document.querySelector('[data-pay-owed]');
            if (owed) { owed.value = '100'; owed.dispatchEvent(new Event('input', { bubbles: true })); }
          });
          await sl(900);
          await pg.evaluate(() => {
            const n = document.getElementById('pos-change-name');
            if (n) { n.value = 'Mrs Adaeze Umeh'; n.dispatchEvent(new Event('input', { bubbles: true })); }
            const ph = document.getElementById('pos-change-phone');
            if (ph) { ph.value = '08031234567'; ph.dispatchEvent(new Event('input', { bubbles: true })); }
          });
          await sl(700);
        } });
      await shot(page, '43-cashier-split-purchase.png',
        'Buying something the drawer cannot cover: part from the till, the rest from the safe', {
          hash: '#/expenses', wait: 3200, action: async (pg) => {
            await pg.evaluate(() => {
              const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
              set('exp-category', 'Stock purchase');
              set('exp-amount', '20000');
              const m = document.getElementById('exp-method');
              if (m) { m.value = 'BOTH'; m.dispatchEvent(new Event('change', { bubbles: true })); }
            });
            await sl(700);
            await pg.evaluate(() => {
              const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
              set('exp-from-cash', '8000');
              set('exp-desc', 'Carton of drips bought at the depot');
            });
            await sl(800);
          } });
      await shot(page, '44-cashier-till.png', 'Opening and counting the drawer', { hash: '#/till', wait: 3000 });
      await shot(page, '44-cashier-sales.png', 'Today\'s sales, and who served them', { hash: '#/sales', wait: 3000 });
      await shot(page, '45-cashier-attendance.png', 'Clocking in and out', { hash: '#/attendance', wait: 3000 });
      await ctx.close();
    }
    // POS and Till already carry phone companions next to their desktop plates;
    // do not repeat those same screens as standalone phone pages.

    // ================= 50 — CHANGE OWED, END TO END ======================
    console.log('\n[50] CHANGE OWED (the N400/N500 case)');
    {
      const { ctx, page } = await session(browser, 'owner');
      await shot(page, '50-change-owed-list.png', 'Change we owe customers — searchable by code, name or phone', {
        hash: '#/customers', wait: 3600, focus: '#co-content' });
      await shot(page, '51-change-owed-search.png', 'Finding a claim when the customer lost their slip', {
        hash: '#/customers', wait: 3400, action: async (pg) => {
          // Search for a name that ACTUALLY has an outstanding claim in the
          // seed. An earlier version searched "Adaeze" — whose claim sits at a
          // different branch — so the manual's "find a claim" figure showed
          // "No claim found", illustrating the opposite of its own caption.
          // Read the real claims first and search the first one's surname.
          const target = await pg.evaluate(async () => {
            const s = JSON.parse(localStorage.getItem('gl_pms_session'));
            const r = await fetch('/api/change-owed?status=OUTSTANDING', { headers: { authorization: 'Bearer ' + s.token } });
            const j = await r.json();
            return (Array.isArray(j) && j[0]) ? String(j[0].customer_name).split(' ').pop() : '';
          });
          await pg.evaluate((q) => {
            const i = document.getElementById('co-search');
            if (i) { i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); }
            const b = document.getElementById('co-search-btn'); if (b) b.click();
          }, target);
          await sl(2200);
          await pg.evaluate(() => { const el = document.getElementById('co-content'); if (el) el.scrollIntoView({ block: 'center' }); });
          await sl(500);
        } });
      await ctx.close();
    }

    // ================= 60 — VENDOR ADMIN =================================
    console.log('\n[60] VENDOR ADMIN');
    {
      const { ctx, page } = await session(browser, 'admin');
      await shot(page, '60-admin-portal.png', 'The PharmaRidge support portal — plan, limits and subscription', { hash: '#/admin', wait: 3400 });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nCaptured ${manifest.length} screenshots into ${OUT}`);
})();
