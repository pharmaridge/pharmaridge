async function renderControlledRegister(view) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const entries = await Api.get(branchId ? `/controlled-register?branch_id=${branchId}` : '/controlled-register');

  view.innerHTML = `
    <h2 class="page-title">Controlled Substance Register</h2>
    <p class="page-subtitle">Tamper-evident, append-only log of every controlled-drug dispense (e.g. Tramadol, Codeine) — required by PCN/NAFDAC. Each row is chained by a SHA-256 hash so any out-of-band edit is detectable.</p>
    ${Exporter.toolbar('ctrl', { label: 'the controlled substance register' })}

    ${branchId ? `<div class="card">
      <button class="btn btn-secondary" id="verify-chain"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Verify Tamper-Evidence Chain for this Branch</button>
      <div id="verify-result" style="margin-top:10px;"></div>
    </div>` : ''}

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Date</th><th>Product</th><th>Qty</th><th>Buyer</th><th>Phone</th><th>ID</th><th>Dispensed By</th><th>Status</th></tr></thead>
          <tbody>
            ${entries.map(e => `
              <tr>
                ${branchId ? '' : `<td>${UI.escapeHtml(e.branch_name)}</td>`}
                <td>${UI.shortDate(e.created_at)}</td>
                <td>${UI.escapeHtml(e.product_name)}</td>
                <td>${e.quantity_dispensed}</td>
                <td>${UI.escapeHtml(e.buyer_name)}</td>
                <td>${UI.escapeHtml(e.buyer_phone)}</td>
                <td>${UI.escapeHtml(e.buyer_id_type || '')} ${UI.escapeHtml(e.buyer_id_number || '')}</td>
                <td>${UI.escapeHtml(e.dispensed_by_name)}</td>
                <td>${e.is_voided
                  ? `${UI.badge('VOIDED', 'red')}<div style="font-size:11px;color:var(--gray-600);">${UI.escapeHtml(e.void_reason || '')}${e.voided_by_name ? ' — ' + UI.escapeHtml(e.voided_by_name) : ''}</div>`
                  : UI.badge('Dispensed', 'green')}</td>
              </tr>
            `).join('') || `<tr><td colspan="9" class="empty-state">No controlled substance dispenses recorded</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  Exporter.wireTableReport('ctrl', {
    title: 'Controlled Substance Register',
    subtitle: 'Statutory dispensing record (PCN / NDLEA)',
    filename: 'controlled-substance-register',
    columns: [
      { key: 'created_at', label: 'Date', format: (v) => UI.shortDate(v) },
      { key: 'product_name', label: 'Product' },
      { key: 'quantity_dispensed', label: 'Qty', align: 'right' },
      { key: 'buyer_name', label: 'Buyer' },
      { key: 'buyer_phone', label: 'Phone' },
      { key: 'buyer_id_type', label: 'ID Type' },
      { key: 'buyer_id_number', label: 'ID Number' },
      { key: 'dispensed_by_name', label: 'Dispensed By' },
      // BUG 50: a voided controlled sale returned its stock but this
      // register still stated the buyer had RECEIVED the drug. An
      // inspector reconciling register against stock finds a dispensing
      // the pharmacy cannot account for. The row is never erased — that
      // would destroy the trail of a controlled drug leaving and
      // returning — so the status is carried on the printed copy too,
      // which is the copy an inspector actually reads.
      { key: 'sale_status', label: 'Status', format: (v, r) => (r.is_voided ? 'VOIDED' : 'Dispensed') },
      { key: 'void_reason', label: 'Void Reason', format: (v) => v || '' },
    ],
    rows: entries,
    summary: [{ label: 'Entries', value: String(entries.length) }],
    note: 'Append-only, SHA-256 hash-chained record. Entries marked VOIDED were reversed after dispensing — the stock was returned and the entry is retained deliberately, never deleted. Verify the chain in-app before relying on a printed copy.',
    emptyMessage: 'No controlled substance dispenses recorded.',
  });

  UI.on('verify-chain', 'click', async () => {
    const result = await Api.get(`/controlled-register/verify/${branchId}`);
    document.getElementById('verify-result').innerHTML = result.valid
      // BUG 60: \u2705 and \U0001F6A8 both render as an empty box where no emoji
      // font is installed. This is the NAFDAC tamper-evidence result — the one
      // message in the app that must never be ambiguous — so it now uses marks
      // that draw in a plain system font (measured), with the wording alone
      // still sufficient to convey the outcome.
      ? `<span style="color:var(--green-700);font-weight:600;">\u2713 Chain valid — ${result.checkedRows} entries verified, no tampering detected.</span>`
      : `<span style="color:var(--red-500);font-weight:600;">\u26A0 Chain broken at entry ${result.brokenAt} — possible tampering. Investigate immediately.</span>`;
  });
}
// Staff Attendance view: Clock In / Clock Out, verified either by GPS
// geofence (GEOLOCATION mode) or by this browser's registered device id
// (REGISTERED_DEVICE mode) — whichever the branch is configured to use
// (see the write-up below for the full design rationale). Plus a
// manager-facing review list of flagged records and, for REGISTERED_DEVICE
// branches, a device registry management panel.
//
// Geolocation handling notes: - We ALWAYS attempt to submit the
// clock-in/out, even if geolocation fails, times out, the browser has no
// support, or the branch is in REGISTERED_DEVICE mode and geolocation
// isn't even requested. The server-side classification handles every
// "couldn't verify" case gracefully — the UI must never block a legitimate
// staff member from clocking in over a verification signal being
// unavailable. - A short timeout (8s) keeps the button from hanging
// indefinitely on a device with degraded GPS reception.
function getDeviceLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null), // permission denied / unavailable / timeout — fall back to no location
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

function statusBadgeFor(status) {
  const map = {
    ON_SITE: 'green', OFF_SITE: 'red', NO_LOCATION: 'amber', GEOFENCE_NOT_SET: 'gray',
    DEVICE_RECOGNIZED: 'green', DEVICE_NOT_RECOGNIZED: 'red', DEVICE_NOT_SET: 'gray',
  };
  const labels = {
    ON_SITE: 'On-Site', OFF_SITE: 'Off-Site', NO_LOCATION: 'No GPS', GEOFENCE_NOT_SET: 'Geofence Not Set',
    DEVICE_RECOGNIZED: 'Recognized Device', DEVICE_NOT_RECOGNIZED: 'Unrecognized Device', DEVICE_NOT_SET: 'No Device Registry',
  };
  if (!status) return '—';
  return UI.badge(labels[status] || status, map[status] || 'gray');
}

const FLAGGED_CLOCK_IN = ['OFF_SITE', 'NO_LOCATION', 'GEOFENCE_NOT_SET', 'DEVICE_NOT_RECOGNIZED', 'DEVICE_NOT_SET'];

// BUG 78 — turn a duration into something a person can read on a payslip.
// null means the shift is still running: deliberately NOT rendered as "0h",
// which would look like someone worked nothing.
function formatWorked(minutes) {
  if (minutes == null) return '—';
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h ? `${h}h ${String(rem).padStart(2, '0')}m` : `${rem}m`;
}

