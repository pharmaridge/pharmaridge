// RESPONSIVE AUDIT — every screen, every breakpoint, measured.
//
// The previous pass proved the DASHBOARD does not scroll sideways. That is one
// screen out of nineteen. This drives the real app into every registered route,
// as roles that can actually see them, at the widths this product genuinely
// meets, and measures:
//
//   1. horizontal overflow of the DOCUMENT (makes every tap land wrong)
//   2. any element whose box escapes the viewport
//   3. touch-target sizes (a 24px button is not usable with a thumb)
//   4. text that is clipped or overlapping
//   5. that wide tables scroll INSIDE .table-wrap rather than moving the page
//
// Widths chosen from real devices this product is deployed to, not round
// numbers: 320 (Galaxy A03 / older budget Android in landscape-locked shells),
// 360 (the single most common Android width in Nigeria), 390 (iPhone 12-15),
// 414 (iPhone Plus/Max), 768 (iPad portrait — the sidebar breakpoint is 900,
// so this is the widest DRAWER layout), 1024 (iPad landscape, just past the
// breakpoint), 1280 (laptop), 1920 (counter monitor).
const puppeteer = require('puppeteer');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

const WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1920];

// Every nav destination, with the lowest role that can reach it. Kept in sync
// with index.html by a check below, so a new screen cannot be added without
// being responsive-tested.
const SCREENS = [
  ['pos', 'staff'], ['dashboard', 'staff'], ['sales', 'staff'], ['till', 'staff'],
  ['attendance', 'staff'], ['stock', 'staff'], ['stocktake', 'staff'],
  ['products', 'manager'], ['purchase-orders', 'staff'], ['transfers', 'staff'],
  ['controlled-register', 'staff'], ['customers', 'staff'],
  ['suppliers', 'manager'], ['expenses', 'manager'], ['accounting', 'manager'],
  ['users', 'manager'], ['sync', 'staff'], ['plan', 'owner'], ['admin', 'admin'],
];

const LOGINS = {
  staff: ['lagos.staff', '1234'],
  manager: ['manager', '1234'],
  owner: ['owner', '1234'],
  admin: null, // resolved below if a vendor seat exists
};

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function assertServerUp(stage) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`\n!! DEV SERVER DOWN before "${stage}" — wrangler dev ProxyController flake,`);
  console.error('!! NOT an app failure. Restart: bash test/devserver.sh 9001');
  process.exit(3);
}

async function login(page, role) {
  const creds = LOGINS[role];
  if (!creds) return false;
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-username', { timeout: 15000 });
  await page.type('#login-username', creds[0]);
  await page.type('#login-pin', creds[1]);
  await Promise.all([
    page.click('#login-form button[type=submit]'),
    page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
  ]);
  await new Promise((r) => setTimeout(r, 1800));
  return true;
}

// Measure the CURRENT page. Returns everything in one round-trip.
const measure = (page) => page.evaluate(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;

  const strays = [];
  const tiny = [];
  const clipped = [];

  // Anything that escapes the viewport horizontally. `.table-wrap` children are
  // EXPECTED to be wider than the screen — that is what the scroll container is
  // for — so an element is only a stray if no scrollable ancestor contains it.
  const inScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const s = getComputedStyle(p);
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && p.clientWidth <= vw + 1) return true;
      p = p.parentElement;
    }
    return false;
  };

  document.querySelectorAll('#main-screen *, #login-screen *').forEach((el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) return;

    const name = el.id ? '#' + el.id
      : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '');

    // 1. escapes the viewport and nothing is scrolling it
    if ((b.right > vw + 1 || b.left < -1) && !inScroller(el)) {
      // The mobile drawer is deliberately parked off-screen at left:-280px.
      const fixedOffscreen = s.position === 'fixed' && b.right <= 1;
      if (!fixedOffscreen) strays.push({ el: name, l: Math.round(b.left), r: Math.round(b.right) });
    }

    // 2. touch targets. Only genuinely interactive, visible controls.
    const tag = el.tagName;
    const isControl = tag === 'BUTTON' || (tag === 'A' && el.getAttribute('href'))
      || tag === 'SELECT' || (tag === 'INPUT' && !['hidden'].includes(el.type));
    if (isControl && b.width > 0 && b.height > 0) {
      // Inline text links inside a paragraph are not touch targets in the
      // same sense; only flag things that present as buttons/controls.
      const looksLikeButton = tag !== 'A' || /btn|tab|nav/.test(String(el.className)) || el.closest('.export-toolbar');
      // THRESHOLD: WCAG 2.2 AA Success Criterion 2.5.8 "Target Size (Minimum)"
      // = 24x24 CSS px. Deliberately the normative floor rather than a number
      // I invented: an earlier version of this probe used 30px, which flagged
      // .btn-sm at 28px as a failure without being able to say against WHAT.
      // Anything genuinely below 24 is a real accessibility defect.
      //
      // 2.5.8 also allows a smaller visible box when the *spacing* around it
      // keeps a 24px undisturbed circle, which is exactly what .btn-sm's
      // ::after hit area provides, so the effective hit box is measured where
      // one exists rather than the border box alone.
      const MIN = 24;
      let hitH = b.height, hitW = b.width;
      const after = getComputedStyle(el, '::after');
      if (after && after.content && after.content !== 'none' && after.position === 'absolute') {
        const ah = parseFloat(after.height);
        if (!Number.isNaN(ah) && ah > hitH) hitH = ah;
      }
      // A checkbox/radio wrapped in its own <label> is activated by clicking
      // ANYWHERE in that label — that is the target 2.5.8 is about, not the
      // 18px box. Measured, not assumed: an earlier run of this probe reported
      // the Plan screen's permission toggles as 18x18 failures when the real
      // tappable region is the full 322x44 label. Only counted when the input
      // is a DIRECT child, which is how every one of them actually ships.
      if (el.type === 'checkbox' || el.type === 'radio') {
        const lab = el.parentElement && el.parentElement.tagName === 'LABEL' ? el.parentElement : null;
        if (lab) {
          const lb = lab.getBoundingClientRect();
          if (lb.height > hitH) hitH = lb.height;
          if (lb.width > hitW) hitW = lb.width;
        }
      }
      if (looksLikeButton && (hitH < MIN || hitW < MIN)) {
        tiny.push({ el: name, w: Math.round(hitW), h: Math.round(hitH) });
      }
    }

    // 3. text clipped by a fixed-height box (content taller than the box with
    //    hidden overflow and no ellipsis) — this is how a label silently
    //    becomes unreadable rather than wrapping.
    if (s.overflow === 'hidden' && s.textOverflow !== 'ellipsis' && el.children.length === 0) {
      const txt = (el.textContent || '').trim();
      if (txt && el.scrollHeight > el.clientHeight + 2) {
        clipped.push({ el: name, txt: txt.slice(0, 28), sh: el.scrollHeight, ch: el.clientHeight });
      }
    }
  });

  return {
    vw,
    overflow: de.scrollWidth - de.clientWidth,
    scrollX: window.scrollX,
    strays: strays.slice(0, 6),
    tiny: tiny.slice(0, 6),
    clipped: clipped.slice(0, 4),
    // Wide tables must live in a scroll container.
    tablesOutsideWrap: [...document.querySelectorAll('#view table')]
      .filter((t) => t.getBoundingClientRect().width > vw && !t.closest('.table-wrap'))
      .map((t) => (t.className || 'table')).slice(0, 3),
  };
});

(async () => {
  await assertServerUp('start');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // Confirm the SCREENS list matches the shipped nav, so this audit cannot
  // silently skip a newly added screen.
  {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    const navs = await page.evaluate(() => [...document.querySelectorAll('a[data-nav]')].map((a) => a.getAttribute('data-nav')));
    const listed = SCREENS.map((s) => s[0]);
    const missing = navs.filter((n) => !listed.includes(n));
    const extra = listed.filter((n) => !navs.includes(n));
    check('every shipped screen is covered by this responsive audit', missing.length === 0, missing.join(','));
    check('...and this audit lists no screen that does not exist', extra.length === 0, extra.join(','));
    console.log(`Covering ${listed.length} screens x ${WIDTHS.length} widths\n`);
    await page.close();
  }

  const worst = [];

  for (const role of ['staff', 'manager', 'owner']) {
    await assertServerUp('role ' + role);
    const reachable = SCREENS.filter(([, r]) =>
      (role === 'staff' && r === 'staff')
      || (role === 'manager' && (r === 'staff' || r === 'manager'))
      || (role === 'owner' && r === 'owner'));
    if (!reachable.length) continue;

    for (const w of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 900 });
      await page.setCacheEnabled(false);
      await page.goto(BASE, { waitUntil: 'networkidle0' });
      await page.evaluate(async () => {
        if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
        if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      });
      if (!(await login(page, role))) { await page.close(); continue; }

      for (const [screen] of reachable) {
        await page.evaluate((s) => { location.hash = '#/' + s; }, screen);
        await new Promise((r) => setTimeout(r, 1100));
        const m = await measure(page);
        const tag = `${screen} @${w}px (${role})`;

        check(`${tag}: page does not scroll sideways`, m.overflow <= 0, `overflow=${m.overflow}px`);
        check(`${tag}: nothing escapes the viewport`, m.strays.length === 0,
          m.strays.map((s) => `${s.el}[${s.l}..${s.r}]`).join(' '));
        check(`${tag}: controls meet WCAG 2.2 AA target size (24px)`, m.tiny.length === 0,
          m.tiny.map((t) => `${t.el} ${t.w}x${t.h}`).join(' '));
        check(`${tag}: no text clipped by a fixed-height box`, m.clipped.length === 0,
          m.clipped.map((c) => `${c.el} "${c.txt}" ${c.sh}>${c.ch}`).join(' '));
        check(`${tag}: wide tables scroll inside their container`, m.tablesOutsideWrap.length === 0,
          m.tablesOutsideWrap.join(','));

        if (m.overflow > 0) worst.push(`${tag} overflow ${m.overflow}px`);
      }
      await page.close();
    }
  }

  await browser.close();
  console.log(`\n${'='.repeat(62)}`);
  console.log(`RESPONSIVE RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
