async function renderTill(view) {
  const session = State.getSession();
  const isManager = State.isManager();
  const branchId = State.effectiveBranchId();

  if (!branchId) {
    view.innerHTML = `<div class="card"><p>Select a specific branch to manage its till.</p></div>`;
    return;
  }

  const [current, history] = await Promise.all([
    Api.get(`/till/current?branch_id=${branchId}`).catch(() => null),
    Api.get(`/till?branch_id=${branchId}`),
  ]);

  // GET /till/:id/expected has always existed on both backends
  // (computeExpectedCash — opening float + cash sales net of change −
  // cash expenses) but the frontend never called it at all: a cashier
  // previously had NO way to see the expected cash figure until AFTER
  // submitting the close, at which point the discrepancy toast was the
  // first and only time they ever saw it. Fetching it up front lets the
  // cashier count the drawer against a known target instead of
  // guessing, and lets them notice/investigate a large discrepancy
  // BEFORE committing the close rather than after (found and fixed
  // during a "is the frontend fully functionally aligned with the
  // backend" audit pass).
  const expected = current ? await Api.get(`/till/${current.id}/expected`).catch(() => null) : null;

  // A manager viewing a till that someone ELSE opened is offered a
  // distinct "Force Close" action (requires a reason) rather than the
  // ordinary close button — this is the recovery path for a cashier who
  // left for the day without closing out, which would otherwise
  // permanently block the branch from opening a new till at all (the
  // database only allows one OPEN till per branch at a time).
  const isForceCloseCandidate = current && isManager && current.opened_by !== session.user.id;

  // BUG 36 (frontend half). A STAFF user looking at a colleague's open till
  // fell through both branches above: not the opener, and not a manager, so
  // isForceCloseCandidate was false and they were shown the ordinary
  // "Close Till" button. The backend accepted it (the 403 was dead code),
  // so a cashier could close another cashier's drawer and own the counted
  // figure. The server now refuses this; the UI must not offer it either,
  // because an action that always errors is its own defect.
  const someoneElsesTill = current && current.opened_by !== session.user.id;
  const staffBlockedFromClosing = someoneElsesTill && !isManager;

  view.innerHTML = `
    <h2 class="page-title">Till / Cash Reconciliation</h2>
    <p class="page-subtitle">Cash-in-drawer tracking per shift — expected cash is computed from opening float + cash sales (net of change) − cash expenses.</p>

    <div class="card">
      ${current ? `
        <h3>Current Session — OPEN since ${UI.shortDate(current.opened_at)}</h3>
        <p>Opened by <b>${UI.escapeHtml(current.opened_by_name)}</b> — Opening cash: <b>${UI.money(current.opening_cash)}</b>${expected != null ? ` — Expected cash right now: <b>${UI.money(expected.expected_closing_cash)}</b>` : ''}</p>
        ${isForceCloseCandidate ? `
          <div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);margin:10px 0;">
            <p style="font-size:13px;">This till was opened by <b>${UI.escapeHtml(current.opened_by_name)}</b>, not you. If they're unavailable to close it themselves (left for the day, forgot, etc.), you can force-close it as a manager — this is recorded distinctly from a normal self-close for audit purposes.</p>
          </div>
        ` : ''}
        ${staffBlockedFromClosing ? `
          <div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);margin:10px 0;">
            <p style="font-size:13px;">This till was opened by <b>${UI.escapeHtml(current.opened_by_name)}</b>, not you. Only they or a manager can close it — whoever closes a drawer owns the counted figure and any shortage it records. Ask a manager if they are unavailable.</p>
          </div>
        ` : `
        <div class="form-inline">
          <div class="form-row">
            <label>Counted Cash in Drawer Now</label>
            <input type="number" id="till-counted" min="0" />
            <span id="till-live-discrepancy" style="display:block;font-size:12px;margin-top:4px;"></span>
          </div>
          ${isForceCloseCandidate ? `
            <div class="form-row" style="min-width:240px;">
              <label>Reason for force-closing (required)</label>
              <input id="till-force-reason" placeholder="e.g. Cashier left for the day without closing" />
            </div>
          ` : ''}
          <button class="btn ${isForceCloseCandidate ? 'btn-danger' : 'btn-primary'}" id="till-close-btn">${isForceCloseCandidate ? 'Force Close Till' : 'Close Till'}</button>
        </div>
        `}
      ` : `
        <h3>No Open Till</h3>
        <div class="form-inline">
          <div class="form-row">
            <label>Opening Cash Float</label>
            <input type="number" id="till-opening" min="0" value="0" />
          </div>
          <button class="btn btn-primary" id="till-open-btn">Open Till</button>
        </div>
      `}
    </div>

    <div class="card">
      <h3>Recent Sessions</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Opened By</th><th>Opened</th><th>Closed</th><th>Opening</th><th>Expected</th><th>Counted</th><th>Discrepancy</th><th>Status</th></tr></thead>
          <tbody>
            ${history.length ? history.map(t => `
              <tr>
                <td>${UI.escapeHtml(t.opened_by_name)}</td>
                <td>${UI.shortDate(t.opened_at)}</td>
                <td>${t.closed_at ? UI.shortDate(t.closed_at) : '—'}</td>
                <td>${UI.money(t.opening_cash)}</td>
                <td>${t.expected_closing_cash != null ? UI.money(t.expected_closing_cash) : '—'}</td>
                <td>${t.counted_closing_cash != null ? UI.money(t.counted_closing_cash) : '—'}</td>
                <td>${t.discrepancy != null ? `<span style="color:${Math.abs(t.discrepancy) > 0.01 ? 'var(--red-500)' : 'var(--green-700)'}">${UI.money(t.discrepancy)}</span>` : '—'}</td>
                <td>${t.status === 'OPEN' ? UI.badge('OPEN', 'amber') : (t.force_closed_by ? `${UI.badge('FORCE-CLOSED', 'red')} <span style="font-size:11px;color:var(--gray-600);">by ${UI.escapeHtml(t.force_closed_by_name)}</span>` : UI.badge('CLOSED', 'gray'))}</td>
              </tr>
            `).join('') : '<tr><td colspan="8" class="empty-state">No till sessions yet</td></tr>'}
          </tbody>
        </table>
      </div>
      ${Exporter.toolbar('till', { label: 'this cash reconciliation report' })}
    </div>

    <!-- THE BRANCH SAFE. Placed on this screen because it is the other half of
         the same question: how much cash is at this shop, and where is it?
         The drawer above is counted every shift; the safe below is the reserve
         that funds a delivery or the rent, which the drawer could never cover.
         Visible to everyone (a cashier needs to know whether a purchase can be
         funded) but movable only by a manager or the Owner. -->
    <div class="card">
      <h3>Branch Safe</h3>
      <p class="page-subtitle">Cash held at this branch <b>outside</b> the counter drawer. This is what pays for a
        delivery or the rent when the till could never cover it. Separate from the till: a safe movement never changes
        what the drawer is expected to hold.</p>
      <div id="safe-content" class="empty-state">Loading…</div>
    </div>
  `;

  Exporter.wireTableReport('till', {
    title: 'Till / Cash Reconciliation',
    subtitle: 'Cash sessions and discrepancies',
    filename: 'till-reconciliation',
    columns: [
      { key: 'opened_by_name', label: 'Opened By' },
      { key: 'opened_at', label: 'Opened', format: (v) => UI.shortDate(v) },
      { key: 'closed_at', label: 'Closed', format: (v) => (v ? UI.shortDate(v) : '') },
      { key: 'opening_cash', label: 'Opening', align: 'right', format: (v) => UI.money(v) },
      { key: 'expected_closing_cash', label: 'Expected', align: 'right', format: (v) => (v != null ? UI.money(v) : '') },
      { key: 'counted_closing_cash', label: 'Counted', align: 'right', format: (v) => (v != null ? UI.money(v) : '') },
      { key: 'discrepancy', label: 'Discrepancy', align: 'right', format: (v) => (v != null ? UI.money(v) : '') },
      { key: 'status', label: 'Status' },
      { key: 'force_closed_by_name', label: 'Force-Closed By' },
    ],
    rows: history,
    summary: [
      { label: 'Sessions', value: String(history.length) },
      { label: 'Net discrepancy', value: UI.money(history.reduce((a, t) => a + Number(t.discrepancy || 0), 0)) },
      { label: 'Sessions with a shortage', value: String(history.filter((t) => Number(t.discrepancy || 0) < -0.01).length) },
    ],
    note: 'A negative discrepancy is a cash shortage. Every discrepancy is posted to Cash Over/Short in the general ledger.',
    emptyMessage: 'No till sessions recorded.',
  });

  UI.guardedClick(document.getElementById('till-open-btn'), async () => {
    const opening_cash = Number(document.getElementById('till-opening').value || 0);
    try {
      await Api.post('/till/open', { branch_id: branchId, opening_cash }, { allowOfflineQueue: false });
      UI.toast('Till opened', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  // Live discrepancy preview as the cashier types — purely informational
  // (the server always recomputes and enforces the real figure on
  // submit), but lets them notice a large mismatch and go recount the
  // drawer before committing the close, rather than only finding out
  // after the fact.
  UI.on('till-counted', 'input', (e) => {
    const el = document.getElementById('till-live-discrepancy');
    if (!el || expected == null) return;
    const counted = Number(e.target.value);
    if (e.target.value === '' || Number.isNaN(counted)) { el.textContent = ''; return; }
    const diff = Math.round((counted - expected.expected_closing_cash) * 100) / 100;
    el.style.color = Math.abs(diff) > 0.01 ? 'var(--red-500)' : 'var(--green-700)';
    el.textContent = Math.abs(diff) > 0.01 ? `Discrepancy so far: ${UI.money(diff)}` : 'Matches expected cash ✓';
  });

  UI.guardedClick(document.getElementById('till-close-btn'), async () => {
    const counted_closing_cash = Number(document.getElementById('till-counted').value || 0);
    const forceReasonEl = document.getElementById('till-force-reason');
    const force_reason = forceReasonEl ? forceReasonEl.value.trim() : undefined;
    if (isForceCloseCandidate && !force_reason) {
      UI.toast('A reason is required to force-close another user\'s till.', 'error');
      return;
    }
    try {
      const result = await Api.post(`/till/${current.id}/close`, { counted_closing_cash, force_reason }, { allowOfflineQueue: false });
      const discRounded = Math.round(result.discrepancy * 100) / 100;
      UI.toast(`Till closed. Discrepancy: ${UI.money(discRounded)}`, Math.abs(discRounded) > 0.01 ? 'warn' : 'success', 6000);
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  // ---- BRANCH SAFE -----------------------------------------------------
  // Loaded after the shell paints, and any failure here leaves the till
  // screen fully usable — a supplementary panel must never be able to take
  // the primary one down with it.
  (async () => {
    const el = document.getElementById('safe-content');
    if (!el) return;
    const canMove = State.isManager() && !State.isAdmin();
    async function load() {
      el.textContent = 'Loading…';
      el.classList.add('empty-state');
      try {
        // Branch-scoped read. A manager viewing "all branches" has no single
        // safe to show, so fall back to the per-branch movements endpoint only
        // when a branch is actually selected.
        const data = branchId
          ? await Api.get(`/safe/${branchId}/movements`)
          : await Api.get('/safe');
        // Two shapes on purpose: one branch returns {safe_balance, movements};
        // "all branches" returns a per-branch array, because there is no single
        // safe to show and summing them would invite a manager to spend a total
        // that exists at five different shops.
        const allBranches = Array.isArray(data);
        const bal = allBranches
          ? data.reduce((a, r) => a + Number(r.safe_balance || 0), 0)
          : Number((data && data.safe_balance) || 0);
        const moves = allBranches ? [] : ((data && data.movements) || []);
        el.classList.remove('empty-state');
        el.innerHTML = `
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            <span class="page-subtitle" style="margin:0;">In the safe now</span>
            <span style="font-size:22px;font-weight:700;color:var(--green-800);">${UI.money(bal)}</span>
          </div>
          ${allBranches ? `
            <div class="table-wrap"><table>
              <thead><tr><th>Branch</th><th>In the safe</th><th>Last movement</th></tr></thead>
              <tbody>${data.map((r) => `<tr>
                <td>${UI.escapeHtml(r.branch_name)}</td>
                <td style="font-weight:600;">${UI.money(r.safe_balance)}</td>
                <td>${r.last_movement_at ? UI.shortDate(r.last_movement_at) : '—'}</td>
              </tr>`).join('')}</tbody>
            </table></div>
            <p class="page-subtitle" style="margin-top:8px;">Choose a single branch at the top of the screen to record a safe movement.</p>
          ` : ''}
          ${canMove && !allBranches ? `
          <div class="form-inline">
            <div class="form-row">
              <label>Movement</label>
              <select id="safe-type">
                <option value="DEPOSIT">Deposit into safe</option>
                <option value="WITHDRAWAL">Withdraw from safe</option>
                <option value="TILL_TRANSFER">Move drawer &rarr; safe</option>
                <option value="TILL_TRANSFER_OUT">Move safe &rarr; drawer</option>
              </select>
            </div>
            <div class="form-row"><label>Amount (N)</label><input type="number" min="0" id="safe-amount" /></div>
            <div class="form-row"><label>Reason</label><input id="safe-reason" placeholder="e.g. Owner float for the month" /></div>
            <button class="btn btn-primary" id="safe-go">Record</button>
          </div>` : ''}
          ${!canMove && !allBranches ? `
          <p class="page-subtitle">Only a manager or the Owner can move money in or out of the safe. Ask them to record it.</p>` : ''}
          <div class="table-wrap" style="margin-top:12px;">
            <table>
              <thead><tr><th>When</th><th>Movement</th><th>Amount</th><th>Reason</th><th>Recorded by</th></tr></thead>
              <tbody>${moves.length ? moves.map((m) => `
                <tr>
                  <td>${UI.shortDate(m.created_at)}</td>
                  <td>${UI.escapeHtml(String(m.entry_type).replace(/_/g, ' '))}</td>
                  <td style="color:${Number(m.amount) < 0 ? 'var(--red-500)' : 'var(--green-700)'};font-weight:600;">${UI.money(m.amount)}</td>
                  <td>${UI.escapeHtml(m.reason || '')}</td>
                  <td>${UI.escapeHtml(m.recorded_by_name || '')}</td>
                </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No safe movements yet</td></tr>'}
              </tbody>
            </table>
          </div>`;

        UI.on('safe-go', 'click', async () => {
          const sel = document.getElementById('safe-type').value;
          const raw = Number(document.getElementById('safe-amount').value || 0);
          const reason = (document.getElementById('safe-reason').value || '').trim();
          if (!(raw > 0)) { UI.toast('Enter an amount', 'error'); return; }
          // "Move safe -> drawer" is a TILL_TRANSFER with a negative sign; the
          // API takes one verb and reads the direction from the sign, so the
          // UI offers the two directions as separate, plainly-worded choices
          // rather than asking a manager to type a minus.
          const entry_type = sel === 'TILL_TRANSFER_OUT' ? 'TILL_TRANSFER' : sel;
          const amount = sel === 'TILL_TRANSFER_OUT' ? -raw : raw;
          try {
            const res = await Api.post('/safe/movements', { branch_id: branchId, entry_type, amount, reason }, { allowOfflineQueue: false });
            UI.toast(`Recorded. The safe now holds ${UI.money(res.safe_balance)}.`, 'success', 6000);
            load();
          } catch (e) { UI.toast(e.message || 'Could not record that movement', 'error', 8000); }
        });
      } catch (e) {
        el.classList.add('empty-state');
        el.textContent = 'Could not load the safe: ' + (e.message || 'unknown error');
      }
    }
    load();
  })();
}
// Renders ONLY the fields that actually changed between the discarded and
// the kept version of a conflicted record.
//
// This table used to print JSON.stringify() of two entire rows side by
// side. Every field was shown whether it changed or not, ids and
// timestamps included, so the one value a manager needed — "the address
// someone corrected and lost" — was buried in a wall of text in a 220px
// cell. In a busy shop that means the conflict is skipped, which is the
// silent-data-loss failure mode people rightly worry about with
// last-write-wins.
//
// Showing the DIFF, with the discarded value first and copyable, turns an
// unreadable log line into a one-glance instruction: this field said X,
// it now says Y, put it back if X was right.
function diffCells(conflict) {
  const parse = (v) => {
    if (v === null || v === undefined) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return {}; }
  };
  const lost = parse(conflict.losing_version);
  const kept = parse(conflict.winning_version);
  // Ignore bookkeeping columns: they always differ and never tell a human
  // anything useful about what was lost.
  const IGNORE = new Set(['id', 'updated_at', 'created_at', 'last_write_device_id', 'branch_id', 'is_deleted']);
  const keys = [...new Set([...Object.keys(lost), ...Object.keys(kept)])]
    .filter((k) => !IGNORE.has(k))
    .filter((k) => String(lost[k] === undefined ? '' : lost[k]) !== String(kept[k] === undefined ? '' : kept[k]));
  if (!keys.length) {
    return '<span style="color:var(--gray-600);">No visible field differed — only sync bookkeeping.</span>';
  }
  return keys.map((k) => {
    const before = lost[k] === undefined || lost[k] === null || lost[k] === '' ? '(empty)' : String(lost[k]);
    const after = kept[k] === undefined || kept[k] === null || kept[k] === '' ? '(empty)' : String(kept[k]);
    return `<div style="margin-bottom:4px;">
      <b>${UI.escapeHtml(k)}</b>:
      <span style="color:var(--red-500);text-decoration:line-through;">${UI.escapeHtml(before)}</span>
      &rarr;
      <span style="color:var(--green-700);">${UI.escapeHtml(after)}</span>
    </div>`;
  }).join('');
}

