// Comparison screenshots across SCENARIO x ROLE x WIDTH x PAGE x ACTION.
//
// Three pharmacy shapes, all live in one seeded database:
//   A — 2 branches,  8 staff, heavy trading      (usernames a.*)
//   B — 1 branch,    2 staff, light trading      (usernames b.*)
//   C — 5 branches, 20 staff, dense estate       (usernames c.*)
//
// Widths include 320px — the narrowest phone still in real use in Nigeria and
// the width that exposed Bug 76 (a button wider than the screen while the
// DOCUMENT did not overflow, so an overflow check alone would have missed it).
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const OUT = process.env.SHOT_DIR || '/tmp/pharmaridge-manual-shots';
fs.mkdirSync(OUT, { recursive: true });
const sl = ms => new Promise(r => setTimeout(r, ms));

const WIDTHS = { tiny: 320, mobile: 390, tablet: 768, desktop: 1440 };

async function session(browser, username, pin = '1234', width = 1440, theme = 'light') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width, height: width < 500 ? 844 : 1000 });
  page.on('dialog', async d => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((t) => { try { localStorage.setItem('gl_pms_theme', t); } catch (e) {} }, theme);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate((u, p) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('login-username', u); set('login-pin', p);
  }, username, pin);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sl(1400);
  return { ctx, page };
}

const manifest = [];

async function shot(page, hash, file, { wait = 2400, action, full = false } = {}) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await sl(wait);
  if (action) { try { await action(page); } catch (e) { console.log('    (action skipped: ' + e.message.slice(0, 60) + ')'); } }
  await sl(400);
  const p = path.join(OUT, file);
  await page.screenshot({ path: p, fullPage: full });
  // Every capture also measures horizontal overflow at this width. A screenshot
  // that merely LOOKS fine is not evidence; Bug 76 was a control wider than the
  // viewport while document.scrollWidth stayed clean, so measure the widest
  // ELEMENT, not just the document.
  const m = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    let worst = null;
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const over = Math.round(r.right - vw);
      if (over > 2 && (!worst || over > worst.over)) {
        worst = { over, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40),
          txt: (el.textContent || '').trim().slice(0, 30) };
      }
    });
    return { vw, docOverflow: document.documentElement.scrollWidth - vw, worst };
  });
  const kb = Math.round(fs.statSync(p).size / 1024);
  const flag = m.worst ? `  ⚠ ${m.worst.tag}.${m.worst.cls} overflows ${m.worst.over}px ("${m.worst.txt}")` : '';
  console.log(`  ${file.padEnd(50)} ${String(kb).padStart(4)}KB${flag}`);
  manifest.push({ file, hash, width: m.vw, docOverflow: m.docOverflow, worst: m.worst });
  return p;
}

(async () => {
  try { const h = await fetch(BASE + '/api/health'); if (!h.ok) throw new Error('health ' + h.status); }
  catch (e) { console.log('server not reachable: ' + e.message); process.exit(3); }

  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    // ================= SCENARIO A — OWNER, 2 branches, 8 staff =============
    console.log('\n[A] OWNER · 2 branches · desktop · light');
    {
      const { ctx, page } = await session(browser, 'owner', '1234', WIDTHS.desktop, 'light');
      await shot(page, '#/dashboard', 'A-owner-desktop-dashboard.png', { wait: 3400 });
      await shot(page, '#/accounting', 'A-owner-desktop-accounting.png', { wait: 3400 });
      await shot(page, '#/sales', 'A-owner-desktop-sales.png');
      await shot(page, '#/stock', 'A-owner-desktop-stock.png');
      await shot(page, '#/customers', 'A-owner-desktop-customers-aging.png', { wait: 3400 });
      await shot(page, '#/users', 'A-owner-desktop-users.png');
      await shot(page, '#/plan', 'A-owner-desktop-plan.png');
      await shot(page, '#/transfers', 'A-owner-desktop-transfers.png');
      await shot(page, '#/purchase-orders', 'A-owner-desktop-purchase-orders.png');
      await shot(page, '#/expenses', 'A-owner-desktop-expenses.png');
      await shot(page, '#/attendance', 'A-owner-desktop-attendance.png');
      await shot(page, '#/sync', 'A-owner-desktop-sync.png');
      await shot(page, '#/users', 'A-owner-desktop-ACTION-transfer-modal.png', { wait: 2400, action: async (pg) => {
        await pg.evaluate(async () => {
          const s = JSON.parse(localStorage.getItem('gl_pms_session'));
          const r = await fetch('/api/users', { headers: { authorization: 'Bearer ' + s.token } });
          const us = await r.json();
          const t = us.find(u => u.role === 'STAFF' && u.is_active);
          const b = document.querySelector(`[data-edit-user="${t.id}"]`); if (b) b.click();
        });
        await sl(700);
        await pg.evaluate(() => { const b = document.getElementById('eu-transfer'); if (b) b.click(); });
        await sl(900);
      } });
      await ctx.close();
    }

    console.log('\n[A] OWNER · 2 branches · desktop · DARK');
    {
      const { ctx, page } = await session(browser, 'owner', '1234', WIDTHS.desktop, 'dark');
      await shot(page, '#/dashboard', 'A-owner-desktop-dark-dashboard.png', { wait: 3400 });
      await shot(page, '#/accounting', 'A-owner-desktop-dark-accounting.png', { wait: 3400 });
      await shot(page, '#/customers', 'A-owner-desktop-dark-customers.png', { wait: 3200 });
      await shot(page, '#/sales', 'A-owner-desktop-dark-sales.png');
      await ctx.close();
    }

    for (const [label, w] of [['tablet', WIDTHS.tablet], ['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      console.log(`\n[A] OWNER · 2 branches · ${label} (${w}px)`);
      const { ctx, page } = await session(browser, 'owner', '1234', w, 'light');
      await shot(page, '#/dashboard', `A-owner-${label}-dashboard.png`, { wait: 3400 });
      await shot(page, '#/accounting', `A-owner-${label}-accounting.png`, { wait: 3200 });
      await shot(page, '#/customers', `A-owner-${label}-customers.png`, { wait: 3200 });
      await shot(page, '#/stock', `A-owner-${label}-stock.png`);
      await shot(page, '#/users', `A-owner-${label}-users.png`);
      if (w < 900) {
        await shot(page, '#/dashboard', `A-owner-${label}-ACTION-nav-open.png`, { wait: 2200, action: async (pg) => {
          await pg.evaluate(() => { const b = document.getElementById('nav-toggle'); if (b) b.click(); });
          await sl(700);
        } });
      }
      await ctx.close();
    }

    console.log('\n[A] BRANCH MANAGER · pinned to Lagos');
    for (const [label, w] of [['desktop', WIDTHS.desktop], ['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      const { ctx, page } = await session(browser, 'a.mgr.lagos', '1234', w, 'light');
      await shot(page, '#/dashboard', `A-branchmgr-${label}-dashboard.png`, { wait: 3400 });
      await shot(page, '#/stock', `A-branchmgr-${label}-stock.png`);
      await shot(page, '#/users', `A-branchmgr-${label}-users-scoped.png`);
      await shot(page, '#/attendance', `A-branchmgr-${label}-attendance.png`);
      if (label === 'desktop') await shot(page, '#/purchase-orders', 'A-branchmgr-desktop-purchase-orders.png');
      await ctx.close();
    }

    console.log('\n[A] CASHIER · POS / till / sales');
    for (const [label, w] of [['desktop', WIDTHS.desktop], ['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      const { ctx, page } = await session(browser, 'a.cash1', '1234', w, 'light');
      await shot(page, '#/pos', `A-cashier-${label}-pos.png`, { wait: 3000 });
      await shot(page, '#/pos', `A-cashier-${label}-ACTION-pos-cart.png`, { wait: 2400, action: async (pg) => {
        await pg.evaluate(() => { const s = document.getElementById('pos-search');
          if (s) { s.value = 'Panadol'; s.dispatchEvent(new Event('input', { bubbles: true })); } });
        await sl(1800);
      } });
      await shot(page, '#/till', `A-cashier-${label}-till.png`);
      await shot(page, '#/sales', `A-cashier-${label}-sales.png`);
      if (label !== 'tiny') await shot(page, '#/attendance', `A-cashier-${label}-attendance.png`);
      await ctx.close();
    }

    // ================= SCENARIO B — 1 branch, 2 staff ======================
    console.log('\n[B] SINGLE-BRANCH MANAGER');
    for (const [label, w] of [['desktop', WIDTHS.desktop], ['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      const { ctx, page } = await session(browser, 'b.mgr', '1234', w, 'light');
      await shot(page, '#/dashboard', `B-manager-${label}-dashboard.png`, { wait: 3400 });
      await shot(page, '#/stock', `B-manager-${label}-stock.png`);
      await shot(page, '#/customers', `B-manager-${label}-customers.png`, { wait: 3200 });
      await shot(page, '#/users', `B-manager-${label}-users.png`);
      if (label === 'desktop') {
        await shot(page, '#/accounting', 'B-manager-desktop-accounting.png', { wait: 3200 });
        await shot(page, '#/expenses', 'B-manager-desktop-expenses.png');
        await shot(page, '#/transfers', 'B-manager-desktop-transfers-single-branch.png');
      }
      await ctx.close();
    }
    console.log('\n[B] CASHIER');
    for (const [label, w] of [['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      const { ctx, page } = await session(browser, 'b.cash1', '1234', w, 'light');
      await shot(page, '#/pos', `B-cashier-${label}-pos.png`, { wait: 3000 });
      await shot(page, '#/till', `B-cashier-${label}-till.png`);
      await shot(page, '#/sales', `B-cashier-${label}-sales.png`);
      await ctx.close();
    }

    // ================= SCENARIO C — 5 branches, 20 staff ===================
    console.log('\n[C] GENERAL MANAGER · org-wide over 5 shops · desktop');
    {
      const { ctx, page } = await session(browser, 'c.gm', '1234', WIDTHS.desktop, 'light');
      await shot(page, '#/dashboard', 'C-generalmgr-desktop-dashboard.png', { wait: 3600 });
      await shot(page, '#/stock', 'C-generalmgr-desktop-stock-all-branches.png', { wait: 3000 });
      await shot(page, '#/users', 'C-generalmgr-desktop-users-20-staff.png', { wait: 3000 });
      await shot(page, '#/transfers', 'C-generalmgr-desktop-transfers-web.png', { wait: 3000 });
      await shot(page, '#/attendance', 'C-generalmgr-desktop-attendance.png', { wait: 3000 });
      await shot(page, '#/purchase-orders', 'C-generalmgr-desktop-purchase-orders.png', { wait: 3000 });
      await shot(page, '#/sales', 'C-generalmgr-desktop-sales.png', { wait: 3000 });
      await shot(page, '#/customers', 'C-generalmgr-desktop-customers.png', { wait: 3200 });
      await shot(page, '#/expenses', 'C-generalmgr-desktop-expenses.png', { wait: 3000 });
      await shot(page, '#/users', 'C-generalmgr-desktop-ACTION-add-user.png', { wait: 2400, action: async (pg) => {
        await pg.evaluate(() => { const b = document.getElementById('add-user-btn')
          || document.querySelector('[data-add-user]')
          || Array.from(document.querySelectorAll('button')).find(x => /add user|new user/i.test(x.textContent));
          if (b) b.click(); });
        await sl(900);
      } });
      await ctx.close();
    }

    console.log('\n[C] OWNER over the 5-shop estate · desktop + dark + tablet + mobile + tiny');
    {
      const { ctx, page } = await session(browser, 'owner', '1234', WIDTHS.desktop, 'light');
      await shot(page, '#/plan', 'C-owner-desktop-plan-8-branches-35-staff.png', { wait: 3000 });
      await shot(page, '#/users', 'C-owner-desktop-users-full-estate.png', { wait: 3200 });
      await shot(page, '#/accounting', 'C-owner-desktop-accounting-consolidated.png', { wait: 3600 });
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, 'owner', '1234', WIDTHS.desktop, 'dark');
      await shot(page, '#/plan', 'C-owner-desktop-dark-plan.png', { wait: 3000 });
      await shot(page, '#/users', 'C-owner-desktop-dark-users.png', { wait: 3200 });
      await ctx.close();
    }
    for (const [label, w] of [['tablet', WIDTHS.tablet], ['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
      const { ctx, page } = await session(browser, 'owner', '1234', w, 'light');
      await shot(page, '#/plan', `C-owner-${label}-plan.png`, { wait: 3000 });
      await shot(page, '#/users', `C-owner-${label}-users-full-estate.png`, { wait: 3200 });
      await shot(page, '#/transfers', `C-owner-${label}-transfers.png`, { wait: 2800 });
      await ctx.close();
    }

    console.log('\n[C] BRANCH MANAGERS · two different shops, showing scoping');
    for (const [user, tag] of [['c.mgr1', 'ikeja'], ['c.mgr3', 'kano-cashonly']]) {
      for (const [label, w] of [['desktop', WIDTHS.desktop], ['mobile', WIDTHS.mobile]]) {
        const { ctx, page } = await session(browser, user, '1234', w, 'light');
        await shot(page, '#/dashboard', `C-branchmgr-${tag}-${label}-dashboard.png`, { wait: 3400 });
        await shot(page, '#/stock', `C-branchmgr-${tag}-${label}-stock-scoped.png`, { wait: 2800 });
        await shot(page, '#/customers', `C-branchmgr-${tag}-${label}-customers.png`, { wait: 3000 });
        if (label === 'desktop') await shot(page, '#/users', `C-branchmgr-${tag}-desktop-users-scoped.png`, { wait: 2800 });
        await ctx.close();
      }
    }

    console.log('\n[C] CASHIERS · busiest and quietest shop');
    for (const [user, tag] of [['c.b1s1', 'ikeja'], ['c.b5s1', 'ibadan']]) {
      for (const [label, w] of [['mobile', WIDTHS.mobile], ['tiny', WIDTHS.tiny]]) {
        const { ctx, page } = await session(browser, user, '1234', w, 'light');
        await shot(page, '#/pos', `C-cashier-${tag}-${label}-pos.png`, { wait: 3000 });
        await shot(page, '#/till', `C-cashier-${tag}-${label}-till.png`);
        await shot(page, '#/sales', `C-cashier-${tag}-${label}-sales.png`);
        await ctx.close();
      }
    }
    {
      const { ctx, page } = await session(browser, 'c.b1s1', '1234', WIDTHS.desktop, 'light');
      await shot(page, '#/pos', 'C-cashier-ikeja-desktop-pos.png', { wait: 3000 });
      await shot(page, '#/pos', 'C-cashier-ikeja-desktop-ACTION-pos-cart.png', { wait: 2400, action: async (pg) => {
        await pg.evaluate(() => { const s = document.getElementById('pos-search');
          if (s) { s.value = 'Panadol'; s.dispatchEvent(new Event('input', { bubbles: true })); } });
        await sl(1800);
      } });
      await shot(page, '#/attendance', 'C-cashier-ikeja-desktop-attendance.png');
      await ctx.close();
    }

    // ================= VENDOR ADMIN ========================================
    console.log('\n[ADMIN] vendor support portal');
    for (const [label, w] of [['desktop', WIDTHS.desktop], ['mobile', WIDTHS.mobile]]) {
      const { ctx, page } = await session(browser, 'admin', '1234', w, 'light');
      await shot(page, '#/admin', `ADMIN-${label}-portal.png`, { wait: 3200 });
      await shot(page, '#/plan', `ADMIN-${label}-plan-support-view.png`, { wait: 3000 });
      if (label === 'desktop') await shot(page, '#/users', 'ADMIN-desktop-users.png', { wait: 3000 });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'));
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  const bad = manifest.filter(m => m.worst);
  console.log(`\nCaptured ${files.length} screenshots into ${OUT}`);
  console.log(bad.length
    ? `OVERFLOW FOUND in ${bad.length} capture(s):\n` + bad.map(b =>
        `  ${b.file} @${b.width}px — ${b.worst.tag}.${b.worst.cls} +${b.worst.over}px "${b.worst.txt}"`).join('\n')
    : 'No element overflowed its viewport in any capture.');
})();
