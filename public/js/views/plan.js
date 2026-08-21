async function renderPlan(view) {
  // BUG 69 — THREE BACKEND CAPABILITIES HAD NO UI FOR THE ROLE THAT OWNS THEM.
  //
  // `ownerOnly` in worker/src/lib/auth.js deliberately admits ADMIN as well as
  // OWNER ("the pharmacy's own proprietor seat, PLUS the vendor's ADMIN seat"),
  // so support can help a client who cannot work a setting out. Executed and
  // confirmed against the live API: as ADMIN,
  //     PUT /settings/manager-permissions   -> 200, and the change PERSISTS
  //     PUT /wht/rates/:code                -> ownerOnly, ADMIN admitted
  //     POST /wht/rates                     -> ownerOnly, ADMIN admitted
  //
  // But this screen gated on isOwner(), which is `role === 'OWNER'` exactly,
  // and #/plan is the ONLY place those controls exist. So ADMIN was told
  // "This page is only available to the account owner" for powers the backend
  // grants it — reproduced in a real browser. Meanwhile the Admin Portal
  // refuses the same manager-permission fields with "these belong to the
  // pharmacy", so the product gave two contradictory answers depending on
  // which door you knocked on, and the working door had no handle.
  //
  // Opened to ADMIN, with the screen clearly marked as someone else's account
  // so a support engineer is never in any doubt whose settings they are
  // changing. STAFF and MANAGER remain excluded, exactly as before.
  const isSupport = State.isAdmin();
  // THE SAME CLASS AGAIN, one role along. A MANAGER may now set the cashiers'
  // safe allowance (PUT /settings/manager-permissions accepts exactly those two
  // fields from them — see routes/settings.js MANAGER_SETTABLE), and #/plan is
  // the only place that control exists. Gating the whole screen on isOwner()
  // would repeat the mistake written up above: a power the backend grants with
  // no door in the UI.
  //
  // Managers are admitted, and shown ONLY the allowance they may change. Every
  // other card here — the plan, VAT, WHT rates, the manager switches — stays
  // owner-and-support, because a manager who could edit those would be
  // granting themselves the authority the Owner withheld.
  const isManagerOnly = !State.isOwner() && !isSupport && State.isManager();
  if (!State.isOwner() && !isSupport && !isManagerOnly) {
    view.innerHTML = `<div class="card"><p>This page is only available to the account owner.</p></div>`;
    return;
  }

  let perms;
  try {
    perms = await Api.get('/settings/manager-permissions');
  } catch (e) {
    // Fail OPEN in the UI: if we cannot read the policy we must not imply
    // managers are restricted when the server would still allow them.
    perms = { managers_can_void_sales: true, managers_can_approve_expenses: true, managers_can_edit_prices: true,
              staff_can_void_sales: true, staff_void_window_minutes: 15,
              staff_can_adjust_stock: true, staff_adjustment_max_units: 5,
              staff_can_spend_from_safe: true, staff_safe_spend_max: 20000 };
  }

  let vat;
  try {
    vat = await Api.get('/settings/vat');
  } catch (e) {
    vat = { vat_enabled: false, vat_rate_percent: 7.5 };
  }

  // WITHHOLDING TAX. Both the rate schedule the owner can edit and the
  // live position (what is owed to the revenue authority, what credit the
  // pharmacy holds). Fails soft: a WHT read error must never blank the
  // whole plan page, which also carries subscription and storage warnings.
  let whtRates = [];
  let whtSummary = null;
  try {
    whtRates = await Api.get('/wht/rates');
  } catch (e) { /* older backend or transient error — section renders empty */ }
  try {
    whtSummary = await Api.get('/wht/summary');
  } catch (e) { /* as above */ }

  let plan;
  try {
    plan = await Api.get('/dashboard/plan');
  } catch (e) {
    view.innerHTML = `<div class="card"><p style="color:var(--red-500)">Failed to load plan: ${UI.escapeHtml(e.message)}</p></div>`;
    return;
  }

  // Kept separate from the normal plan fetch: a data-management problem must
  // not hide the owner's VAT, WHT or subscription controls.
  let dataManagement = null;
  if (State.isOwner()) {
    try { dataManagement = await Api.get('/data-management/status'); } catch (e) { /* non-destructive screen stays usable */ }
  }

  const statusKind = { ACTIVE: 'green', TRIAL: 'amber', SUSPENDED: 'red', EXPIRED: 'red' }[plan.subscription_status] || 'gray';

  // CAPACITY YOU HAVE ALREADY PAID FOR — not an allowance you are burning.
  //
  // This previously read "3 / 5 used" and "2 remaining on your current plan",
  // which describes a quota being consumed. That is the wrong mental model and
  // the client corrected it: the limit is what they have ALREADY BOUGHT.
  // Leaving two branch slots unopened does not save them anything, and closing
  // a branch frees the SLOT to reuse — it does not reduce the bill. Only
  // PharmaRidge can raise the ceiling, because raising it is a purchase.
  //
  // So the wording is now "3 of 5 paid for — 2 available to use", and the bar
  // is never coloured as a warning for being FULL: using everything you paid
  // for is the goal, not a problem. Red is reserved for the one case that
  // actually needs an action — you want more than you have bought.
  function usageBar(label, used, max, remaining) {
    const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
    const full = remaining <= 0;
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <h3 style="margin:0;">${label}</h3>
          <span style="font-size:13px;color:var(--gray-600);"><strong>${used}</strong> of <strong>${max}</strong> paid for</span>
        </div>
        <div class="usage-bar-track" style="background:var(--gray-200);border-radius:6px;height:10px;margin-top:10px;overflow:hidden;">
          <div class="usage-bar-fill usage-${full ? 'ok' : 'ok'}" style="width:${pct}%;height:100%;background:var(--green-500);"></div>
        </div>
        <div style="font-size:12px;color:var(--gray-600);margin-top:6px;">
          ${remaining > 0
            ? `<strong>${remaining}</strong> more already paid for and ready to use — open ${remaining === 1 ? 'it' : 'them'} whenever you need ${remaining === 1 ? 'it' : 'them'}, at no extra cost.`
            : `You are using everything on your plan. To add more, contact support — the ceiling can only be raised by PharmaRidge.`}
        </div>
      </div>
    `;
  }

  function featureRow(label, enabled) {
    return `<tr><td>${label}</td><td>${enabled ? UI.badge('Enabled', 'green') : UI.badge('Not on your plan', 'gray')}</td></tr>`;
  }

  // A MANAGER sees ONLY the control they may actually use. Rendering the full
  // screen and hiding eight cards would be a maintenance trap — the next card
  // added would be visible to them by default, which is the wrong way round
  // for a permissions screen.
  if (isManagerOnly) {
    view.innerHTML = `
      <h2 class="page-title">Cashier Spending Allowance</h2>
      <p class="page-subtitle">How much your cashiers may take from the branch safe for a purchase.
        The rest of the plan and tax settings belong to the Owner.</p>
      ${!State.isBranchPinned() && plan.storage && plan.storage.available && plan.storage.status !== 'OK' ? `
        <div class="card" style="border-left:4px solid ${plan.storage.status === 'CRITICAL' ? 'var(--red-500)' : 'var(--amber-500)'};background:${plan.storage.status === 'CRITICAL' ? 'var(--tint-red)' : 'var(--tint-amber)'};">
          <h3 style="margin:0 0 6px;">${plan.storage.status === 'CRITICAL' ? 'Storage almost full' : 'Storage is filling up'}</h3>
          <p style="margin:0 0 7px;font-size:13px;">${UI.escapeHtml(plan.storage.message || '')}</p>
          <p style="margin:0;font-size:13px;"><strong>${plan.storage.megabytes} MB</strong> of ${plan.storage.limit_megabytes} MB estimated (${plan.storage.percent_used}%). Please alert the Owner; only the Owner can choose retention or reset actions.</p>
        </div>
      ` : ''}
      <div class="card">
        <h3>Cashier Permissions</h3>
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="sperm-safe" ${perms.staff_can_spend_from_safe ? 'checked' : ''}/> Cashiers can <strong>pay for things from the branch safe</strong></label>
          <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">For a purchase the till drawer cannot cover. Untick to require a manager for every naira that leaves the safe.</small>
        </div>
        <div class="form-row" style="margin-left:22px;">
          <label>Most they may take from the safe, per purchase (N)</label>
          <input type="number" id="sperm-safe-cap" value="${perms.staff_safe_spend_max}" min="0" max="10000000" step="100" style="max-width:160px;" />
          <small class="muted" style="display:block;font-size:12px;">Anything larger needs a manager. <strong>0 means no limit.</strong></small>
        </div>
        <button class="btn btn-primary" id="sperm-safe-save">Save Allowance</button>
      </div>`;
    UI.guardedClick(document.getElementById('sperm-safe-save'), async () => {
      const cap = Number(document.getElementById('sperm-safe-cap').value);
      if (!Number.isFinite(cap) || cap < 0 || cap > 10000000) {
        UI.toast('Safe limit must be an amount between 0 and 10,000,000 (0 means no limit)', 'error');
        return;
      }
      try {
        await Api.put('/settings/manager-permissions', {
          staff_can_spend_from_safe: document.getElementById('sperm-safe').checked,
          staff_safe_spend_max: cap,
        }, { allowOfflineQueue: false });
        UI.toast('Cashier safe allowance saved', 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
    return;
  }

  view.innerHTML = `
    <h2 class="page-title">${isSupport ? 'Client Plan &amp; Policy (Support View)' : 'My Plan'}</h2>
    <p class="page-subtitle">${isSupport
      ? 'You are signed in as PharmaRidge Support. These are the PHARMACY\'s own settings, not yours — every change here is recorded against your support account.'
      : 'Your subscription, usage, and contracted limits for this PharmaRidge deployment.'}</p>
    ${isSupport ? `<div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);">
      <b>Acting on a client's account.</b> Manager/cashier permissions, VAT and withholding-tax
      rates belong to the pharmacy. Change them only when the owner has asked you to, and tell
      them what you changed — the owner sees the same screen without this notice.
    </div>` : ''}

    <div class="grid grid-2">
      <div class="stat-card">
        <div class="label">Subscription Status</div>
        <div class="value">${UI.badge(plan.subscription_status, statusKind)}</div>
        <div class="meta" style="font-size:11px;color:var(--gray-600);margin-top:4px;">Plan: ${UI.escapeHtml(plan.subscription_plan)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Renewal Date</div>
        <div class="value">${plan.subscription_renewal_date || '—'}</div>
      </div>
    </div>

    ${plan.subscription_status !== 'ACTIVE' && plan.subscription_status !== 'TRIAL' ? `
    <div class="card" style="border-left:4px solid var(--red-500);margin-top:16px;">
      <h3>⚠ Action Required</h3>
      <p>Your subscription is currently <strong>${plan.subscription_status}</strong>. New actions (adding sales, staff, branches, etc.) are disabled until this is resolved. Please contact <strong>${UI.escapeHtml(plan.support_contact.display)}</strong> as soon as possible.</p>
    </div>` : ''}

    <div class="grid grid-2" style="margin-top:16px;">
      ${usageBar('Branches', plan.branches.used, plan.branches.max, plan.branches.remaining)}
      ${usageBar('Staff Accounts', plan.staff.used, plan.staff.max, plan.staff.remaining)}
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Modules on Your Plan</h3>
      <div class="table-wrap">
        <table>
          <tbody>
            ${featureRow('Multi-Branch Support', plan.features.multi_branch_enabled)}
            ${featureRow('Staff Attendance &amp; Geofencing', plan.features.attendance_module_enabled)}
            ${featureRow('Controlled Drug Register', plan.features.controlled_register_enabled)}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Branding</h3>
      <p class="page-subtitle">Your business name and logo, as configured by PharmaRidge support. Contact them to update these.</p>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><td>Business Name</td><td>${plan.branding.business_name ? UI.escapeHtml(plan.branding.business_name) : UI.badge('Using default "PharmaRidge" name', 'gray')}</td></tr>
            <tr><td>Logo</td><td>${plan.branding.has_logo ? UI.badge('Set', 'green') : UI.badge('Not set', 'gray')}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>VAT (Value Added Tax)</h3>
      <p class="page-subtitle">Unlike the modules above (set by PharmaRidge support), VAT registration is your own business's tax status — you control this yourself. Turning it on does <strong>not</strong> increase what your customers pay at checkout: it simply extracts the VAT portion from your existing prices for your own FIRS remittance records and reports.</p>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="vat-enabled" ${vat.vat_enabled ? 'checked' : ''}/> Enable VAT tracking</label>
      </div>
      <div class="form-row">
        <label>VAT Rate (%)</label>
        <input type="number" id="vat-rate" value="${vat.vat_rate_percent}" min="0" max="100" step="0.1" style="max-width:120px;" />
      </div>
      <button class="btn btn-primary" id="vat-save">Save VAT Settings</button>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Withholding Tax (WHT)</h3>
      <p class="page-subtitle">
        WHT is <strong>not an extra tax</strong> — it is income tax deducted in advance.
        When you pay rent, professional fees or a supplier, you withhold a percentage and
        remit it to the revenue authority on their behalf, giving them a credit note.
        <strong>Your cost does not change:</strong> a ₦100,000 rent bill is still a ₦100,000
        expense — ₦90,000 goes to the landlord and ₦10,000 to the tax authority.
        Deductions must be remitted by the <strong>21st of the following month</strong>.
      </p>
      ${whtSummary ? `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
          <div style="flex:1;min-width:190px;padding:12px;border-radius:8px;background:var(--tint-amber);border-left:4px solid var(--amber-500);">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">You owe the tax authority</div>
            <div style="font-size:22px;font-weight:700;">${UI.money(whtSummary.payable_outstanding)}</div>
            <div style="font-size:12px;">${whtSummary.payable_outstanding_count} deduction${whtSummary.payable_outstanding_count === 1 ? '' : 's'} not yet remitted — due ${UI.escapeHtml(whtSummary.next_remittance_due || '')}</div>
          </div>
          <div style="flex:1;min-width:190px;padding:12px;border-radius:8px;background:var(--tint-green);border-left:4px solid var(--green-600);">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Tax credit you can reclaim</div>
            <div style="font-size:22px;font-weight:700;">${UI.money(whtSummary.receivable_credit)}</div>
            <div style="font-size:12px;">Withheld from you by customers on ${whtSummary.receivable_count} sale${whtSummary.receivable_count === 1 ? '' : 's'}</div>
          </div>
        </div>
        <p style="font-size:12px;margin:0 0 14px;">These two are <strong>never netted off</strong> against each other — one is money you hold for the tax authority, the other is credit you can offset against your own income tax.</p>
      ` : ''}
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Category</th><th style="text-align:right;">Rate</th><th>Applies to</th><th></th></tr></thead>
          <tbody>
            ${whtRates.length ? whtRates.map((r) => `
              <tr${r.is_active ? '' : ' style="opacity:.5;"'}>
                <td>${UI.escapeHtml(r.name)}${r.is_system ? '' : ' ' + UI.badge('Custom', 'blue')}${r.is_active ? '' : ' ' + UI.badge('Off', 'gray')}</td>
                <td style="text-align:right;"><input type="number" class="wht-rate-input" data-code="${UI.escapeHtml(r.code)}" value="${r.rate_percent}" min="0" max="100" step="0.1" style="max-width:90px;text-align:right;" aria-label="Withholding tax rate for ${UI.escapeHtml(r.label || r.code)}, percent" title="Withholding tax rate for ${UI.escapeHtml(r.label || r.code)}" /> %</td>
                <td style="font-size:12px;">${r.direction === 'BOTH' ? 'Payments &amp; receipts' : r.direction === 'PAYABLE' ? 'Payments you make' : 'Receipts from customers'}</td>
                <td><button class="btn btn-secondary btn-sm" data-wht-save="${UI.escapeHtml(r.code)}">Save</button></td>
              </tr>
            `).join('') : '<tr><td colspan="4">No WHT rates configured.</td></tr>'}
          </tbody>
        </table>
      </div>
      <p style="font-size:12px;margin-top:10px;">
        Rates shown are the Deduction of Tax at Source (Withholding) Regulations 2024, effective 1 January 2025,
        for <strong>resident</strong> recipients. Non-resident rates are higher in several categories.
        Nigerian rates change — edit any figure above if your tax adviser directs otherwise.
        Goods <em>manufactured or produced by the supplier itself</em> are exempt from the supply-of-goods deduction.
      </p>
    </div>

    ${plan.storage && plan.storage.available && plan.storage.status !== 'OK' ? `
      <div class="card" style="margin-top:16px;border-left:4px solid ${plan.storage.status === 'CRITICAL' ? 'var(--red-500)' : 'var(--amber-500)'};background:${plan.storage.status === 'CRITICAL' ? 'var(--tint-red)' : 'var(--tint-amber)'};">
        <h3 style="margin:0 0 6px;">${plan.storage.status === 'CRITICAL' ? '⚠ Storage almost full' : '⚠ Storage is filling up'}</h3>
        <p style="margin:0 0 8px;font-size:13px;">${UI.escapeHtml(plan.storage.message || '')}</p>
        <p style="margin:0;font-size:13px;"><strong>${plan.storage.megabytes} MB</strong> of ${plan.storage.limit_megabytes} MB used (${plan.storage.percent_used}%).</p>
      </div>
    ` : ''}

    <div class="card" style="margin-top:16px;">
      <h3>Storage</h3>
      <p class="page-subtitle">Business records are not automatically deleted. We warn you well before capacity becomes a problem so the Owner can retain required records, plan an upgrade, or use the guarded data-management process after exporting what must be kept.</p>
      ${plan.storage && plan.storage.available ? `
        <div class="form-row">
          <label>Database used</label>
          <div>${plan.storage.megabytes} MB of ${plan.storage.limit_megabytes} MB (${plan.storage.percent_used}%) — ${plan.storage.status === 'OK' ? 'plenty of room' : plan.storage.status.toLowerCase()}</div>
        </div>
      ` : '<p style="font-size:13px;">Storage usage is not available on this deployment.</p>'}
    </div>

    ${State.isOwner() ? `
      <div class="card" style="margin-top:16px;border-left:4px solid var(--red-500);">
        <h3 style="margin-top:0;">Owner Data Management</h3>
        <p class="page-subtitle">Use this only after exporting the reports or backup you must retain. You can preview and permanently delete a selected period, clear business data while retaining accounts and branches, or start over and remove Manager and Staff credentials. General Managers receive capacity warnings but cannot use this control.</p>
        ${dataManagement && dataManagement.storage && dataManagement.storage.available ? `
          <div style="font-size:13px;margin:0 0 10px;"><strong>Live data estimate:</strong> ${dataManagement.storage.megabytes} MB of ${dataManagement.storage.limit_megabytes} MB (${dataManagement.storage.percent_used}%). This does not guarantee that Cloudflare immediately reduces physical allocation after a delete.</div>
        ` : '<div style="font-size:13px;margin:0 0 10px;">Storage status is temporarily unavailable; deletion remains permanently destructive.</div>'}
        <button class="btn btn-danger" id="owner-data-management">Review data-management options</button>
        ${dataManagement && dataManagement.recent_cleanups && dataManagement.recent_cleanups.length ? `
          <p style="font-size:12px;margin:12px 0 0;color:var(--gray-600);">Most recent cleanup: ${UI.escapeHtml(dataManagement.recent_cleanups[0].mode)} on ${UI.shortDate(dataManagement.recent_cleanups[0].created_at)} (${dataManagement.recent_cleanups[0].record_total || 0} records previewed).</p>
        ` : ''}
      </div>
    ` : ''}

    <div class="card" style="margin-top:16px;">
      <h3>Manager Permissions</h3>
      <p class="page-subtitle">You decide what your managers may do. These are your own controls, not PharmaRidge's — unticking a box takes that power away from <strong>every</strong> manager immediately, both General Managers and Branch Managers. Your own Owner account is never restricted by these settings.</p>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="perm-void" ${perms.managers_can_void_sales ? 'checked' : ''}/> Managers can <strong>void sales</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">Voiding reverses revenue and cost of goods in your accounts.</small>
      </div>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="perm-expense" ${perms.managers_can_approve_expenses ? 'checked' : ''}/> Managers can <strong>approve expenses</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">Approval is what releases money against an expense claim.</small>
      </div>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="perm-price" ${perms.managers_can_edit_prices ? 'checked' : ''}/> Managers can <strong>change branch prices</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">Controls the per-branch selling price customers are charged.</small>
      </div>
      <button class="btn btn-primary" id="perm-save">Save Manager Permissions</button>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Cashier Permissions</h3>
      <p class="page-subtitle">
        Two things a cashier does are also the two commonest ways money goes missing in a pharmacy:
        <strong>voiding a sale</strong> after taking the cash, and <strong>writing off stock</strong> as damaged after taking the goods.
        They are also how honest mistakes get fixed — so rather than banning them, PharmaRidge keeps them
        <em>small</em>: a cashier may undo their own recent sale, and write off a unit or two.
        Anything bigger needs you or a manager.
      </p>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="sperm-void" ${perms.staff_can_void_sales ? 'checked' : ''}/> Cashiers can <strong>void their own recent sale</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">Only a sale they served themselves, while their till is still open. Untick to require a manager for every void.</small>
      </div>
      <div class="form-row" style="margin-left:22px;">
        <label>Time limit (minutes)</label>
        <input type="number" id="sperm-window" value="${perms.staff_void_window_minutes}" min="0" max="1440" step="1" style="max-width:120px;" />
        <small class="muted" style="display:block;font-size:12px;">After this many minutes a cashier must ask a manager. 0 means no time limit.</small>
      </div>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="sperm-adjust" ${perms.staff_can_adjust_stock ? 'checked' : ''}/> Cashiers can <strong>write off small amounts of stock</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">For a dropped bottle or a torn sachet. Untick to require a manager for every write-off.</small>
      </div>
      <div class="form-row" style="margin-left:22px;">
        <label>Most units per write-off</label>
        <input type="number" id="sperm-cap" value="${perms.staff_adjustment_max_units}" min="0" max="10000" step="1" style="max-width:120px;" />
        <small class="muted" style="display:block;font-size:12px;">Anything larger needs a manager.</small>
      </div>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="sperm-safe" ${perms.staff_can_spend_from_safe ? 'checked' : ''}/> Cashiers can <strong>pay for things from the branch safe</strong></label>
        <small class="muted" style="display:block;margin:2px 0 0 22px;font-size:12px;">For a purchase the till drawer cannot cover. Untick to require a manager for every naira that leaves the safe.</small>
      </div>
      <div class="form-row" style="margin-left:22px;">
        <label>Most they may take from the safe, per purchase (N)</label>
        <input type="number" id="sperm-safe-cap" value="${perms.staff_safe_spend_max}" min="0" max="10000000" step="100" style="max-width:160px;" />
        <small class="muted" style="display:block;font-size:12px;">Anything larger needs a manager. <strong>0 means no limit.</strong></small>
      </div>
      <button class="btn btn-primary" id="sperm-save">Save Cashier Permissions</button>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Need to upgrade or have a question about your plan?</h3>
      <p>To add more branches or staff, enable a module, or resolve a billing issue, contact PharmaRidge support:</p>
      <ul style="line-height:1.9;">
        ${plan.support_contact.name ? `<li><strong>Contact:</strong> ${UI.escapeHtml(plan.support_contact.name)}</li>` : ''}
        ${plan.support_contact.phone ? `<li><strong>Phone:</strong> ${UI.escapeHtml(plan.support_contact.phone)}</li>` : ''}
        ${plan.support_contact.email ? `<li><strong>Email:</strong> ${UI.escapeHtml(plan.support_contact.email)}</li>` : ''}
      </ul>
    </div>
  `;

  UI.guardedClick(document.getElementById('owner-data-management'), async () => {
    await openOwnerDataManagement();
  });

  UI.guardedClick(document.getElementById('perm-save'), async () => {
    try {
      await Api.put('/settings/manager-permissions', {
        managers_can_void_sales: document.getElementById('perm-void').checked,
        managers_can_approve_expenses: document.getElementById('perm-expense').checked,
        managers_can_edit_prices: document.getElementById('perm-price').checked,
      }, { allowOfflineQueue: false });
      UI.toast('Manager permissions saved', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  UI.guardedClick(document.getElementById('sperm-save'), async () => {
    const windowMinutes = Number(document.getElementById('sperm-window').value);
    const cap = Number(document.getElementById('sperm-cap').value);
    if (!Number.isInteger(windowMinutes) || windowMinutes < 0 || windowMinutes > 1440) {
      UI.toast('Time limit must be a whole number of minutes between 0 and 1440', 'error');
      return;
    }
    if (!Number.isInteger(cap) || cap < 0 || cap > 10000) {
      UI.toast('Write-off limit must be a whole number between 0 and 10000', 'error');
      return;
    }
    // 0 is a legitimate value here and means NO LIMIT — not "nothing allowed".
    // Whether a cashier may spend from the safe at all is the tick box above.
    const safeCap = Number(document.getElementById('sperm-safe-cap').value);
    if (!Number.isFinite(safeCap) || safeCap < 0 || safeCap > 10000000) {
      UI.toast('Safe limit must be an amount between 0 and 10,000,000 (0 means no limit)', 'error');
      return;
    }
    try {
      await Api.put('/settings/manager-permissions', {
        staff_can_void_sales: document.getElementById('sperm-void').checked,
        staff_void_window_minutes: windowMinutes,
        staff_can_adjust_stock: document.getElementById('sperm-adjust').checked,
        staff_adjustment_max_units: cap,
        staff_can_spend_from_safe: document.getElementById('sperm-safe').checked,
        staff_safe_spend_max: safeCap,
      }, { allowOfflineQueue: false });
      UI.toast('Cashier permissions saved', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  UI.guardedClick(document.getElementById('vat-save'), async () => {
    const rate = Number(document.getElementById('vat-rate').value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      UI.toast('VAT rate must be a number between 0 and 100', 'error');
      return;
    }
    try {
      await Api.put('/settings/vat', {
        vat_enabled: document.getElementById('vat-enabled').checked,
        vat_rate_percent: rate,
      }, { allowOfflineQueue: false });
      UI.toast('VAT settings saved', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  // WHT rate edits. One button per row so the owner changes exactly the
  // rate they meant to, rather than a bulk save that could silently
  // rewrite a schedule they only glanced at — these figures decide how
  // much tax is deducted from every future payment.
  document.querySelectorAll('[data-wht-save]').forEach((btn) => {
    UI.guardedClick(btn, async () => {
      const code = btn.dataset.whtSave;
      const input = document.querySelector(`.wht-rate-input[data-code="${code}"]`);
      const rate = Number(input && input.value);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        UI.toast('WHT rate must be a number between 0 and 100', 'error');
        return;
      }
      try {
        await Api.put(`/wht/rates/${encodeURIComponent(code)}`, { rate_percent: rate }, { allowOfflineQueue: false });
        UI.toast(`${code} withholding rate saved as ${rate}%`, 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  });
}

// Owner-only, deliberately two-stage dialog. A coloured destructive button is
// not a safety control: the server previews current rows, then repeats the
// checks at submission time after two acknowledgements and an exact phrase.
async function openOwnerDataManagement() {
  let status;
  try {
    status = await Api.get('/data-management/status');
  } catch (e) {
    UI.toast(e.message || 'Could not load data-management options.', 'error');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const modal = UI.openModal(`
    <h2 style="margin-top:0;color:var(--red-600);">Owner Data Management</h2>
    <p class="page-subtitle">This is a permanent hard-delete process, not an archive. Download/verify required reports or a backup first. Sync every active device before continuing: known offline queues block this action, and older queued items are quarantined for review after any cleanup rather than being allowed to recreate records. Check your accountant, tax adviser and applicable pharmacy/controlled-drug record-retention obligations before you continue.</p>
    <div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);margin:12px 0;">
      <strong>Storage reality:</strong> deleting rows reduces the active-data estimate, but Cloudflare controls physical database allocation. Do not use deletion as the only capacity plan when storage is critical.
    </div>
    <div class="form-row">
      <label for="dm-mode">What do you want to remove?</label>
      <select id="dm-mode">${(status.modes || []).map((m) => `<option value="${UI.escapeHtml(m.code)}">${UI.escapeHtml(m.label)}</option>`).join('')}</select>
      <small id="dm-mode-help" class="muted" style="display:block;margin-top:5px;font-size:12px;"></small>
      <small id="dm-mode-retains" class="muted" style="display:block;margin-top:5px;font-size:12px;"></small>
    </div>
    <div id="dm-period" class="grid grid-2" style="margin:8px 0;">
      <div class="form-row"><label for="dm-start">From date (inclusive)</label><input id="dm-start" type="date" max="${today}" /></div>
      <div class="form-row"><label for="dm-end">To date (inclusive)</label><input id="dm-end" type="date" max="${today}" value="${today}" /></div>
    </div>
    <div id="dm-preview" class="card" style="background:var(--gray-50);margin:12px 0;font-size:13px;">Choose an option and select <strong>Preview impact</strong>. Nothing has been deleted.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
      <button class="btn btn-ghost" id="dm-close" type="button">Cancel</button>
      <button class="btn btn-secondary" id="dm-preview-button" type="button">Preview impact</button>
    </div>
  `);
  const byId = (id) => modal.querySelector(`#${id}`);
  const select = byId('dm-mode');
  const help = byId('dm-mode-help');
  const retains = byId('dm-mode-retains');
  const period = byId('dm-period');
  const previewEl = byId('dm-preview');
  function selectedMode() { return (status.modes || []).find((m) => m.code === select.value) || null; }
  function resetPreview() {
    const mode = selectedMode();
    period.style.display = mode && mode.needs_dates ? '' : 'none';
    help.textContent = mode ? mode.description : '';
    retains.innerHTML = mode && mode.retains ? `<strong>Protected for continuity:</strong> ${UI.escapeHtml(mode.retains)}` : '';
    previewEl.innerHTML = 'Option changed. Select <strong>Preview impact</strong>; nothing has been deleted.';
  }
  select.addEventListener('change', resetPreview);
  resetPreview();
  byId('dm-close').addEventListener('click', () => UI.closeModal(modal));

  UI.guardedClick(byId('dm-preview-button'), async () => {
    const mode = selectedMode();
    if (!mode) return;
    let url = `/data-management/preview?mode=${encodeURIComponent(mode.code)}`;
    if (mode.needs_dates) {
      const start = byId('dm-start').value;
      const end = byId('dm-end').value;
      if (!start || !end) { UI.toast('Choose both dates for the period you want to review.', 'error'); return; }
      url += `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;
    }
    try {
      const preview = await Api.get(url);
      const counts = Object.entries(preview.records || {}).filter((entry) => Number(entry[1]) > 0);
      const list = counts.length
        ? `<ul style="columns:2;column-gap:24px;margin:8px 0 0;padding-left:20px;">${counts.map(([table, count]) => `<li>${UI.escapeHtml(table.replace(/_/g, ' '))}: <strong>${Number(count).toLocaleString()}</strong></li>`).join('')}</ul>`
        : '<p style="margin:8px 0 0;">No matching rows are currently found. Preview again immediately before confirming if data may still arrive.</p>';
      const retained = preview.retained
        ? `<div style="margin-top:10px;padding:10px;border-left:4px solid var(--green-500);background:var(--tint-green);"><strong>Protected for continuity:</strong> ${Number(preview.retained.stock_batches || 0).toLocaleString()} current stock batch(es), ${Number(preview.retained.stock_base_units || 0).toLocaleString()} base unit(s), ${Number(preview.retained.stocked_products || 0).toLocaleString()} stocked product(s), plus posted GL and branch-safe figures. Supplier and purchase-order links on retained batches will be removed.</div>`
        : (preview.retains ? `<div style="margin-top:10px;padding:10px;border-left:4px solid var(--green-500);background:var(--tint-green);"><strong>Protected for continuity:</strong> ${UI.escapeHtml(preview.retains)}</div>` : '');
      const blockers = preview.blockers && preview.blockers.length
        ? `<div style="margin-top:10px;padding:10px;border-left:4px solid var(--red-500);background:var(--tint-red);"><strong>Cannot run yet:</strong> ${preview.blockers.map((b) => `${b.count} ${UI.escapeHtml(b.label)}`).join(', ')}. Close/resolve these operations, then preview again.</div>`
        : '';
      previewEl.innerHTML = `
        <h3 style="margin:0 0 5px;">Preview: ${UI.escapeHtml(preview.mode_label)}</h3>
        <p style="margin:0;">${UI.escapeHtml(preview.description || '')}</p>
        <p style="margin:8px 0 0;"><strong>${Number(preview.record_total || 0).toLocaleString()}</strong> records currently match this cleanup.</p>
        ${list}${retained}${blockers}
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--gray-200);">
          <label style="display:flex;gap:7px;align-items:flex-start;margin:7px 0;"><input id="dm-exported" type="checkbox" /> <span>I exported or verified the reports/backup I am responsible for retaining.</span></label>
          <label style="display:flex;gap:7px;align-items:flex-start;margin:7px 0;"><input id="dm-retention" type="checkbox" /> <span>I understand the deletion is permanent in this app and I have considered financial, VAT/WHT, prescription and controlled-drug record-retention obligations.</span></label>
          <label for="dm-confirm" style="display:block;margin-top:10px;">Type exactly <strong>${UI.escapeHtml(preview.confirmation_phrase)}</strong> to enable removal</label>
          <input id="dm-confirm" autocomplete="off" spellcheck="false" style="width:100%;margin-top:4px;" />
          <button class="btn btn-danger" id="dm-run" type="button" style="margin-top:10px;" ${preview.can_run ? '' : 'disabled'}>Permanently remove matching data</button>
        </div>`;
      const runButton = byId('dm-run');
      if (!runButton) return;
      UI.guardedClick(runButton, async () => {
        const current = selectedMode();
        const payload = {
          mode: current.code,
          confirmation: byId('dm-confirm').value,
          export_confirmed: !!byId('dm-exported').checked,
          retention_acknowledged: !!byId('dm-retention').checked,
        };
        if (current.needs_dates) {
          payload.start_date = byId('dm-start').value;
          payload.end_date = byId('dm-end').value;
        }
        try {
          const result = await Api.post('/data-management/purge', payload, { allowOfflineQueue: false });
          UI.closeModal(modal);
          UI.toast(result.message || 'Data removal completed.', 'success', 9000);
          Router.navigate();
        } catch (e) { UI.toast(e.message || 'Data removal was not completed.', 'error', 9000); }
      });
    } catch (e) {
      previewEl.textContent = e.message || 'Could not calculate the cleanup preview.';
      UI.toast(e.message || 'Could not calculate the cleanup preview.', 'error');
    }
  });
}
