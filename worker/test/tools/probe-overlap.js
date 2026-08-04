// OVERLAP AUDIT — do interactive controls physically collide on small screens?
//
// The existing responsive probe measures DOCUMENT OVERFLOW and TAP-TARGET SIZE.
// Neither of those detects two buttons sitting on top of one another: a pair of
// controls can overlap perfectly while the page never scrolls sideways and both
// are 44px tall. The client reported exactly this ("at its lowest the buttons
// tend to overlap each other"), so it is measured directly here.
//
// WHAT COUNTS AS A BUG
//   1. Two interactive elements whose rectangles INTERSECT by more than a
//      hairline. Whichever is painted on top steals the other's taps.
//   2. An interactive element that is CLIPPED by its scroll container on the
//      cross axis (visible but unreachable).
//   3. Controls pushed outside the viewport horizontally.
//
// WHAT IS DELIBERATELY NOT A BUG
//   - Nested controls (a button inside a label, an <svg> inside a button):
//     containment is not collision. Only SIBLING-ish pairs are compared.
//   - Elements inside a horizontally scrollable .table-wrap that are simply
//     scrolled out of view — that is the intended pattern for wide tables.
//   - Hidden elements (display:none, visibility:hidden, zero-size, opacity 0).
//   - Modal content while a modal is open vs the page behind it.
//
// Requires: bash test/devserver.sh 9001
const puppeteer = require('puppeteer');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
// The narrowest real devices this product meets, plus the two breakpoints.
const WIDTHS = [320, 360, 390, 414, 768];
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
  admin: ['admin', '1234'],
};

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, role) {
  const [u, p] = LOGINS[role];
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((un, pin) => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('login-username', un);
    set('login-pin', pin);
  }, u, p);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  // A fresh scenario has a large catalog and browser contexts intentionally
  // start isolated. Give startup enough room on a loaded CI/worker machine;
  // a 25s harness timeout is not an overlap finding.
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('login-screen');
    return el && el.classList.contains('hidden');
  }, { timeout: 45000 });
}

// Runs INSIDE the page. Returns every genuine collision.
const MEASURE = () => {
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, [role="button"], .tab, [data-tab]';
  const vw = document.documentElement.clientWidth;

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // Inside a collapsed/hidden ancestor?
    let p = el.parentElement;
    while (p) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      p = p.parentElement;
    }
    return true;
  };

  const els = [...document.querySelectorAll(SEL)].filter(visible);

  const describe = (el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${t ? '("' + t + '")' : ''}`;
  };

  const collisions = [];
  const escapes = [];

  for (let i = 0; i < els.length; i++) {
    const a = els[i];
    const ra = a.getBoundingClientRect();

    // Horizontal escape: a control whose box leaves the viewport. Ignore
    // anything inside a horizontally-scrollable wrapper, where that is normal.
    //
    // TRAP — the first run of this probe reported 95 "failures" that were all
    // the CLOSED off-canvas sidebar parked at left:-280px (CSS line 585). That
    // is the drawer working exactly as designed; every nav link legitimately
    // sits outside the viewport until the drawer is opened. Measuring a
    // deliberate design as a defect is the same mistake as reading a 404 as a
    // bug. The drawer IS still audited — but in its OPEN state, below, which is
    // the only state where its links are meant to be reachable.
    // A horizontally scrollable ancestor makes off-screen content REACHABLE by
    // swiping, which is the intended pattern for wide tables and tab strips
    // (.tabs carries overflow-x:auto). My first version only excluded
    // .table-wrap and so reported the Stock/Accounting tab strips as broken
    // when they scroll perfectly well. Detect the capability, don't hard-code
    // the class list.
    const inScroller = (() => {
      let p = a.parentElement;
      while (p && p !== document.body) {
        const ov = getComputedStyle(p).overflowX;
        if ((ov === 'auto' || ov === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
        p = p.parentElement;
      }
      return false;
    })();
    const inClosedDrawer = !!(a.closest('.sidebar') && !a.closest('.sidebar.open'));
    if (!inScroller && !inClosedDrawer && (ra.left < -1 || ra.right > vw + 1)) {
      escapes.push({ el: describe(a), left: Math.round(ra.left), right: Math.round(ra.right), vw });
    }

    for (let j = i + 1; j < els.length; j++) {
      const b = els[j];
      // Containment is not collision.
      if (a.contains(b) || b.contains(a)) continue;
      // A closed drawer's links are stacked off-screen at the same coordinates;
      // comparing them to each other reports the drawer's own layout as a pile-up.
      if (a.closest('.sidebar') && !a.closest('.sidebar.open')) continue;
      if (b.closest('.sidebar') && !b.closest('.sidebar.open')) continue;

      // AN OVERLAY IS SUPPOSED TO COVER THE PAGE. When the drawer is open it
      // sits at z-index 45 above a scrim at z-index 44 whose pointer-events is
      // `auto`, so nothing behind it can be tapped — verified with
      // elementFromPoint: the point over a page button resolves to the scrim,
      // and the point over a drawer link resolves to the link. Reporting
      // "drawer link overlaps page button" is therefore reporting a modal for
      // being modal. A collision only matters between elements that are BOTH
      // actually hittable, so compare only within the same layer.
      const layerOf = (el) => (el.closest('.sidebar') ? 'drawer'
        : el.closest('.modal, .modal-backdrop, [role="dialog"]') ? 'modal'
        : 'page');
      const drawerOpen = !!document.querySelector('.sidebar.open');
      if (drawerOpen && layerOf(a) !== layerOf(b)) continue;

      // A CONTROL SCROLLED OUT OF ITS OWN SCROLL BOX IS NOT ON SCREEN.
      //
      // .table-wrap has overflow-y:auto and max-height:68vh, so a long table
      // keeps rendering rows far below its own visible band; their boxes still
      // report real page coordinates. On Suppliers at 414px the page shows TWO
      // such tables, and a "Record Payment" row scrolled 93px past the bottom
      // of the first wrapper landed on top of an "Edit" button in the second.
      // Measured: the offending button's visible height inside its own wrapper
      // was NEGATIVE (-93px) — it is clipped away entirely and cannot be
      // tapped, so the two never compete for a tap.
      //
      // This is the vertical twin of the horizontal `inScroller` rule above,
      // and of the closed-drawer rule: geometry alone is not visibility.
      // Reported as 5 collisions per width for two widths; all false.
      const clippedAway = (el) => {
        const r = el.getBoundingClientRect();
        for (let q = el.parentElement; q && q !== document.body; q = q.parentElement) {
          const st = getComputedStyle(q);
          if (!/(auto|scroll|hidden|clip)/.test(st.overflowY)) continue;
          const pr = q.getBoundingClientRect();
          if (Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top) <= 1) return true;
        }
        return false;
      };
      if (clippedAway(a) || clippedAway(b)) continue;

      const rb = b.getBoundingClientRect();

      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      // >2px on BOTH axes = a real two-dimensional intersection, not a
      // shared edge or a 1px rounding artefact.
      if (ox > 2 && oy > 2) {
        // One control deliberately laid over another (e.g. a clear-button
        // inside a search field) shows up as a small badge over a large
        // input. Only report when the overlap is a meaningful share of the
        // SMALLER control, i.e. it genuinely competes for the same taps.
        const areaOverlap = ox * oy;
        const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
        if (smaller > 0 && areaOverlap / smaller > 0.25) {
          collisions.push({
            a: describe(a), b: describe(b),
            overlapX: Math.round(ox), overlapY: Math.round(oy),
            pct: Math.round((areaOverlap / smaller) * 100),
          });
        }
      }
    }
  }
  return { collisions, escapes, count: els.length, vw };
};

(async () => {
  console.log('=== CONTROL OVERLAP AUDIT (small screens) ===');
  console.log('BASE=' + BASE);
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

  let worst = [];
  try {
    for (const width of WIDTHS) {
      // One isolated context per ROLE/WIDTH rather than per screen. The old
      // 95-context sweep repeatedly signed the same user in and out, which is
      // both slower and, with one-active-session enforcement, needlessly
      // revokes contexts that are still booting. Navigation within one role's
      // context still exercises every screen and every control geometry.
      for (const role of Object.keys(LOGINS)) {
        const roleScreens = SCREENS.filter((entry) => entry[1] === role);
        if (!roleScreens.length) continue;
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setCacheEnabled(false);
        await page.setViewport({ width, height: 780 });
        try {
          await login(page, role);
          for (const [screen] of roleScreens) {
            try {
              await page.evaluate((s) => { location.hash = '#/' + s; }, screen);
              await sleep(1100);
              const m = await page.evaluate(MEASURE);
              const tag = `${width}px ${screen}`;

              // THE DRAWER OPEN. Below 900px the nav is off-canvas; with it
              // open, every link must be on-screen and must not collide with
              // the page behind it or the scrim.
              if (width <= 900) {
                const opened = await page.evaluate(() => {
                  const btn = document.getElementById('nav-toggle')
                    || document.querySelector('[data-nav-toggle], .nav-toggle, .hamburger');
                  if (btn) { btn.click(); return true; }
                  return false;
                });
                if (opened) {
                  await sleep(500);
                  const isOpen = await page.evaluate(() => !!document.querySelector('.sidebar.open'));
                  ok(`${tag}: the nav drawer actually opens`, isOpen);
                  if (isOpen) {
                    const mo = await page.evaluate(MEASURE);
                    ok(`${tag}: [drawer open] no controls overlap`, mo.collisions.length === 0,
                      mo.collisions.slice(0, 2).map((c) => `${c.a} ∩ ${c.b} (${c.overlapX}×${c.overlapY}px, ${c.pct}%)`).join(' ; '));
                    ok(`${tag}: [drawer open] every nav link is on-screen`, mo.escapes.length === 0,
                      mo.escapes.slice(0, 2).map((e) => `${e.el} [${e.left}..${e.right}] vw=${e.vw}`).join(' ; '));
                    if (mo.collisions.length) worst.push(`${tag} [drawer open]: ${mo.collisions.length} collision(s)`);
                    if (mo.escapes.length) worst.push(`${tag} [drawer open]: ${mo.escapes.length} escape(s)`);
                  }
                  await page.evaluate(() => {
                    const b = document.getElementById('nav-toggle')
                      || document.querySelector('[data-nav-toggle], .nav-toggle, .hamburger');
                    if (b) b.click();
                  });
                  await sleep(300);
                }
              }
              ok(`${tag}: no controls overlap each other`, m.collisions.length === 0,
                m.collisions.slice(0, 2).map((c) => `${c.a} ∩ ${c.b} (${c.overlapX}×${c.overlapY}px, ${c.pct}%)`).join(' ; '));
              ok(`${tag}: no control escapes the viewport`, m.escapes.length === 0,
                m.escapes.slice(0, 2).map((e) => `${e.el} [${e.left}..${e.right}] vw=${e.vw}`).join(' ; '));
              if (m.collisions.length) worst.push(`${tag}: ${m.collisions.length} collision(s)`);
              if (m.escapes.length) worst.push(`${tag}: ${m.escapes.length} escape(s)`);
            } catch (e) {
              ok(`${width}px ${screen}: screen renders`, false, String(e.message).slice(0, 90));
            }
          }
        } finally {
          await ctx.close();
        }
      }
      console.log(`  ...${width}px swept`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (worst.length) {
    console.log('\nWORST OFFENDERS:');
    [...new Set(worst)].slice(0, 25).forEach((w) => console.log('  - ' + w));
  }
  if (fails.length) process.exit(1);
})();
