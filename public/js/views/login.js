function renderLogin() {
  const el = document.getElementById('login-screen');
  const branding = Branding.get();
  const name = Branding.displayName();
  const poweredBy = Branding.poweredByLine();
  el.innerHTML = `
    <div class="login-card">
      <!-- Theme control BEFORE sign-in, not only after. A cashier opening the
           app at 6am in a dim shop, or on a phone already in night mode,
           should not have to authenticate through a bright white card first.
           Icon/label are filled in by Theme.mount() below. -->
      <button id="login-theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" title="Switch to dark mode" aria-pressed="false"></button>
      ${branding.has_logo && branding.logo_url
        ? `<img class="login-logo" src="${branding.logo_url}" alt="${UI.escapeHtml(name)}" />`
        : `<img class="login-logo login-logo-product" src="/branding/pharmaridge-logo.png" alt="PharmaRidge" />`}
      <h1>${branding.business_name ? UI.escapeHtml(name) : `${Branding.PRODUCT_NAME}`}</h1>
      <p class="subtitle">${branding.business_name ? 'Pharmacy &amp; patent medicine store management' : 'Multi-branch pharmacy &amp; patent medicine store management'}</p>
      <form id="login-form">
        <label>Username</label>
        <input type="text" id="login-username" autocomplete="username" required />
        <label>PIN / Password</label>
        <input type="password" id="login-pin" autocomplete="current-password" required />
        <button type="submit" class="btn btn-primary">Sign in</button>
        <div id="login-error" class="login-error hidden"></div>
      </form>
      <div class="demo-hint">
        Demo accounts (PIN <b>1234</b> for all):<br/>
        <b>manager</b> — General Manager, every branch<br/>
        <b>lagos.mgr</b> — Branch Manager, Lagos only<br/>
        <b>owner</b> — Owner, every branch + plan settings<br/>
        <b>lagos.staff</b> — Staff, Lagos branch only<br/>
        <b>minna.staff</b> — Staff, Minna branch only
      </div>
      ${poweredBy ? `<div class="powered-by-footer">${UI.escapeHtml(poweredBy)}</div>` : ''}
    </div>
  `;
  // Re-bound on every render: this view replaces its own innerHTML on each
  // logout, which destroys the previously-bound button. Theme.mount() is
  // idempotent per element (it marks what it has bound) so this cannot stack
  // duplicate listeners.
  Theme.mount('login-theme-toggle');

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const pin = document.getElementById('login-pin').value;
    const errorEl = document.getElementById('login-error');
    errorEl.classList.add('hidden');
    try {
      const data = await Api.post('/auth/login', { username, pin }, { allowOfflineQueue: false });
      State.setSession({ token: data.token, user: data.user, branch: data.branch, viewBranchId: null });
      window.App.afterLogin();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}
