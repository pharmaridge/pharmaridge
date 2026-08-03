// REACHABILITY PROBE — is every control the user can see actually reachable?
//
// The screenshot pass flagged 60 captures where some element extends past the
// viewport. That number alone proves NOTHING: a table inside a wrapper with
// overflow-x:auto is SUPPOSED to extend past the viewport, and the user
// swipes it. Bug 76 was the opposite — an element wider than the screen with
// no scrollable ancestor, so its far edge could never be reached.
//
// MY OWN FIRST VERSION OF THIS PROBE WAS WRONG and reported 3,384 "unreachable
// controls". Every one was the CLOSED off-canvas nav drawer, which sits at
// left:-280px by design (style.css @media max-width:900px) until you tap the
// menu. A closed drawer is not an unreachable control; it is a closed drawer.
// Recorded as trap #66. Two corrections follow from it:
//
//   * Only elements that are actually PRESENTED count. Anything inside a
//     collapsed/off-canvas container, or clipped by an ancestor's overflow
//     to zero visible area, is excluded — and the drawer is instead opened
//     and audited in its OPEN state, which is the state the user sees.
//   * Only the RIGHT edge running past the viewport is a reachability
//     problem in an LTR layout. Negative left offsets are how off-canvas,
//     carousels and scrolled-away content legitimately work.
//
// What remains is the real question, asked by execution: for each presented
// element that extends past the right edge, if I actually SCROLL every
// scrollable ancestor to its maximum, does the element come into view?
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

const WIDTHS = [320, 360, 390, 768, 1024, 1440];
const ROUTES = ['/dashboard', '/pos', '/sales', '/till', '/attendance', '/stock', '/stocktake',
  '/products', '/purchase-orders', '/transfers', '/customers', '/suppliers', '/expenses',
  '/controlled-register', '/sync', '/users', '/plan', '/accounting'];

async function session(browser, username, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width, height: width < 500 ? 844 : 1000 });
  page.on('dialog', async d => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-username', u); set('login-pin', '1234');
  }, username);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await sl(1200);
  return { ctx, page };
}

// Runs INSIDE the page. Actually scrolls candidate ancestors, then re-measures.
async function unreachable(page) {
  return page.evaluate(async () => {
    const vw = document.documentElement.clientWidth;

    // "Presented" = visible, non-zero box, and not parked off-canvas by an
    // ancestor. An element whose whole box sits left of the viewport is
    // off-canvas, not clipped.
    const presented = (el) => {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.right <= 0) return false;               // entirely off to the left
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.visibility === 'hidden' || ps.display === 'none' || Number(ps.opacity) === 0) return false;
        const pr = p.getBoundingClientRect();
        if (pr.right <= 0) return false;            // inside an off-canvas panel
        if (/(hidden|clip)/.test(ps.overflowX) && (r.left >= pr.right || r.right <= pr.left)) return false;
      }
      return true;
    };

    const over = [];
    document.querySelectorAll('body *').forEach(el => {
      if (!presented(el)) return;
      if (el.getBoundingClientRect().right - vw > 2) over.push(el);
    });
    if (!over.length) return [];

    const scrollers = new Set();
    over.forEach(el => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (/(auto|scroll)/.test(st.overflowX) && p.scrollWidth - p.clientWidth > 1) scrollers.add(p);
      }
    });
    const saved = [...scrollers].map(s => [s, s.scrollLeft]);
    const docSaved = window.scrollX;

    const measureRight = () => over.map(el =>
      el.getBoundingClientRect().right - document.documentElement.clientWidth);

    const base = measureRight();
    [...scrollers].forEach(s => { s.scrollLeft = s.scrollWidth; });
    window.scrollTo(document.documentElement.scrollWidth, window.scrollY);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scrolled = measureRight();

    saved.forEach(([s, v]) => { s.scrollLeft = v; });
    window.scrollTo(docSaved, window.scrollY);

    const out = [];
    over.forEach((el, i) => {
      // Reachable if at SOME scroll position the right edge is inside the
      // viewport. A wide table is never fully visible at once; every part of
      // it must merely be visitable.
      if (Math.min(base[i], scrolled[i]) <= 2) return;
      const tag = el.tagName.toLowerCase();
      out.push({
        tag,
        interactive: ['button', 'a', 'input', 'select', 'textarea'].includes(tag)
          || el.hasAttribute('onclick') || el.getAttribute('role') === 'button'
          || !!el.dataset.action,
        cls: String(el.className || '').slice(0, 60),
        id: el.id || null,
        txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44),
        worstRight: Math.round(Math.min(base[i], scrolled[i])),
      });
    });
    return out;
  });
}

// The nav drawer in its OPEN state — the state a phone user actually sees.
async function openDrawer(page) {
  await page.evaluate(() => { const b = document.getElementById('nav-toggle'); if (b) b.click(); });
  await sl(600);
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const findings = [];
  try {
    for (const [user, label] of [['owner', 'OWNER'], ['a.cash1', 'CASHIER'], ['c.mgr1', 'BRANCH MGR']]) {
      for (const w of WIDTHS) {
        console.log(`\n=== ${label} @ ${w}px ===`);
        const { ctx, page } = await session(browser, user, w);
        for (const route of ROUTES) {
          await page.evaluate(h => { location.hash = '#' + h; }, route);
          await sl(1600);
          let bads;
          try { bads = await unreachable(page); }
          catch (e) { bad(`${route} — probe threw: ${e.message.slice(0, 70)}`); continue; }
          const inter = bads.filter(b => b.interactive);
          if (!bads.length) ok(`${route} — everything presented is reachable`);
          else if (inter.length) {
            bad(`${route} — ${inter.length} UNREACHABLE CONTROL(S): `
              + inter.map(b => `${b.tag}${b.id ? '#' + b.id : '.' + b.cls}"${b.txt}" +${b.worstRight}px`).join('; '));
            bads.forEach(b => findings.push({ user, w, route, sev: b.interactive ? 'HIGH' : 'LOW', ...b }));
          } else {
            bad(`${route} — ${bads.length} unreachable non-interactive node(s): `
              + bads.slice(0, 3).map(b => `${b.tag}.${b.cls} +${b.worstRight}px`).join('; '));
            bads.forEach(b => findings.push({ user, w, route, sev: 'LOW', ...b }));
          }
        }
        // The OPEN drawer, on the widths where it exists at all (<=900px).
        if (w <= 900) {
          await page.evaluate(() => { location.hash = '#/dashboard'; });
          await sl(1400);
          await openDrawer(page);
          const bads = await unreachable(page);
          const inter = bads.filter(b => b.interactive);
          if (inter.length) {
            bad(`nav drawer OPEN — ${inter.length} unreachable menu control(s): `
              + inter.map(b => `"${b.txt}" +${b.worstRight}px`).join('; '));
            inter.forEach(b => findings.push({ user, w, route: 'nav-drawer-open', sev: 'HIGH', ...b }));
          } else ok('nav drawer OPEN — every menu item reachable');
        }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }

  console.log('\n' + '='.repeat(60));
  const high = findings.filter(f => f.sev === 'HIGH');
  const low = findings.filter(f => f.sev === 'LOW');
  if (high.length) {
    console.log(`UNREACHABLE INTERACTIVE CONTROLS: ${high.length}`);
    high.forEach(f => console.log(`  ${f.user}@${f.w} ${f.route} — ${f.tag}${f.id ? '#' + f.id : '.' + f.cls} "${f.txt}" +${f.worstRight}px`));
  } else console.log('No unreachable interactive control at any width, any role, any route.');
  if (low.length) {
    console.log(`\nUnreachable non-interactive content: ${low.length} occurrence(s), distinct:`);
    const seen = new Set();
    low.forEach(f => { const k = `${f.route}|${f.tag}|${f.cls}`; if (seen.has(k)) return; seen.add(k);
      console.log(`  ${f.route} ${f.tag}.${f.cls} "${f.txt}" +${f.worstRight}px (first ${f.user}@${f.w})`); });
  } else console.log('No unreachable non-interactive content either.');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
})();
