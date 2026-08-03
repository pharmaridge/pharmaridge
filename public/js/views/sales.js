async function renderSales(view, path) {
  const parts = path.split('/');
  const saleId = parts[2];
  if (saleId) return renderSaleDetail(view, saleId);

  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const scopeQuery = branchId ? `?branch_id=${branchId}` : '';
  const sales = await Api.get(`/sales${scopeQuery}`);

  view.innerHTML = `
    <h2 class="page-title">Sales History</h2>
    <p class="page-subtitle">Every completed and voided transaction — click a row for the full receipt and to void if needed.</p>
    ${Exporter.toolbar('sales', { label: 'this sales history' })}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Date</th><th>Served By</th><th>Customer</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${sales.map(s => `
              <tr>
                ${branchId ? '' : `<td>${UI.escapeHtml(s.branch_name)}</td>`}
                <td>${UI.shortDate(s.created_at)}</td>
                <td>${UI.escapeHtml(s.served_by_name)}</td>
                <td>${UI.escapeHtml(s.customer_name || 'Walk-in')}</td>
                <td>${UI.money(s.total)}</td>
                <td>${s.status === 'COMPLETED' ? UI.badge('COMPLETED', 'green') : s.status === 'VOIDED' ? UI.badge('VOIDED', 'red') : UI.badge(s.status, 'amber')}</td>
                <td><a class="btn btn-secondary btn-sm" href="#/sales/${s.id}">View</a></td>
              </tr>
            `).join('') || `<tr><td colspan="7" class="empty-state">No sales recorded yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  Exporter.wireTableReport('sales', {
    title: 'Sales History',
    subtitle: branchId ? 'Selected branch' : 'All branches',
    filename: 'sales-history',
    columns: [
      { key: 'created_at', label: 'Date', format: (v) => UI.shortDate(v) },
      { key: 'id', label: 'Receipt No.', format: (v) => String(v).slice(0, 8).toUpperCase() },
      ...(branchId ? [] : [{ key: 'branch_name', label: 'Branch' }]),
      { key: 'served_by_name', label: 'Served By' },
      { key: 'customer_name', label: 'Customer', format: (v) => v || 'Walk-in' },
      { key: 'total', label: 'Total', align: 'right', format: (v) => UI.money(v) },
      { key: 'status', label: 'Status' },
    ],
    rows: sales,
    summary: [
      { label: 'Transactions', value: String(sales.length) },
      { label: 'Completed Value', value: UI.money(sales.filter((x) => x.status === 'COMPLETED').reduce((a, x) => a + Number(x.total || 0), 0)) },
      { label: 'Voided', value: String(sales.filter((x) => x.status === 'VOIDED').length) },
    ],
    note: 'Voided transactions are listed for audit but excluded from the completed value total.',
    emptyMessage: 'No sales recorded for this selection.',
  });
}

async function renderSaleDetail(view, saleId) {
  const sale = await Api.get(`/sales/${saleId}`);
  view.innerHTML = `
    <a href="#/sales" style="font-size:12px;color:var(--green-700);">← Back to sales history</a>
    <h2 class="page-title">Sale Receipt</h2>
    <p class="page-subtitle">${UI.shortDate(sale.created_at)} · ${sale.status === 'COMPLETED' ? UI.badge('COMPLETED', 'green') : sale.status === 'VOIDED' ? UI.badge('VOIDED', 'red') : UI.badge(sale.status, 'amber')}</p>

    <div class="card">
      <div class="export-toolbar no-print" style="margin-bottom:10px;">
        <button class="btn btn-secondary btn-sm" id="rc-print"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M6 16h12v5H6z"/></svg>Print Receipt</button>
        <button class="btn btn-secondary btn-sm" id="rc-a4"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>A4 / PDF</button>
      </div>
      <!-- Rendered by the SAME Receipt module the printer uses, so a reprint
           can never disagree with what is shown here or with the original. -->
      <div class="receipt">${Receipt.screenHtml(sale)}</div>
      ${sale.status === 'COMPLETED' ? `<button class="btn btn-danger" id="void-sale-btn" style="margin-top:14px;">Void This Sale</button>` : ''}
    </div>
  `;

  UI.on('rc-print', 'click', () => Receipt.printThermal(sale));
  UI.on('rc-a4', 'click', () => Receipt.printA4(sale));

  UI.on('void-sale-btn', 'click', () => {
    const modal = UI.openModal(`
      <h3>Void Sale</h3>
      <p class="page-subtitle">This restores stock to inventory and reverses any credit debt created by this sale. This cannot be undone.</p>
      <div class="form-row"><label>Reason (required)</label><textarea id="void-reason" rows="2" placeholder="e.g. Wrong item scanned; customer changed their mind."></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="void-cancel">Cancel</button>
        <button class="btn btn-danger" id="void-confirm">Void Sale</button>
      </div>
    `);
    modal.querySelector('#void-cancel').addEventListener('click', () => UI.closeModal(modal));
    UI.guardedClick(modal.querySelector('#void-confirm'), async () => {
      // BUG 80: the server now REQUIRES a reason (VOID_REASON_REQUIRED). A void
      // reverses the money, the stock and the books, and this note is the only
      // record of why. Checked here too so the cashier is told BEFORE the round
      // trip rather than meeting a server error after clicking Void.
      const reason = (modal.querySelector('#void-reason').value || '').trim();
      if (reason.length < 4) {
        UI.toast('Give a reason for voiding this sale — it is the only record of why the money, stock and books were reversed.', 'error', 7000);
        return;
      }
      try {
        await Api.post(`/sales/${saleId}/void`, { reason }, { allowOfflineQueue: false });
        UI.toast('Sale voided', 'success');
        UI.closeModal(modal);
        renderSaleDetail(view, saleId);
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  });
}
