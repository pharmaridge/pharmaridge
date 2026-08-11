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
        : `<div class="login-logo-stage login-logo-stage-transparent"><img class="login-logo login-logo-product" src="/branding/pharmaridge-mark.png" alt="PharmaRidge" /></div>`}
      <h1>${branding.business_name ? UI.escapeHtml(name) : `${Branding.PRODUCT_NAME}`}</h1>
      <p class="subtitle">${branding.business_name ? 'Pharmacy &amp; patent medicine store management' : 'Multi-branch pharmacy &amp; patent medicine store management'}</p>
      <form id="login-form">
        <label>Username</label>
        <input type="text" id="login-username" autocomplete="username" required />
        <label for="login-pin">PIN / Password</label>
        ${UI.passwordField('login-pin', { label: 'PIN or password', autocomplete: 'current-password', required: true })}
        <button type="submit" class="btn btn-primary" id="login-submit" aria-busy="false">Sign in</button>
        <div id="login-error" class="login-error hidden"></div>
      </form>
      <div class="live-sample-label">Live Sample 1</div>
      ${poweredBy ? `<div class="powered-by-footer">${UI.escapeHtml(poweredBy)}</div>` : ''}
    </div>
  `;
  // Re-bound on every render: this view replaces its own innerHTML on each
  // logout, which destroys the previously-bound button. Theme.mount() is
  // idempotent per element (it marks what it has bound) so this cannot stack
  // duplicate listeners.
  Theme.mount('login-theme-toggle');
  UI.bindPasswordReveals(el);

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const pin = document.getElementById('login-pin').value;
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');
    const setSubmitting = (active) => {
      submitBtn.disabled = active;
      submitBtn.classList.toggle('is-loading', active);
      submitBtn.setAttribute('aria-busy', active ? 'true' : 'false');
      submitBtn.innerHTML = active
        ? `<svg class="login-submit-spinner" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="20 12"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur=".75s" repeatCount="indefinite" /></circle></svg><span>Signing in…</span>`
        : 'Sign in';
    };
    errorEl.classList.add('hidden');
    setSubmitting(true);
    try {
      const data = await Api.post('/auth/login', { username, pin }, { allowOfflineQueue: false });
      State.setSession({ token: data.token, user: data.user, branch: data.branch, viewBranchId: null });
      window.App.afterLogin();
    } catch (err) {
      setSubmitting(false);
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}
