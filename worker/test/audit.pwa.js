// PROBE: drive the REAL app in a REAL browser and measure the theme system by
// COMPUTED STYLE, not by reading CSS. Also re-checks Bug 57 (the stuck scrim).
//
// Everything here is measured from the rendered page: getComputedStyle for
// colours, a real WCAG contrast computation, and elementFromPoint for the
// overlay. Reading the stylesheet would prove nothing about what a user sees.
const puppeteer = require('puppeteer');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

// `wrangler dev`'s ProxyController intermittently dies under the rapid
// open/close page churn this probe creates (an empty `[ERROR]` in the console
// and a ProxyController2.emitErrorEvent stack in the wrangler log). That is a
// LOCAL TOOLING flake, not an application defect — but if it is not detected,
// the probe reports ERR_CONNECTION_REFUSED and a careless reader records a
// green run as a pass or a red run as an app bug. Fail loudly and distinctly
// instead, so the two can never be confused.
async function assertServerUp(stage) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`\n!! DEV SERVER IS DOWN before "${stage}" — this is the wrangler dev`);
  console.error('!! ProxyController flake, NOT an application failure. Restart with');
  console.error('!!   bash test/devserver.sh 9001');
  console.error('!! and re-run. No result from this run should be trusted.');
  process.exit(3);
}

function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
function parse(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
// Flatten a possibly-translucent colour onto a known backdrop.
function over(fg, bg) {
  if (fg[3] >= 1) return fg;
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]);
}
function contrast(fgS, bgS) {
  const fg = parse(fgS), bg = parse(bgS);
  if (!fg || !bg) return null;
  const f = over(fg, bg);
  const l1 = lum(f), l2 = lum(bg);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function checkContrast(name, fg, bg, min) {
  const r = contrast(fg, bg);
  check(`${name} (>= ${min}:1)`, r !== null && r >= min, r === null ? `unparseable ${fg} on ${bg}` : `${r.toFixed(2)}:1  fg=${fg} bg=${bg}`);
  return r;
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // ---------------------------------------------------------------------
  // 1. NO FLASH OF LIGHT for a device whose OS is in dark mode, on a COLD
  //    load with no stored preference. This is the failure the head script
  //    exists to prevent, so it is measured first.
  // ---------------------------------------------------------------------
  await assertServerUp('A. first paint');
  console.log('\n=== A. FIRST PAINT (OS dark, no stored preference) ===');
  {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 1280, height: 900 });

    // MY FIRST ATTEMPT AT THIS CHECK WAS WORTHLESS AND I ONLY FOUND OUT BY
    // REVERTING. It read data-theme after `domcontentloaded`, which is AFTER
    // every script — including one at the end of <body> — has already run. It
    // passed just as happily with theme.js moved out of <head>, so it proved
    // nothing about the flash it was named for.
    //
    // This version pins the ORDERING instead, which is the thing that actually
    // determines whether a user sees a white flash: a MutationObserver
    // installed before ANY page script runs records the value of data-theme at
    // the exact moment <body> is inserted into the document. With theme.js
    // render-blocking in <head> the attribute is already set; with it anywhere
    // in <body>, the browser has begun building (and can paint) the body while
    // the attribute is still null. Verified by reverting: the revert now fails.
    await page.evaluateOnNewDocument(() => {
      window.__themeAtBodyStart = 'BODY_NEVER_SEEN';
      new MutationObserver((records, obs) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeName === 'BODY') {
              window.__themeAtBodyStart = document.documentElement.getAttribute('data-theme');
              obs.disconnect();
              return;
            }
          }
        }
        // Observe `document` with subtree:true, NOT document.documentElement:
        // at the moment evaluateOnNewDocument runs, <html> does not exist yet
        // (verified: document.documentElement === null here), so targeting it
        // silently observed nothing and the check reported BODY_NEVER_SEEN.
      }).observe(document, { childList: true, subtree: true });
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const atBody = await page.evaluate(() => window.__themeAtBodyStart);
    check('the theme is already applied when <body> starts parsing (no flash)',
      atBody === 'dark', `data-theme at <body> insertion = ${atBody}`);
    const early = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('theme is applied by the time the document is ready', early === 'dark', `data-theme=${early}`);
    await page.waitForSelector('#login-username');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const l = lum(parse(bg));
    check('the page really is dark, not just labelled dark', l < 0.15, `body bg=${bg} luminance=${l.toFixed(3)}`);
    const meta = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').getAttribute('content'));
    check('OS chrome colour follows the dark theme', meta === '#0d1512', `theme-color=${meta}`);
    await page.close();
  }

  // ---------------------------------------------------------------------
  // 2. OS light + explicit stored dark must WIN. A user who chose dark on a
  //    daytime phone must not be flipped back.
  // ---------------------------------------------------------------------
  await assertServerUp('B. explicit choice');
  console.log('\n=== B. AN EXPLICIT CHOICE BEATS THE DEVICE ===');
  {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('gl_pms_theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const t = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('stored dark survives a reload on a light device', t === 'dark', `data-theme=${t}`);
    // ...and the inverse.
    await page.evaluate(() => localStorage.setItem('gl_pms_theme', 'light'));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('stored light survives on a dark device', t2 === 'light', `data-theme=${t2}`);
    // Corrupt value must not brick the app.
    await page.evaluate(() => localStorage.setItem('gl_pms_theme', 'chartreuse'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const t3 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('a corrupt stored theme falls back to the device', t3 === 'dark', `data-theme=${t3}`);
    await page.close();
  }

  // ---------------------------------------------------------------------
  // 3. THE TOGGLE, from the login screen, before authenticating.
  // ---------------------------------------------------------------------
  await assertServerUp('C. toggle');
  console.log('\n=== C. TOGGLE ON THE LOGIN SCREEN ===');
  {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-theme-toggle');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('starts light on a light device', before === 'light', before);
    const visible = await page.evaluate(() => {
      const b = document.getElementById('login-theme-toggle');
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), hasIcon: !!b.querySelector('svg'), label: b.getAttribute('aria-label') };
    });
    check('the login toggle is a real, sized, visible control', visible.w >= 32 && visible.h >= 32, JSON.stringify(visible));
    check('...it has an icon (not an empty box)', visible.hasIcon);
    check('...and it names the ACTION for screen readers', visible.label === 'Switch to dark mode', visible.label);
    await page.click('#login-theme-toggle');
    await new Promise((r) => setTimeout(r, 300));
    const after = await page.evaluate(() => ({
      t: document.documentElement.getAttribute('data-theme'),
      label: document.getElementById('login-theme-toggle').getAttribute('aria-label'),
      pressed: document.getElementById('login-theme-toggle').getAttribute('aria-pressed'),
      stored: localStorage.getItem('gl_pms_theme'),
    }));
    check('pressing it switches to dark', after.t === 'dark', JSON.stringify(after));
    check('...the label updates to the new action', after.label === 'Switch to light mode', after.label);
    check('...aria-pressed reflects the state', after.pressed === 'true', after.pressed);
    check('...and the choice is persisted', after.stored === 'dark', String(after.stored));
    await page.close();
  }

  // ---------------------------------------------------------------------
  // 4. CONTRAST, MEASURED, ON REAL RENDERED ELEMENTS, IN BOTH THEMES.
  //    This is the part that catches a token that was inverted wrongly.
  // ---------------------------------------------------------------------
  for (const mode of ['light', 'dark']) {
    await assertServerUp('D. contrast ' + mode);
    console.log(`\n=== D. RENDERED CONTRAST — ${mode.toUpperCase()} THEME ===`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    // MY OWN TEST BUG, recorded rather than quietly patched: all these pages
    // share one browser profile, so the session written by the LIGHT pass was
    // still in localStorage for the DARK pass. The app correctly skipped the
    // login screen, and the probe then failed clicking a submit button that
    // was legitimately hidden. The app was right; the test was wrong.
    await page.evaluate((m) => { localStorage.clear(); localStorage.setItem('gl_pms_theme', m); }, mode);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-username');

    // Login card first (pre-auth surface).
    const loginCol = await page.evaluate(() => {
      const c = document.querySelector('.login-card');
      const h = c.querySelector('h1');
      const sub = c.querySelector('p.subtitle');
      const hint = c.querySelector('.live-sample-label');
      const btn = c.querySelector('.btn-primary');
      const g = (e) => getComputedStyle(e);
      return {
        cardBg: g(c).backgroundColor,
        h1: g(h).color,
        sub: g(sub).color,
        hint: g(hint).color,
        btnBg: g(btn).backgroundColor, btnFg: g(btn).color,
      };
    });
    checkContrast('login heading on card', loginCol.h1, loginCol.cardBg, 4.5);
    checkContrast('login subtitle on card', loginCol.sub, loginCol.cardBg, 4.5);
    checkContrast('Live Sample 1 label on card', loginCol.hint, loginCol.cardBg, 4.5);
    checkContrast('Sign in button label on its fill', loginCol.btnFg, loginCol.btnBg, 4.5);

    // Now authenticate and measure the real application chrome.
    await page.type('#login-username', 'manager');
    await page.type('#login-pin', '1234');
    await Promise.all([
      page.click('#login-form button[type=submit]'),
      page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
    ]);
    await new Promise((r) => setTimeout(r, 2500));

    const app = await page.evaluate(() => {
      const g = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const body = getComputedStyle(document.body);
      const card = g('.card') || g('.stat-card');
      const stat = document.querySelector('.stat-card');
      const th = g('th');
      const td = g('td');
      const tb = g('.topbar');
      const navA = document.querySelector('#sidebar a:not(.active)');
      const navActive = document.querySelector('#sidebar a.active');
      const sect = g('.nav-section');
      const out = {
        bodyBg: body.backgroundColor,
        bodyFg: body.color,
        cardBg: card ? card.backgroundColor : null,
        topbarBg: tb.backgroundColor, topbarFg: tb.color,
        thFg: th ? th.color : null, thBg: th ? th.backgroundColor : null,
        tdFg: td ? td.color : null,
        navFg: navA ? getComputedStyle(navA).color : null,
        navActiveFg: navActive ? getComputedStyle(navActive).color : null,
        navActiveBg: navActive ? getComputedStyle(navActive).backgroundColor : null,
        sectionFg: sect ? sect.color : null,
        sidebarBg: g('#sidebar').backgroundColor,
      };
      if (stat) {
        out.statLabel = getComputedStyle(stat.querySelector('.label')).color;
        out.statValue = getComputedStyle(stat.querySelector('.value')).color;
        out.statBg = getComputedStyle(stat).backgroundColor;
      }
      return out;
    });

    checkContrast('body text on the page', app.bodyFg, app.bodyBg, 4.5);
    if (app.cardBg) checkContrast('body text on a card', app.bodyFg, app.cardBg, 4.5);
    checkContrast('topbar text on the topbar', app.topbarFg, app.topbarBg, 4.5);
    if (app.thFg) checkContrast('table header on its own fill', app.thFg, app.thBg, 4.5);
    if (app.tdFg && app.cardBg) checkContrast('table cell text on a card', app.tdFg, app.cardBg, 4.5);
    if (app.navFg) checkContrast('inactive nav item', app.navFg, app.sidebarBg, 4.5);
    if (app.navActiveFg) checkContrast('ACTIVE nav item on its fill', app.navActiveFg, app.navActiveBg, 4.5);
    if (app.sectionFg) checkContrast('nav section caption', app.sectionFg, app.sidebarBg, 4.5);
    if (app.statLabel) checkContrast('stat card label', app.statLabel, app.statBg, 4.5);
    if (app.statValue) checkContrast('stat card VALUE (the number)', app.statValue, app.statBg, 4.5);

    // Toasts and the offline banner are chips with text on a solid fill —
    // the classic thing a naive inversion ruins.
    const chips = await page.evaluate(() => {
      const mk = (cls) => {
        const d = document.createElement('div');
        d.className = cls; d.textContent = 'x';
        document.getElementById('toast-container').appendChild(d);
        const s = getComputedStyle(d);
        const r = { bg: s.backgroundColor, fg: s.color };
        d.remove(); return r;
      };
      const banner = document.getElementById('offline-banner');
      banner.classList.remove('hidden');
      const bs = getComputedStyle(banner);
      const out = {
        toast: mk('toast'), success: mk('toast success'),
        error: mk('toast error'), warn: mk('toast warn'),
        banner: { bg: bs.backgroundColor, fg: bs.color },
      };
      banner.classList.add('offline-banner-danger');
      const ds = getComputedStyle(banner);
      out.bannerDanger = { bg: ds.backgroundColor, fg: ds.color };
      banner.classList.remove('offline-banner-danger');
      banner.classList.add('hidden');
      return out;
    });
    checkContrast('default toast', chips.toast.fg, chips.toast.bg, 4.5);
    checkContrast('success toast', chips.success.fg, chips.success.bg, 4.5);
    checkContrast('error toast', chips.error.fg, chips.error.bg, 4.5);
    checkContrast('warning toast', chips.warn.fg, chips.warn.bg, 4.5);
    checkContrast('OFFLINE banner (cashier must read this)', chips.banner.fg, chips.banner.bg, 4.5);
    checkContrast('offline banner in its FAILED state', chips.bannerDanger.fg, chips.bannerDanger.bg, 4.5);

    // Badges: every colour the app can emit, rendered for real.
    const badges = await page.evaluate(() => {
      const kinds = ['green', 'blue', 'amber', 'red', 'gray'];
      const host = document.querySelector('.card') || document.body;
      return kinds.map((k) => {
        const s = document.createElement('span');
        s.className = 'badge badge-' + k; s.textContent = 'Aa';
        host.appendChild(s);
        const cs = getComputedStyle(s);
        const r = { k, fg: cs.color, bg: cs.backgroundColor };
        s.remove(); return r;
      });
    });
    for (const b of badges) checkContrast(`badge-${b.k}`, b.fg, b.bg, 4.5);

    // The six former hardcoded pastels, now tokens, rendered on a card.
    const tints = await page.evaluate(() => {
      const names = ['--tint-amber', '--tint-green', '--tint-red', '--tint-gray'];
      const host = document.querySelector('.card') || document.body;
      const bodyFg = getComputedStyle(document.body).color;
      return names.map((n) => {
        const d = document.createElement('div');
        d.style.background = `var(${n})`; d.textContent = 'x';
        host.appendChild(d);
        const bg = getComputedStyle(d).backgroundColor;
        d.remove();
        return { n, bg, fg: bodyFg };
      });
    });
    for (const t of tints) checkContrast(`body text on ${t.n} callout`, t.fg, t.bg, 4.5);

    // Form controls must not be invisible.
    const form = await page.evaluate(() => {
      const host = document.querySelector('.card') || document.body;
      const w = document.createElement('div');
      w.className = 'form-row';
      w.innerHTML = '<label>L</label><input type="text" placeholder="ph" />';
      host.appendChild(w);
      const i = w.querySelector('input');
      const s = getComputedStyle(i);
      const r = { inpBg: s.backgroundColor, inpFg: s.color, inpBorder: s.borderTopColor, labelFg: getComputedStyle(w.querySelector('label')).color };
      w.remove(); return r;
    });
    checkContrast('text typed into an input', form.inpFg, form.inpBg, 4.5);
    checkContrast('input border against the card', form.inpBorder, app.cardBg || app.bodyBg, 1.4);
    checkContrast('form label', form.labelFg, app.cardBg || app.bodyBg, 4.5);

    await page.close();
  }

  // ---------------------------------------------------------------------
  // 5. BUG 57 REGRESSION — the scrim must not survive a navigation.
  // ---------------------------------------------------------------------
  await assertServerUp('E. mobile drawer');
  console.log('\n=== E. MOBILE DRAWER / SCRIM (BUG 57) ===');
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-username');
    await page.type('#login-username', 'manager');
    await page.type('#login-pin', '1234');
    await Promise.all([
      page.click('#login-form button[type=submit]'),
      page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
    ]);
    await new Promise((r) => setTimeout(r, 2000));

    const read = () => page.evaluate(() => {
      const sc = document.getElementById('nav-scrim');
      const cs = getComputedStyle(sc);
      const at = document.elementFromPoint(200, 500);
      return {
        sidebarOpen: document.getElementById('sidebar').classList.contains('open'),
        scrimShow: sc.classList.contains('show'),
        opacity: cs.opacity, pointer: cs.pointerEvents,
        aria: document.getElementById('nav-toggle').getAttribute('aria-expanded'),
        blocking: !!(at && at.id === 'nav-scrim'),
      };
    });

    await page.waitForFunction(() => window.App && typeof window.App._setNav === 'function', { timeout: 10000 });

    // A HARNESS LIMITATION, INVESTIGATED AND RULED OUT AS AN APP BUG.
    //
    // After the login navigation, this headless Chrome reports
    // document.hasFocus() === false and then silently DISCARDS every trusted
    // input event: page.click, page.mouse.click and even a raw CDP
    // Input.dispatchMouseEvent all deliver nothing, while el.click() works.
    // page.bringToFront() does not restore focus.
    //
    // I checked this against the app before blaming the harness: the exact
    // same probe run against the PREVIOUS commit (d1db264, before any of this
    // pass's changes) shows identical behaviour — real input works on the
    // login screen and stops working after login. So it is not something the
    // theme or Bug 57 work introduced, and it is not a defect in the app.
    // CDP hit-testing confirms the hamburger is the topmost element at its own
    // coordinates and that #nav-scrim is pointer-events:none while hidden, so
    // nothing in the page is intercepting.
    //
    // Real clicks ARE still exercised where they can be: the login submit and
    // the login-screen theme toggle above both go through page.click() and
    // pass. For the post-login drawer, the honest choice is to drive the same
    // handler the button is bound to rather than pretend a click happened —
    // and to ASSERT that the wiring exists, so a regression that unbinds the
    // hamburger is still caught.
    const wiring = await page.evaluate(() => {
      const t = document.getElementById('nav-toggle');
      const r = t.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { present: !!t, topmost: !!(at && at.closest('#nav-toggle')), w: Math.round(r.width), h: Math.round(r.height) };
    });
    check('the menu button exists and nothing overlaps it', wiring.present && wiring.topmost, JSON.stringify(wiring));
    check('...and it is a thumb-sized target', wiring.w >= 30 && wiring.h >= 30, JSON.stringify(wiring));

    // Drive the button's own handler (el.click() dispatches a real click event
    // through the same listener the user's tap would reach).
    await page.evaluate(() => document.getElementById('nav-toggle').click());
    await new Promise((r) => setTimeout(r, 500));
    let s = await read();
    check('pressing the menu button opens the drawer and shows the scrim',
      s.sidebarOpen && s.scrimShow && s.aria === 'true', JSON.stringify(s));

    // The exact reproduction: a hash change that did NOT come from a nav tap.
    await page.evaluate(() => { location.hash = '#/customers'; });
    await new Promise((r) => setTimeout(r, 2000));
    s = await read();
    check('a hash-change navigation closes the drawer', !s.sidebarOpen, JSON.stringify(s));
    check('...and REMOVES the scrim (Bug 57)', !s.scrimShow && s.pointer === 'none', JSON.stringify(s));
    check('...so nothing is swallowing taps on the page', !s.blocking, `elementFromPoint blocking=${s.blocking}`);
    check('...and the toggle reports collapsed to assistive tech', s.aria === 'false', s.aria);

    // The page must still be genuinely interactive afterwards.
    //
    // MY OWN TEST BUG (second one this run, recorded not hidden): the first
    // version of this probed a NAV link. At 390px the drawer is correctly
    // parked off-screen at left:-280px once closed, so elementFromPoint
    // returned null and reported 'nothing' — the app was behaving exactly as
    // designed and my assertion was nonsense. What actually matters is that
    // the CONTENT the user is looking at can be touched, so probe that: the
    // hamburger (which must always be reachable to get the menu back) and a
    // point in the middle of the rendered view.
    const clickable = await page.evaluate(() => {
      const t = document.getElementById('nav-toggle');
      const tr = t.getBoundingClientRect();
      const atToggle = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
      const view = document.getElementById('view');
      const vr = view.getBoundingClientRect();
      const y = Math.min(vr.top + 60, window.innerHeight - 10);
      const atView = document.elementFromPoint(vr.left + vr.width / 2, y);
      return {
        toggle: atToggle ? (atToggle.closest('#nav-toggle') ? 'reachable' : (atToggle.id || atToggle.tagName)) : 'nothing',
        view: atView ? (atView.closest('#view') ? 'reachable' : (atView.id || atView.tagName)) : 'nothing',
      };
    });
    check('the menu button is still reachable after the navigation', clickable.toggle === 'reachable', JSON.stringify(clickable));
    check('the page content is still touchable (no invisible sheet)', clickable.view === 'reachable', JSON.stringify(clickable));

    // Back button, the other path into Router.navigate().
    await page.evaluate(() => window.App._setNav(true));
    await new Promise((r) => setTimeout(r, 400));
    await page.goBack();
    await new Promise((r) => setTimeout(r, 1800));
    s = await read();
    check('the browser Back button also clears the scrim', !s.scrimShow && !s.blocking, JSON.stringify(s));

    await page.close();
  }

  // ---------------------------------------------------------------------
  // 6. BUG 58 — THE PAGE MUST NOT SCROLL SIDEWAYS ON A PHONE.
  //    Measured at every width this product actually meets. A document that
  //    scrolls horizontally makes every tap land in the wrong place.
  // ---------------------------------------------------------------------
  console.log('\n=== F. NO HORIZONTAL OVERFLOW ON ANY PHONE (BUG 58) ===');
  await assertServerUp('F. overflow');
  {
    for (const w of [320, 360, 390, 414]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 844 });
      // BYPASS THE SERVICE WORKER CACHE for this section.
      //
      // Found by reverting: the Bug 58 revert PASSED, which was impossible if
      // the check had teeth. The service worker serves /css/style.css
      // cache-first, so every page in this browser profile kept rendering the
      // stylesheet captured on the very first load — the probe was measuring
      // an old build. Any CSS assertion made without this is worthless, and
      // this is exactly the "a pass is not proof" trap.
      await page.setCacheEnabled(false);
      await page.goto(BASE, { waitUntil: 'networkidle0' });
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
      await page.goto(BASE, { waitUntil: 'networkidle0' });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-username');

      const loginOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`login screen does not scroll sideways at ${w}px`, loginOverflow <= 0, `overflow=${loginOverflow}px`);

      await page.type('#login-username', 'manager');
      await page.type('#login-pin', '1234');
      await Promise.all([
        page.click('#login-form button[type=submit]'),
        page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
      ]);
      await new Promise((r) => setTimeout(r, 2200));

      const r = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollX: window.scrollX,
        // The topbar itself must fit: it is sticky, so if IT overflows the
        // controls scroll out of reach entirely.
        topbarOverflow: (() => {
          const t = document.querySelector('.topbar');
          return Math.round(t.scrollWidth - t.clientWidth);
        })(),
        // Every topbar control must be inside the viewport.
        strays: ['#nav-toggle', '#theme-toggle', '#logout-btn'].map((s) => {
          const e = document.querySelector(s);
          if (!e || getComputedStyle(e).display === 'none') return null;
          const b = e.getBoundingClientRect();
          return b.right > document.documentElement.clientWidth + 1 || b.left < -1
            ? `${s} right=${Math.round(b.right)}` : null;
        }).filter(Boolean),
      }));
      check(`the app does not scroll sideways at ${w}px`, r.overflow <= 0, `overflow=${r.overflow}px scrollX=${r.scrollX}`);
      check(`the topbar itself fits at ${w}px`, r.topbarOverflow <= 0, `topbar overflow=${r.topbarOverflow}px`);
      // BUG 64: the fix for Bug 58 (min-width:0 so the row can shrink) let the
      // brand absorb ALL the shrinkage. Measured 0px wide at 320/360 and 3-6px
      // at 390/414 while the <svg> still reported 20px — the mark was clipped
      // to a 1px vertical tick. It is the app's identity in installed mode,
      // where there is no browser chrome, so it is not negotiable.
      const mark = await page.evaluate(() => {
        const brand = document.getElementById('topbar-brand');
        const svg = brand && brand.querySelector('svg.brand-ico');
        if (!brand || !svg) return null;
        return {
          container: Math.round(brand.getBoundingClientRect().width),
          svg: Math.round(svg.getBoundingClientRect().width),
        };
      });
      check(`the brand mark is not squashed at ${w}px`,
        mark && mark.container >= 18 && mark.svg >= 18, JSON.stringify(mark));
      check(`every topbar control is on-screen at ${w}px`, r.strays.length === 0, r.strays.join(', '));
      await page.close();
    }
  }

  // ---------------------------------------------------------------------
  // 7. PAPER IS ALWAYS LIGHT, WHATEVER THE APP THEME IS.
  //    The print frame links the app stylesheet. Verified adversarially:
  //    forcing data-theme="dark" onto that frame turns cards, badges, stat
  //    cards and unstyled tables into dark blocks with light text — on an
  //    80mm thermal roll that is a wasted roll per receipt.
  // ---------------------------------------------------------------------
  console.log('\n=== G. PRINTED OUTPUT STAYS BLACK-ON-WHITE IN BOTH THEMES ===');
  await assertServerUp('G. print');
  for (const mode of ['light', 'dark']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCacheEnabled(false);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(async (m) => {
      if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      localStorage.clear(); localStorage.setItem('gl_pms_theme', m);
    }, mode);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-username');
    await page.type('#login-username', 'manager');
    await page.type('#login-pin', '1234');
    await Promise.all([
      page.click('#login-form button[type=submit]'),
      page.waitForFunction(() => !document.getElementById('main-screen').classList.contains('hidden'), { timeout: 20000 }),
    ]);
    await new Promise((r) => setTimeout(r, 2400));

    const pr = await page.evaluate(async () => {
      window.print = () => {};
      // Deliberately include elements the print CSS does NOT define but the
      // views really do emit into printed documents, plus a table with no
      // .print-table class — those are the ones that would silently inherit.
      Exporter.printDocument(`
        <div class="print-header"><div class="print-business">Biz</div></div>
        <div class="card">card</div><span class="badge badge-green">B</span>
        <p class="muted">muted</p><div class="empty-state">empty</div>
        <div class="stat-card"><div class="label">L</div><div class="value">N1.00</div></div>
        <table><thead><tr><th>Bare</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>
        <table class="print-table"><thead><tr><th>P</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>`,
        { title: 'probe' });
      await new Promise((r) => setTimeout(r, 800));
      const d = document.getElementById('print-frame').contentDocument;
      const pick = (sel) => { const e = d.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return { fg: s.color, bg: s.backgroundColor }; };
      return {
        theme: d.documentElement.getAttribute('data-theme'),
        body: pick('body'), card: pick('.card'), badge: pick('.badge'),
        statCard: pick('.stat-card'), statValue: pick('.stat-card .value'),
        bareTh: pick('table:not(.print-table) th'), bareTd: pick('table:not(.print-table) td'),
        printTh: pick('table.print-table th'),
      };
    });

    check(`print frame pins the light theme (app is ${mode})`, pr.theme === 'light', `data-theme=${pr.theme}`);
    const inkOk = (v) => { const f = parse(v.fg); return f && lum(over(f, [255, 255, 255])) < 0.5; };
    const paperOk = (v) => { const b = parse(v.bg); return !b || b[3] === 0 || lum(b) > 0.8; };
    for (const [k, v] of Object.entries(pr)) {
      if (k === 'theme' || !v) continue;
      check(`  ${k}: dark ink on light paper (app is ${mode})`, inkOk(v) && paperOk(v), `fg=${v.fg} bg=${v.bg}`);
    }
    await page.close();
  }

  await browser.close();
  console.log(`\n${'='.repeat(62)}`);
  console.log(`PROBE RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
