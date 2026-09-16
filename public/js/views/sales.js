async function renderSales(view, path, selectedRetailCategory) {
  const parts = path.split('/');
  const saleId = parts[2];
  if (saleId) return renderSaleDetail(view, saleId);

  const branchId = State.effectiveBranchId();
  const retailCategory = selectedRetailCategory || 'ALL';
  const query = [];
  if (branchId) query.push(`branch_id=${encodeURIComponent(branchId)}`);
  if (retailCategory !== 'ALL') query.push(`retail_category=${encodeURIComponent(retailCategory)}`);
  const scopeQuery = query.length ? `?${query.join('&')}` : '';
  const [sales, categorySummary] = await Promise.all([
    Api.get(`/sales${scopeQuery}`),
    Api.get(`/sales/category-summary${scopeQuery}`),
  ]);
  const categoriesFor = (value) => String(value || '').split(',').filter(Boolean)
    .map((code) => UI.retailCategoryLabel(code)).join(', ') || '—';

  view.innerHTML = `
    <h2 class="page-title">Sales History</h2>
    <p class="page-subtitle">Every completed and voided transaction, grouped by the retail category saved with each sale line. Click a row for the full receipt and to void if needed.</p>
    <div class="card">
      <div class="form-row" style="max-width:360px;margin-bottom:0;">
        <label for="sales-retail-category">Retail Category</label>
        <select id="sales-retail-category">${UI.retailCategoryOptions(retailCategory, true, 'All retail categories')}</select>
        <small class="muted">Filter sales containing a category. A mixed basket can appear under more than one category; the summary below uses each line's own value.</small>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Category Sales Summary</h3>
      <p class="page-subtitle">Completed sales only. Gross sales and quantities are grouped from the saved sale-line category, so later product edits do not rewrite history.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Retail Category</th><th style="text-align:right;">Sales</th><th style="text-align:right;">Base Units Sold</th><th style="text-align:right;">Gross Sales</th></tr></thead>
        <tbody>${categorySummary.map((row) => `<tr><td>${UI.escapeHtml(UI.retailCategoryLabel(row.retail_category))}</td><td style="text-align:right;">${Number(row.sale_count || 0).toLocaleString()}</td><td style="text-align:right;">${Number(row.base_units_sold || 0).toLocaleString()}</td><td style="text-align:right;">${UI.money(row.gross_sales)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No completed sales in this category selection</td></tr>'}</tbody>
      </table></div>
    </div>
    ${Exporter.toolbar('sales', { label: 'this sales history' })}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Date</th><th>Served By</th><th>Customer</th><th>Retail Category</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${sales.map((sale) => `
              <tr>
                ${branchId ? '' : `<td>${UI.escapeHtml(sale.branch_name)}</td>`}
                <td>${UI.shortDate(sale.created_at)}</td>
                <td>${UI.escapeHtml(sale.served_by_name)}</td>
                <td>${UI.escapeHtml(sale.customer_name || 'Walk-in')}</td>
                <td>${UI.escapeHtml(categoriesFor(sale.retail_categories))}</td>
                <td>${UI.money(sale.total)}</td>
                <td>${sale.status === 'COMPLETED' ? UI.badge('COMPLETED', 'green') : sale.status === 'VOIDED' ? UI.badge('VOIDED', 'red') : UI.badge(sale.status, 'amber')}</td>
                <td><a class="btn btn-secondary btn-sm" href="#/sales/${sale.id}">View</a></td>
              </tr>
            `).join('') || `<tr><td colspan="8" class="empty-state">No sales recorded in this category selection</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('sales-retail-category').addEventListener('change', (event) => {
    renderSales(view, path, event.target.value);
  });
  Exporter.wireTableReport('sales', {
    title: 'Sales History',
    subtitle: `${branchId ? 'Selected branch' : 'All branches'} · ${retailCategory === 'ALL' ? 'All retail categories' : UI.retailCategoryLabel(retailCategory)}`,
    filename: retailCategory === 'ALL' ? 'sales-history' : `sales-history-${retailCategory.toLowerCase()}`,
    columns: [
      { key: 'created_at', label: 'Date', format: (value) => UI.shortDate(value) },
      { key: 'id', label: 'Receipt No.', format: (value) => String(value).slice(0, 8).toUpperCase() },
      ...(branchId ? [] : [{ key: 'branch_name', label: 'Branch' }]),
      { key: 'served_by_name', label: 'Served By' },
      { key: 'customer_name', label: 'Customer', format: (value) => value || 'Walk-in' },
      { key: 'retail_categories', label: 'Retail Category', format: categoriesFor },
      { key: 'total', label: 'Total', align: 'right', format: (value) => UI.money(value) },
      { key: 'status', label: 'Status' },
    ],
    rows: sales,
    summary: [
      { label: 'Transactions', value: String(sales.length) },
      { label: 'Completed Value', value: UI.money(sales.filter((sale) => sale.status === 'COMPLETED').reduce((total, sale) => total + Number(sale.total || 0), 0)) },
      { label: 'Voided', value: String(sales.filter((sale) => sale.status === 'VOIDED').length) },
    ],
    note: 'Voided transactions are listed for audit but excluded from the completed value total. Category summary uses completed sale-line values.',
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
