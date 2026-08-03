async function renderTransfers(view) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const [transfers, branches] = await Promise.all([
    Api.get(branchId ? `/transfers?branch_id=${branchId}` : '/transfers'),
    Api.get('/branches'),
  ]);

  view.innerHTML = `
    <h2 class="page-title">Branch Stock Transfers</h2>
    <p class="page-subtitle">Move stock between branches while preserving batch traceability (same batch_no/expiry, new branch-local batch row on receipt).</p>

    <div class="card">
      <h3>Initiate Transfer ${branchId ? '' : '<span style="font-size:11px;color:var(--gray-600);">(select a branch above to initiate as that branch)</span>'}</h3>
      ${branchId ? `
      <div id="transfer-form"></div>
      ` : `<p class="empty-state">Select a specific branch (top-right) to initiate a transfer from it.</p>`}
    </div>

    <div class="card">
      <h3>Transfers</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>From</th><th>To</th><th>Qty</th><th>Status</th><th>Initiated</th><th></th></tr></thead>
          <tbody>
            ${transfers.map(t => `
              <tr>
                <td>${UI.escapeHtml(t.product_name)}</td>
                <td>${UI.escapeHtml(t.from_branch_name)}</td>
                <td>${UI.escapeHtml(t.to_branch_name)}</td>
                <td>${t.quantity}</td>
                <td>${UI.badge(t.status, t.status === 'RECEIVED' ? 'green' : t.status === 'CANCELLED' ? 'red' : 'amber')}</td>
                <td>${UI.shortDate(t.initiated_at)}</td>
                <td>
                  ${t.status === 'PENDING' ? `<button class="btn btn-secondary btn-sm" data-in-transit="${t.id}">Mark In-Transit</button>` : ''}
                  ${t.status === 'PENDING' || t.status === 'IN_TRANSIT' ? `<button class="btn btn-secondary btn-sm" data-receive="${t.id}">Mark Received</button>` : ''}
                  ${t.status === 'PENDING' || t.status === 'IN_TRANSIT' ? `<button class="btn btn-danger btn-sm" data-cancel="${t.id}">Cancel</button>` : ''}
                </td>
              </tr>
            `).join('') || `<tr><td colspan="7" class="empty-state">No transfers yet</td></tr>`}
          </tbody>
        </table>
      </div>
      ${Exporter.toolbar('transfers', { label: 'this transfer log' })}
    </div>
  `;

  Exporter.wireTableReport('transfers', {
    title: 'Inter-Branch Stock Transfers',
    subtitle: branchId ? 'Selected branch' : 'All branches',
    filename: 'stock-transfers',
    columns: [
      { key: 'initiated_at', label: 'Date', format: (v) => UI.shortDate(v) },
      { key: 'from_branch_name', label: 'From' },
      { key: 'to_branch_name', label: 'To' },
      { key: 'product_name', label: 'Product' },
      { key: 'quantity', label: 'Qty', align: 'right' },
      { key: 'received_at', label: 'Received', format: (v) => (v ? UI.shortDate(v) : '') },
      { key: 'status', label: 'Status' },
    ],
    rows: transfers,
    summary: [{ label: 'Transfers', value: String(transfers.length) }],
    emptyMessage: 'No transfers recorded.',
  });

  if (branchId) {
    const batches = await Api.get(`/stock?branch_id=${branchId}`);
    document.getElementById('transfer-form').innerHTML = `
      <div class="form-inline">
        <div class="form-row">
          <label>Stock Batch (from this branch)</label>
          <select id="tr-batch">${batches.map(b => `<option value="${b.id}" data-max="${b.quantity_remaining}">${UI.escapeHtml(b.product_name)} — ${b.batch_no || 'no batch#'} (${b.quantity_remaining} left)</option>`).join('')}</select>
        </div>
        <div class="form-row">
          <label>Send to Branch</label>
          <select id="tr-to-branch">${branches.filter(b => b.id !== branchId && b.is_active).map(b => `<option value="${b.id}">${UI.escapeHtml(b.name)}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Quantity</label><input type="number" min="1" step="1" id="tr-qty" value="1" /></div>
        <button class="btn btn-primary" id="tr-submit">Send Transfer</button>
      </div>
    `;
    UI.guardedClick(document.getElementById('tr-submit'), async () => {
      try {
        await Api.post('/transfers', {
          stock_batch_id: document.getElementById('tr-batch').value,
          to_branch_id: document.getElementById('tr-to-branch').value,
          quantity: Number(document.getElementById('tr-qty').value),
        }, { allowOfflineQueue: false });
        UI.toast('Transfer initiated', 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  view.querySelectorAll('[data-receive]').forEach((btn) => UI.guardedClick(btn, async () => {
    try {
      await Api.post(`/transfers/${btn.dataset.receive}/receive`, {}, { allowOfflineQueue: false });
      UI.toast('Transfer received into stock', 'success');
      Router.navigate();
    } catch (e) {
      UI.toast(e.message, 'error');
      // FUNCTIONAL GAP (found during this audit pass, same class of
      // issue as the purchase-order receive form fix): a rejected
      // receive attempt (e.g. this transfer was already received by
      // another request a moment ago — the exact race this route's
      // guarded-claim pattern is designed to reject) previously left
      // the stale "Mark Received"/"Cancel" buttons visible on the OLD
      // status row, inviting an immediate, pointless retry. Re-fetching
      // the list after ANY failed action means the row always reflects
      // the transfer's real current status.
      Router.navigate();
    }
  }));

  view.querySelectorAll('[data-in-transit]').forEach((btn) => UI.guardedClick(btn, async () => {
    try {
      await Api.post(`/transfers/${btn.dataset.inTransit}/mark-in-transit`, {}, { allowOfflineQueue: false });
      UI.toast('Transfer marked in-transit', 'success');
      Router.navigate();
    } catch (e) {
      UI.toast(e.message, 'error');
      Router.navigate();
    }
  }));

  view.querySelectorAll('[data-cancel]').forEach((btn) => UI.guardedClick(btn, async () => {
    if (!confirm('Cancel this transfer? The stock will remain at the source branch.')) return;
    try {
      await Api.post(`/transfers/${btn.dataset.cancel}/cancel`, {}, { allowOfflineQueue: false });
      UI.toast('Transfer cancelled', 'success');
      Router.navigate();
    } catch (e) {
      UI.toast(e.message, 'error');
      Router.navigate();
    }
  }));
}
