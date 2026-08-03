const UI = (() => {
  function toast(message, type = 'info', timeout = 4000) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  function money(n) {
    const v = Number(n || 0);
    // Uses a plain "N" prefix rather than the Unicode Naira sign (₦) —
    // requested explicitly by the client. The Unicode glyph also has a
    // real practical downside in a Nigerian pharmacy POS context: it
    // frequently fails to render (shows as a tofu/blank box, or is
    // silently dropped) on many thermal receipt printers, older
    // Android WebViews, and system fonts that lack Naira-sign glyph
    // coverage — a plain ASCII "N" prints/renders reliably everywhere.
    return 'N' + v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function shortDate(iso) {
    if (!iso) return '—';
    return new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('en-NG', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function badge(text, kind = 'gray') {
    return `<span class="badge badge-${kind}">${text}</span>`;
  }

  function openModal(innerHtml) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal">${innerHtml}</div>`;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    // BUG 114: modals render outside the router, so they need the same
    // label association applied to them or every dialog field is announced
    // as a bare "edit text". Guarded: Router may not have loaded yet.
    try { if (window.Router && Router.associateFormLabels) Router.associateFormLabels(backdrop); } catch (e) {}
    return backdrop;
  }

  function closeModal(el) {
    if (el) el.remove();
  }

  // LEGACY-BROWSER COMPATIBILITY helper: every view in this app used to
  // write `document.getElementById(id)?.addEventListener(event, fn)` —
  // optional chaining is ES2020 syntax that throws a hard SyntaxError
  // while PARSING the script on any pre-2020 browser/WebView, failing
  // the entire app (blank screen) rather than just skipping a missing
  // element. This helper provides the exact same "only attach the
  // listener if the element actually exists" behavior (an element is
  // legitimately absent whenever a view conditionally renders it, e.g.
  // a manager-only button that doesn't exist in the DOM for a STAFF
  // user) using only universally-supported syntax. Every
  // `document.getElementById(...)?.addEventListener(...)` call site in
  // public/js/views/*.js was converted to use this during a production
  // legacy-device-compatibility audit pass.
  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    return el;
  }

  // Prevents a double-submit race (rapid double-click, or an
  // accidental double-tap on a touchscreen — realistic on a busy POS
  // counter) on a "one-shot mutating action" button — Save, Add,
  // Record Payment, Create, etc. Found to be a real, systemic gap
  // during this audit: only the POS checkout button and the
  // attendance clock-in/out buttons guarded against this (via a bare
  // `btn.disabled = true`) before this fix, while every other save/
  // add/record button across products, customers, suppliers, users,
  // stock adjustments, purchase orders, transfers, and admin settings
  // had NO such guard. Several of the affected backend endpoints
  // (customer/supplier payments, stock adjustments, user/product/
  // supplier creation, PO creation, transfer initiation) have no
  // Idempotency-Key protection either — that mechanism is deliberately
  // reserved for the offline-queueable sales/expenses endpoints (see
  // public/js/api.js's OFFLINE_QUEUEABLE list) — so a genuine double-
  // click on one of these could really double-record a payment,
  // double-create a user/product/PO, or double-adjust stock.
  //
  // Disables the element the INSTANT the click fires (synchronously,
  // before `handler` even starts running), so a second click arriving
  // before the async handler resolves is impossible to act on. Only
  // re-enables the element afterward if it is still attached to the
  // document (`isConnected`) — every success path in this app either
  // closes the modal (`UI.closeModal`) or re-renders the whole view
  // (`Router.navigate()`), both of which remove/replace the element
  // entirely; re-enabling a since-discarded element is harmless but
  // pointless, so this correctly leaves it disabled forever in that
  // case rather than doing unnecessary work on a detached node.
  function guardedClick(el, handler) {
    if (!el) return;
    el.addEventListener('click', async (e) => {
      if (el.disabled) return; // extra safety net against a same-tick double-fire
      el.disabled = true;
      try {
        await handler(e);
      } catch (err) {
        // Every real call site in this app already catches its own
        // errors inside `handler` (showing a toast via UI.toast), so
        // this branch is not expected to ever run in normal operation
        // — it exists purely as a defensive backstop so a future call
        // site that forgets its own try/catch fails safely (button
        // correctly re-enabled below) instead of leaving an unhandled
        // promise rejection floating around, which browsers merely log
        // to the console but which is cleaner to prevent outright.
        console.error('[UI.guardedClick] handler threw without catching its own error:', err);
      } finally {
        if (el.isConnected) el.disabled = false;
      }
    });
  }

  async function updateOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    const countEl = document.getElementById('queue-count');
    const n = (await Offline.count()) + (await Offline.customerEditCount());
    const failedN = await Offline.failedCount();
    const isOffline = !navigator.onLine;
    if (isOffline || n > 0 || failedN > 0) {
      banner.classList.remove('hidden');
      // A permanently-failed item needs a human to look at it (see
      // Offline.flush()'s rationale) -- visually distinct from an
      // ordinary "still syncing" pending count, which will clear itself
      // once connectivity returns.
      banner.classList.toggle('offline-banner-danger', failedN > 0);
      const parts = [];
      if (n > 0) parts.push(`${n} pending`);
      if (failedN > 0) parts.push(`${failedN} need attention -- see Sync Status`);
      countEl.textContent = parts.length ? `(${parts.join(', ')})` : '';
    } else {
      banner.classList.add('hidden');
    }
  }

  function escapeHtml(s) {
    // LEGACY-BROWSER COMPATIBILITY: `s ?? ''` (nullish coalescing, ES2020)
    // rewritten as `s == null ? '' : s` — see public/js/api.js's
    // handleSessionExpired comment for the full rationale. `== null`
    // (loose equality) is the standard, deliberate idiom here: it's
    // true for BOTH `null` and `undefined` while leaving every other
    // falsy value (0, '', false) untouched — the exact same semantics
    // `??` provides, just expressed in syntax every browser has always
    // understood.
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { toast, money, shortDate, badge, openModal, closeModal, on, guardedClick, updateOfflineBanner, escapeHtml };
})();

// BUG 111 — `window.UI` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.UI && UI.thing())` — a reasonable-looking defensive idiom that
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
window.UI = UI;
