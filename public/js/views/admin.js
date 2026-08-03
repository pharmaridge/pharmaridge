async function renderAdmin(view) {
  if (!State.isAdmin()) {
    view.innerHTML = `<div class="card"><p>This page is only available to the platform administrator (Admin Portal) account.</p></div>`;
    return;
  }

  let settings;
  let vatSettings;
  try {
    settings = await Api.get('/admin/settings');
    vatSettings = await Api.get('/settings/vat');
  } catch (e) {
    view.innerHTML = `<div class="card"><p style="color:var(--red-500)">Failed to load: ${UI.escapeHtml(e.message)}</p></div>`;
    return;
  }

  // Holds a freshly-picked-but-not-yet-saved logo as a data: URL so the
  // preview and the eventual save both use the exact same validated
  // string — never re-reads the file input at save time.
  let pendingLogoDataUrl = null;

  const MAX_LOGO_BYTES = 500 * 1024;
  const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });
  }

  function render() {
    const currentLogoUrl = pendingLogoDataUrl || (settings.logo_data_url ? `/api/branding/logo?v=${encodeURIComponent(settings.updated_at || '')}` : null);

    view.innerHTML = `
      <h2 class="page-title">Admin Portal</h2>
      <p class="page-subtitle">Manage this client's plan limits, feature toggles, subscription status, and branding. Changes here take effect immediately and are enforced by the server, not just hidden in the UI.</p>

      <div class="grid grid-3">
        <div class="stat-card">
          <div class="label">Branches</div>
          <div class="value">${settings.usage.branches_used} / ${settings.usage.effective_max_branches}</div>
        </div>
        <div class="stat-card">
          <div class="label">Staff Accounts</div>
          <div class="value">${settings.usage.staff_used} / ${settings.max_staff}</div>
        </div>
        <div class="stat-card">
          <div class="label">Subscription</div>
          <div class="value">${UI.badge(settings.subscription_status, { ACTIVE: 'green', TRIAL: 'amber', SUSPENDED: 'red', EXPIRED: 'red' }[settings.subscription_status] || 'gray')}</div>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Client Branding</h3>
        <p class="page-subtitle">Set this client's own trading name and logo. Once set, it replaces "PharmaRidge" in the browser tab title, topbar, login screen, and PWA install icon for everyone using this deployment — including on the login screen, before anyone signs in — and a small "Powered by PharmaRidge" attribution appears on the login screen.</p>
        <div class="form-inline">
          <div class="form-row"><label>Business Name</label><input id="a-business-name" placeholder="e.g. Ada Medicals Ltd" value="${UI.escapeHtml(settings.business_name || '')}" maxlength="80" /></div>
        </div>
        <div style="margin-top:12px;">
          <label style="display:block;font-size:12px;font-weight:600;color:var(--gray-600);margin-bottom:6px;">Logo (PNG, JPEG, WEBP, or GIF — max 500 KB)</label>
          <!-- The logo PREVIEW tile keeps a literal white backing in both
               themes on purpose: a client logo is almost always a dark mark on
               a transparent PNG, and previewing it on a dark tile would render
               it invisible and make the owner think the upload failed. This is
               the one place in the app where a fixed light surface is correct. -->
          <div style="display:flex;align-items:center;gap:14px;">
            ${currentLogoUrl ? `<img src="${currentLogoUrl}" alt="Logo preview" style="height:56px;width:56px;object-fit:contain;border:1px solid var(--gray-200);border-radius:8px;background:#fff;" />` : `<div style="height:56px;width:56px;border:1px dashed var(--gray-200);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-size:11px;">No logo</div>`}
            <div>
              <input type="file" id="a-logo-file" accept="image/png,image/jpeg,image/webp,image/gif" />
              ${settings.logo_data_url || pendingLogoDataUrl ? `<button class="btn btn-ghost btn-sm" id="a-logo-remove" style="margin-left:8px;">Remove logo</button>` : ''}
              <div id="a-logo-msg" style="font-size:11px;color:var(--gray-600);margin-top:6px;"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Plan Limits</h3>
        <div class="form-inline">
          <div class="form-row">
            <label>Max Branches</label>
            <input type="number" min="1" id="a-max-branches" value="${settings.max_branches}" />
          </div>
          <div class="form-row">
            <label>Max Staff Accounts</label>
            <input type="number" min="1" id="a-max-staff" value="${settings.max_staff}" />
          </div>
          <div class="form-row">
            <label>Subscription Plan Name</label>
            <input id="a-plan-name" value="${UI.escapeHtml(settings.subscription_plan)}" />
          </div>
          <div class="form-row">
            <label>Subscription Status</label>
            <select id="a-status">
              ${['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map(s => `<option value="${s}" ${s === settings.subscription_status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>Renewal Date</label>
            <input type="date" id="a-renewal" value="${settings.subscription_renewal_date || ''}" />
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Modules Enabled for This Client</h3>
        <div class="form-inline">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="a-multi-branch" ${settings.multi_branch_enabled ? 'checked' : ''}/> Multi-Branch Support</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="a-attendance" ${settings.attendance_module_enabled ? 'checked' : ''}/> Staff Attendance &amp; Geofencing</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="a-controlled" ${settings.controlled_register_enabled ? 'checked' : ''}/> Controlled Drug Register</label>
        </div>
        <p style="font-size:12px;color:var(--gray-600);margin-top:10px;">Turning off Multi-Branch Support caps this client at 1 active branch regardless of the numeric Max Branches value above. Turning off Controlled Drug Register blocks dispensing any controlled substance (Tramadol/Codeine-type products) at checkout entirely, not just hiding the audit-trail screen.</p>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>VAT (Value Added Tax) — Client-Controlled Setting</h3>
        <p class="page-subtitle">Unlike the modules above, VAT is the CLIENT's own tax-registration status — normally set by their own OWNER account on the "My Plan" screen, not by you. Shown here read-only for support visibility, with an override available if a client needs help.</p>
        <div class="form-inline">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="a-vat-enabled" ${vatSettings.vat_enabled ? 'checked' : ''}/> VAT tracking enabled</label>
          <div class="form-row"><label>VAT Rate (%)</label><input type="number" id="a-vat-rate" value="${vatSettings.vat_rate_percent}" min="0" max="100" step="0.1" style="max-width:120px;" /></div>
        </div>
        <button class="btn btn-secondary" id="a-vat-save" style="margin-top:10px;">Override VAT Settings</button>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Client Support Contact</h3>
        <p class="page-subtitle">Shown to the pharmacy owner when they hit a plan limit or their subscription lapses.</p>
        <div class="form-inline">
          <div class="form-row"><label>Contact Name</label><input id="a-contact-name" value="${UI.escapeHtml(settings.admin_contact_name || '')}" /></div>
          <div class="form-row"><label>Phone</label><input id="a-contact-phone" value="${UI.escapeHtml(settings.admin_contact_phone || '')}" /></div>
          <div class="form-row"><label>Email</label><input id="a-contact-email" value="${UI.escapeHtml(settings.admin_contact_email || '')}" /></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Internal Notes</h3>
        <p class="page-subtitle">Never shown to the client — for vendor/support use only.</p>
        <textarea id="a-notes" rows="3" style="width:100%;">${UI.escapeHtml(settings.notes || '')}</textarea>
      </div>

      <button class="btn btn-primary" id="a-save" style="margin-top:14px;">Save Changes</button>
    `;

    let logoCleared = false;

    document.getElementById('a-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      const msgEl = document.getElementById('a-logo-msg');
      if (!file) return;
      msgEl.textContent = '';
      if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
        msgEl.textContent = 'Please choose a PNG, JPEG, WEBP, or GIF image.';
        msgEl.style.color = 'var(--red-500)';
        e.target.value = '';
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        msgEl.textContent = `That file is ${Math.round(file.size / 1024)} KB — please choose an image under 500 KB.`;
        msgEl.style.color = 'var(--red-500)';
        e.target.value = '';
        return;
      }
      try {
        pendingLogoDataUrl = await readFileAsDataUrl(file);
        logoCleared = false;
        msgEl.textContent = 'Logo ready — click "Save Changes" to apply it.';
        msgEl.style.color = 'var(--gray-600)';
        render();
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.color = 'var(--red-500)';
      }
    });

    const removeBtn = document.getElementById('a-logo-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        pendingLogoDataUrl = null;
        logoCleared = true;
        // LEGACY-BROWSER COMPATIBILITY: object spread (`{...settings}`)
        // is ES2018 syntax — see public/js/state.js's persist()
        // comment for the full rationale (mirrored here).
        settings = Object.assign({}, settings, { logo_data_url: null });
        render();
      });
    }

    UI.guardedClick(document.getElementById('a-save'), async () => {
      const maxBranches = Number(document.getElementById('a-max-branches').value);
      const maxStaff = Number(document.getElementById('a-max-staff').value);
      if (!Number.isInteger(maxBranches) || maxBranches < 1 || !Number.isInteger(maxStaff) || maxStaff < 1) {
        UI.toast('Max Branches and Max Staff must be positive whole numbers.', 'error');
        return;
      }
      const businessNameRaw = document.getElementById('a-business-name').value.trim();
      try {
        const payload = {
          max_branches: maxBranches,
          max_staff: maxStaff,
          subscription_plan: document.getElementById('a-plan-name').value,
          subscription_status: document.getElementById('a-status').value,
          subscription_renewal_date: document.getElementById('a-renewal').value || null,
          multi_branch_enabled: document.getElementById('a-multi-branch').checked,
          attendance_module_enabled: document.getElementById('a-attendance').checked,
          controlled_register_enabled: document.getElementById('a-controlled').checked,
          admin_contact_name: document.getElementById('a-contact-name').value || null,
          admin_contact_phone: document.getElementById('a-contact-phone').value || null,
          admin_contact_email: document.getElementById('a-contact-email').value || null,
          business_name: businessNameRaw || null,
          notes: document.getElementById('a-notes').value || null,
        };
        if (pendingLogoDataUrl) payload.logo_data_url = pendingLogoDataUrl;
        else if (logoCleared) payload.logo_data_url = null;

        settings = await Api.put('/admin/settings', payload);
        pendingLogoDataUrl = null;
        logoCleared = false;
        UI.toast('Settings updated', 'success');
        Branding.load(); // refresh the topbar/tab-title/login-screen branding immediately
        render();
      } catch (e) {
        UI.toast(e.message, 'error');
      }
    });

    UI.guardedClick(document.getElementById('a-vat-save'), async () => {
      const rate = Number(document.getElementById('a-vat-rate').value);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        UI.toast('VAT rate must be a number between 0 and 100', 'error');
        return;
      }
      try {
        vatSettings = await Api.put('/settings/vat', {
          vat_enabled: document.getElementById('a-vat-enabled').checked,
          vat_rate_percent: rate,
        });
        UI.toast('VAT settings overridden', 'success');
        render();
      } catch (e) {
        UI.toast(e.message, 'error');
      }
    });
  }

  render();
}
// General Ledger / accounting reports view — Chart of Accounts, Trial
// Balance, Profit & Loss, and Balance Sheet — backed by the new /api/gl/*
// endpoints (the original implementation and worker/src/routes/gl.js, both
// fully parity-mirrored). See the original implementation's "GENERAL
// LEDGER & CHART OF ACCOUNTS" section and the original implementation for
// the full accounting rationale behind every figure shown here.
//
// VISIBILITY: manager-only (MANAGER/OWNER/ADMIN), matching the backend
// route's own managerOnly gate — a plain STAFF cashier has no legitimate
// need to see organization-wide account balances (mirrors the "Users &
// Branches" / "Products" nav items' State.isManager gate).
