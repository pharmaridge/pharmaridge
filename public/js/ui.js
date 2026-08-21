const UI = (() => {
  // Every red toast gets a short, explicit recovery reference. Individual views
  // still give precise validation text; generic API errors cannot leave the
  // operator without knowing the expected next step.
  function errorRecovery(message) {
    const text = String(message || '').toLowerCase();
    // An "open till session" is an operational blocker, not an expired login;
    // test it before the broader session/sign-in wording below.
    if (/open till|open stocktake|open attendance|pending.*transfer|unsynced/.test(text)) return 'Close or resolve the named operation, sync devices, then preview and try again.';
    if (/session|sign in|auth|token|account.*deactiv/.test(text)) return 'Sign in again with an active account, then repeat the action.';
    if (/offline|network|connection|sync/.test(text)) return 'Check the connection, then use Sync Status or retry when the device is online.';
    if (/permission|forbidden|not allowed|owner|manager|role/.test(text)) return 'Use an account with the required role, or ask the Owner or Manager to complete this action.';
    if (/stock|quantity|batch|expiry/.test(text)) return 'Review the available batch, quantity, expiry and branch, correct the entry, then try again.';
    if (/required|must|invalid|choose|enter|date|amount|pin|password/.test(text)) return 'Complete the highlighted field in the stated format, then submit again.';
    if (/not found|unknown|no matching|missing/.test(text)) return 'Refresh this screen, confirm the selected record still exists, then try again.';
    return 'Review the message, correct the required setup or entry, then try again. If it continues, refresh and contact your Manager.';
  }

  function toast(message, type = 'info', timeout = 4000) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const main = document.createElement('div');
    main.className = 'toast-message';
    main.textContent = message;
    el.appendChild(main);
    if (type === 'error') {
      const action = document.createElement('div');
      action.className = 'toast-recovery';
      action.textContent = `What to do: ${errorRecovery(message)}`;
      el.appendChild(action);
    }
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
    try {
      applyFieldGuidance(backdrop);
      if (window.Router && Router.associateFormLabels) Router.associateFormLabels(backdrop);
    } catch (e) {}
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

  // PIN/PASSWORD REVEAL — a counter worker should be able to check an entry
  // before saving it, especially on a small phone keyboard. Every front-end
  // PIN/password field uses this one component so login, Add User and Reset
  // PIN cannot drift into different reveal behaviour or accessibility labels.
  function passwordField(id, options) {
    const o = options || {};
    const label = escapeHtml(o.label || 'password');
    const placeholder = o.placeholder ? ` placeholder="${escapeHtml(o.placeholder)}"` : '';
    const autocomplete = o.autocomplete ? ` autocomplete="${escapeHtml(o.autocomplete)}"` : '';
    const required = o.required ? ' required' : '';
    return `<div class="password-field">
      <input type="password" id="${escapeHtml(id)}"${placeholder}${autocomplete}${required} />
      <button type="button" class="password-toggle" data-password-toggle="${escapeHtml(id)}" data-password-noun="${label}" aria-label="Show ${label}" title="Show ${label}" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.7"/></svg>
      </button>
    </div>`;
  }

  function bindPasswordReveals(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-password-toggle]').forEach((button) => {
      if (button.getAttribute('data-password-bound')) return;
      button.setAttribute('data-password-bound', '1');
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-password-toggle');
        const input = scope.querySelector ? scope.querySelector(`#${id}`) : document.getElementById(id);
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        const noun = button.getAttribute('data-password-noun') || 'password';
        const next = showing ? `Show ${noun}` : `Hide ${noun}`;
        button.setAttribute('aria-label', next);
        button.setAttribute('title', next);
        button.setAttribute('aria-pressed', showing ? 'false' : 'true');
        button.classList.toggle('is-revealed', !showing);
      });
    });
  }

  // INPUT GUIDANCE ----------------------------------------------------------
  // A label says WHAT a field is. A good placeholder says WHAT THE OPERATOR
  // SHOULD TYPE, its unit, and (for money) how the number is used. Views are
  // created dynamically, so applying this after every routed render gives
  // consistent guidance to ordinary forms, modal forms and repeatable PO/
  // receiving lines without relying on each author remembering it.
  const FIELD_GUIDANCE = [
    ['#u-name', 'e.g. Ngozi Okafor — the person\'s full name'],
    ['#u-username', 'e.g. ngozi.okafor — unique sign-in name'],
    ['#u-title', 'e.g. Sales Attendant or Pharmacist-in-Charge'],
    ['#eu-name', 'Correct the person\'s full name'],
    ['#eu-phone', 'e.g. 0803 123 4567'],
    ['#eu-title', 'Their current job at the pharmacy'],
    ['#cust-name, #ec-name', 'e.g. Mrs Adaeze Umeh or clinic name'],
    ['#cust-phone, #ec-phone', 'e.g. 0803 123 4567 — used to find the account'],
    ['#cust-idnum, #ec-idnum', 'Enter the ID number exactly as presented'],
    ['#pay-amount', 'e.g. 5,000 — amount the customer pays today'],
    ['#pay-notes', 'e.g. Transfer reference or payment note'],
    ['#sup-name, #es-name', 'e.g. Emzor Distributors'],
    ['#sup-phone, #es-phone', 'e.g. supplier sales line / contact number'],
    ['#sup-address, #es-address', 'e.g. depot, street and city'],
    ['#cpay-amount', 'e.g. 25,000 — gross supplier debt being settled'],
    ['#cpay-wht-tin', 'e.g. supplier tax ID for the WHT credit note'],
    ['#exp-amount', 'e.g. 12,500 — total amount paid for this expense'],
    ['#exp-from-cash', 'e.g. 8,000 — drawer share; safe pays the remainder'],
    ['#exp-desc', 'What was bought or paid for, and why'],
    ['#pos-discount', '0 unless a real discount is approved'],
    ['#pos-change-name', 'Customer name for the change claim'],
    ['#pos-change-phone', 'Phone number if no customer name is available'],
    ['#till-opening', 'e.g. 5,000 — physical float counted at opening'],
    ['#till-counted', 'Enter the physical cash counted in the drawer now'],
    ['#safe-amount', 'e.g. 50,000 — amount moving in or out of the safe'],
    ['#tr-qty', 'e.g. 24 — base units being sent to the other branch'],
    ['#adj-qty', 'Use a negative number for a write-off; positive only for a verified correction'],
    ['#adj-reason', 'What happened, how many units, and who verified it'],
    ['#b-name', 'e.g. Main Branch — area or town'],
    ['#b-address', 'Full premises address used for licence and geofence records'],
    ['#b-phone', 'Branch contact number'],
    ['#b-pcn', 'Enter the PCN or PPMV licence number exactly'],
    ['#b-super', 'Registered superintendent pharmacist\'s full name'],
    ['#rl-name', 'New branch name after relocation'],
    ['#rl-phone', 'New premises contact number'],
    ['#edit-lat', 'e.g. 6.6018 — premises latitude'],
    ['#edit-lng', 'e.g. 3.3515 — premises longitude'],
    ['#edit-radius', 'e.g. 100 — permitted distance in metres'],
    ['#po-notes', 'e.g. supplier quotation, order reference or delivery instruction'],
    ['[data-item-qty]', 'e.g. 120 — total base units to order, not cartons'],
    ['[data-item-cost]', 'e.g. 85.50 — expected cost of ONE base unit; line total = quantity × cost'],
    ['[data-b-batch]', 'e.g. PDX-24A — supplier batch/lot printed on the pack'],
    ['[data-b-count]', 'e.g. 12 — count in the selected received unit'],
    ['[data-b-ppc]', 'e.g. 10 — packs in ONE carton on this delivery'],
    ['[data-b-upp]', 'e.g. 10 — base units in ONE pack on this delivery'],
    ['[data-b-total]', 'Invoice total for this batch line; unit cost is calculated from it'],
    ['[data-b-sell]', 'e.g. 120 — selling price for ONE base piece/unit'],
    ['[data-b-pack]', 'Optional selling price for one complete pack'],
    ['[data-b-carton]', 'Optional selling price for one complete carton'],
    ['#p-nafdac, #ep-nafdac', 'e.g. 04-1234 — registration number on the pack'],
    ['#p-units-per-pack, #ep-units-per-pack', 'e.g. 10 — base units inside ONE pack'],
    ['#p-packs-per-carton, #ep-packs-per-carton', 'e.g. 10 — packs inside ONE carton'],
    ['#p-reorder, #ep-reorder', 'e.g. 50 — alert when stock falls below this many base units'],
    ['#po-price', 'e.g. 120 — default selling price for ONE base unit'],
    ['#po-pack-price', 'Optional price for one complete pack'],
    ['#po-carton-price', 'Optional price for one complete carton'],
    ['#force-close-reason', 'Why the count could not be completed and who confirmed it'],
  ];

  function genericGuidance(input, root) {
    const id = input.id ? `#${input.id}` : '';
    for (const [selector, text] of FIELD_GUIDANCE) {
      try { if ((input.matches && input.matches(selector)) || (id && selector.split(',').map((s) => s.trim()).includes(id))) return text; } catch (e) { /* ignore invalid/missing selector */ }
    }
    const row = input.closest ? input.closest('.form-row') : null;
    const label = row && row.querySelector ? row.querySelector('label') : null;
    const words = String(label && label.textContent || '').trim().toLowerCase();
    if (/full name|^name$/.test(words)) return 'Enter the full name used in pharmacy records';
    if (/phone/.test(words)) return 'Enter a reachable phone number';
    if (/address/.test(words)) return 'Enter the full address';
    if (/base unit/.test(words)) return 'e.g. tablet, capsule, bottle or sachet — the smallest sellable unit';
    if (/amount|cost|price|float|quantity|qty/.test(words)) return 'Enter the amount or quantity shown on the real document/count';
    if (/reason|notes|description/.test(words)) return 'Explain the real-world reason clearly';
    return '';
  }

  function applyFieldGuidance(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('input, textarea').forEach((input) => {
      const type = String(input.type || '').toLowerCase();
      if (['hidden', 'checkbox', 'radio', 'file', 'button', 'submit'].includes(type)) return;
      const guidance = genericGuidance(input, scope);
      if (!guidance) return;
      // Date controls cannot consistently render placeholder text across
      // browsers, but their title still exposes the input expectation.
      if (!input.placeholder && type !== 'date') input.placeholder = guidance;
      if (!input.title) input.title = guidance;
    });
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

  return { toast, errorRecovery, money, shortDate, badge, openModal, closeModal, on, passwordField, bindPasswordReveals, applyFieldGuidance, guardedClick, updateOfflineBanner, escapeHtml };
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
