async function renderSync(view) {
  const isManager = State.isManager();
  const session = State.getSession();

  if (isManager) {
    const [overview, conflicts] = await Promise.all([
      Api.get('/sync/overview'),
      Api.get('/sync/conflicts'),
    ]);
    view.innerHTML = `
      <h2 class="page-title">Branch Sync Status</h2>
      <p class="page-subtitle">Live visibility into every branch's offline-sync health — last push/pull, pending local changes, and connectivity.</p>
      <div class="grid grid-3">
        ${overview.map(b => `
          <div class="stat-card ${b.connectivity_status === 'OFFLINE' ? 'danger' : b.connectivity_status === 'STALE' ? 'warn' : ''}">
            <div class="label">${UI.escapeHtml(b.branch_name)}</div>
            <div class="value" style="font-size:16px;">${statusBadge(b.connectivity_status)}</div>
            <div style="font-size:12px;color:var(--gray-600);margin-top:8px;line-height:1.6;">
              Device: ${UI.escapeHtml(b.device_id || '—')}<br/>
              App v${b.app_version || '—'}<br/>
              Last heartbeat: ${b.last_heartbeat_at ? UI.shortDate(b.last_heartbeat_at) : 'never'}<br/>
              Last push: ${b.last_push_at ? UI.shortDate(b.last_push_at) : 'never'}<br/>
              Last pull: ${b.last_pull_at ? UI.shortDate(b.last_pull_at) : 'never'}<br/>
              Pending local changes: <b>${b.pending_push_count}</b>
              ${b.last_sync_error ? `<br/><span style="color:var(--red-500)">Error: ${UI.escapeHtml(b.last_sync_error)}</span>` : ''}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>⚠ Sync Conflicts Pending Review</h3>
        <p class="page-subtitle">When two branches edit the same shared record (e.g. a customer) while both offline, whichever push arrives second wins — the other's changes are discarded. This list surfaces exactly what was discarded so you can manually reconcile it if it mattered; it does not undo the overwrite automatically.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Detected</th><th>Table</th><th>Branch</th><th>What was overwritten</th><th></th></tr></thead>
            <tbody>
              ${conflicts.length ? conflicts.map(c => `
                <tr>
                  <td>${UI.shortDate(c.detected_at)}</td>
                  <td>${UI.escapeHtml(c.table_name)}</td>
                  <td>${UI.escapeHtml(c.branch_name || '—')}</td>
                  <td style="font-size:12px;max-width:420px;">${diffCells(c)}</td>
                  <td><button class="btn btn-secondary btn-sm" data-review-conflict="${c.id}">Mark Reviewed</button></td>
                </tr>
              `).join('') : `<tr><td colspan="6" class="empty-state">No unreviewed sync conflicts</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    view.querySelectorAll('[data-review-conflict]').forEach((btn) => UI.guardedClick(btn, async () => {
      try {
        await Api.post(`/sync/conflicts/${btn.dataset.reviewConflict}/review`, {});
        UI.toast('Marked reviewed', 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    }));
  } else {
    const branchId = session.user.branch_id;
    const queueCount = await Offline.count();
    const failedItems = await Offline.getAllFailed();
    view.innerHTML = `
      <h2 class="page-title">Sync Status — My Branch</h2>
      <p class="page-subtitle">This device's local offline queue and last sync.</p>
      <div class="grid grid-2">
        <div class="stat-card ${!navigator.onLine ? 'danger' : ''}">
          <div class="label">Connection</div>
          <!-- BUG 60: the connection state was carried by a coloured emoji and
               nothing else. With no emoji font (measured: 🟢/🔴 render as tofu)
               a cashier saw an empty box next to no word at all in the offline
               case. Now the WORD carries the meaning, the .danger rail on the
               card carries the colour, and the mark is a glyph that provably
               draws in a plain system font. -->
          <div class="value">${navigator.onLine ? '\u25CF Online' : '\u25CF Offline'}</div>
        </div>
        <div class="stat-card ${queueCount > 0 ? 'warn' : ''}">
          <div class="label">Pending Local Changes</div>
          <div class="value">${queueCount}</div>
        </div>
      </div>
      <div class="card">
        <button class="btn btn-primary" id="sync-now"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M21 12a9 9 0 01-15.5 6.2M3 12a9 9 0 0115.5-6.2"/><path d="M3 18v-4h4M21 6v4h-4"/></svg>Sync Now</button>
      </div>
      ${failedItems.length ? `
      <div class="card" style="margin-top:16px;border:1px solid var(--red-500);">
        <h3>⚠ Items That Could Not Be Synced</h3>
        <p class="page-subtitle">
          These were queued while offline, but once this device reconnected the
          server actively rejected them — retrying automatically would never
          succeed (e.g. the stock they referenced sold out elsewhere in the
          meantime, or the till/session they belonged to was already closed).
          Review each one, then either fix the underlying issue and Retry, or
          Discard it if it's no longer relevant.
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Queued</th><th>Request</th><th>Server said</th><th></th></tr></thead>
            <tbody>
              ${failedItems.map(item => `
                <tr>
                  <td>${UI.shortDate(item.queuedAt || item.failedAt)}</td>
                  <td>${UI.escapeHtml(item.method)} ${UI.escapeHtml(item.path)}</td>
                  <td style="color:var(--red-500);">${UI.escapeHtml(item.errorMessage || 'Rejected')} (HTTP ${item.status})</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" data-retry-failed="${item.id}">Retry</button>
                    <button class="btn btn-danger btn-sm" data-discard-failed="${item.id}">Discard</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    `;
    UI.guardedClick(document.getElementById('sync-now'), async () => {
      try {
        const pendingCount = (await Offline.count()) + (await Offline.customerEditCount());
        await Api.post('/sync/heartbeat', { device_id: DeviceId.get(), app_version: '1.0.0', pending_push_count: pendingCount }, { allowOfflineQueue: false });
        const result = await Api.flushQueue();
        const customerResult = branchId ? await Api.pushCustomerQueue(branchId) : { ok: 0, remaining: 0 };
        const totalSent = result.ok + customerResult.ok;
        const totalRemaining = result.remaining + customerResult.remaining;
        const failedMsg = result.permanentlyFailed ? ` ${result.permanentlyFailed} could not be synced — see below.` : '';
        UI.toast(`Synced. ${totalSent} sent, ${totalRemaining} still pending.${failedMsg}`, result.permanentlyFailed ? 'warn' : 'success');
        Router.navigate();
      } catch (e) { UI.toast('Still offline — will retry automatically.', 'warn'); }
    });
    view.querySelectorAll('[data-retry-failed]').forEach(btn => UI.guardedClick(btn, async () => {
      await Offline.retryFailed(Number(btn.dataset.retryFailed));
      UI.updateOfflineBanner();
      UI.toast('Moved back to the pending queue — will retry on next sync.', 'success');
      Router.navigate();
    }));
    view.querySelectorAll('[data-discard-failed]').forEach(btn => UI.guardedClick(btn, async () => {
      if (!confirm('Permanently discard this item? It will never be synced.')) return;
      await Offline.removeFailed(Number(btn.dataset.discardFailed));
      UI.updateOfflineBanner();
      UI.toast('Discarded.', 'success');
      Router.navigate();
    }));
  }
}

function statusBadge(status) {
  const map = { ONLINE: 'green', STALE: 'amber', OFFLINE: 'red', NEVER_SYNCED: 'gray' };
  return UI.badge(status.replace('_', ' '), map[status] || 'gray');
}
