async function renderStocktake(view, path) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const parts = path.split('/');
  const stocktakeId = parts[2];

  if (stocktakeId) return renderStocktakeDetail(view, stocktakeId);

  if (!branchId) {
    view.innerHTML = `<div class="card"><p>Select a specific branch to run a stocktake.</p></div>`;
    return;
  }

  const sessions = await Api.get(`/stocktakes?branch_id=${branchId}`);
  const openOne = sessions.find(s => s.status === 'OPEN');

  view.innerHTML = `
    <h2 class="page-title">Stocktake (Physical Inventory Count)</h2>
    <p class="page-subtitle">Freeze system quantities, record what's physically counted, then close to auto-generate variance adjustments.</p>
    <div class="card">
      ${openOne ? `
        <p>An open stocktake session is in progress (started by ${UI.escapeHtml(openOne.started_by_name)} at ${UI.shortDate(openOne.started_at)}).</p>
        <button class="btn btn-primary" id="goto-open">Continue Counting →</button>
      ` : `
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="start-stocktake">Start Full Stocktake Session</button>
          <button class="btn btn-secondary" id="start-scoped-stocktake">Start Scoped Stocktake…</button>
        </div>
        <p class="page-subtitle" style="margin-top:8px;margin-bottom:0;">A Full session counts every product currently in stock at this branch. A Scoped session lets you count only a specific category, only Controlled Drug Register items, or hand-picked products — useful for a quick spot-check without freezing the whole branch's inventory.</p>
      `}
    </div>
    <div class="card">
      <h3>History</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Started By</th><th>Started</th><th>Status</th><th>Closed</th><th></th></tr></thead>
          <tbody>
            ${sessions.map(s => `
              <tr>
                <td>${UI.escapeHtml(s.started_by_name)}</td>
                <td>${UI.shortDate(s.started_at)}</td>
                <td>${s.status === 'OPEN' ? UI.badge('OPEN', 'amber') : s.status === 'CANCELLED' ? UI.badge('CANCELLED', 'red') : UI.badge(s.status, 'gray')}</td>
                <td>${s.closed_at ? UI.shortDate(s.closed_at) : '—'}</td>
                <td><a href="#/stocktake/${s.id}" class="btn btn-secondary btn-sm">View</a></td>
              </tr>
            `).join('') || `<tr><td colspan="5" class="empty-state">No stocktake sessions yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  UI.on('start-stocktake', 'click', async () => {
    try {
      const s = await Api.post('/stocktakes', { branch_id: branchId }, { allowOfflineQueue: false });
      location.hash = `#/stocktake/${s.id}`;
    } catch (e) { UI.toast(e.message, 'error'); }
  });
  UI.on('start-scoped-stocktake', 'click', async () => {
    try {
      await openScopedStocktakeModal(branchId);
    } catch (e) { UI.toast(e.message, 'error'); }
  });
  UI.on('goto-open', 'click', () => { location.hash = `#/stocktake/${openOne.id}`; });
}

// FUNCTIONAL GAP CLOSED (real gap found and fixed during this audit):
// POST /stocktakes has always supported an optional `product_ids`
// array on BOTH backends to scope a session to specific products
// instead of counting every batch at the branch, but the frontend
// never exposed any way to supply it. This modal closes that gap with
// three real, common pharmacy workflows: a quick spot-check of one
// category, a Controlled Drug Register count (a real regulatory
// requirement distinct from a full physical inventory), or hand-picked
// products.
async function openScopedStocktakeModal(branchId) {
  const products = await Api.get('/products');
  const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

  const modal = UI.openModal(`
    <h3>Start Scoped Stocktake</h3>
    <p class="page-subtitle">Count only what you select below — everything else at this branch is left untouched by this session.</p>
    <div class="form-row">
      <label>Scope</label>
      <select id="ss-scope">
        <option value="category">By Category</option>
        <option value="controlled">Controlled Drug Register Only</option>
        <option value="products">Pick Individual Products</option>
      </select>
    </div>
    <div id="ss-category-row" class="form-row">
      <label>Category</label>
      <select id="ss-category">${categories.map(c => `<option value="${UI.escapeHtml(c)}">${UI.escapeHtml(c)}</option>`).join('') || '<option value="">No categories found</option>'}</select>
    </div>
    <div id="ss-products-row" class="form-row" style="display:none;">
      <label>Products</label>
      <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;">
        ${products.map(p => `
          <label style="display:block;font-weight:normal;font-size:13px;padding:2px 0;">
            <input type="checkbox" class="ss-product-cb" value="${p.id}" /> ${UI.escapeHtml(p.name)}${p.is_controlled ? ' ' + UI.badge('Controlled', 'red') : ''}
          </label>
        `).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="ss-cancel">Cancel</button>
      <button class="btn btn-primary" id="ss-start">Start Scoped Stocktake</button>
    </div>
  `);

  const scopeSelect = modal.querySelector('#ss-scope');
  const categoryRow = modal.querySelector('#ss-category-row');
  const productsRow = modal.querySelector('#ss-products-row');
  scopeSelect.addEventListener('change', () => {
    const scope = scopeSelect.value;
    categoryRow.style.display = scope === 'category' ? '' : 'none';
    productsRow.style.display = scope === 'products' ? '' : 'none';
  });

  modal.querySelector('#ss-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#ss-start'), async () => {
    const scope = scopeSelect.value;
    let productIds;
    if (scope === 'category') {
      const category = modal.querySelector('#ss-category').value;
      if (!category) { UI.toast('No category selected', 'error'); return; }
      productIds = products.filter(p => p.category === category).map(p => p.id);
    } else if (scope === 'controlled') {
      productIds = products.filter(p => p.is_controlled).map(p => p.id);
    } else {
      productIds = Array.from(modal.querySelectorAll('.ss-product-cb:checked')).map(cb => cb.value);
    }
    if (!productIds.length) { UI.toast('No products match that scope — nothing to count', 'error'); return; }
    // PLATFORM-LIMIT NOTE (see worker/src/lib/d1Limits.js): this array
    // used to be interpolated straight into a single `IN (...)` on the
    // server, which D1 rejected outright past 99 ids — a scoped count
    // of a large category simply failed with an unreadable
    // "too many SQL variables". The server now chunks properly, so any
    // size is accepted; this note exists so nobody "optimises" the
    // chunking away again. No client-side cap is needed here.
    try {
      const s = await Api.post('/stocktakes', { branch_id: branchId, product_ids: productIds }, { allowOfflineQueue: false });
      UI.closeModal(modal);
      location.hash = `#/stocktake/${s.id}`;
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}


async function renderStocktakeDetail(view, stocktakeId) {
  const s = await Api.get(`/stocktakes/${stocktakeId}`);
  const session = State.getSession();
  const isManager = State.isManager();
  const isForceCloseCandidate = s.status === 'OPEN' && isManager && s.started_by !== session.user.id;
  // Anyone who could close their own stocktake may also cancel it
  // outright (own session, any status transition from OPEN); a manager
  // may additionally force-cancel someone else's still-open session —
  // identical authorization shape to the existing force-close path.
  const canCancel = s.status === 'OPEN' && (s.started_by === session.user.id || isManager);

  view.innerHTML = `
    <a href="#/stocktake" style="font-size:12px;color:var(--green-700);">← Back to stocktakes</a>
    <h2 class="page-title">Stocktake — ${s.status}</h2>
    <p class="page-subtitle">Started by ${UI.escapeHtml(s.started_by_name)} on ${UI.shortDate(s.started_at)} ${s.closed_at ? '· Closed ' + UI.shortDate(s.closed_at) : ''}${s.force_closed_by_name ? ` · Force-closed by ${UI.escapeHtml(s.force_closed_by_name)}` : ''}</p>
    <p class="page-subtitle" style="margin-top:-12px;">Variance is calculated against live stock at the moment each line is counted, not the quantity when this session opened — so normal sales made while the count is in progress are never mistaken for shrinkage.</p>
    ${isForceCloseCandidate ? `
      <div class="card" style="border-left:4px solid var(--amber-500);background:var(--tint-amber);">
        <p style="font-size:13px;">This stocktake was started by <b>${UI.escapeHtml(s.started_by_name)}</b>, not you. If they're unavailable to finish it (left for the day, forgot, etc.), you can force-close it as a manager — uncounted lines are left untouched, and this is recorded distinctly from a normal close for audit purposes. Alternatively, if this session should never have been started at all, cancel it below instead (no stock adjustments will be applied either way).</p>
        <div class="form-row"><label>Reason for force-closing (required)</label><input id="force-close-reason" placeholder="e.g. Staff went home before finishing the count" /></div>
      </div>
    ` : ''}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Batch</th><th>Qty When Session Opened</th><th>Counted Qty</th><th>Variance</th><th></th></tr></thead>
          <tbody>
            ${s.lines.map(l => `
              <tr>
                <td>${UI.escapeHtml(l.product_name)}</td>
                <td>${UI.escapeHtml(l.batch_no || '—')}</td>
                <td>${l.system_quantity}</td>
                <td>${s.status === 'OPEN' ? `<input type="number" class="qty-input" data-line="${l.id}" value="${l.counted_quantity == null ? '' : l.counted_quantity}" style="width:90px" />` : (l.counted_quantity == null ? '—' : l.counted_quantity)}</td>
                <td style="color:${l.variance < 0 ? 'var(--red-500)' : l.variance > 0 ? 'var(--green-700)' : 'inherit'}">${l.variance != null ? (l.variance > 0 ? '+' : '') + l.variance : '—'}</td>
                <td>${s.status === 'OPEN' ? `<button class="btn btn-secondary btn-sm" data-save-line="${l.id}">Save</button>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${Exporter.toolbar('stocktake', { label: 'this count sheet' })}
      <div style="display:flex;gap:10px;margin-top:14px;">
        ${s.status === 'OPEN' ? `<button class="btn ${isForceCloseCandidate ? 'btn-danger' : 'btn-primary'}" id="close-stocktake">${isForceCloseCandidate ? 'Force Close Stocktake' : 'Close Stocktake & Apply Adjustments'}</button>` : ''}
        ${canCancel ? `<button class="btn btn-secondary" id="cancel-stocktake">${isForceCloseCandidate ? 'Cancel (Force)' : 'Cancel Stocktake'}</button>` : ''}
      </div>
    </div>
  `;

  // A stocktake is counted on paper walking the shelves, then keyed in. An
  // OPEN session prints as a blank count sheet (counted column empty); a
  // CLOSED one prints as the signed variance record.
  Exporter.wireTableReport('stocktake', {
    title: s.status === 'OPEN' ? 'Stocktake Count Sheet' : 'Stocktake Variance Report',
    subtitle: `Started ${UI.shortDate(s.started_at)} by ${s.started_by_name || ''} · ${s.status}`,
    filename: `stocktake-${String(s.id).slice(0, 8)}`,
    columns: [
      { key: 'product_name', label: 'Product' },
      { key: 'batch_no', label: 'Batch' },
      { key: 'system_quantity', label: 'System Qty', align: 'right' },
      { key: 'counted_quantity', label: 'Counted Qty', align: 'right', format: (v) => (v == null ? '' : String(v)) },
      { key: 'variance', label: 'Variance', align: 'right', format: (v) => (v == null ? '' : (v > 0 ? `+${v}` : String(v))) },
    ],
    rows: s.lines,
    summary: [
      { label: 'Lines', value: String(s.lines.length) },
      { label: 'Counted', value: String(s.lines.filter((l) => l.counted_quantity != null).length) },
      { label: 'Net variance (units)', value: String(s.lines.reduce((a, l) => a + Number(l.variance || 0), 0)) },
    ],
    note: s.status === 'OPEN'
      ? 'Blank count sheet — record physical counts in the Counted Qty column, then key them in.'
      : 'Closed stocktake. Variances have been applied to stock and posted to the general ledger.',
    emptyMessage: 'No lines in this stocktake.',
  });

  view.querySelectorAll('[data-save-line]').forEach((btn) => UI.guardedClick(btn, async () => {
    const lineId = btn.dataset.saveLine;
    const input = view.querySelector(`[data-line="${lineId}"]`);
    const counted_quantity = Number(input.value);
    try {
      await Api.put(`/stocktakes/lines/${lineId}/count`, { counted_quantity });
      UI.toast('Count saved', 'success', 1500);
      renderStocktakeDetail(view, stocktakeId);
    } catch (e) { UI.toast(e.message, 'error'); }
  }));

  UI.guardedClick(document.getElementById('close-stocktake'), async () => {
    const forceCloseReasonEl = document.getElementById('force-close-reason');
    const force_reason = forceCloseReasonEl ? forceCloseReasonEl.value.trim() : undefined;
    if (isForceCloseCandidate && !force_reason) {
      UI.toast('A reason is required to force-close another user\'s stocktake.', 'error');
      return;
    }
    if (!confirm('Close this stocktake? Variances on counted lines will be applied as stock adjustments immediately.')) return;
    try {
      const result = await Api.post(`/stocktakes/${stocktakeId}/close`, { force_reason }, { allowOfflineQueue: false });
      UI.toast(`Stocktake closed. ${result.adjustments_created} adjustment(s) applied.`, 'success', 5000);
      renderStocktakeDetail(view, stocktakeId);
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  UI.guardedClick(document.getElementById('cancel-stocktake'), async () => {
    let reason;
    if (isForceCloseCandidate) {
      const forceCloseReasonEl = document.getElementById('force-close-reason');
      reason = forceCloseReasonEl ? forceCloseReasonEl.value.trim() : undefined;
      if (!reason) {
        UI.toast('A reason is required to cancel another user\'s stocktake.', 'error');
        return;
      }
    }
    if (!confirm('Cancel this stocktake entirely? No stock adjustments will be applied — this simply abandons the session.')) return;
    try {
      await Api.post(`/stocktakes/${stocktakeId}/cancel`, { reason }, { allowOfflineQueue: false });
      UI.toast('Stocktake cancelled — no stock was affected.', 'success', 4000);
      renderStocktakeDetail(view, stocktakeId);
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
// Describes how a batch was delivered, e.g. "10 cartons of 10 x 12".
// Batches received before this was recorded show "—", which is honest:
// nothing was captured for them and they fall back to the product default.
function arrivalLabel(b) {
  if (!b.received_unit) return '—';
  const n = (x) => Number(x).toLocaleString('en-NG');
  const count = b.received_unit_count != null ? n(b.received_unit_count) : '?';
  if (b.received_unit === 'PIECE') return `${count} pieces`;
  if (b.received_unit === 'PACK') return `${count} packs of ${n(b.units_per_pack_at_receipt)}`;
  return `${count} cartons of ${n(b.packs_per_carton_at_receipt)} x ${n(b.units_per_pack_at_receipt)}`;
}

