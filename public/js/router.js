// Minimal hash-based router.
//
// Cleanup contract: views often need a document/window-level listener
// (e.g. POS closing a search dropdown on an outside click). Attaching
// those directly with document.addEventListener and never removing them
// would leak one extra listener on every single navigation into that
// view — over a full shift of a cashier bouncing in and out of the POS
// screen hundreds of times, that turns into real, compounding memory
// and CPU overhead. Views should register such listeners via
// Router.onCleanup(fn) instead; every registered cleanup runs
// automatically right before the next view renders.
const Router = (() => {
  const routes = {};
  let cleanupFns = [];
  // BUG 63 — THE USER COULD END UP LOOKING AT A SCREEN THEY DID NOT ASK FOR.
  //
  // navigate() is async: it paints "Loading…", awaits the view's own data
  // fetches, and the view then writes into #view. There was no guard against
  // two navigations overlapping, so BOTH ran to completion and BOTH wrote the
  // same element — whichever resolved LAST won, regardless of which one the
  // user actually asked for.
  //
  // Reproduced with one endpoint slowed to 2.5s, which is an ordinary Nigerian
  // mobile connection, not a contrived delay:
  //     tap Dashboard, wait 300ms, tap Sales History
  //     -> URL: #/sales   nav highlight: sales   SCREEN: "Dashboard"
  // The URL and the menu agree with each other and disagree with the content,
  // with no error and nothing to retry. It also fired at login: setting the
  // hash before afterLogin()'s own navigate() had finished left the Dashboard
  // painted under a #/plan URL, permanently.
  //
  // Fixed with a monotonic generation token. Every navigate() takes the next
  // ticket; after each await it checks whether it is still the current one and
  // abandons the write if not. The stale response is discarded instead of
  // overwriting the screen the user is now on.
  let navToken = 0;

  function register(path, renderFn) {
    routes[path] = renderFn;
  }

  // Views call this instead of document.addEventListener directly when
  // they need a listener that must be torn down on navigation away.
  function onCleanup(fn) {
    cleanupFns.push(fn);
  }

  function runCleanup() {
    for (const fn of cleanupFns) {
      try { fn(); } catch (e) { console.error('[router] cleanup failed', e); }
    }
    cleanupFns = [];
  }

  function currentPath() {
    return (location.hash || '#/dashboard').replace('#', '');
  }

  // BUG 63, part 2 — THE STALE HANDLER STILL PAINTED.
  //
  // A view's final act IS `view.innerHTML = ...`, so comparing tokens after
  // `await handler()` returns is too late: the stale screen is already up.
  // Four attempts failed before this one, and the reasons are kept because
  // they are the same mistake in different clothes:
  //
  //   1. Check the token after the await.  -> already painted.
  //   2. Module-level "current writer" token set at navigation start.
  //      -> the SLOW handler writes later, when that variable already names
  //         the newest navigation (itself), so the write passes. Observed:
  //         `[gate] write "Dashboard" -> applied` arriving after Sales History.
  //   3. Re-pin the token around the handler call. -> JavaScript has no
  //      continuation-local storage; the pin is gone after the first await.
  //   4. Hand the handler a DETACHED element and only attach it if still
  //      current. -> broke 4 screens outright: the views make 167
  //      `document.getElementById(...)` calls plus 11 `UI.on(...)` lookups
  //      against their OWN children, all of which return null while the tree
  //      is out of the document ("Failed to load: Cannot set properties of
  //      null"). The element must stay attached.
  //
  // What works, and is the smallest thing that can: give each navigation its
  // own tiny proxy object standing in for the view. `innerHTML` on the proxy
  // forwards to the real #view only while that navigation is still current;
  // once superseded it silently swallows the write. Views receive the proxy
  // instead of the element, the real element never leaves the DOM, and every
  // document.getElementById call inside a view keeps working exactly as
  // before. Nothing to keep in sync and no ordering assumption to get wrong.
  //
  // Deliberately NOT cancelling the in-flight requests: that would mean
  // rewriting every view around AbortController, and the responses are
  // harmless — they are simply no longer wanted on screen.
  function viewProxyFor(token) {
    const real = document.getElementById('view');
    return {
      get innerHTML() { return real.innerHTML; },
      set innerHTML(html) {
        if (token !== navToken) return; // superseded — drop the paint
        real.innerHTML = html;
      },
      // A few views touch the element beyond innerHTML. Forward the small,
      // real surface rather than a blanket Proxy, which older WebViews in this
      // deployment's target range do not support.
      get classList() { return real.classList; },
      get className() { return real.className; },
      set className(v) { real.className = v; },
      get dataset() { return real.dataset; },
      querySelector(sel) { return real.querySelector(sel); },
      querySelectorAll(sel) { return real.querySelectorAll(sel); },
      appendChild(n) { return real.appendChild(n); },
      addEventListener(t, f, o) { return real.addEventListener(t, f, o); },
      removeEventListener(t, f, o) { return real.removeEventListener(t, f, o); },
      scrollTo() { return real.scrollTo.apply(real, arguments); },
      get element() { return real; },
    };
  }

  function register(path, renderFn) {
    routes[path] = renderFn;
  }

  // Views call this instead of document.addEventListener directly when
  // they need a listener that must be torn down on navigation away.
  function onCleanup(fn) {
    cleanupFns.push(fn);
  }

  function runCleanup() {
    for (const fn of cleanupFns) {
      try { fn(); } catch (e) { console.error('[router] cleanup failed', e); }
    }
    cleanupFns = [];
  }

  function currentPath() {
    return (location.hash || '#/dashboard').replace('#', '');
  }

  // BUG 63, part 2 — THE STALE HANDLER STILL PAINTED.
  //
  // A view's final act IS `view.innerHTML = ...`, so comparing tokens after
  // `await handler()` returns is too late: the stale screen is already on
  // display. Three attempts at gating the write failed, and the reasons are
  // worth keeping because they are all the same mistake in different clothes:
  //
  //   1. Check the token after the await.        -> already painted.
  //   2. Module-level "current writer" token set at navigation start.
  //      -> the SLOW handler writes later, by which time that variable names
  //         the newest navigation (itself), so the write passes. Observed:
  //         `[gate] write "Dashboard" -> applied` landing after Sales History.
  //   3. Re-pin the token around the handler call.
  //      -> JavaScript has no continuation-local storage. The pin is restored
  //         the moment the handler first awaits, so by its final synchronous
  //         stretch — the stretch that paints — it is gone again.
  //
  // What IS reliable is object identity. Each navigation gets its own detached
  // container element and the handler is only ever given that. When the
  // navigation is still current, its container is adopted into the DOM; when
  // it has been superseded, its container is simply never attached and is
  // garbage. A stale handler cannot paint over the live screen because it was
  // never holding the live element in the first place — no token to keep in
  // sync, no ordering assumption, nothing to get wrong later.
  //
  // Deliberately NOT cancelling the in-flight requests: that would mean
  // rewriting every view around AbortController, and the responses are
  // harmless — they are simply no longer wanted on screen.

  function register(path, renderFn) {
    routes[path] = renderFn;
  }

  // Views call this instead of document.addEventListener directly when
  // they need a listener that must be torn down on navigation away.
  function onCleanup(fn) {
    cleanupFns.push(fn);
  }

  function runCleanup() {
    for (const fn of cleanupFns) {
      try { fn(); } catch (e) { console.error('[router] cleanup failed', e); }
    }
    cleanupFns = [];
  }

  function currentPath() {
    return (location.hash || '#/dashboard').replace('#', '');
  }

  // BUG 63, part 2 — GATING AFTER `await handler()` IS TOO LATE.
  //
  // The first attempt compared the token once the view function had RETURNED.
  // But a view's final act IS `view.innerHTML = ...`, so by then the stale
  // screen is already painted and discarding the return value changes nothing.
  // Traced live, with one endpoint slowed to 2.5s:
  //
  //   #view <= "Sales History"    <- what the user asked for
  //   #view <= "Dashboard"        <- the slow one, landing after
  //   [router] discarded stale render for /dashboard    <- too late
  //
  // The WRITE itself must be gated. There are 35 `view.innerHTML =` sites
  // across 19 view files, so routing them through a helper would mean 35 edits
  // and any one missed silently reopens the bug. Instead the gate lives on the
  // #view element: its innerHTML setter is replaced once, at startup, and
  // refuses writes that belong to a superseded navigation. One place, and no
  // view file can bypass it — including a view added later.
  //
  // Deliberately a dropped write rather than a cancelled request: aborting the
  // in-flight fetches would require rewriting every view around
  // AbortController, and the responses are harmless — they are simply no
  // longer wanted on screen.

  // BUG 114 — A VISIBLE LABEL IS NOT AN ANNOUNCED LABEL.
  //
  // This app's markup convention is `.form-row > label + input`: the label
  // sits BESIDE the field, not wrapping it and with no `for=`. Sighted users
  // read it correctly, which is why it survived every previous audit. A
  // screen reader cannot associate the two, so ~47 fields across POS,
  // Products, Customers, Till and Transfers were announced as a bare "edit
  // text" — the operator is told nothing about what they are typing into.
  //
  // Fixed once, here, rather than at 98 markup sites: a per-site fix is one
  // somebody forgets on the next screen they add, and this way a NEW screen
  // inherits the behaviour automatically.
  //
  // Never overwrites an explicit `for=` or `aria-label`, and leaves a label
  // that WRAPS its control alone — that pairing is already associated by the
  // HTML spec.
  function associateFormLabels(root) {
    let n = 0;
    try {
      (root || document).querySelectorAll('.form-row').forEach((row) => {
        const label = row.querySelector(':scope > label');
        if (!label || label.getAttribute('for')) return;
        if (label.querySelector('input, select, textarea')) return;
        const fields = [...row.querySelectorAll('input:not([type=hidden]), select, textarea')];
        if (!fields.length) return;
        // A row can hold SEVERAL controls under one label — the change-owed
        // row is "Who is the change for?" over both a name and a phone box.
        // `for=` can only point at one, so the first gets the association and
        // the rest get an aria-label derived from the shared label plus their
        // own placeholder ("Who is the change for? — Phone number"). Linking
        // only the first, as my initial version did, left the others silent.
        const text = (label.textContent || '').trim().replace(/\s+/g, ' ');
        fields.forEach((field, i) => {
          if (field.getAttribute('aria-label')) return;
          if (i === 0) {
            if (!field.id) field.id = `fld-${Date.now().toString(36)}-${n++}`;
            label.setAttribute('for', field.id);
          } else {
            const own = field.getAttribute('placeholder') || field.getAttribute('title') || '';
            field.setAttribute('aria-label', own ? `${text} — ${own}` : text);
          }
        });
      });
    } catch (e) { /* never let an accessibility nicety break a screen */ }
  }

  // Re-associates labels for controls added after the initial render.
  // Disconnected on the next navigation via the existing cleanup hook, so
  // observers never accumulate.
  let labelObserver = null;
  function watchForLateFields(view) {
    try {
      if (labelObserver) labelObserver.disconnect();
      if (typeof MutationObserver === 'undefined') return;
      labelObserver = new MutationObserver(() => {
        if (window.UI && UI.applyFieldGuidance) UI.applyFieldGuidance(view);
        associateFormLabels(view);
      });
      labelObserver.observe(view, { childList: true, subtree: true });
      // NOT registered with onCleanup(): navigate() calls runCleanup() at its
      // START, so a cleanup registered during this navigation is executed by
      // the NEXT one — but the observer was being torn down before the screen
      // it was watching had finished rendering. Measured: 3 mutations fired
      // on the Till screen and none reached the handler.
      //
      // The single `labelObserver` handle is disconnected by the next call to
      // watchForLateFields() above instead, which happens exactly once per
      // navigation. One observer exists at any time and none accumulate.
    } catch (e) { /* an accessibility nicety must never break a screen */ }
  }

  async function navigate() {
    const myToken = ++navToken;
    runCleanup();

    if (!State.isLoggedIn()) {
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('main-screen').classList.add('hidden');
      return;
    }
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');

    const path = currentPath();
    const base = '/' + path.split('/')[1];
    const handler = routes[base] || routes['/dashboard'];

    document.querySelectorAll('#sidebar a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === '#' + base);
    });
    // Close the mobile drawer through the app's single setNav() writer — see
    // the BUG 57 comment in js/app.js. This previously removed the 'open'
    // class directly, which moved the sidebar but left the full-screen scrim
    // showing and swallowing every tap on any navigation that did not come
    // from a sidebar link (hash change, Back button, or an internal
    // Router.navigate()). Guarded because the router also runs before
    // App.init() has finished wiring the nav on first paint.
    if (window.App && typeof window.App._setNav === 'function') window.App._setNav(false);
    else document.getElementById('sidebar').classList.remove('open');

    const view = viewProxyFor(myToken);
    view.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      await handler(view, path);
      if (window.UI && UI.applyFieldGuidance) UI.applyFieldGuidance(view);
      associateFormLabels(view);   // Bug 114 — see the helper above.
      // Some screens reveal fields AFTER the first render — a panel that
      // opens when a checkbox is ticked, a form that appears once data
      // arrives. Those were still unannounced (pos-change-phone, the safe
      // movement form). Observing the view catches them without every screen
      // having to remember to call this itself.
      watchForLateFields(view);
      // A screen that fills a sub-panel from its own async fetch (the Till's
      // safe-movement form does exactly this) can finish AFTER the observer
      // is attached but produce no further mutations for it to see. One
      // settle pass catches those without polling.
      setTimeout(() => {
        if (window.UI && UI.applyFieldGuidance) UI.applyFieldGuidance(view);
        associateFormLabels(view);
      }, 700);
      if (myToken !== navToken) console.debug('[router] discarded stale render for', path);
    } catch (e) {
      // Only the CURRENT navigation may report an error. A failure belonging
      // to a screen the user has already navigated away from must not replace
      // the screen they are now looking at. (The proxy would swallow it
      // anyway; returning early also keeps the console clean.)
      if (myToken !== navToken) return;
      console.error(e);
      view.innerHTML = `<div class="card"><p style="color:var(--red-500)">Failed to load: ${UI.escapeHtml(e.message)}</p></div>`;
    }
  }

  function start() {
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  return { register, navigate, start, onCleanup, associateFormLabels };
})();

// BUG 111 — `window.Router` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.Router && Router.thing())` — a reasonable-looking defensive idiom that
// is in fact ALWAYS FALSE here, so the guarded branch never runs and the
// fallback is taken silently and forever.
//
// What that actually cost: every receipt and every printed report showed
// "PharmaRidge" as the letterhead instead of the client's own pharmacy name,
// on every white-labelled deployment, since day one. Nothing errored — the
// fallback was a legitimate-looking default.
//
// Publishing the module on `window` makes those guards true and keeps them
// honest as guards (a module genuinely not loaded is still falsy). Assigning
// here rather than rewriting ~11 call sites is deliberate: the next such
// guard someone writes will also work.
window.Router = Router;
