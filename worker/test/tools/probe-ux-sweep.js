// probe-uxsweep — a UI/UX gap hunt, run as a machine rather than by eye.
//
// The role-trigger probe already proves every menu item opens. This asks the
// questions a person notices and a status code cannot:
//
//   * does anything overflow the screen on the narrowest phone still in real
//     use in Nigeria (320px)?
//   * is any interactive control too small to hit with a thumb?
//   * does any screen render an empty shell — a heading and nothing else —
//     where the user is given no next step?
//   * do any raw template artefacts ("undefined", "NaN", "[object Object]",
//     "null") reach the page?
//   * does every form control have a label a screen reader can announce?
//   * are the tap targets in the primary flow reachable without scrolling
//     horizontally?
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const ROLES = [
  { label: 'OWNER', user: 'owner' },
  { label: 'BRANCH MANAGER', user: 'lagos.mgr' },
  { label: 'STAFF', user: 'lagos.staff' },
];
const WIDTHS = [{ name: 'phone-320', w: 320, h: 720 }, { name: 'desktop-1440', w: 1440, h: 1000 }];

async function signIn(browser, username, width, height) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.on('dialog', async (d) => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-username', u); set('login-pin', '1234');
  }, username);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await page.waitForFunction(() => typeof State !== 'undefined' && !!State.getSession(), { timeout: 15000 });
  await sl(1800);
  return { ctx, page };
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  for (const size of WIDTHS) {
    for (const role of ROLES) {
      console.log(`\n=== ${role.label} @ ${size.name} ===`);
      let page;
      try { ({ page } = await signIn(browser, role.user, size.w, size.h)); }
      catch (e) { check(`${role.user} signs in at ${size.w}px`, false, e.message.slice(0, 70)); continue; }

      const dests = await page.evaluate(() => [...document.querySelectorAll('#sidebar a[data-nav]')]
        .filter((a) => getComputedStyle(a).display !== 'none')
        .map((a) => a.getAttribute('data-nav')));

      const overflow = [], tiny = [], hollow = [], artefacts = [], unlabelled = [];
      const unassociated = [];
      for (const d of dests) {
        await page.evaluate((h) => { location.hash = `#/${h}`; }, d);
        // Wait for the screen to FINISH, not just to start. The router paints
        // a "Loading…" placeholder first and several screens fetch before
        // rendering; a fixed 1s sample caught the dashboard mid-load and
        // reported an 8-character "empty shell" on a screen that renders
        // 3,803 characters when given a moment. Poll for real content, with
        // a ceiling so a genuinely empty screen is still reported.
        await sl(600);
        for (let i = 0; i < 12; i++) {
          const settled = await page.evaluate(() => {
            const v = document.getElementById('view') || document.body;
            const t = (v.innerText || '').trim();
            return t.length > 60 && !/^Loading/i.test(t);
          });
          if (settled) break;
          await sl(400);
        }
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          // Widest element that spills past the viewport. Measuring the
          // ELEMENT not the document: a control wider than the screen can
          // overflow while document.scrollWidth stays clean (Bug 76).
          //
          // MY FIRST VERSION OF THIS WAS WRONG and reported six healthy
          // screens as broken. It flagged any element wider than the viewport
          // — but a wide TABLE inside a `.table-wrap { overflow-x: auto }` is
          // the intended design: the table scrolls within its own box and the
          // page does not move. Measured: doc.scrollWidth === clientWidth ===
          // 320 on every one of them.
          //
          // The user-visible failure is content that is off-screen and
          // UNREACHABLE — i.e. the PAGE scrolls sideways, or an element
          // overflows while NOT inside something that scrolls. Both are
          // checked; a wide child of a scrollable ancestor is not a defect.
          let worst = null;
          const scrolls = (el) => {
            for (let n = el.parentElement; n; n = n.parentElement) {
              const ox = getComputedStyle(n).overflowX;
              if (ox === 'auto' || ox === 'scroll') return true;
            }
            return false;
          };
          document.querySelectorAll('body *').forEach((el) => {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return;
            const over = Math.round(b.right - vw);
            if (over > 2 && !scrolls(el) && (!worst || over > worst.over)) {
              worst = { over, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 28) };
            }
          });
          const pageScrollsSideways = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
          // Interactive controls smaller than a comfortable thumb target.
          //
          // Measure the EFFECTIVE tap target, not the control's own box. A
          // checkbox is 18px by design and always will be — what the thumb
          // actually hits is the <label> wrapping it, which this stylesheet
          // already sizes to 44px. My first version flagged every checkbox on
          // the Plan screen as too small; the control was fine and the check
          // was naive.
          const small = [];
          document.querySelectorAll('button, a[href], select, input:not([type=hidden])').forEach((el) => {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return;
            const lab = el.closest('label');
            const eff = lab ? Math.max(b.height, lab.getBoundingClientRect().height) : b.height;
            if (eff < 22) small.push(`${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 18)}(${Math.round(eff)}px)`);
          });
          const view = document.getElementById('view') || document.querySelector('.view') || document.body;
          const text = (view.innerText || '').trim();
          // Form controls with nothing a screen reader can announce.
          const noLabel = [];
          const unassoc = [];
          document.querySelectorAll('#view input:not([type=hidden]), #view select, #view textarea').forEach((el) => {
            const id = el.getAttribute('id');
            // This app's convention is `.form-row > label + input` — a
            // SIBLING label, not a wrapper and not `for=`. That looks correct
            // and reads correctly to a sighted user, but a screen reader
            // cannot associate the two, so the field is announced as just
            // "edit text". My first version of this check ignored the
            // sibling case and reported every well-formed field as
            // unlabelled; counting it as a PASS would have been equally
            // wrong, so it is counted separately below.
            const row = el.closest('.form-row');
            const sibling = row && row.querySelector('label');
            const explicit = (id && document.querySelector(`label[for="${id}"]`))
              || el.closest('label') || el.getAttribute('aria-label');
            const anyText = explicit || sibling || el.getAttribute('placeholder') || el.getAttribute('title');
            if (!anyText) noLabel.push(`${el.tagName.toLowerCase()}#${id || '(no id)'}`);
            else if (!explicit && sibling && id) unassoc.push(id);
          });
          return {
            worst, pageScrollsSideways,
            small: [...new Set(small)].slice(0, 3),
            len: text.length,
            junk: (text.match(/\b(undefined|NaN|\[object Object\]|null)\b/g) || []).slice(0, 2),
            noLabel: [...new Set(noLabel)].slice(0, 3),
            unassoc: [...new Set(unassoc)],
          };
        });
        if (r.worst) overflow.push(`${d}:${r.worst.tag}.${r.worst.cls}+${r.worst.over}px`);
        if (r.pageScrollsSideways) overflow.push(`${d}:THE PAGE ITSELF scrolls sideways`);
        if (r.small.length) tiny.push(`${d}:${r.small.join(',')}`);
        if (r.len < 40) hollow.push(`${d}(${r.len} chars)`);
        if (r.junk.length) artefacts.push(`${d}:${r.junk.join(',')}`);
        if (r.noLabel.length) unlabelled.push(`${d}:${r.noLabel.join(',')}`);
        if (r.unassoc.length) unassociated.push(...r.unassoc);
      }

      check(`nothing overflows the ${size.w}px viewport`, overflow.length === 0, overflow.slice(0, 3).join(' | '));
      check('every control is big enough to tap', tiny.length === 0, tiny.slice(0, 2).join(' | '));
      check('no screen renders an empty shell', hollow.length === 0, hollow.join(' | '));
      check('no raw undefined/NaN/[object Object] reaches the page', artefacts.length === 0, artefacts.slice(0, 3).join(' | '));
      check('every form control has visible label text', unlabelled.length === 0, unlabelled.slice(0, 3).join(' | '));
      // Reported separately because it is an ACCESSIBILITY gap, not a broken
      // screen: the label is there and readable, it is simply not programmatically
      // tied to its input.
      check('...and that label is programmatically associated (for= / aria-label)',
        unassociated.length === 0,
        `${unassociated.length} fields rely on a sibling label only, e.g. ${unassociated.slice(0, 4).join(', ')}`);

      await page.close();
    }
  }

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
