// =============================================================================
// Theme (light / dark) — loaded FIRST, in <head>, deliberately render-blocking
// =============================================================================
//
// WHY THIS IS A SEPARATE FILE IN <head> AND NOT AN INLINE <script>:
//
// The usual trick for a flash-free dark theme is a tiny inline <script> in the
// head. This app cannot do that. public/_headers ships
//     Content-Security-Policy: ... script-src 'self'; ...
// with no 'unsafe-inline' and no nonce, so an inline bootstrap would be BLOCKED
// by the browser on the real Cloudflare Pages deployment while working fine in
// local dev (where those headers aren't applied). That is the worst possible
// failure mode: a dark-mode user gets a white screen flash on every single page
// load in production only. An external same-origin file satisfies 'self', is
// precached by the service worker (so it costs no network round-trip after the
// first visit), and executes before <body> is parsed — which is what actually
// prevents the flash.
//
// LEGACY-BROWSER COMPATIBILITY: no optional chaining, no nullish coalescing, no
// arrow functions, no const/let-only assumptions beyond ES5+. This runs on the
// budget Android WebViews this product is deployed to, where a SyntaxError in a
// head script blanks the ENTIRE app before anything else even loads. This file
// is the single most dangerous place in the codebase to use modern syntax.
//
// THE MODEL, kept deliberately simple (two states, one button):
//   - No stored preference  -> follow the device ("system"). A cashier whose
//     phone is in night mode gets a dark app without ever finding a setting.
//   - Pressing the toggle   -> stores an explicit 'light' or 'dark' that then
//     wins over the device, forever, on that device.
// There is no tri-state cycle. A three-way button whose current meaning you
// have to infer is exactly the kind of cleverness this UI is trying to avoid.

var Theme = (function () {
  var KEY = 'gl_pms_theme';

  // The <meta name="theme-color"> value paints the browser/OS chrome around
  // the PWA (Android status bar, desktop title bar). Left at the light value,
  // a dark app renders under a bright green bar, which looks broken in
  // standalone/installed mode. These MUST stay in sync with --topbar-bg in
  // css/style.css; audit.pwa.js asserts exactly that, because a silent drift
  // here is invisible in a browser tab and only shows up once installed.
  var CHROME = { light: '#0a3b2c', dark: '#0d1512' };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      // Private mode / disabled storage must never break the app: fall back to
      // following the device rather than throwing out of a head script.
      return null;
    }
  }

  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  // The theme actually being rendered right now: always 'light' or 'dark',
  // never 'system'. Views and the toggle label ask this.
  function effective() {
    var s = stored();
    if (s) return s;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  // True when the user has never pressed the toggle on this device.
  function isFollowingSystem() {
    return stored() === null;
  }

  function apply() {
    var mode = effective();
    var root = document.documentElement;
    root.setAttribute('data-theme', mode);
    // color-scheme makes the browser render its OWN widgets (scrollbars, form
    // controls, the <select> dropdown popup, date pickers) in the matching
    // shade. Without it a dark app still gets a blinding white scrollbar and a
    // white native dropdown over the branch switcher.
    root.style.colorScheme = mode;
    setChromeColour(mode);
    return mode;
  }

  function setChromeColour(mode) {
    // <head> may not be fully parsed the first time this runs; that is fine,
    // the meta tag ships with the light value and this corrects it on the
    // second call from App.init(). Guarded so it can never throw.
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', CHROME[mode] || CHROME.light);
    } catch (e) { /* head not ready — corrected on the next apply() */ }
  }

  function set(mode) {
    try {
      if (mode === 'light' || mode === 'dark') localStorage.setItem(KEY, mode);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage unavailable — the theme still applies for this page */ }
    var applied = apply();
    syncToggles();
    return applied;
  }

  function toggle() {
    return set(effective() === 'dark' ? 'light' : 'dark');
  }

  // Reverts to following the device. Not currently surfaced as its own
  // control (see the two-state note above) but kept as the honest inverse of
  // set(), and used by the tests to restore a clean state.
  function followSystem() {
    return set(null);
  }

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true" width="18" height="18"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>';

  // Every registered toggle button is kept in sync, so the login screen's
  // control and the topbar's control can never disagree about the current
  // state — they are the same state rendered twice.
  var toggleIds = [];

  function labelFor(mode) {
    // The button states the ACTION it performs, not the state it is in.
    // "Dark mode" on a button that is currently showing a moon is ambiguous;
    // "Switch to dark mode" is not. Screen readers read this verbatim.
    return mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function syncToggles() {
    var mode = effective();
    for (var i = 0; i < toggleIds.length; i++) {
      var el = document.getElementById(toggleIds[i]);
      if (!el) continue;
      // Show the icon of the theme you would GET by pressing — a moon means
      // "press for dark". This is the convention users already know from iOS
      // and Android quick settings.
      el.innerHTML = mode === 'dark' ? SUN : MOON;
      el.setAttribute('aria-label', labelFor(mode));
      el.setAttribute('title', labelFor(mode));
      el.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
    }
  }

  // Wire a button by id. Safe to call repeatedly for the same id (the login
  // view re-renders its card on every logout), and safe to call for an id that
  // does not exist yet.
  function mount(id) {
    if (toggleIds.indexOf(id) === -1) toggleIds.push(id);
    var el = document.getElementById(id);
    if (el && !el.getAttribute('data-theme-bound')) {
      el.setAttribute('data-theme-bound', '1');
      el.addEventListener('click', function () { toggle(); });
    }
    syncToggles();
  }

  // Follow the device live, but ONLY while the user has not made an explicit
  // choice. Someone who deliberately set light mode must not be flipped to
  // dark at sunset by their phone's automatic schedule.
  try {
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (isFollowingSystem()) { apply(); syncToggles(); } };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange); // Safari < 14 / old WebView
    }
  } catch (e) { /* matchMedia unsupported — the app just stays on its stored theme */ }

  // Applied IMMEDIATELY at parse time, before <body> exists. This is the line
  // that actually prevents the white flash.
  apply();

  return {
    apply: apply,
    set: set,
    toggle: toggle,
    followSystem: followSystem,
    effective: effective,
    isFollowingSystem: isFollowingSystem,
    mount: mount,
    syncToggles: syncToggles,
    CHROME: CHROME,
  };
})();

window.Theme = Theme;
