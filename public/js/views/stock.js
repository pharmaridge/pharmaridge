async function renderStock(view, path) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const tab = path.split('/')[2] || 'batches';

  const scopeQuery = branchId ? `?branch_id=${branchId}` : '';

  view.innerHTML = `
    <h2 class="page-title">Stock &amp; Expiry</h2>
    <p class="page-subtitle">Batch-level inventory tracking with FEFO, expiry alerts, low-stock alerts, and manual adjustments.</p>
    <div class="tabs">
      <div class="tab ${tab === 'batches' ? 'active' : ''}" data-tab="batches">All Batches</div>
      <div class="tab ${tab === 'expiry' ? 'active' : ''}" data-tab="expiry">Expiry Alerts</div>
      <div class="tab ${tab === 'low' ? 'active' : ''}" data-tab="low">Low Stock</div>
      <div class="tab ${tab === 'valuation' ? 'active' : ''}" data-tab="valuation">Valuation</div>
      <div class="tab ${tab === 'adjustments' ? 'active' : ''}" data-tab="adjustments">Adjustments</div>
    </div>
    <div id="stock-tab-content"></div>
  `;

  view.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    location.hash = `#/stock/${t.dataset.tab}`;
  }));

  const content = document.getElementById('stock-tab-content');

  if (tab === 'batches') {
    const batches = await Api.get(`/stock${scopeQuery}`);
    content.innerHTML = `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Product</th><th>Batch No.</th><th>Expiry</th><th>Qty Remaining</th><th>How it arrived</th><th>Cost/Unit</th><th>Sell/Unit</th><th>Pack Price</th><th>Carton Price</th><th></th></tr></thead>
            <tbody>
              ${batches.map(b => `
                <tr>
                  ${branchId ? '' : `<td>${UI.escapeHtml(b.branch_name)}</td>`}
                  <td>${UI.escapeHtml(b.product_name)}</td>
                  <td>${UI.escapeHtml(b.batch_no || '—')}</td>
                  <td>${b.expiry_date || '—'}</td>
                  <td>${b.quantity_remaining} ${b.base_unit}</td>
                  <!-- BUG 113 — SHOW WHAT "A PACK" MEANS FOR THIS BATCH.
                       The nesting is recorded per batch because suppliers
                       differ, and it drives both the price AND the number of
                       pieces that leave the shelf. If the storekeeper cannot
                       see it, they cannot spot a delivery keyed with the
                       wrong carton size — the one mistake this model exists
                       to prevent. -->
                  <td style="font-size:12px;">${arrivalLabel(b)}</td>
                  <td>${UI.money(b.cost_price_per_unit)}</td>
                  <td>${UI.money(b.selling_price_per_unit)}</td>
                  <td>${b.pack_price != null ? UI.money(b.pack_price) : '—'}</td>
                  <td>${b.carton_price != null ? UI.money(b.carton_price) : '—'}</td>
                  <td><button class="btn btn-secondary btn-sm" data-adjust="${b.id}">Adjust</button></td>
                </tr>
              `).join('') || `<tr><td colspan="11" class="empty-state">No stock batches</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
      ${Exporter.toolbar('stk-batches', { label: 'this stock list' })}
    `;
    Exporter.wireTableReport('stk-batches', {
      title: 'Stock on Hand (by batch)',
      subtitle: branchId ? 'Selected branch' : 'All branches',
      filename: 'stock-on-hand',
      columns: [
        ...(branchId ? [] : [{ key: 'branch_name', label: 'Branch' }]),
        { key: 'product_name', label: 'Product' },
        { key: 'batch_no', label: 'Batch No.' },
        { key: 'expiry_date', label: 'Expiry' },
        { key: 'quantity_remaining', label: 'Qty', align: 'right' },
        { key: 'base_unit', label: 'Unit' },
        { key: 'cost_price_per_unit', label: 'Cost/Unit', align: 'right', format: (v) => UI.money(v) },
        { key: 'selling_price_per_unit', label: 'Sell/Unit', align: 'right', format: (v) => UI.money(v) },
      ],
      rows: batches,
      summary: [
        { label: 'Batches', value: String(batches.length) },
        { label: 'Stock at Cost', value: UI.money(batches.reduce((a, b) => a + Number(b.quantity_remaining || 0) * Number(b.cost_price_per_unit || 0), 0)) },
        { label: 'Stock at Retail', value: UI.money(batches.reduce((a, b) => a + Number(b.quantity_remaining || 0) * Number(b.selling_price_per_unit || 0), 0)) },
      ],
      emptyMessage: 'No stock batches for this selection.',
    });
    content.querySelectorAll('[data-adjust]').forEach((btn) => btn.addEventListener('click', () => openAdjustModal(btn.dataset.adjust)));
  } else if (tab === 'expiry') {
    const alerts = await Api.get(`/stock/expiry-alerts${scopeQuery}`);
    content.innerHTML = `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Product</th><th>Batch</th><th>Expiry</th><th>Qty</th><th>Days to Expiry</th></tr></thead>
            <tbody>
              ${alerts.map(a => `
                <tr>
                  <td>${UI.escapeHtml(a.branch_name)}</td>
                  <td>${UI.escapeHtml(a.product_name)}</td>
                  <td>${UI.escapeHtml(a.batch_no || '—')}</td>
                  <td>${a.expiry_date}</td>
                  <td>${a.quantity_remaining}</td>
                  <td>${a.days_to_expiry < 0 ? UI.badge('EXPIRED', 'red') : a.days_to_expiry <= 30 ? UI.badge(a.days_to_expiry + 'd', 'red') : a.days_to_expiry <= 90 ? UI.badge(a.days_to_expiry + 'd', 'amber') : a.days_to_expiry + 'd'}</td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="empty-state">No batches with an expiry date on file</td></tr>`}
            </tbody>
          </table>
        </div>
        ${Exporter.toolbar('stk-expiry', { label: 'this expiry report' })}
      </div>
    `;
    Exporter.wireTableReport('stk-expiry', {
      title: 'Expiry Alert Report',
      subtitle: branchId ? 'Selected branch' : 'All branches',
      filename: 'expiry-alerts',
      columns: [
        { key: 'branch_name', label: 'Branch' },
        { key: 'product_name', label: 'Product' },
        { key: 'batch_no', label: 'Batch' },
        { key: 'expiry_date', label: 'Expiry' },
        { key: 'quantity_remaining', label: 'Qty', align: 'right' },
        { key: 'days_to_expiry', label: 'Days to Expiry', align: 'right', format: (v) => (v < 0 ? `EXPIRED (${Math.abs(v)}d ago)` : String(v)) },
      ],
      rows: alerts,
      summary: [
        { label: 'Batches flagged', value: String(alerts.length) },
        { label: 'Already expired', value: String(alerts.filter((a) => a.days_to_expiry < 0).length) },
        { label: 'Expiring within 30 days', value: String(alerts.filter((a) => a.days_to_expiry >= 0 && a.days_to_expiry <= 30).length) },
      ],
      note: 'Expired stock must be quarantined and removed from sale.',
      emptyMessage: 'No batches with an expiry date on file.',
    });
  } else if (tab === 'low') {
    const alerts = await Api.get(`/stock/low-stock${scopeQuery}`);
    content.innerHTML = `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Product</th><th>On Hand</th><th>Reorder Level</th></tr></thead>
            <tbody>
              ${alerts.map(a => `
                <tr><td>${UI.escapeHtml(a.branch_name)}</td><td>${UI.escapeHtml(a.product_name)}</td><td>${a.quantity_on_hand}</td><td>${a.reorder_level}</td></tr>
              `).join('') || `<tr><td colspan="4" class="empty-state">No products below reorder level</td></tr>`}
            </tbody>
          </table>
        </div>
        ${Exporter.toolbar('stk-low', { label: 'this reorder report' })}
      </div>
    `;
    Exporter.wireTableReport('stk-low', {
      title: 'Low Stock / Reorder Report',
      subtitle: branchId ? 'Selected branch' : 'All branches',
      filename: 'low-stock-reorder',
      columns: [
        { key: 'branch_name', label: 'Branch' },
        { key: 'product_name', label: 'Product' },
        { key: 'quantity_on_hand', label: 'On Hand', align: 'right' },
        { key: 'reorder_level', label: 'Reorder Level', align: 'right' },
        { key: 'shortfall', label: 'Shortfall', align: 'right',
          format: (v, r) => String(Math.max(0, Number(r.reorder_level || 0) - Number(r.quantity_on_hand || 0))) },
      ],
      rows: alerts,
      summary: [{ label: 'Products below reorder level', value: String(alerts.length) }],
      note: 'Use this as a purchase-order worksheet.',
      emptyMessage: 'No products are below their reorder level.',
    });
  } else if (tab === 'valuation') {
    // FUNCTIONAL GAP CLOSED (found during this audit's route-inventory
    // sweep — "does the frontend use 100% of what the backend
    // supports?"): GET /api/stock/value has existed identically on
    // both backends since the very first version of this feature
    // (fully covered by test/integration.test.js and
    // worker/test/integration.test.js), returning both
    // stock_value_at_cost AND stock_value_at_retail for the requesting
    // branch (or, org-wide for a manager with no branch filter,
    // per-branch AND total figures) — but no screen anywhere in the
    // frontend ever called it. A manager had no single place in the
    // app to see "how much is our physical inventory worth right now"
    // broken down by branch, only the Dashboard's org-wide/single-
    // branch summary cards (which show the SAME two numbers, but never
    // the full per-branch breakdown table needed to compare branches
    // against each other at a glance).
    const valuation = await Api.get(`/stock/value${scopeQuery}`);
    if (branchId) {
      // Single-branch scope (STAFF, or a MANAGER who has picked one
      // branch in the top-level switcher): the endpoint returns one
      // flat row directly.
      content.innerHTML = `
        <div class="grid grid-2">
          <div class="stat-card">
            <div class="label">Stock Value (Cost)</div>
            <div class="value">${UI.money(valuation.stock_value_at_cost)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Stock Value (Retail)</div>
            <div class="value">${UI.money(valuation.stock_value_at_retail)}</div>
          </div>
        </div>
      `;
    } else {
      // Org-wide scope (MANAGER/OWNER/ADMIN viewing "All Branches"):
      // the endpoint returns { by_branch: [...], total: {...} } — show
      // the total as headline stat cards, and the per-branch rows in a
      // table underneath so branches can be compared side by side.
      const branches = await Api.get('/branches');
      const branchNameById = new Map(branches.map(b => [b.id, b.name]));
      content.innerHTML = `
        <div class="grid grid-2">
          <div class="stat-card">
            <div class="label">Total Stock Value (Cost)</div>
            <div class="value">${UI.money(valuation.total.stock_value_at_cost)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Total Stock Value (Retail)</div>
            <div class="value">${UI.money(valuation.total.stock_value_at_retail)}</div>
          </div>
        </div>
        <div class="card" style="margin-top:16px;">
          <h3>By Branch</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Branch</th><th>Stock Value (Cost)</th><th>Stock Value (Retail)</th></tr></thead>
              <tbody>
                ${valuation.by_branch.map(row => `
                  <tr>
                    <td>${UI.escapeHtml(branchNameById.get(row.branch_id) || '—')}</td>
                    <td>${UI.money(row.stock_value_at_cost)}</td>
                    <td>${UI.money(row.stock_value_at_retail)}</td>
                  </tr>
                `).join('') || `<tr><td colspan="3" class="empty-state">No stock recorded at any branch</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  } else if (tab === 'adjustments') {
    const adjustments = await Api.get(`/adjustments${scopeQuery}`);
    content.innerHTML = `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Product</th><th>Batch</th><th>Type</th><th>Qty Change</th><th>Reason</th></tr></thead>
            <tbody>
              ${adjustments.map(a => `
                <tr>
                  <td>${UI.shortDate(a.created_at)}</td>
                  <td>${UI.escapeHtml(a.product_name)}</td>
                  <td>${UI.escapeHtml(a.batch_no || '—')}</td>
                  <td>${a.adjustment_type}</td>
                  <td style="color:${a.quantity_change < 0 ? 'var(--red-500)' : 'var(--green-700)'}">${a.quantity_change > 0 ? '+' : ''}${a.quantity_change}</td>
                  <td>${UI.escapeHtml(a.reason || '—')}</td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="empty-state">No adjustments recorded</td></tr>`}
            </tbody>
          </table>
        </div>
        ${Exporter.toolbar('stk-adj', { label: 'this adjustment audit trail' })}
      </div>
    `;
    Exporter.wireTableReport('stk-adj', {
      title: 'Stock Adjustment Audit Trail',
      subtitle: branchId ? 'Selected branch' : 'All branches',
      filename: 'stock-adjustments',
      columns: [
        { key: 'created_at', label: 'Date', format: (v) => UI.shortDate(v) },
        { key: 'product_name', label: 'Product' },
        { key: 'batch_no', label: 'Batch' },
        { key: 'adjustment_type', label: 'Type' },
        { key: 'quantity_change', label: 'Qty Change', align: 'right', format: (v) => (v > 0 ? `+${v}` : String(v)) },
        { key: 'reason', label: 'Reason' },
      ],
      rows: adjustments,
      summary: [
        { label: 'Adjustments', value: String(adjustments.length) },
        { label: 'Net units written off', value: String(adjustments.reduce((a, r) => a + Math.min(0, Number(r.quantity_change || 0)), 0)) },
      ],
      note: 'Every manual stock movement is recorded here for shrinkage investigation.',
      emptyMessage: 'No adjustments recorded.',
    });
  }
}

function openAdjustModal(batchId) {
  const modal = UI.openModal(`
    <h3>Adjust Stock Batch</h3>
    <div class="form-row">
      <label>Adjustment Type</label>
      <select id="adj-type">
        <option value="DAMAGE">Damage</option>
        <option value="EXPIRED">Expired write-off</option>
        <option value="THEFT_LOSS">Theft / Loss</option>
        <option value="MANUAL_CORRECTION">Manual Correction</option>
      </select>
    </div>
    <div class="form-row">
      <label>Quantity Change (negative for loss, positive for correction/add-back)</label>
      <input type="number" id="adj-qty" value="-1" />
    </div>
    <div class="form-row">
      <label>Reason</label>
      <textarea id="adj-reason" rows="2"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="adj-cancel">Cancel</button>
      <button class="btn btn-primary" id="adj-save">Save Adjustment</button>
    </div>
  `);
  modal.querySelector('#adj-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#adj-save'), async () => {
    const adjustment_type = modal.querySelector('#adj-type').value;
    const quantity_change = Number(modal.querySelector('#adj-qty').value);
    const reason = modal.querySelector('#adj-reason').value;
    try {
      await Api.post('/adjustments', { stock_batch_id: batchId, adjustment_type, quantity_change, reason }, { allowOfflineQueue: false });
      UI.toast('Adjustment recorded', 'success');
      UI.closeModal(modal);
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
