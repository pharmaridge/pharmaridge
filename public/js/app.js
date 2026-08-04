const App = (() => {
  async function init() {
    // The first-paint SVG loader is visible only while startup branding is
    // genuinely loading. Branding.load() handles its own offline/error
    // fallback, so resolving it is the single honest moment to turn the loader
    // off and render a usable sign-in form.
    const startupLogin = document.getElementById('login-screen');
    if (startupLogin) {
      startupLogin.classList.add('is-loading');
      startupLogin.setAttribute('aria-busy', 'true');
    }
    // Load this deployment's branding (business name/logo, if the Admin
    // Portal has set any) before anything else renders, so the login
    // screen a first-time visitor sees is already correctly branded
    // rather than flashing the generic "PharmaRidge" name first.
    await Branding.load();

    // Service worker update handling: skipWaiting()/clients.claim() in
    // sw.js let a NEW service worker take control immediately, but an
    // already-open tab keeps executing its already-loaded (old) JS in
    // memory until the page itself reloads — so a shipped bugfix would
    // otherwise never actually reach a cashier's tab that's been open
    // since the start of their shift. `controllerchange` fires exactly
    // when the new SW takes over; reacting to it with a one-time reload
    // (guarded so it can only ever fire once per page load, since some
    // browsers can emit it more than once) closes that gap safely,
    // including for any sale currently mid-flight in memory — a reload
    // discards in-memory POS cart state, so we only do this when the POS
    // cart is empty; otherwise we wait until the cart is cleared.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then((registration) => {
          // Browsers already check for a new SW on normal navigation, but
          // a pharmacy POS tab is realistically left open for an entire
          // shift with no navigations at all — so also poll explicitly.
          setInterval(() => registration.update().catch(() => {}), 15 * 60 * 1000);
        })
        .catch((e) => console.warn('SW registration failed', e));

      let reloadedForUpdate = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadedForUpdate) return;
        const cartHasItems = typeof posCart !== 'undefined' && posCart.length > 0;
        if (cartHasItems) {
          UI.toast('A new version is available. It will apply automatically once your current cart is empty.', 'info', 8000);
          const waitForEmptyCart = setInterval(() => {
            if (typeof posCart === 'undefined' || posCart.length === 0) {
              clearInterval(waitForEmptyCart);
              reloadedForUpdate = true;
              location.reload();
            }
          }, 5000);
        } else {
          reloadedForUpdate = true;
          location.reload();
        }
      });
    }

    // PWA INSTALL / RE-INSTALL ACCESS.
    //
    // Browsers are allowed to suppress beforeinstallprompt after a person has
    // installed then removed an app, or after they dismissed the prompt. A
    // topbar button that only appears while that event is held therefore
    // disappears precisely when someone needs help reinstalling. The sidebar
    // entry is permanent: it opens an honest compatibility/help panel on every
    // device, and triggers the native install prompt whenever the browser has
    // made one available.
    let deferredInstallPrompt = null;
    const installBtn = document.getElementById('install-app-btn');
    const sidebarInstallBtn = document.getElementById('sidebar-install-btn');

    function isStandalonePwa() {
      return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true);
    }

    function canUsePwaInstall() {
      return !!(window.isSecureContext && 'serviceWorker' in navigator);
    }

    function browserInstallHelp() {
      const ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/i.test(ua)) {
        return 'Open this sample in Safari, tap Share, then choose Add to Home Screen.';
      }
      if (/Android/i.test(ua)) {
        return 'Open your browser menu (⋮) and choose Install app or Add to Home screen.';
      }
      return 'Open your browser menu and choose Install app, Apps, or Create shortcut.';
    }

    async function requestNativeInstall() {
      if (!deferredInstallPrompt) return false;
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      if (installBtn) installBtn.classList.add('hidden');
      prompt.prompt();
      try {
        const choice = await prompt.userChoice;
        if (choice.outcome === 'accepted') {
          UI.toast('App installed — launch it from your home screen or app list, even offline.', 'success', 6500);
          return true;
        }
      } catch (e) { /* user dismissed or browser quirk */ }
      return false;
    }

    function openInstallModal() {
      const installed = isStandalonePwa();
      const compatible = canUsePwaInstall();
      const promptReady = !!deferredInstallPrompt;
      let body;
      if (installed) {
        body = `
          <h3>App Already Installed</h3>
          <p class="page-subtitle">This device is already running PharmaRidge as an installed app. Open it again from your home screen or app list.</p>
          <div class="modal-actions"><button class="btn btn-primary" id="pwa-help-close">Close</button></div>`;
      } else if (!compatible) {
        body = `
          <h3>PWA Download Not Compatible</h3>
          <p class="page-subtitle">This device or browser is not compatible for downloading the PWA. Kindly keep using PharmaRidge in your browser.</p>
          <div class="modal-actions"><button class="btn btn-primary" id="pwa-help-close">Continue in browser</button></div>`;
      } else if (promptReady) {
        body = `
          <h3>Download PharmaRidge</h3>
          <p class="page-subtitle">Install the app for full-screen use, faster launch, and offline access.</p>
          <div class="modal-actions"><button class="btn btn-ghost" id="pwa-help-close">Not now</button><button class="btn btn-primary" id="pwa-install-now">Download / Install App</button></div>`;
      } else {
        body = `
          <h3>Reinstall PharmaRidge</h3>
          <p class="page-subtitle">This device supports the PWA, but the browser has not supplied its install prompt. This can happen after an app was installed then deleted, or after a prompt was dismissed.</p>
          <div class="note" style="margin:12px 0;">${UI.escapeHtml(browserInstallHelp())}</div>
          <div class="modal-actions"><button class="btn btn-primary" id="pwa-help-close">Continue in browser</button></div>`;
      }
      const modal = UI.openModal(body);
      const close = modal.querySelector('#pwa-help-close');
      if (close) close.addEventListener('click', function () { UI.closeModal(modal); });
      const installNow = modal.querySelector('#pwa-install-now');
      if (installNow) UI.guardedClick(installNow, async function () {
        const installedNow = await requestNativeInstall();
        if (installedNow) UI.closeModal(modal);
        else {
          UI.closeModal(modal);
          UI.toast('The browser did not complete installation. ' + browserInstallHelp(), 'info', 7000);
        }
      });
    }

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installBtn && !isStandalonePwa()) installBtn.classList.remove('hidden');
    });
    if (installBtn) UI.guardedClick(installBtn, requestNativeInstall);
    if (sidebarInstallBtn) sidebarInstallBtn.addEventListener('click', openInstallModal);

    window.addEventListener('appinstalled', function () {
      deferredInstallPrompt = null;
      if (installBtn) installBtn.classList.add('hidden');
      UI.toast('App installed — you can now launch it from your home screen or app list.', 'success', 6500);
    });
    if (isStandalonePwa() && installBtn) installBtn.classList.add('hidden');

    // The topbar toggle. theme.js has already APPLIED the theme (it ran in
    // <head>); this only binds the control and syncs its icon/label, which
    // could not happen earlier because <body> did not exist yet.
    Theme.mount('theme-toggle');

    Router.register('/dashboard', renderDashboard);
    Router.register('/pos', renderPos);
    Router.register('/sales', renderSales);
    Router.register('/till', renderTill);
    Router.register('/attendance', renderAttendance);
    Router.register('/stock', renderStock);
    Router.register('/stocktake', renderStocktake);
    Router.register('/products', renderProducts);
    Router.register('/purchase-orders', renderPurchaseOrders);
    Router.register('/transfers', renderTransfers);
    Router.register('/customers', renderCustomers);
    Router.register('/suppliers', renderSuppliers);
    Router.register('/expenses', renderExpenses);
    Router.register('/controlled-register', renderControlledRegister);
    Router.register('/sync', renderSync);
    Router.register('/users', renderUsers);
    Router.register('/plan', renderPlan);
    Router.register('/accounting', renderAccounting);
    Router.register('/admin', renderAdmin);

    renderLogin();
    const readyLogin = document.getElementById('login-screen');
    if (readyLogin) {
      readyLogin.classList.remove('is-loading');
      readyLogin.setAttribute('aria-busy', 'false');
    }

    document.getElementById('logout-btn').addEventListener('click', async function () {
      // Best-effort server revocation. A local logout must still complete when
      // offline, but when connected it removes this exact session immediately
      // rather than leaving a usable token behind until expiry.
      const session = State.getSession();
      if (session && session.token && navigator.onLine) {
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
            body: '{}',
          });
        } catch (e) { /* local logout still wins if the network drops */ }
      }
      State.clearSession();
      location.hash = '#/dashboard';
      afterLogout();
    });

    // MOBILE NAVIGATION.
    //
    // The drawer previously toggled open and had no way to close except
    // pressing the same hamburger again — on a phone it covered the screen
    // and tapping the content behind it did nothing, which reads as a
    // frozen app. It also stayed open after choosing a destination, so
    // every navigation left the menu sitting over the page you had just
    // asked for.
    //
    // Written without optional chaining / arrow-default syntax concerns —
    // see the note in js/ui.js: this file must parse on older Android
    // WebViews, where an ES2020 SyntaxError blanks the ENTIRE app.
    var sidebarEl = document.getElementById('sidebar');
    var scrimEl = document.getElementById('nav-scrim');
    function setNav(open) {
      if (!sidebarEl) return;
      sidebarEl.classList.toggle('open', open);
      if (scrimEl) scrimEl.classList.toggle('show', open);
      var toggle = document.getElementById('nav-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    // BUG 57 — THE APP COULD FREEZE BEHIND AN INVISIBLE OVERLAY.
    //
    // Drawer state lived in two places: this function (which moves the
    // sidebar, the scrim AND aria-expanded together) and a lone
    // `sidebar.classList.remove('open')` inside Router.navigate(). The router
    // copy closed the SIDEBAR only. Any navigation that did not originate
    // from a sidebar tap — a hash change, the browser Back button, or a view
    // calling Router.navigate() itself (the 30s background refresh does this
    // whenever a role or branch changes) — therefore slid the drawer away and
    // left the scrim at opacity:1, pointer-events:auto covering the entire
    // viewport.
    //
    // Reproduced in a real headless browser at 390px:
    //   open the menu -> location.hash = '#/customers'
    //   -> sidebarOpen:false, scrimShow:true, scrimOpacity:"1",
    //      pointerEvents:"auto", elementFromPoint(200,500) === "nav-scrim"
    // Every tap on the page was being swallowed by a transparent sheet. To
    // the cashier the app is simply frozen, and the only escape is a reload —
    // which, mid-sale, is exactly when it hurts most.
    //
    // Fixed by making setNav the ONLY writer of drawer state and exposing it,
    // so the router closes the drawer through the same door as everything
    // else instead of reaching in and moving one of its three parts.
    App._setNav = setNav;
    document.getElementById('nav-toggle').addEventListener('click', function () {
      setNav(!sidebarEl.classList.contains('open'));
    });
    if (scrimEl) scrimEl.addEventListener('click', function () { setNav(false); });
    // Choosing a destination must dismiss the menu, or the answer stays
    // hidden behind the question.
    sidebarEl.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('a[data-nav]')) setNav(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setNav(false);
    });

    window.addEventListener('online', async () => {
      UI.toast('Back online — syncing pending changes…', 'success');
      await Api.flushQueue();
      const currentSession = State.getSession();
      const branchIdForSync = currentSession && currentSession.user && currentSession.user.branch_id;
      if (branchIdForSync) await Api.pushCustomerQueue(branchIdForSync);
      UI.updateOfflineBanner();
      Router.navigate();
    });
    window.addEventListener('offline', () => UI.updateOfflineBanner());

    UI.updateOfflineBanner();

    if (State.isLoggedIn()) {
      afterLogin(true);
    }

    Router.start();

    // Periodically try flushing the offline queue & sending a heartbeat
    // so the manager's Sync Status dashboard stays fresh — and, as of
    // this audit pass, also refreshing this device's OWN logged-in
    // user record so a role/branch/name change made by a manager from
    // another device takes effect on this tab within 30s instead of
    // being stuck until the JWT naturally expires (see
    // refreshCurrentUser()'s comment above for the full rationale).
    setInterval(async () => {
      if (!State.isLoggedIn()) return;
      if (navigator.onLine) {
        try {
          const branchId = State.getSession().user.branch_id;
          if (branchId) {
            const pendingCount = (await Offline.count()) + (await Offline.customerEditCount());
            await Api.post('/sync/heartbeat', { device_id: DeviceId.get(), app_version: '1.0.0', pending_push_count: pendingCount }, { allowOfflineQueue: false });
            await Api.pushCustomerQueue(branchId);
          }
          await Api.flushQueue();
          await refreshCurrentUser();
        } catch (e) { /* ignore transient errors */ }
      }
      UI.updateOfflineBanner();
    }, 30000);
  }

  async function afterLogin(silent = false) {
    Api.resetSessionExpiredGuard();

    // FUNCTIONAL GAP CLOSED (found during this audit's route-inventory
    // sweep): GET /api/users/me has existed identically, fully working,
    // on both backends since day one, but nothing in the frontend ever
    // called it — the topbar name/role label and every role-gated nav
    // item's visibility were computed ONLY from the JWT-login-time
    // snapshot cached in localStorage (State.getSession().user), which
    // is never refreshed for the lifetime of that browser tab/session.
    // Concretely: if a manager promotes a STAFF cashier to MANAGER (or
    // renames them, or reassigns their branch) while that cashier is
    // ALREADY logged in on their own device, their tab kept showing the
    // old role/name and hiding manager-only nav items (Users, Products,
    // Accounting) for the rest of their up-to-12h JWT lifetime — the
    // very same class of "stale until logout" bug this codebase already
    // fixed once for account DEACTIVATION (server-side, enforced on
    // every request) but never closed for the read-only DISPLAY layer.
    // Fetched here (both on real login AND on every silent page-reload
    // re-hydration) and again periodically in the background — see the
    // setInterval below — with a network failure never blocking the
    // rest of afterLogin from proceeding with whatever's already cached.
    try {
      const fresh = await Api.get('/users/me');
      State.updateSessionUser(fresh);
    } catch (e) { /* offline or transient — fall back to the cached snapshot; a genuine "account deactivated" 401 is already handled centrally by api.js's handleSessionExpired */ }

    renderChrome();
    await refreshBranchSwitcher();

    if (!silent) {
      location.hash = '#/dashboard';
    }
    Router.navigate();

    // BUG 108 — a staged transfer is useless if the person never sees it.
    // Asked here, at sign-in, because that is the one moment they are
    // certainly looking at the screen and certainly online. Never blocks the
    // app: a failure here leaves them working exactly as before, which is the
    // whole point of staging the move rather than applying it.
    promptPendingTransfer().catch(() => {});
  }

  // Shows the "you are being moved" prompt, if there is one waiting.
  async function promptPendingTransfer() {
    let pending = [];
    try {
      pending = await Api.get('/users/transfers/pending/mine');
    } catch (e) { return; }
    if (!Array.isArray(pending) || !pending.length) return;
    const t = pending[0];
    const where = t.to_branch_name || 'a different branch';
    const from = t.from_branch_name || 'your current branch';

    // BUG 109 — A PROMOTION IS NOT A MOVE, AND SAYING SO IS NONSENSE.
    //
    // Bug 108 staged every transfer, and because a promotion and a branch move
    // travel the SAME endpoint, role changes were correctly staged too. But
    // this prompt was written for a move, so a cashier promoted to Branch
    // Manager at the shop they already work in was told "You are being moved
    // to Rivertown Pharmacy" — from Rivertown to Rivertown. It reads like a
    // bug even though the underlying change is right, and a person who does
    // not understand a request cannot meaningfully consent to it.
    //
    // Three genuinely different events share this dialog, so it now names
    // whichever one is actually happening:
    //   role changed, branch same      -> a promotion or a step back
    //   branch changed, role same      -> a move
    //   both changed                   -> a move AND a change of role
    const RANK = { STAFF: 1, MANAGER: 2, OWNER: 3 };
    const label = (r, branchId) => (r === 'OWNER' ? 'Owner'
      : r === 'MANAGER' ? (branchId ? 'Branch Manager' : 'General Manager') : 'Staff');
    const fromLabel = label(t.from_role, t.from_branch_id);
    const toLabel = label(t.to_role, t.to_branch_id);
    const roleChanged = t.from_role !== t.to_role
      || (t.from_role === 'MANAGER' && !t.from_branch_id !== !t.to_branch_id);
    const branchChanged = (t.from_branch_id || null) !== (t.to_branch_id || null);
    const isPromotion = roleChanged && (RANK[t.to_role] || 0) > (RANK[t.from_role] || 0);
    const isStepBack = roleChanged && (RANK[t.to_role] || 0) < (RANK[t.from_role] || 0);

    const heading = !branchChanged && isPromotion
      ? `You are being promoted to ${toLabel}`
      : !branchChanged && isStepBack
        ? `Your role is changing to ${toLabel}`
        : !branchChanged && roleChanged
          ? `Your role is changing to ${toLabel}`
          : branchChanged && roleChanged
            ? `You are being moved to ${where} as ${toLabel}`
            : `You are being moved to ${where}`;

    const detail = !branchChanged
      ? `<b>${UI.escapeHtml(t.requested_by_name || 'A manager')}</b> has asked to change your role
         from <b>${UI.escapeHtml(fromLabel)}</b> to <b>${UI.escapeHtml(toLabel)}</b>
         at <b>${UI.escapeHtml(where)}</b>. You stay at the same branch.`
      : `<b>${UI.escapeHtml(t.requested_by_name || 'A manager')}</b> has asked to move you
         from <b>${UI.escapeHtml(from)}</b> to <b>${UI.escapeHtml(where)}</b>${roleChanged
           ? `, and to change your role from <b>${UI.escapeHtml(fromLabel)}</b> to <b>${UI.escapeHtml(toLabel)}</b>`
           : ` as <b>${UI.escapeHtml(toLabel)}</b>`}.`;

    const settleNote = branchChanged
      ? `Nothing has changed yet. Finish anything you still have open here first —
         close your till, complete your sales — then confirm. If you are offline
         when you confirm, your work at ${UI.escapeHtml(from)} still counts.`
      : `Nothing has changed yet. You keep working exactly as you are until you
         confirm, so anything you record now — including offline — still counts.
         Your new permissions start the moment you accept.`;

    const modal = UI.openModal(`
      <h3 style="margin:0 0 8px;">${UI.escapeHtml(heading)}</h3>
      <p style="margin:0 0 10px;font-size:13px;color:var(--gray-700);">${detail}</p>
      <p style="margin:0 0 10px;font-size:13px;"><b>Reason given:</b> ${UI.escapeHtml(t.reason || '')}</p>
      <div style="background:var(--green-50,#f0f7f3);border-left:3px solid var(--green-600);padding:8px 11px;font-size:12.5px;margin-bottom:12px;">
        ${settleNote}
      </div>
      <div id="ptx-err" style="display:none;color:var(--red-500);font-size:12.5px;margin-bottom:8px;"></div>
      <label style="font-size:12.5px;color:var(--gray-700);">If you cannot move yet, say why:</label>
      <input id="ptx-reason" type="text" placeholder="e.g. my till is still open tonight" style="margin-bottom:10px;" />
      <div class="modal-actions">
        <button class="btn btn-secondary" id="ptx-decline">${branchChanged ? 'I cannot move yet' : 'Not yet'}</button>
        <button class="btn btn-primary" id="ptx-confirm">${branchChanged ? 'Yes, move me' : 'Yes, I accept'}</button>
      </div>
    `);

    const err = (m) => {
      const el = document.getElementById('ptx-err');
      if (el) { el.textContent = m; el.style.display = 'block'; }
    };
    UI.on('ptx-confirm', 'click', async () => {
      try {
        await Api.post(`/users/transfers/pending/${t.id}/confirm`, {});
        UI.closeModal(modal);
        UI.toast(branchChanged ? `You are now at ${where}.` : `You are now ${toLabel}.`, 'success');
        const fresh = await Api.get('/users/me');
        State.updateSessionUser(fresh);
        renderChrome();
        await refreshBranchSwitcher();
        Router.navigate();
      } catch (e) { err(e.message || 'Could not confirm the transfer.'); }
    });
    UI.on('ptx-decline', 'click', async () => {
      const reason = (document.getElementById('ptx-reason') || {}).value || '';
      try {
        await Api.post(`/users/transfers/pending/${t.id}/decline`, { reason });
        UI.closeModal(modal);
        UI.toast('Your manager has been told.', 'info');
      } catch (e) { err(e.message || 'Could not decline the transfer.'); }
    });
  }

  // Applies the CURRENT (possibly just-refreshed) session's user info
  // to the topbar label and every role-gated nav item's visibility.
  // Split out from afterLogin so refreshCurrentUser() (periodic
  // background refresh) can re-apply it without repeating the rest of
  // afterLogin's one-time login/reload setup work.
  function renderChrome() {
    const session = State.getSession();
    // Show the human title ("General Manager" / "Branch Manager"), not the
    // raw enum. Prefer the server-derived role_label; fall back locally.
    const roleText = session.user.role_label || State.roleLabelOf(session.user);
    document.getElementById('user-label').textContent = `${session.user.full_name} (${roleText})`;
    document.getElementById('nav-users').style.display = State.isManager() ? '' : 'none';
    document.getElementById('nav-products').style.display = State.isManager() ? '' : 'none';
    document.getElementById('nav-accounting').style.display = State.isManager() ? '' : 'none';
    // MANAGER-AND-ABOVE (client decision after a live audit demonstration
    // that a STAFF token could read a ₦50,000 supplier debt, the ₦10,000
    // FIRS position and a ₦100,000 rent payment). The backend now refuses
    // these reads outright; hiding the nav keeps the UI honest instead of
    // offering a cashier a screen that would 403.
    document.getElementById('nav-suppliers').style.display = State.isManager() ? '' : 'none';
    // BUG 99: STAFF may RECORD an expense (the cashier is who actually buys the
    // diesel), they simply cannot browse the pharmacy's whole cost base. The
    // link was hidden from them entirely, so a capability the backend grants
    // had no route in the UI. The screen itself shows them a record-only form.
    document.getElementById('nav-expenses').style.display = '';
    // BUG 69 (nav half). The Plan screen is the ONLY home for three settings
    // the backend's `ownerOnly` guard deliberately grants to ADMIN as well
    // (manager/cashier permissions and the two WHT-rate routes). Gating the
    // nav on isOwner() alone left support able to USE those endpoints but
    // unable to reach the only screen that exposes them — verified in a real
    // browser: ADMIN saw "This page is only available to the account owner".
    // The screen itself re-titles to "Client Plan & Policy (Support View)" and
    // carries an explicit "acting on a client's account" notice, so a support
    // engineer is never in doubt whose settings they are editing.
    // A MANAGER now has one control on this screen (the cashiers' safe
    // allowance), so the link must exist for them too — otherwise the power the
    // backend grants has no door, which is the gap Bug 99 was.
    document.getElementById('nav-plan').style.display =
      (State.isOwner() || State.isAdmin() || State.isManager()) ? '' : 'none';
    document.getElementById('nav-admin').style.display = State.isAdmin() ? '' : 'none';
  }

  // Periodic background refresh of the logged-in user's OWN live
  // role/name/branch/job_title — see afterLogin's comment above for the
  // full rationale. Called from the same 30s interval that already
  // exists for offline-queue flushing/heartbeat, so this adds no new
  // network-polling machinery. If the role or branch actually changed
  // (e.g. a manager just promoted/reassigned this user from another
  // device), the nav chrome, branch switcher, AND the current view are
  // all re-rendered so a changed permission set (or, for a
  // newly-reassigned STAFF, a changed data scope) takes effect
  // immediately rather than only on the user's next manual navigation.
  async function refreshCurrentUser() {
    if (!State.isLoggedIn()) return;
    const before = State.getSession().user;
    try {
      const fresh = await Api.get('/users/me');
      const roleChanged = before.role !== fresh.role;
      const branchChanged = before.branch_id !== fresh.branch_id;
      State.updateSessionUser(fresh);
      renderChrome();
      if (roleChanged || branchChanged) {
        await refreshBranchSwitcher();
        Router.navigate();
      }
    } catch (e) { /* transient network error — a genuine deactivation 401 is already handled centrally by api.js */ }
  }


  // Called by Api.js when the server rejects a request with 401 for a
  // reason unrelated to a bad login attempt (expired JWT, or the user
  // was deactivated mid-session). State.clearSession() has already run
  // by this point; this just resets the visible chrome back to a clean
  // logged-out shell and drops the user on the login screen.
  function afterLogout() {
    // Router.navigate() only reveals the existing login DOM. If the most
    // recent sign-in replaced its button label with the animated "Signing
    // in…" SVG, revealing that stale DOM after logout made it look as though
    // authentication was still in progress forever. Re-rendering is the
    // authoritative reset: it creates the ordinary enabled Sign in button and
    // removes the spinner on every deliberate logout, expiry or 401.
    renderLogin();
    const loginScreen = document.getElementById('login-screen');
    if (loginScreen) {
      loginScreen.classList.remove('is-loading');
      loginScreen.setAttribute('aria-busy', 'false');
    }
    // A DELIBERATE sign-out discards any in-progress POS cart. This is
    // the opposite intent from a crash/expiry (where the cart is
    // deliberately preserved — see the persistence note in
    // views/pos.js): handing a shared till to the next cashier must not
    // hand over the previous cashier's half-built basket, which they
    // could then complete under their own name.
    //
    // Every user's cart key is cleared, not just the current one, since
    // State.clearSession() has already run by the time we get here and
    // the departing user's id is no longer available.
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('gl_pms_pos_cart:') === 0) stale.push(k);
      }
      for (const k of stale) localStorage.removeItem(k);
    } catch (e) { /* private mode / quota — never block a sign-out */ }
    Router.navigate();
  }

  // BUG 94 — the "All Branches" wording is chosen per breakpoint (see below),
  // and a <select>'s text is baked in at render time. Without this listener a
  // phone rotated from portrait to landscape, or a resized desktop window,
  // would keep whichever label was correct when the switcher was last drawn:
  // a landscape tablet stuck reading "All", or worse a 320px portrait phone
  // stuck reading the full "All Branches (Total)" that does not fit and was
  // the original defect. Re-rendered only when a breakpoint is actually
  // CROSSED, so an ordinary resize drag does not re-fetch the branch list.
  (function watchSwitcherBreakpoints() {
    if (!window.matchMedia) return;
    ['(max-width: 560px)', '(max-width: 900px)'].forEach((q) => {
      const mq = window.matchMedia(q);
      const onChange = () => { refreshBranchSwitcher().catch(() => {}); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange); // older WebKit
    });
  })();

  async function refreshBranchSwitcher() {
    const session = State.getSession();
    const switcherEl = document.getElementById('branch-switcher');
    const scopeLabel = document.getElementById('branch-scope-label');

    // BRANCH-SCOPED MANAGERS (migration 0003): only an ORG-WIDE manager gets
    // the all-branches switcher. A manager pinned to one branch is treated
    // exactly like STAFF here — they see their branch name, not a control
    // that lets them pick a branch the server would refuse to serve.
    if (State.isManager() && !State.isBranchPinned()) {

      try {
        const branches = await Api.get('/branches');
        // Branch names are free-text set by MANAGER/OWNER/ADMIN via the
        // Users & Branches screen — escaped here for correctness and
        // defense-in-depth consistency with every other place a branch
        // name is rendered in this codebase (e.g. `<option>` elements
        // have a restricted parsing model that stops an injected `<img>`
        // from becoming a live element, so this specific sink was not an
        // exploitable XSS vector even before this fix, but a name
        // containing `<`/`&` would still visually corrupt the dropdown,
        // and leaving one unescaped `${...name}` in the codebase is a
        // trap for a future refactor that copies this pattern into a
        // genuinely exploitable sink).
        //
        // Deactivated branches are DELIBERATELY still listed here (not
        // filtered out) — a manager must still be able to drill into a
        // closed branch's historical sales/reports via this switcher
        // (see the "historical data stays fully visible forever" scoping
        // decision), just clearly marked so it's obvious why any NEW
        // action attempted there will be rejected with BRANCH_INACTIVE.
        // BUG 94 — THE "ALL BRANCHES" LABEL DID NOT FIT THE PHONE CONTROL.
        //
        // Capping the switcher's width so it stops covering the brand mark is
        // only half the fix: the closed <select> still has to SAY something
        // legible. Measured with the control's own computed font at 320px,
        // "All Branches (Total)" needs 126px of text width against 50px of
        // usable space, so the browser truncated it to "All Brar" — a control
        // that no longer reads as a word at all.
        //
        // The label is therefore chosen to fit the space that exists rather
        // than the width being grown to fit the label, because at 320px the
        // room simply is not there: the widest the control can be while its
        // left edge still clears the 20px mark is 102px, and "All Branches"
        // alone needs 121px including padding and the caret.
        //
        // "(Total)" is the first thing dropped — it restates what an
        // all-branches view already means — and below 560px the phrase
        // shortens again to "All". The full wording is unchanged on tablet
        // and desktop, where it fits comfortably.
        // Widths verified by rendering, not by arithmetic: at the <=900px cap
        // of 112px the control shows ~72px of text, and "All Branches" needs
        // 81px — it rendered as "All Branche" with the final letter sliced.
        // (`scrollWidth === clientWidth` did NOT report that clipping, so the
        // <select> was measured against its own font instead; see trap #72.)
        // "All Shops" at 60px is the longest phrase that fits the tablet cap
        // whole, and it is the word a Nigerian pharmacy owner uses for a
        // branch anyway. Below 560px only "All" fits the 90px cap.
        const allLabel = window.matchMedia('(max-width: 560px)').matches ? 'All'
          : window.matchMedia('(max-width: 900px)').matches ? 'All Shops'
          : 'All Branches (Total)';
        switcherEl.innerHTML = `<option value="">${allLabel}</option>` + branches.map(b => `<option value="${b.id}">${b.is_active ? '' : '\u2715 '}${UI.escapeHtml(b.name)}${b.is_active ? '' : ' (Deactivated)'}</option>`).join('');
        switcherEl.value = State.getViewBranch() || '';
        switcherEl.classList.remove('hidden');
        scopeLabel.classList.add('hidden');
        switcherEl.onchange = () => {
          State.setViewBranch(switcherEl.value || null);
          Router.navigate();
        };
      } catch (e) { /* not logged in yet or network issue */ }
    } else {
      switcherEl.classList.add('hidden');
      // A branch-pinned MANAGER has no `session.branch` (that is only
      // populated at login for STAFF), so resolve their branch name from
      // the branch list — otherwise the topbar would just read "Branch"
      // and the manager could not tell which branch they are looking at.
      let label = (session.branch && session.branch.name) || null;
      const pinned = State.pinnedBranchId();
      if (!label && pinned) {
        try {
          const branches = await Api.get('/branches');
          const mine = (branches || []).find((b) => b.id === pinned);
          if (mine) label = mine.name;
        } catch (e) { /* offline or not yet authorised — fall through */ }
      }
      scopeLabel.textContent = label || 'Branch';
      scopeLabel.classList.remove('hidden');
    }
  }

  return { init, afterLogin, afterLogout, refreshBranchSwitcher, refreshCurrentUser };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
