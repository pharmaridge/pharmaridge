// BUG 94 REGRESSION PROBE — the topbar must not stack its own controls.
//
// Reported by the client: on ADMIN and OWNER mobile the "All Branches (Total)"
// branch switcher sat on top of the mortar-and-pestle brand mark. Measured
// before the fix at 320px: the mark occupies x=56..76 and the switcher's left
// edge was at x=57 — it covered 19 of the mark's 20px, i.e. effectively all of
// it, at 320/360/390/414px, for both roles.
//
// Two causes, both regression-locked here:
//   1. `.brand { flex-shrink: 0 }` inside a `.topbar-left { min-width: 0 }`
//      made the brand OVERFLOW its parent instead of compressing, and
//      `.topbar-right` painted over the overflow.
//   2. `.branch-switcher { max-width: 100% }` below 560px let the control claim
//      the whole flex line — widest exactly where there is least room.
//
// The label is asserted too, because capping the width alone left the closed
// <select> reading "All Brar": a control truncated mid-word. Every role that
// gets a switcher is checked, because a branch-PINNED manager and STAFF get a
// scope label instead and must not regress into a switcher.
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

const WIDTHS = [320, 360, 390, 414, 480, 560, 640, 768, 900, 1024, 1440];
// Roles that see the org-wide switcher, and roles that must NOT.
const SWITCHER_ROLES = [['admin', 'ADMIN'], ['owner', 'OWNER'], ['c.gm', 'GENERAL MANAGER']];
const LABEL_ROLES = [['c.mgr1', 'BRANCH MANAGER (pinned)'], ['a.cash1', 'STAFF']];

async function session(browser, username, width, theme = 'light') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width, height: 844 });
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
  await sl(1500);
  return { ctx, page };
}

async function measure(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const vis = e => !!(e && e.offsetParent !== null && e.getBoundingClientRect().width > 0);
    const R = e => { const r = e.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top),
        b: Math.round(r.bottom), w: Math.round(r.width) }; };
    const sw = q('#branch-switcher'), ico = q('.brand-ico'), brand = q('.brand');
    const nav = q('#nav-toggle'), th = q('#theme-toggle'), lo = q('#logout-btn');
    const label = q('#branch-scope-label');
    const overlap = (a, b) => {
      if (!a || !b) return 0;
      const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      return (x > 0 && y > 0) ? Math.round(x) : 0;
    };
    const out = {
      vw: document.documentElement.clientWidth,
      switcherVisible: vis(sw), labelVisible: vis(label),
      icoVisible: vis(ico),
    };
    if (vis(sw)) {
      const S = R(sw);
      out.sw = S;
      out.swText = sw.selectedOptions[0] ? sw.selectedOptions[0].text : '';
      // Does the CLOSED select truncate its own selected text?
      const cs = getComputedStyle(sw);
      const cv = document.createElement('canvas').getContext('2d');
      cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const usable = sw.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 18;
      out.textWidth = Math.ceil(cv.measureText(out.swText).width);
      out.usableWidth = Math.round(usable);
      out.truncated = out.textWidth > usable + 1;
      out.ovIco = vis(ico) ? overlap(S, R(ico)) : 0;
      out.ovBrand = vis(brand) ? overlap(S, R(brand)) : 0;
      out.ovNav = vis(nav) ? overlap(S, R(nav)) : 0;
      out.ovTheme = vis(th) ? overlap(S, R(th)) : 0;
      out.ovLogout = vis(lo) ? overlap(S, R(lo)) : 0;
    }
    if (vis(label)) { out.label = R(label); out.labelText = label.textContent.trim();
      out.ovLabelIco = vis(ico) ? overlap(R(label), R(ico)) : 0; }
    // Nothing in the topbar may escape the viewport either.
    const bar = q('.topbar');
    out.escapes = [...bar.querySelectorAll('*')].filter(e => {
      if (!vis(e)) return false;
      const r = e.getBoundingClientRect();
      return r.right > document.documentElement.clientWidth + 1 || r.left < -1;
    }).map(e => (e.id || e.className || e.tagName) + '');
    return out;
  });
}

(async () => {
  try { const h = await fetch(BASE + '/api/health'); if (!h.ok) throw new Error('health ' + h.status); }
  catch (e) { console.log('server not reachable: ' + e.message); process.exit(3); }

  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const [user, role] of SWITCHER_ROLES) {
      console.log(`\n=== ${role} (${user}) — org-wide branch switcher ===`);
      for (const w of WIDTHS) {
        const { ctx, page } = await session(browser, user, w);
        const m = await measure(page);
        if (!m.switcherVisible) {
          bad(`@${w}px — ${role} should have the org-wide switcher and does not`);
          await ctx.close(); continue;
        }
        // THE REPORTED DEFECT: the switcher over the brand mark.
        if (m.ovIco === 0) ok(`@${w}px — switcher clears the brand mark (sw.left=${m.sw.l}, mark ends ${m.icoVisible ? 'x' : 'hidden'})`);
        else bad(`@${w}px — switcher covers ${m.ovIco}px of the ${20}px brand mark`);
        // ...and any other topbar control.
        const others = { brand: m.ovBrand, nav: m.ovNav, theme: m.ovTheme, logout: m.ovLogout };
        const hit = Object.entries(others).filter(([, v]) => v > 0);
        if (!hit.length) ok(`@${w}px — switcher overlaps no other topbar control`);
        else bad(`@${w}px — switcher overlaps ${hit.map(([k, v]) => `${k} by ${v}px`).join(', ')}`);
        // The label must remain a readable word, not a truncated fragment.
        if (!m.truncated) ok(`@${w}px — "${m.swText}" fits (${m.textWidth}px of ${m.usableWidth}px usable)`);
        else bad(`@${w}px — "${m.swText}" is truncated (${m.textWidth}px needs > ${m.usableWidth}px usable)`);
        // Client instruction: on mobile the control must be 3/5–3/4 of the
        // 150px it used to be, i.e. 90–112px. Asserted as a RANGE so a future
        // tweak inside the agreed band does not fail, but growing it back to
        // the old width does.
        if (w <= 900) {
          if (m.sw.w >= 88 && m.sw.w <= 113) ok(`@${w}px — switcher is ${m.sw.w}px, within the agreed 3/5–3/4 band`);
          else bad(`@${w}px — switcher is ${m.sw.w}px, outside the agreed 90–112px mobile band`);
        }
        if (!m.escapes.length) ok(`@${w}px — nothing in the topbar escapes the viewport`);
        else bad(`@${w}px — topbar content escapes: ${m.escapes.slice(0, 3).join(', ')}`);
        await ctx.close();
      }
    }

    // A pinned manager and a cashier get a LABEL, never the switcher; that
    // label must not sit on the mark either.
    for (const [user, role] of LABEL_ROLES) {
      console.log(`\n=== ${role} (${user}) — scope label, no switcher ===`);
      for (const w of [320, 390, 768, 1440]) {
        const { ctx, page } = await session(browser, user, w);
        const m = await measure(page);
        if (m.switcherVisible) bad(`@${w}px — ${role} must NOT get the org-wide switcher`);
        else ok(`@${w}px — no org-wide switcher, as designed`);
        if (m.labelVisible && m.ovLabelIco > 0) bad(`@${w}px — scope label covers ${m.ovLabelIco}px of the brand mark`);
        else ok(`@${w}px — scope label clears the brand mark`);
        await ctx.close();
      }
    }

    // Dark mode uses the same box model, but assert it rather than assume it.
    console.log('\n=== DARK MODE ===');
    for (const w of [320, 390, 768]) {
      const { ctx, page } = await session(browser, 'owner', w, 'dark');
      const m = await measure(page);
      if (m.switcherVisible && m.ovIco === 0 && !m.truncated) ok(`@${w}px dark — switcher clears the mark and "${m.swText}" fits`);
      else bad(`@${w}px dark — ovIco=${m.ovIco} truncated=${m.truncated} text="${m.swText}"`);
      await ctx.close();
    }
  } finally { await browser.close(); }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
