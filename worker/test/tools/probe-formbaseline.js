// FORM BASELINE PROBE — do the controls on one inline row share a baseline?
//
// Bug 90 fixed a 166px vertical drift between controls on the Add User row by
// reserving label height. That fix is correct for LABELLED columns, but a bare
// action button sitting directly inside .form-inline has no label to reserve,
// so with align-items:flex-start it starts at the top of the row while every
// labelled input starts one label-height lower (Bug 92).
//
// Measures, per .form-inline row, the vertical spread between the visible
// controls (input/select/button). Anything beyond a couple of pixels is drift.
// Buttons are called out separately because that is the case Bug 92 covers and
// because a button floating above its own row is the one that looks broken.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

// A row is aligned when every control's top is within this many px. Selects
// render 2px taller than inputs in Chromium, so a small tolerance is correct.
const TOL = 6;

const WIDTHS = [390, 768, 1440];
// Screens that actually contain an inline form, by the role that can see them.
const CASES = [
  ['owner', ['/users', '/products', '/customers', '/suppliers', '/expenses',
    '/purchase-orders', '/transfers', '/till', '/accounting', '/admin']],
  ['a.cash1', ['/till', '/customers']],
];

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

async function rows(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.form-inline').forEach((f, i) => {
      const ctrls = [...f.querySelectorAll('input, select, button')]
        .filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
      if (ctrls.length < 2) return;
      // Only compare controls that are actually on the SAME visual row —
      // .form-inline wraps at narrow widths, and two controls on different
      // wrapped lines are SUPPOSED to have different tops.
      //
      // MY FIRST VERSION BUCKETED BY VERTICAL PROXIMITY (within 30px) and so
      // scored a clean pass on a row I had already measured as 40px out by
      // hand: the drifting button fell outside the band, became a bucket of
      // one, and was skipped. A grouping rule that discards the outlier can
      // never see an outlier. Recorded as trap #69.
      //
      // Flex wrapping is detected by X instead, which is what actually defines
      // a line: in an LTR flex row each item starts further right than the
      // last, and a WRAP is the moment left stops advancing. Vertical position
      // is then purely the thing under test, never an input to the grouping.
      const boxes = ctrls.map(e => { const r = e.getBoundingClientRect();
        return { el: e, tag: e.tagName.toLowerCase(),
          id: e.id || (e.textContent || '').trim().slice(0, 16),
          top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left) }; });
      const lines = [];
      let cur = [];
      for (const b of boxes) {
        if (cur.length && b.left <= cur[cur.length - 1].left) { lines.push(cur); cur = []; }
        cur.push(b);
      }
      if (cur.length) lines.push(cur);
      for (const group of lines) {
        if (group.length < 2) continue;
        const tops = group.map(g => g.top);
        const spread = Math.max(...tops) - Math.min(...tops);
        out.push({ form: i, spread, group: group.map(({ el, ...g }) => g) });
      }
    });
    return out;
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const findings = [];
  try {
    for (const [user, routes] of CASES) {
      for (const w of WIDTHS) {
        console.log(`\n=== ${user} @ ${w}px ===`);
        const { ctx, page } = await session(browser, user, w);
        for (const route of routes) {
          await page.evaluate(h => { location.hash = '#' + h; }, route);
          await sl(1700);
          let rs;
          try { rs = await rows(page); } catch (e) { bad(`${route} — probe threw ${e.message.slice(0, 50)}`); continue; }
          if (!rs.length) { ok(`${route} — no multi-control inline row to check`); continue; }
          const drifted = rs.filter(r => r.spread > TOL);
          if (!drifted.length) ok(`${route} — ${rs.length} inline row(s), all controls share a baseline`);
          else {
            drifted.forEach(d => {
              const hi = d.group.reduce((a, b) => (a.top < b.top ? a : b));
              const lo = d.group.reduce((a, b) => (a.top > b.top ? a : b));
              const detached = d.group.filter(g => g.bottom <= Math.max(...d.group.map(x => x.top)));
              bad(`${route} — inline row drifts ${d.spread}px: ${hi.tag}#${hi.id}@${hi.top} vs ${lo.tag}#${lo.id}@${lo.top}`
                + (detached.length ? ` — ${detached.map(x => x.tag + '#' + x.id).join(',')} sits ENTIRELY ABOVE the row` : ''));
              findings.push({ user, w, route, spread: d.spread, hi, lo, detached: detached.length });
            });
          }
        }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }

  console.log('\n' + '='.repeat(60));
  if (findings.length) {
    const worst = findings.reduce((a, b) => (a.spread > b.spread ? a : b));
    console.log(`Drifting inline rows: ${findings.length}. Worst: ${worst.route} @${worst.w}px — ${worst.spread}px`);
    const byRoute = {};
    findings.forEach(f => { byRoute[f.route] = Math.max(byRoute[f.route] || 0, f.spread); });
    Object.entries(byRoute).sort((a, b) => b[1] - a[1]).forEach(([r, s]) => console.log(`  ${r}: worst ${s}px`));
  } else console.log('Every inline form row shares a baseline at every width tested.');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
})();
