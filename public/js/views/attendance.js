async function renderAttendance(view) {
  const isManager = State.isManager();
  // BUG 74 — needed to hide "End shift" on your own row: the server refuses a
  // self force-clock-out (SELF_FORCE_CLOCKOUT_FORBIDDEN), so showing it there
  // would be a control that can only ever fail.
  const myUserId = (State.getSession().user || {}).id;
  const session = State.getSession();
  const branchId = isManager ? State.getViewBranch() : session.user.branch_id;

  // Always fetch the branch list (small) so we can look up the current
  // branch's attendance_mode regardless of role — a STAFF account needs
  // to know their OWN branch's mode to decide whether to request
  // geolocation or the device id when clocking in.
  const [current, branches] = await Promise.all([
    Api.get('/attendance/me/current'),
    Api.get('/branches'),
  ]);

  const myBranch = branches.find((b) => b.id === (isManager ? branchId : session.user.branch_id));
  const attendanceMode = (myBranch && myBranch.attendance_mode) || 'GEOLOCATION';


  view.innerHTML = `
    <h2 class="page-title">Staff Attendance</h2>
    <p class="page-subtitle">
      ${attendanceMode === 'REGISTERED_DEVICE'
        ? 'This branch verifies attendance by registered device. Clocking in from a laptop the manager has not registered is recorded and flagged for review — it is never silently blocked.'
        : 'Clock in/out with GPS location capture. An off-site or missing-location clock-in is recorded and flagged for manager review — it is never silently blocked, since GPS accuracy and device permissions vary.'}
    </p>

    <div class="card">
      <h3>My Shift</h3>
      ${current ? `
        <p>Clocked in at <b>${UI.shortDate(current.clock_in_at)}</b> — ${statusBadgeFor(current.clock_in_status)}
          ${current.clock_in_distance_meters != null ? `<span style="font-size:12px;color:var(--gray-600);"> (${Math.round(current.clock_in_distance_meters)}m from branch)</span>` : ''}
        </p>
        <button class="btn btn-danger" id="clock-out-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>Clock Out</button>
      ` : `
        <p>You are not currently clocked in.</p>
        <button class="btn btn-primary" id="clock-in-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>Clock In</button>
      `}
      <div id="attendance-status-msg" style="margin-top:10px;font-size:12px;color:var(--gray-600);"></div>
    </div>

    <div class="card">
      <h3>${isManager ? 'Attendance Records' : 'My Branch — Recent Attendance'}</h3>
      <div class="tabs">
        <div class="tab active" data-attendance-tab="all">All</div>
        <div class="tab" data-attendance-tab="flagged">⚠ Pending Review</div>
      </div>
      <div id="attendance-table"></div>
    </div>

    ${isManager ? `<div id="device-registry-card"></div>` : ''}
  `;

  async function loadTable(flaggedOnly) {
    const q = branchId ? `?branch_id=${branchId}${flaggedOnly ? '&flagged_only=true' : ''}` : (flaggedOnly ? '?flagged_only=true' : '');
    const rows = await Api.get(`/attendance${q}`);
    const tableEl = document.getElementById('attendance-table');
    tableEl.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>${isManager && !branchId ? '<th>Branch</th>' : ''}<th>Staff</th><th>Clock In</th><th>In Status</th><th>Clock Out</th><th>Out Status</th><th>Hours</th><th>Reviewed</th>${isManager ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${rows.map(a => `
              <tr>
                ${isManager && !branchId ? `<td>${UI.escapeHtml(a.branch_name)}</td>` : ''}
                <td>${UI.escapeHtml(a.user_full_name)}</td>
                <td>${UI.shortDate(a.clock_in_at)}</td>
                <td>${statusBadgeFor(a.clock_in_status)}</td>
                <td>${a.clock_out_at
                  ? UI.shortDate(a.clock_out_at) + (a.force_closed_by ? ' <span class="badge badge-amber" title="' + UI.escapeHtml(a.force_closed_reason || '') + '">ended by manager</span>' : '')
                  : '<span style="color:var(--amber-500);">Still clocked in</span>'}</td>
                <td>${statusBadgeFor(a.clock_out_status)}</td>
                <td>${formatWorked(a.worked_minutes)}</td>
                <td>${a.manager_override_by ? `\u2713 by ${UI.escapeHtml(a.override_by_name)}` : (FLAGGED_CLOCK_IN.includes(a.clock_in_status) || FLAGGED_CLOCK_IN.includes(a.clock_out_status) ? '\u2022 Pending' : '—')}</td>
                ${isManager ? `<td>${[
                  // BUG 74 — a shift someone never ended needs a way to be
                  // ended. Shown only for OTHER people's open shifts: the
                  // server refuses self force-clock-out, so offering it on
                  // your own row would be a button that always fails.
                  (!a.clock_out_at && a.user_id !== myUserId) ? `<button class="btn btn-secondary btn-sm" data-force-out="${a.id}" data-name="${UI.escapeHtml(a.user_full_name)}">End shift</button>` : '',
                  (!a.manager_override_by && (FLAGGED_CLOCK_IN.includes(a.clock_in_status) || FLAGGED_CLOCK_IN.includes(a.clock_out_status))) ? `<button class="btn btn-secondary btn-sm" data-override="${a.id}">Review</button>` : '',
                ].filter(Boolean).join(' ')}</td>` : ''}
              </tr>
            `).join('') || `<tr><td colspan="9" class="empty-state">No attendance records</td></tr>`}
          </tbody>
        </table>
      </div>
      ${Exporter.toolbar('attendance', { label: 'this attendance sheet' })}
    `;
    Exporter.wireTableReport('attendance', {
      title: 'Staff Attendance Sheet',
      subtitle: (branchId ? 'Selected branch' : 'All branches') + (flaggedOnly ? ' · pending review only' : ''),
      filename: 'attendance-sheet',
      columns: [
        ...(isManager && !branchId ? [{ key: 'branch_name', label: 'Branch' }] : []),
        { key: 'user_full_name', label: 'Staff' },
        { key: 'clock_in_at', label: 'Clock In', format: (v) => UI.shortDate(v) },
        { key: 'clock_in_status', label: 'In Status' },
        { key: 'clock_out_at', label: 'Clock Out', format: (v) => (v ? UI.shortDate(v) : 'Still clocked in') },
        { key: 'clock_out_status', label: 'Out Status' },
        // BUG 78 — the payroll sheet used to hand the owner two raw timestamps
        // and leave them to subtract. Both a human-readable span and the raw
        // minutes go out, because a spreadsheet needs a number it can total.
        { key: 'worked_minutes', label: 'Hours Worked', format: (v) => formatWorked(v) },
        { key: 'worked_minutes', label: 'Minutes', format: (v) => (v == null ? '' : String(v)) },
        { key: 'override_by_name', label: 'Reviewed By' },
        { key: 'force_closed_by_name', label: 'Shift Ended By Manager' },
      ],
      rows,
      summary: [
        { label: 'Records', value: String(rows.length) },
        { label: 'Total hours (closed shifts)', value: formatWorked(rows.reduce((t, a) => t + (a.worked_minutes || 0), 0)) },
        { label: 'Still open (no hours yet)', value: String(rows.filter((a) => a.worked_minutes == null).length) },
        { label: 'Flagged / unreviewed', value: String(rows.filter((a) => !a.manager_override_by && (FLAGGED_CLOCK_IN.includes(a.clock_in_status) || FLAGGED_CLOCK_IN.includes(a.clock_out_status))).length) },
      ],
      note: 'Attendance is verified by GPS geofence or registered device. Flagged rows require manager review before payroll.',
      emptyMessage: 'No attendance records for this selection.',
    });
    tableEl.querySelectorAll('[data-override]').forEach((btn) => btn.addEventListener('click', () => openOverrideModal(btn.dataset.override, () => loadTable(flaggedOnly))));
    tableEl.querySelectorAll('[data-force-out]').forEach((btn) => btn.addEventListener('click', () => openForceClockOutModal(btn.dataset.forceOut, btn.dataset.name, () => loadTable(flaggedOnly))));
  }

  view.querySelectorAll('[data-attendance-tab]').forEach((tab) => tab.addEventListener('click', () => {
    view.querySelectorAll('[data-attendance-tab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadTable(tab.dataset.attendanceTab === 'flagged');
  }));

  UI.on('clock-in-btn', 'click', async () => {
    const btn = document.getElementById('clock-in-btn');
    const msgEl = document.getElementById('attendance-status-msg');
    btn.disabled = true;
    let location = null;
    let deviceId = null;
    if (attendanceMode === 'REGISTERED_DEVICE') {
      deviceId = DeviceId.get();
    } else {
      msgEl.textContent = 'Getting your location…';
      location = await getDeviceLocation();
    }
    try {
      const record = await Api.post('/attendance/clock-in', { location, device_id: deviceId }, { allowOfflineQueue: false });
      const statusMsg = {
        ON_SITE: '\u2713 Clocked in — verified on-site.',
        OFF_SITE: `⚠ Clocked in, but you appear to be ${Math.round(record.clock_in_distance_meters)}m from the branch. This has been flagged for manager review.`,
        NO_LOCATION: '⚠ Clocked in, but no GPS location was available (permission denied or unsupported device). Flagged for manager review.',
        GEOFENCE_NOT_SET: 'ℹ Clocked in. This branch has no GPS geofence configured yet, so location could not be verified.',
        DEVICE_RECOGNIZED: '\u2713 Clocked in — recognized device.',
        DEVICE_NOT_RECOGNIZED: '⚠ Clocked in, but this device is not registered for this branch. Flagged for manager review.',
        DEVICE_NOT_SET: 'ℹ Clocked in. This branch has no registered devices configured yet, so device could not be verified.',
      }[record.clock_in_status];
      UI.toast(statusMsg, ['ON_SITE', 'DEVICE_RECOGNIZED'].includes(record.clock_in_status) ? 'success' : 'warn', 6000);
      Router.navigate();
    } catch (e) {
      UI.toast(e.message, 'error');
      btn.disabled = false;
      msgEl.textContent = '';
    }
  });

  UI.on('clock-out-btn', 'click', async () => {
    const btn = document.getElementById('clock-out-btn');
    const msgEl = document.getElementById('attendance-status-msg');
    btn.disabled = true;
    let location = null;
    let deviceId = null;
    if (attendanceMode === 'REGISTERED_DEVICE') {
      deviceId = DeviceId.get();
    } else {
      msgEl.textContent = 'Getting your location…';
      location = await getDeviceLocation();
    }
    try {
      await Api.post(`/attendance/${current.id}/clock-out`, { location, device_id: deviceId }, { allowOfflineQueue: false });
      UI.toast('Clocked out. Have a good day!', 'success');
      Router.navigate();
    } catch (e) {
      UI.toast(e.message, 'error');
      btn.disabled = false;
      msgEl.textContent = '';
    }
  });

  loadTable(false);
  if (isManager) renderDeviceRegistryCard(branches, branchId);
}

// Manager-only panel: for whichever branch is currently selected (or
// every branch, if "All Branches" is selected), list/register/revoke
// the laptops trusted for REGISTERED_DEVICE attendance verification.
async function renderDeviceRegistryCard(branches, selectedBranchId) {
  const card = document.getElementById('device-registry-card');
  if (!card) return;

  const targetBranches = selectedBranchId ? branches.filter((b) => b.id === selectedBranchId) : branches;

  async function render() {
    const sections = await Promise.all(targetBranches.map(async (b) => {
      const devices = b.attendance_mode === 'REGISTERED_DEVICE' ? await Api.get(`/attendance/devices?branch_id=${b.id}`) : [];
      return { branch: b, devices };
    }));

    card.innerHTML = `
      <div class="card" style="margin-top:16px;">
        <h3>Registered Devices</h3>
        <p class="page-subtitle">Only relevant for branches set to "Registered Device" attendance mode (change this under Users &amp; Branches → Branches → Edit). Register the laptop you're using right now, or revoke one that's been replaced or lost.</p>
        ${sections.map(({ branch, devices }) => `
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gray-200);">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>${UI.escapeHtml(branch.name)}</strong>
              ${UI.badge(branch.attendance_mode === 'REGISTERED_DEVICE' ? 'Registered Device Mode' : 'Geolocation Mode', branch.attendance_mode === 'REGISTERED_DEVICE' ? 'green' : 'gray')}
            </div>
            ${branch.attendance_mode === 'REGISTERED_DEVICE' ? `
              <div class="table-wrap" style="margin-top:8px;">
                <table>
                  <thead><tr><th>Label</th><th>Registered</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    ${devices.map((d) => `
                      <tr>
                        <td>${UI.escapeHtml(d.label || '(unlabeled)')}</td>
                        <td>${UI.shortDate(d.registered_at)} by ${UI.escapeHtml(d.registered_by_name)}</td>
                        <td>${d.revoked_at ? UI.badge('Revoked', 'red') : UI.badge('Active', 'green')}</td>
                        <td>${!d.revoked_at ? `<button class="btn btn-ghost btn-sm" data-revoke="${d.id}" data-branch="${branch.id}">Revoke</button>` : ''}</td>
                      </tr>
                    `).join('') || `<tr><td colspan="4" class="empty-state">No devices registered yet</td></tr>`}
                  </tbody>
                </table>
              </div>
              <button class="btn btn-secondary btn-sm" data-register-device="${branch.id}" style="margin-top:8px;">+ Register This Laptop</button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;

    card.querySelectorAll('[data-register-device]').forEach((btn) => btn.addEventListener('click', () => openRegisterDeviceModal(btn.dataset.registerDevice, render)));
    card.querySelectorAll('[data-revoke]').forEach((btn) => UI.guardedClick(btn, async () => {
      if (!confirm('Revoke this device? Staff clocking in from it afterward will be flagged as an unrecognized device.')) return;
      try {
        await Api.post(`/attendance/devices/${btn.dataset.revoke}/revoke`, { branch_id: btn.dataset.branch });
        UI.toast('Device revoked', 'success');
        render();
      } catch (e) { UI.toast(e.message, 'error'); }
    }));
  }

  render();
}

function openRegisterDeviceModal(branchId, onDone) {
  const thisDeviceId = DeviceId.get();
  const modal = UI.openModal(`
    <h3>Register a Device</h3>
    <p class="page-subtitle">Register the laptop you're using right now (recommended — most tamper-resistant), or enter a device code read off another laptop's screen to register it remotely.</p>
    <div class="form-row">
      <label>Device</label>
      <select id="reg-device-source">
        <option value="this">This laptop (${thisDeviceId.slice(0, 8)}…)</option>
        <option value="other">A different laptop — I have its device code</option>
      </select>
    </div>
    <div class="form-row" id="reg-device-code-row" style="display:none;">
      <label>Device Code (from the other laptop's Staff Attendance page)</label>
      <input id="reg-device-code" placeholder="Paste the code here" />
    </div>
    <div class="form-row"><label>Label</label><input id="reg-device-label" placeholder="e.g. Front counter laptop" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="reg-cancel">Cancel</button>
      <button class="btn btn-primary" id="reg-confirm">Register</button>
    </div>
    <p style="font-size:11px;color:var(--gray-600);margin-top:10px;">This laptop's own device code (share it with a manager to register it remotely instead): <code>${thisDeviceId}</code></p>
  `);
  modal.querySelector('#reg-device-source').addEventListener('change', (e) => {
    modal.querySelector('#reg-device-code-row').style.display = e.target.value === 'other' ? '' : 'none';
  });
  modal.querySelector('#reg-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#reg-confirm'), async () => {
    const source = modal.querySelector('#reg-device-source').value;
    const deviceId = source === 'this' ? thisDeviceId : modal.querySelector('#reg-device-code').value.trim();
    if (!deviceId) { UI.toast('Device code is required', 'error'); return; }
    try {
      await Api.post('/attendance/devices', { branch_id: branchId, device_id: deviceId, label: modal.querySelector('#reg-device-label').value || null });
      UI.toast('Device registered', 'success');
      UI.closeModal(modal);
      onDone();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}

// BUG 74 — end a shift the employee never closed themselves.
//
// The counterpart of the till force-close. The default end time is now, but a
// manager discovering an unclosed shift the next morning can set the real one;
// the server refuses a time before the clock-in or in the future, so this can
// never manufacture hours.
function openForceClockOutModal(attendanceId, staffName, onDone) {
  const modal = UI.openModal(`
    <h3>End ${UI.escapeHtml(staffName)}'s Shift</h3>
    <p class="page-subtitle">This person never clocked out. Ending their shift on their behalf is recorded against your name, with your reason, so payroll can see it was not the employee who closed it.</p>
    <div class="form-row"><label for="fco-when">Clock-out time (leave blank for now)</label><input id="fco-when" placeholder="YYYY-MM-DD HH:MM:SS" /></div>
    <div class="form-row"><label for="fco-reason">Reason (required)</label><textarea id="fco-reason" rows="3" placeholder="e.g. Went home at 6pm without clocking out; confirmed with the branch manager."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="fco-cancel">Cancel</button>
      <button class="btn btn-primary" id="fco-confirm">End shift</button>
    </div>
  `);
  modal.querySelector('#fco-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#fco-confirm'), async () => {
    const reason = (modal.querySelector('#fco-reason').value || '').trim();
    if (reason.length < 4) {
      UI.toast('Give a reason for ending this person\'s shift on their behalf.', 'error', 7000);
      return;
    }
    const when = (modal.querySelector('#fco-when').value || '').trim();
    try {
      await Api.post(`/attendance/${attendanceId}/force-clock-out`,
        when ? { reason, clock_out_at: when } : { reason },
        { allowOfflineQueue: false });
      UI.toast('Shift ended', 'success');
      UI.closeModal(modal);
      onDone();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}

function openOverrideModal(attendanceId, onDone) {
  const modal = UI.openModal(`
    <h3>Review Flagged Attendance</h3>
    <p class="page-subtitle">Approving this confirms you've reviewed the mismatch (e.g. faulty GPS, an unregistered but legitimate laptop, confirmed on-site by other means) — the original evidence is kept as-is for audit purposes.</p>
    <div class="form-row"><label>Reason (required)</label><textarea id="override-reason" rows="3" placeholder="e.g. Staff phone GPS was inaccurate; confirmed present via CCTV timestamp."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="override-cancel">Cancel</button>
      <button class="btn btn-primary" id="override-confirm">Approve</button>
    </div>
  `);
  modal.querySelector('#override-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#override-confirm'), async () => {
    // BUG 51: the server now REQUIRES a reason (OVERRIDE_REASON_REQUIRED).
    // Approving a flagged record is a manager vouching that someone really
    // was on duty when the geofence says otherwise — it is the only
    // explanation a proprietor will ever have for why that shift was paid.
    // Checked here as well so the manager is told before the round trip,
    // rather than meeting a server error after clicking Approve.
    const reason = (modal.querySelector('#override-reason').value || '').trim();
    if (reason.length < 4) {
      UI.toast('Give a reason for approving this flagged record — it is the only explanation anyone will have later for why this shift was paid.', 'error', 7000);
      return;
    }
    try {
      await Api.post(`/attendance/${attendanceId}/override`, { reason }, { allowOfflineQueue: false });
      UI.toast('Attendance record reviewed', 'success');
      UI.closeModal(modal);
      onDone();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
// Admin Portal — the software vendor's own admin screen for THIS
// client's deployment (single-tenant-per-client model: one deployment =
// one paying pharmacy, so "plan settings" is exactly the one
// client_settings row the server exposes via /api/admin/settings).
// Only an ADMIN-role account can reach this (enforced both here in the
// UI and, authoritatively, server-side by adminOnly middleware).
