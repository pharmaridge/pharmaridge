async function renderUsers(view) {
  if (!State.isManager()) {
    view.innerHTML = `<div class="card"><p>Only managers can manage users and branches.</p></div>`;
    return;
  }
  const [users, branches] = await Promise.all([Api.get('/users'), Api.get('/branches')]);
  // DEFAULT-CREDENTIAL WARNING. The seed ships demo accounts on PIN 1234;
  // every doc says to change them and nothing enforced it. Rather than
  // block (which would break evaluation installs), make the risk
  // impossible to miss for the people who can actually fix it.
  // Fail quiet: a warning banner must never take down the Users screen.
  let defaultPinAccounts = [];
  try {
    const warn = await Api.get('/users/default-pin-warning');
    defaultPinAccounts = (warn && warn.default_pin_accounts) || [];
  } catch (e) { /* older backend or transient error — show nothing */ }

  // BUG 108 — the manager's half of staged transfers. A request nobody can
  // see is a request nobody chases, and the person quietly never moves.
  // Fail quiet for the same reason as the PIN warning above: a banner must
  // never take down the Users screen.
  let pendingTransfers = [];
  try {
    pendingTransfers = await Api.get('/users/transfers/pending') || [];
  } catch (e) { /* older backend or transient error — show nothing */ }
  // A MANAGER cannot grant the OWNER role (only an existing OWNER or the
  // ADMIN can) — enforced authoritatively server-side; the dropdown
  // simply doesn't offer an option the server would reject anyway.
  const canAssignOwner = State.isOwner() || State.isAdmin();

  // Forcing a transfer through needs ORG-WIDE authority — an Owner, or a
  // General Manager (a MANAGER with no branch pinned). Mirrors the server's
  // FORCE_REQUIRES_ORG_WIDE_AUTHORITY rule so a pinned Branch Manager is
  // never shown a button that is guaranteed to 403.
  const meNow = (State.getSession() || {}).user || {};
  const canForceTransfer = State.isOwner() || State.isAdmin()
    || (meNow.role === 'MANAGER' && !meNow.branch_id);

  // FRONT-TO-BACK ALIGNMENT for the privilege-escalation fix in
  // worker/src/routes/users.js: the server now refuses (403
  // INSUFFICIENT_ROLE_AUTHORITY) any attempt to modify an account whose
  // rank is not strictly below your own, with self-service exempted.
  // Mirror that rule here so a manager is never shown an Edit/Delete
  // button that is guaranteed to fail — the server remains the
  // authority; this only stops the UI from promising something it
  // cannot deliver. Ranks MUST stay in sync with ROLE_RANK there.
  const ROLE_RANK = { ADMIN: 4, OWNER: 3, MANAGER: 2, STAFF: 1 };
  const session = State.getSession();
  const me = (session && session.user) || {};
  const myRank = ROLE_RANK[me.role] || 0;
  function canModify(u) {
    if (u.id === me.id) return true;            // self-service
    return myRank > (ROLE_RANK[u.role] || 0);   // strictly higher rank only
  }

  view.innerHTML = `
    <h2 class="page-title">Users &amp; Branches</h2>
    ${defaultPinAccounts.length ? `
      <div class="card" style="border-left:4px solid var(--red-500);background:var(--tint-red);">
        <h3 style="margin:0 0 6px;color:var(--red-500);">⚠ ${defaultPinAccounts.length} account${defaultPinAccounts.length === 1 ? ' is' : 's are'} still using the default PIN</h3>
        <p style="margin:0 0 8px;font-size:13px;">Anyone who knows this product's demo PIN can sign in as ${defaultPinAccounts.length === 1 ? 'this account' : 'these accounts'} and act with their full authority. Change ${defaultPinAccounts.length === 1 ? 'it' : 'them'} before this pharmacy goes live — use <strong>Edit → Reset PIN</strong> on each row below.</p>
        <p style="margin:0;font-size:13px;">${defaultPinAccounts.map(a => `<strong>${UI.escapeHtml(a.username)}</strong> (${UI.escapeHtml(a.role_label)})`).join(' · ')}</p>
      </div>
    ` : ''}
    ${pendingTransfers.length ? `
      <div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);">
        <h3 style="margin:0 0 6px;">${pendingTransfers.length} transfer${pendingTransfers.length === 1 ? '' : 's'} waiting to be confirmed</h3>
        <p style="margin:0 0 8px;font-size:13px;">Nobody has been moved yet. Each person keeps working where they are — and anything they record offline stays valid — until they confirm. That is deliberate: moving somebody mid-shift is how offline work gets orphaned.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Who</th><th>From</th><th>To</th><th>Asked by</th><th>Reason</th><th></th></tr></thead>
          <tbody>${pendingTransfers.map((t) => `
            <tr>
              <td><strong>${UI.escapeHtml(t.user_name || '')}</strong><div style="font-size:11px;color:var(--gray-600);">${UI.escapeHtml(t.username || '')}</div></td>
              <td>${UI.escapeHtml(t.from_branch_name || '—')}</td>
              <td>${UI.escapeHtml(t.to_branch_name || '—')}</td>
              <td>${UI.escapeHtml(t.requested_by_name || '')}</td>
              <td style="font-size:12px;">${UI.escapeHtml(t.reason || '')}</td>
              <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" data-cancel-transfer="${t.id}">Withdraw</button>
                ${canForceTransfer ? `<button class="btn btn-danger btn-sm" data-force-transfer="${t.id}">Force</button>` : ''}
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
        ${canForceTransfer ? `<p style="margin:8px 0 0;font-size:12px;color:var(--gray-600);"><strong>Force</strong> moves the person without their confirmation — for somebody who has left or cannot be reached. It is recorded as forced.</p>` : ''}
      </div>
    ` : ''}
    <p class="page-subtitle">An <strong>Owner</strong> always sees every branch. A <strong>General Manager</strong> sees and runs every branch. A <strong>Branch Manager</strong> runs exactly one branch and cannot see any other. <strong>Staff</strong> are locked to one branch.</p>

    <div class="tabs">
      <div class="tab active" data-tab="users">Users</div>
      <div class="tab" data-tab="branches">Branches</div>
    </div>

    <div id="users-tab-content"></div>
  `;

  // Withdraw / force handlers for the pending-transfer banner. Bound once,
  // here, against the view root — the banner is rendered by the same
  // innerHTML assignment above, so it exists by the time this runs.
  view.querySelectorAll('[data-cancel-transfer]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.cancelTransfer;
    if (!confirm('Withdraw this transfer request? The person stays where they are.')) return;
    try {
      await Api.post(`/users/transfers/pending/${id}/cancel`, {});
      UI.toast('Transfer request withdrawn.', 'success');
      renderUsers(view);
    } catch (e) { UI.toast(e.message || 'Could not withdraw the request.', 'error'); }
  }));
  view.querySelectorAll('[data-force-transfer]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.forceTransfer;
    if (!confirm('Force this transfer through WITHOUT the person confirming it?\n\nUse this only for somebody who has left or cannot be reached. It is recorded as forced.')) return;
    try {
      await Api.post(`/users/transfers/pending/${id}/force`, {});
      UI.toast('Transfer forced through and recorded as such.', 'success');
      renderUsers(view);
    } catch (e) { UI.toast(e.message || 'Could not force the transfer.', 'error'); }
  }));

  function showUsers() {
    document.getElementById('users-tab-content').innerHTML = `
      <div class="card">
        <h3>Add User</h3>
        <div class="form-inline">
          <div class="form-row"><label>Full Name</label><input id="u-name" /></div>
          <div class="form-row"><label>Username</label><input id="u-username" /></div>
          <div class="form-row"><label>PIN</label><input id="u-pin" type="password" /></div>
          <div class="form-row">
            <label>Role</label>
            <select id="u-role">
              <option value="STAFF">Staff</option>
              <option value="BRANCH_MANAGER">Branch Manager — one branch only</option>
              <option value="GENERAL_MANAGER">General Manager — every branch</option>
              ${canAssignOwner ? '<option value="OWNER">Owner</option>' : ''}
            </select>
          </div>
          <div class="form-row" id="u-branch-row">
            <label>Branch</label>
            <select id="u-branch">
              <option value="">All branches (org-wide)</option>
              ${branches.filter(b => b.is_active).map(b => `<option value="${b.id}">${UI.escapeHtml(b.name)}</option>`).join('')}
            </select>
            <small id="u-branch-hint" class="muted" style="display:block;margin-top:4px;font-size:12px;">Staff accounts are locked to one branch.</small>
          </div>
          <div class="form-row"><label>Job Title</label><input id="u-title" placeholder="Pharmacist-in-Charge, Sales Attendant..." />
            <small class="muted" style="display:block;margin-top:4px;font-size:12px;">Their job on the shop floor. The access level (Branch Manager / General Manager) is set by Role above and shown separately — don't repeat it here, or the two columns can disagree after a promotion.</small></div>
          <button class="btn btn-primary" id="u-add">Add</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branch</th><th>Job Title</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${users.map(u => `
                <tr>
                  <td>${UI.escapeHtml(u.full_name)}</td>
                  <td>${UI.escapeHtml(u.username)}</td>
                  <td>${UI.badge(u.role_label || State.roleLabelOf(u), u.role === 'OWNER' ? 'green' : (u.role === 'MANAGER' && !u.branch_id) ? 'green' : u.role === 'MANAGER' ? 'blue' : 'gray')}</td>
                  <td>${UI.escapeHtml(u.branch_name || (u.role === 'STAFF' ? '—' : 'All branches'))}</td>
                  <td>${UI.escapeHtml(u.job_title || '—')}</td>
                  <td>${u.is_active ? UI.badge('Active', 'green') : UI.badge('Inactive', 'red')}${u.is_login_locked ? ' ' + UI.badge('Locked', 'amber') : ''}</td>
                  <td>
                    ${canModify(u)
                      ? `${u.is_login_locked ? `<button class="btn btn-primary btn-sm" data-unlock-user="${u.id}" data-name="${UI.escapeHtml(u.full_name)}" title="Locked after too many failed sign-in attempts. Unlock now instead of waiting for the lock to expire.">Unlock</button> ` : ''}<button class="btn btn-secondary btn-sm" data-edit-user="${u.id}" data-name="${UI.escapeHtml(u.full_name)}">Edit</button>
                         <button class="btn btn-danger btn-sm" data-delete-user="${u.id}" data-name="${UI.escapeHtml(u.full_name)}">Delete</button>`
                      : `<span class="muted" style="font-size:12px;" title="Only a higher-ranked account (or PharmaRidge support) can change this user.">No access</span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${Exporter.toolbar('users', { label: 'the staff register' })}
      </div>
    `;
    Exporter.wireTableReport('users', {
      title: 'Staff Register', subtitle: 'User accounts and access', filename: 'staff-register',
      columns: [
        { key: 'full_name', label: 'Name' },
        { key: 'username', label: 'Username' },
        { key: 'role_label', label: 'Role' },
        { key: 'branch_name', label: 'Branch', format: (v) => v || 'All branches' },
        { key: 'job_title', label: 'Job Title' },
        { key: 'phone', label: 'Phone' },
        { key: 'is_active', label: 'Status', format: (v) => (v ? 'Active' : 'Inactive') },
      ],
      rows: users,
      summary: [
        { label: 'Accounts', value: String(users.length) },
        { label: 'Active', value: String(users.filter((u) => u.is_active).length) },
      ],
      note: 'PINs are never exported. This register lists access only.',
      emptyMessage: 'No user accounts.',
    });
    // Apply the branch-row rules immediately on first render too, not just
    // on change — the default role is STAFF, for which the blank
    // "All branches" option must NOT be selectable.
    // The Branch field is only meaningful for roles that live at ONE
    // branch. Selecting "General Manager" hides it entirely, which also
    // closes a real usability trap in the previous design: the branch
    // dropdown defaulted to the blank "All branches" option, so choosing
    // MANAGER and pressing Add immediately created a full org-wide
    // manager by accident — the most privileged non-owner account in the
    // system, created by doing nothing.
    function applyBranchRowRules(r) {
      const needsBranch = (r === 'STAFF' || r === 'BRANCH_MANAGER');
      document.getElementById('u-branch-row').style.display = needsBranch ? '' : 'none';
      const hint = document.getElementById('u-branch-hint');
      if (hint) {
        hint.textContent = r === 'BRANCH_MANAGER'
          ? 'This manager will run only the branch you choose, and cannot see any other branch.'
          : 'Staff accounts are locked to one branch.';
      }
      const sel = document.getElementById('u-branch');
      if (needsBranch && sel && !sel.value) {
        const first = sel.querySelector('option[value]:not([value=""])');
        if (first) sel.value = first.value;
      }
    }
    applyBranchRowRules(document.getElementById('u-role').value);
    document.getElementById('u-role').addEventListener('change', (e) => {
      // BRANCH-SCOPED MANAGERS (migration 0003): STAFF must have a branch;
      // a MANAGER may optionally have one (blank = org-wide). OWNER is
      // always org-wide, so the row stays hidden for that role.
      applyBranchRowRules(e.target.value);
    });
    UI.guardedClick(document.getElementById('u-add'), async () => {
      const full_name = document.getElementById('u-name').value.trim();
      const username = document.getElementById('u-username').value.trim();
      const pin = document.getElementById('u-pin').value;
      // The UI offers Branch Manager / General Manager as separate
      // choices for clarity; both are role MANAGER on the wire, and the
      // presence of branch_id is what actually distinguishes them (see
      // roleLabel in worker/src/lib/auth.js for why that is the single
      // source of truth).
      const uiRole = document.getElementById('u-role').value;
      const role = (uiRole === 'BRANCH_MANAGER' || uiRole === 'GENERAL_MANAGER') ? 'MANAGER' : uiRole;
      if (!full_name || !username || !pin) { UI.toast('Fill all required fields', 'error'); return; }
      try {
        await Api.post('/users', {
          full_name, username, pin, role,
          branch_id: (uiRole === 'STAFF' || uiRole === 'BRANCH_MANAGER')
            ? (document.getElementById('u-branch').value || undefined)
            : undefined,
          job_title: document.getElementById('u-title').value,
        }, { allowOfflineQueue: false });
        UI.toast('User created', 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    // FUNCTIONAL GAP CLOSED (found during a production audit): the
    // backend has always fully supported editing a user's name/phone/
    // job title, activating/deactivating an account, resetting a PIN,
    // and soft-deleting a user (with a server-enforced guard against
    // ever removing the last active manager/owner) — this is even
    // covered by dedicated regression tests ("Deactivating a user
    // immediately invalidates their already-issued token", "Cannot
    // deactivate the last remaining active manager/owner"). But this
    // screen previously had NO way to reach any of it: only "Add User"
    // existed, so a manager who needed to deactivate a departing staff
    // member, reset a forgotten PIN, correct a typo'd name, or remove a
    // mistakenly-created account had no UI path to do so at all,
    // despite the API fully supporting every one of those actions.
    view.querySelectorAll('[data-edit-user]').forEach((btn) => btn.addEventListener('click', () => {
      const u = users.find((x) => x.id === btn.dataset.editUser);
      openEditUserModal(u);
    }));
    // A locked-out account cannot sign in at all, so the affected person
    // cannot clear it themselves — a higher-ranked account does it here.
    // Same authority as a PIN reset (see users.js's unlock route).
    view.querySelectorAll('[data-unlock-user]').forEach((btn) => UI.guardedClick(btn, async () => {
      try {
        await Api.post(`/users/${btn.dataset.unlockUser}/unlock`, {}, { allowOfflineQueue: false });
        UI.toast(`${btn.dataset.name} can sign in again`, 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    }));

    view.querySelectorAll('[data-delete-user]').forEach((btn) => UI.guardedClick(btn, async () => {
      if (!confirm(`Permanently remove ${btn.dataset.name}? This cannot be undone (their sales/attendance history is preserved, but they will no longer be able to log in or appear in this list).`)) return;
      try {
        await Api.del(`/users/${btn.dataset.deleteUser}`);
        UI.toast('User removed', 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    }));
  }

  function openEditUserModal(u) {
    const modal = UI.openModal(`
      <h3>Edit User — ${UI.escapeHtml(u.full_name)}</h3>
      <div class="form-row"><label>Full Name</label><input id="eu-name" value="${UI.escapeHtml(u.full_name)}" /></div>
      <div class="form-row"><label>Phone</label><input id="eu-phone" value="${UI.escapeHtml(u.phone || '')}" /></div>
      <div class="form-row"><label>Job Title</label><input id="eu-title" value="${UI.escapeHtml(u.job_title || '')}" /></div>
      <div class="form-row">
        <label>Status</label>
        <select id="eu-active">
          <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.is_active ? 'selected' : ''}>Inactive (blocks login immediately, even for an already-open session)</option>
        </select>
      </div>
      <div class="form-row"><label>Reset PIN (leave blank to keep current)</label><input type="password" id="eu-pin" placeholder="At least 4 digits" /></div>
      <!-- BUG 75 (frontend half). This card used to tell the operator that a
           branch or role change was impossible and that they should deactivate
           and recreate the account — advice that cannot be followed (the
           username stays reserved) and that split one human into two payroll
           identities. Transfer & Promote is now a real action, so the card
           points at it instead of apologising for its absence. -->
      <div class="card" style="margin:12px 0 0;border-left:4px solid var(--blue-600);background:var(--blue-100);">
        <b>Moving ${UI.escapeHtml(u.full_name)} to another branch, or changing their role?</b>
        <p class="page-subtitle" style="margin:6px 0 8px;">
          Use <b>Transfer &amp; Promote</b> — they keep this same account and username, so their
          record stays in one place. Everything they have already done stays with the branch and
          the role it was done under, and the change is recorded with your reason.
        </p>
        <button class="btn btn-secondary btn-sm" id="eu-transfer">Transfer &amp; Promote…</button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="eu-cancel">Cancel</button>
        <button class="btn btn-primary" id="eu-save">Save</button>
      </div>
    `);
    modal.querySelector('#eu-cancel').addEventListener('click', () => UI.closeModal(modal));
    modal.querySelector('#eu-transfer').addEventListener('click', () => {
      UI.closeModal(modal);
      openTransferModal(u);
    });
    UI.guardedClick(modal.querySelector('#eu-save'), async () => {
      const pin = modal.querySelector('#eu-pin').value;
      if (pin && pin.length < 4) { UI.toast('PIN must be at least 4 characters', 'error'); return; }
      const payload = {
        full_name: modal.querySelector('#eu-name').value.trim(),
        phone: modal.querySelector('#eu-phone').value.trim() || null,
        job_title: modal.querySelector('#eu-title').value.trim() || null,
        is_active: modal.querySelector('#eu-active').value === '1',
      };
      if (pin) payload.pin = pin;
      try {
        await Api.put(`/users/${u.id}`, payload, { allowOfflineQueue: false });
        UI.toast('User updated', 'success');
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }


  // TRANSFER & PROMOTE  (BUG 75, frontend half).
  //
  // One human, one account. The four UI roles map onto the two things the
  // server actually stores — role and branch_id — exactly as roleLabel() in
  // worker/src/lib/auth.js derives them, so the wording here can never drift
  // from the wording the API returns:
  //     Staff            -> role STAFF,   branch REQUIRED
  //     Branch Manager   -> role MANAGER, branch REQUIRED
  //     General Manager  -> role MANAGER, branch NULL
  //     Owner            -> role OWNER,   branch NULL
  async function openTransferModal(u) {
    const currentUiRole = u.role === 'MANAGER'
      ? (u.branch_id ? 'BRANCH_MANAGER' : 'GENERAL_MANAGER')
      : u.role;
    const me = State.getSession().user;
    // A manager may never hand out OWNER — mirrors canAssignRole() on the
    // server. Offering it and then failing with a 403 would be a worse
    // experience than not offering it, and the server still enforces it.
    const canGrantOwner = me.role === 'OWNER' || me.role === 'ADMIN';
    const activeBranches = (branches || []).filter((b) => b.is_active);

    const modal = UI.openModal(`
      <h3>Transfer &amp; Promote — ${UI.escapeHtml(u.full_name)}</h3>
      <p class="page-subtitle" style="margin:0 0 12px;">
        Currently <b>${UI.escapeHtml(u.role_label || State.roleLabelOf(u))}</b>${u.branch_name ? ' at ' + UI.escapeHtml(u.branch_name) : ''}.
        They keep the username <b>${UI.escapeHtml(u.username)}</b>.
      </p>
      <div class="form-row">
        <label for="tr-role">New role</label>
        <select id="tr-role">
          <option value="STAFF" ${currentUiRole === 'STAFF' ? 'selected' : ''}>Staff — one branch</option>
          <option value="BRANCH_MANAGER" ${currentUiRole === 'BRANCH_MANAGER' ? 'selected' : ''}>Branch Manager — runs one branch</option>
          <option value="GENERAL_MANAGER" ${currentUiRole === 'GENERAL_MANAGER' ? 'selected' : ''}>General Manager — all branches</option>
          ${canGrantOwner ? `<option value="OWNER" ${currentUiRole === 'OWNER' ? 'selected' : ''}>Owner — full control</option>` : ''}
        </select>
      </div>
      <div class="form-row" id="tr-branch-row">
        <label for="tr-branch">Branch</label>
        <select id="tr-branch">
          ${activeBranches.map((b) => `<option value="${b.id}" ${b.id === u.branch_id ? 'selected' : ''}>${UI.escapeHtml(b.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label for="tr-reason">Reason for this change</label>
        <input id="tr-reason" placeholder="e.g. Promoted to run the Ikeja branch" />
      </div>
      <div class="card" style="margin:12px 0 0;border-left:4px solid var(--gray-400);">
        <p class="page-subtitle" style="margin:0;">
          Everything they have already recorded stays exactly where it is — past sales, tills and
          shifts keep the branch and the authority they were made under. If a shift is running it is
          closed at their current branch first. An open till must be settled before they can move.
        </p>
      </div>
      <!-- Every previous move, so the person approving this one can see the
           pattern (a cashier moved four times in a year is a conversation).
           Loaded after the modal opens so a slow request never delays it. -->
      <div id="tr-history" style="margin-top:12px;"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="tr-cancel">Cancel</button>
        <button class="btn btn-primary" id="tr-save">Transfer</button>
      </div>
    `);

    // The Branch field is only meaningful for the two branch-scoped roles.
    // Hiding it for the org-wide ones is what makes "General Manager" and
    // "Owner" mean branch_id = null without the operator having to know that.
    function applyRoleRules() {
      const uiRole = modal.querySelector('#tr-role').value;
      const needsBranch = uiRole === 'STAFF' || uiRole === 'BRANCH_MANAGER';
      modal.querySelector('#tr-branch-row').style.display = needsBranch ? '' : 'none';
    }
    applyRoleRules();
    modal.querySelector('#tr-role').addEventListener('change', applyRoleRules);
    modal.querySelector('#tr-cancel').addEventListener('click', () => UI.closeModal(modal));

    // Past moves. Fail quiet: this is context, and a failure to load it must
    // never stop someone performing a legitimate transfer.
    (async () => {
      try {
        const hist = await Api.get(`/users/${u.id}/assignment-history`);
        const el = modal.querySelector('#tr-history');
        if (!el || !hist || !hist.length) return;
        el.innerHTML = `
          <label style="display:block;margin-bottom:6px;">Previous changes</label>
          <div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Change</th><th>By</th><th>Reason</th></tr></thead>
            <tbody>${hist.map((h) => `
              <tr>
                <td>${UI.shortDate(h.changed_at)}</td>
                <td>${UI.escapeHtml(h.from_role_label || h.from_role)}${h.from_branch_name ? ' · ' + UI.escapeHtml(h.from_branch_name) : ''}
                    → ${UI.escapeHtml(h.to_role_label || h.to_role)}${h.to_branch_name ? ' · ' + UI.escapeHtml(h.to_branch_name) : ''}</td>
                <td>${UI.escapeHtml(h.changed_by_name || '—')}</td>
                <td>${UI.escapeHtml(h.reason || '')}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`;
      } catch (e) { /* context only — never block the transfer */ }
    })();

    UI.guardedClick(modal.querySelector('#tr-save'), async () => {
      const uiRole = modal.querySelector('#tr-role').value;
      const reason = modal.querySelector('#tr-reason').value.trim();
      if (reason.length < 4) { UI.toast('Give a reason for this transfer', 'error'); return; }
      const needsBranch = uiRole === 'STAFF' || uiRole === 'BRANCH_MANAGER';
      const role = (uiRole === 'BRANCH_MANAGER' || uiRole === 'GENERAL_MANAGER') ? 'MANAGER' : uiRole;
      // branch_id is sent EXPLICITLY as null for the org-wide roles, never
      // omitted: the API treats an absent field as "unchanged", so omitting it
      // would silently leave a promoted Branch Manager still pinned.
      const payload = { role, branch_id: needsBranch ? modal.querySelector('#tr-branch').value : null, reason };
      try {
        const res = await Api.post(`/users/${u.id}/transfer`, payload, { allowOfflineQueue: false });
        const label = (res && res.role_label) || '';
        UI.toast(`${u.full_name} is now ${label}${res && res.transfer && res.transfer.shift_auto_closed ? ' — their open shift was closed at the old branch' : ''}`, 'success');
        // BUG 88: an orphaned stocktake at the old branch BLOCKS that branch
        // from counting again, and the person who left it can no longer see it.
        // Shown as a separate, longer warning so it is not lost behind the
        // success toast.
        if (res && res.work_left_behind) {
          UI.toast(res.work_left_behind.message, 'warn', 14000);
        }
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  // RELOCATE A CLOSED BRANCH  (client decision, frontend half).
  //
  // The whole point is the CHOICE, so the modal presents it as the primary
  // decision rather than burying it in a dropdown: does the new shop continue
  // the old one's trading history, or start clean? Getting this wrong distorts
  // every year-on-year comparison in either direction, so there is no default
  // and the consequences of each option are spelled out on screen.
  function openRelocateBranchModal(branchId, branchName) {
    const modal = UI.openModal(`
      <h3>Relocate ${UI.escapeHtml(branchName)}</h3>
      <p class="page-subtitle">This branch is closed. Reopening it at a new address is one of two very different things — choose the one that matches what actually happened.</p>
      <div class="form-row">
        <label for="rl-mode">What happened to this shop?</label>
        <select id="rl-mode">
          <option value="">— choose —</option>
          <option value="CARRY_OVER">It MOVED — keep all its sales, shifts and ledger history</option>
          <option value="FRESH_START">It closed for good — open a separate new shop starting from zero</option>
        </select>
      </div>
      <div id="rl-explain" class="card" style="margin:10px 0;border-left:4px solid var(--gray-400);">
        <p class="page-subtitle" style="margin:0;">Pick an option above to see exactly what it will do.</p>
      </div>
      <div class="form-row"><label for="rl-name">Branch name</label><input id="rl-name" value="${UI.escapeHtml(branchName)}" /></div>
      <div class="form-row"><label for="rl-address">New address</label><input id="rl-address" placeholder="e.g. 9 Allen Avenue, Ikeja" /></div>
      <div class="form-row"><label for="rl-phone">Phone</label><input id="rl-phone" /></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="rl-cancel">Cancel</button>
        <button class="btn btn-primary" id="rl-save">Relocate</button>
      </div>
    `);
    const explain = modal.querySelector('#rl-explain');
    modal.querySelector('#rl-mode').addEventListener('change', (e) => {
      if (e.target.value === 'CARRY_OVER') {
        explain.innerHTML = `<p class="page-subtitle" style="margin:0;"><b>Same branch, new address.</b> Every sale, shift, till session and ledger entry stays attached, so last year's figures and this year's read as one continuous history. Use this when the business simply moved.</p>`;
      } else if (e.target.value === 'FRESH_START') {
        explain.innerHTML = `<p class="page-subtitle" style="margin:0;"><b>A separate new branch.</b> ${UI.escapeHtml(branchName)} stays closed and keeps its own history, readable in every report. The new shop's reports begin at zero. Use this when the old shop was wound up.</p>`;
      } else {
        explain.innerHTML = `<p class="page-subtitle" style="margin:0;">Pick an option above to see exactly what it will do.</p>`;
      }
    });
    modal.querySelector('#rl-cancel').addEventListener('click', () => UI.closeModal(modal));
    UI.guardedClick(modal.querySelector('#rl-save'), async () => {
      const mode = modal.querySelector('#rl-mode').value;
      if (!mode) { UI.toast('Choose whether this shop moved or closed for good', 'error'); return; }
      const address = modal.querySelector('#rl-address').value.trim();
      if (!address) { UI.toast('A new address is required', 'error'); return; }
      const name = modal.querySelector('#rl-name').value.trim();
      if (mode === 'FRESH_START' && !name) { UI.toast('A name is required for the new branch', 'error'); return; }
      try {
        const res = await Api.post(`/branches/${branchId}/relocate`, {
          mode, name, address, phone: modal.querySelector('#rl-phone').value.trim() || null,
        }, { allowOfflineQueue: false });
        UI.toast((res && res.relocation && res.relocation.message) || 'Branch relocated', 'success', 12000);
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error', 9000); }
    });
  }

  function showBranches() {
    document.getElementById('users-tab-content').innerHTML = `
      <div class="card">
        <h3>Add Branch</h3>
        <div class="form-inline">
          <div class="form-row"><label>Name</label><input id="b-name" /></div>
          <div class="form-row"><label>Address</label><input id="b-address" /></div>
          <div class="form-row"><label>Phone</label><input id="b-phone" /></div>
          <div class="form-row">
            <label>License Type</label>
            <select id="b-license"><option value="PHARMACY">PHARMACY</option><option value="PPMV">PPMV</option></select>
          </div>
          <div class="form-row"><label>PCN/PPMV License No.</label><input id="b-pcn" /></div>
          <div class="form-row"><label>Superintendent Pharmacist</label><input id="b-super" /></div>
        </div>
        <div class="form-inline" style="margin-top:8px;">
          <div class="form-row"><label>PCN Licence Expiry Date</label><input type="date" id="b-pcn-expiry" /></div>
          <div class="form-row"><label>Superintendent Registration Expiry</label><input type="date" id="b-super-expiry" /></div>
        </div>
        <button class="btn btn-primary" id="b-add" style="margin-top:10px;">Add Branch</button>
      </div>
      <div class="card">
        <h3>Branches</h3>
        <p class="page-subtitle">Set each branch's attendance verification method: Geolocation (GPS geofence — best for mobile/handheld staff) or Registered Device (trusted laptop list — best for fixed till/back-office machines where GPS is unreliable or absent). Manage registered devices from the Staff Attendance tab. Deactivating a branch (e.g. it has permanently closed) immediately blocks any NEW sale, purchase order, stock transfer, adjustment, stocktake, till session, expense, or attendance clock-in there — its historical data stays fully visible in every report forever.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Address</th><th>License</th><th>PCN/PPMV No.</th><th>Superintendent</th><th>Licence Expiry</th><th>Attendance Mode</th><th>Geofence</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${branches.map(b => `
                <tr>
                  <td>${UI.escapeHtml(b.name)}</td>
                  <td>${UI.escapeHtml(b.address || '—')}</td>
                  <td>${b.license_type}</td>
                  <td>${UI.escapeHtml(b.pcn_license_no || '—')}</td>
                  <td>${UI.escapeHtml(b.superintendent_pharmacist || '—')}</td>
                  <td>${licenseExpiryCell(b)}</td>
                  <td>${UI.badge(b.attendance_mode === 'REGISTERED_DEVICE' ? 'Registered Device' : 'Geolocation', b.attendance_mode === 'REGISTERED_DEVICE' ? 'green' : 'gray')}</td>
                  <td>${b.latitude != null ? `${UI.badge('Set', 'green')} <span style="font-size:11px;color:var(--gray-600);">±${b.geofence_radius_meters}m</span>` : UI.badge('Not set', 'gray')}</td>
                  <td>${b.is_active ? UI.badge('Active', 'green') : UI.badge('Deactivated', 'red')}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" data-edit-branch="${b.id}">Edit</button>
                    <button class="btn ${b.is_active ? 'btn-danger' : 'btn-secondary'} btn-sm" data-toggle-branch-active="${b.id}" data-currently-active="${b.is_active ? '1' : '0'}">${b.is_active ? 'Deactivate' : 'Reactivate'}</button>
                    ${!b.is_active ? `<button class="btn btn-secondary btn-sm" data-relocate-branch="${b.id}" data-branch-name="${UI.escapeHtml(b.name)}">Relocate…</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    UI.guardedClick(document.getElementById('b-add'), async () => {
      const name = document.getElementById('b-name').value.trim();
      if (!name) { UI.toast('Name required', 'error'); return; }
      try {
        await Api.post('/branches', {
          name,
          address: document.getElementById('b-address').value,
          phone: document.getElementById('b-phone').value,
          license_type: document.getElementById('b-license').value,
          pcn_license_no: document.getElementById('b-pcn').value,
          superintendent_pharmacist: document.getElementById('b-super').value,
          pcn_license_expiry_date: document.getElementById('b-pcn-expiry').value || undefined,
          superintendent_registration_expiry_date: document.getElementById('b-super-expiry').value || undefined,
        }, { allowOfflineQueue: false });
        UI.toast('Branch added', 'success');
        window.App.refreshBranchSwitcher();
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    // FUNCTIONAL/COMPLIANCE GAP CLOSED (found during a production
    // audit): branches.is_active has existed in the schema since day
    // one and was already enforced server-side on every branch-scoped
    // creation route (sales, purchase orders, transfers, adjustments,
    // stocktakes, till opens, expenses, attendance clock-ins) — but
    // there was NO way anywhere in the frontend to actually set it. A
    // manager permanently closing a branch had no UI path to reflect
    // that at all. This toggle button is the only frontend entry point
    // to PUT /api/branches/:id's is_active field.
    document.querySelectorAll('[data-toggle-branch-active]').forEach((btn) => UI.guardedClick(btn, async () => {
      const branchId = btn.dataset.toggleBranchActive;
      const currentlyActive = btn.dataset.currentlyActive === '1';
      const branch = branches.find((b) => b.id === branchId);
      const confirmMsg = currentlyActive
        ? `Deactivate ${branch ? branch.name : 'this branch'}? This immediately blocks any NEW sale, purchase order, stock transfer, adjustment, stocktake, till session, expense, or attendance clock-in there. Historical data stays fully visible. You can reactivate it at any time.`
        : `Reactivate ${branch ? branch.name : 'this branch'}? Staff will immediately be able to record new activity there again.`;
      if (!confirm(confirmMsg)) return;
      try {
        const res = await Api.put(`/branches/${branchId}`, { is_active: !currentlyActive }, { allowOfflineQueue: false });
        // BUG 86: the server reports anything left unfinished at a branch that
        // has just been closed. A bland "Branch deactivated" would hide an
        // uncounted till drawer, so show the warning prominently and for long
        // enough to read.
        if (res && res.closure_warning) {
          UI.toast(res.closure_warning.message, 'warn', 14000);
        } else {
          UI.toast(currentlyActive ? 'Branch deactivated' : 'Branch reactivated', 'success');
        }
        window.App.refreshBranchSwitcher();
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    }));

    // RELOCATION (client decision). A closed branch can reopen at a new
    // address either CONTINUING its history or starting clean — the two are
    // not interchangeable, so the choice is explicit and has no default.
    document.querySelectorAll('[data-relocate-branch]').forEach((btn) => btn.addEventListener('click', () => {
      openRelocateBranchModal(btn.dataset.relocateBranch, btn.dataset.branchName);
    }));

    document.querySelectorAll('[data-edit-branch]').forEach((btn) => btn.addEventListener('click', () => {
      const branch = branches.find(b => b.id === btn.dataset.editBranch);
      openBranchGeofenceModal(branch);
    }));
  }

  function licenseExpiryCell(b) {
    const dates = [b.pcn_license_expiry_date, b.superintendent_registration_expiry_date].filter(Boolean);
    if (!dates.length) return '—';
    const soonest = dates.sort()[0];
    const daysLeft = Math.floor((new Date(soonest) - new Date()) / 86400000);
    if (daysLeft < 0) return UI.badge('EXPIRED', 'red');
    if (daysLeft <= 90) return UI.badge(`${daysLeft}d left`, 'amber');
    return soonest;
  }

  function openBranchGeofenceModal(branch) {
    const modal = UI.openModal(`
      <h3>Edit Branch — ${UI.escapeHtml(branch.name)}</h3>
      <div class="form-row"><label>PCN Licence Expiry Date</label><input type="date" id="edit-pcn-expiry" value="${branch.pcn_license_expiry_date || ''}" /></div>
      <div class="form-row"><label>Superintendent Registration Expiry</label><input type="date" id="edit-super-expiry" value="${branch.superintendent_registration_expiry_date || ''}" /></div>
      <h4 style="margin:14px 0 6px;font-size:13px;">Attendance Verification Method</h4>
      <div class="form-row">
        <label>Mode</label>
        <select id="edit-attendance-mode">
          <option value="GEOLOCATION" ${branch.attendance_mode !== 'REGISTERED_DEVICE' ? 'selected' : ''}>Geolocation (GPS geofence — mobile/handheld staff)</option>
          <option value="REGISTERED_DEVICE" ${branch.attendance_mode === 'REGISTERED_DEVICE' ? 'selected' : ''}>Registered Device (trusted laptops — fixed till/back-office machines)</option>
        </select>
      </div>
      <div id="geofence-fields">
        <h4 style="margin:14px 0 6px;font-size:13px;">Geofence (used only in Geolocation mode)</h4>
        <div class="form-inline">
          <div class="form-row"><label>Latitude</label><input type="number" step="any" id="edit-lat" value="${branch.latitude == null ? '' : branch.latitude}" /></div>
          <div class="form-row"><label>Longitude</label><input type="number" step="any" id="edit-lng" value="${branch.longitude == null ? '' : branch.longitude}" /></div>
          <div class="form-row"><label>Radius (meters)</label><input type="number" id="edit-radius" value="${branch.geofence_radius_meters}" /></div>
        </div>
        <button class="btn btn-secondary btn-sm" id="use-my-location" style="margin-top:6px;">Use my current location</button>
        <div id="geofence-msg" style="font-size:11px;color:var(--gray-600);margin-top:6px;"></div>
      </div>
      <p style="font-size:11px;color:var(--gray-600);margin-top:10px;">Registered devices for "Registered Device" mode are managed from the Staff Attendance tab, not here.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="edit-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-save">Save</button>
      </div>
    `);
    modal.querySelector('#edit-cancel').addEventListener('click', () => UI.closeModal(modal));
    modal.querySelector('#use-my-location').addEventListener('click', () => {
      const msgEl = modal.querySelector('#geofence-msg');
      if (!('geolocation' in navigator)) { msgEl.textContent = 'Geolocation is not supported on this device/browser.'; return; }
      msgEl.textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          modal.querySelector('#edit-lat').value = pos.coords.latitude;
          modal.querySelector('#edit-lng').value = pos.coords.longitude;
          msgEl.textContent = `Captured (±${Math.round(pos.coords.accuracy)}m accuracy). Stand at the branch entrance before clicking this for best results.`;
        },
        () => { msgEl.textContent = 'Could not get your location — check browser permissions.'; },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
    UI.guardedClick(modal.querySelector('#edit-save'), async () => {
      const lat = modal.querySelector('#edit-lat').value;
      const lng = modal.querySelector('#edit-lng').value;
      try {
        await Api.put(`/branches/${branch.id}`, {
          pcn_license_expiry_date: modal.querySelector('#edit-pcn-expiry').value || null,
          superintendent_registration_expiry_date: modal.querySelector('#edit-super-expiry').value || null,
          attendance_mode: modal.querySelector('#edit-attendance-mode').value,
          latitude: lat !== '' ? Number(lat) : null,
          longitude: lng !== '' ? Number(lng) : null,
          geofence_radius_meters: Number(modal.querySelector('#edit-radius').value) || 100,
        });
        UI.toast('Branch updated', 'success');
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  view.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    t.dataset.tab === 'users' ? showUsers() : showBranches();
  }));

  showUsers();
}
