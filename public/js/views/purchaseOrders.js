async function renderPurchaseOrders(view, path) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const parts = path.split('/');
  const poId = parts[2];
  if (poId) return renderPoDetail(view, poId);

  const scopeQuery = branchId ? `?branch_id=${branchId}` : '';
  const [pos, suppliers, products] = await Promise.all([
    Api.get(`/purchase-orders${scopeQuery}`),
    Api.get('/suppliers'),
    Api.get('/products'),
  ]);

  view.innerHTML = `
    <h2 class="page-title">Purchase Orders</h2>
    <p class="page-subtitle">Order stock from suppliers, then receive it into batch-tracked inventory.</p>
    <div class="card">
      <h3>New Purchase Order</h3>
      <div class="form-inline">
        <div class="form-row">
          <label>Supplier</label>
          <select id="po-supplier"><option value="">— none / cash purchase —</option>${suppliers.map(s => `<option value="${s.id}">${UI.escapeHtml(s.name)}</option>`).join('')}</select>
        </div>
        <div class="form-row">
          <label>Notes</label>
          <input id="po-notes" />
        </div>
      </div>
      <div id="po-items"></div>
      <button class="btn btn-secondary btn-sm" id="po-add-item" style="margin-top:8px;">+ Add product line</button>
      <div style="margin-top:14px;"><button class="btn btn-primary" id="po-create">Create Purchase Order</button></div>
    </div>
    <div class="card">
      <h3>Existing Orders</h3>
      <div class="table-wrap">
        <table>
          <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Supplier</th><th>Status</th><th>Ordered</th><th></th></tr></thead>
          <tbody>
            ${pos.map(p => `
              <tr>
                ${branchId ? '' : `<td>${UI.escapeHtml(p.branch_name)}</td>`}
                <td>${UI.escapeHtml(p.supplier_name || 'N/A')}</td>
                <td>${UI.badge(p.status, p.status === 'RECEIVED' ? 'green' : p.status === 'CANCELLED' ? 'red' : 'amber')}</td>
                <td>${UI.shortDate(p.ordered_at)}</td>
                <td><a class="btn btn-secondary btn-sm" href="#/purchase-orders/${p.id}">View</a></td>
              </tr>
            `).join('') || `<tr><td colspan="5" class="empty-state">No purchase orders yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  let itemRows = [{ product_id: '', quantity_ordered: 1, expected_unit_cost: '' }];
  function renderItems() {
    document.getElementById('po-items').innerHTML = itemRows.map((row, idx) => `
      <div class="form-inline" style="margin-top:8px;">
        <div class="form-row">
          <label>Product</label>
          <select data-item-product="${idx}"><option value="">Select…</option>${products.map(p => `<option value="${p.id}" ${row.product_id === p.id ? 'selected' : ''}>${UI.escapeHtml(p.name)}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Qty (base units)</label><input type="number" min="1" step="1" data-item-qty="${idx}" value="${row.quantity_ordered}" /></div>
        <div class="form-row"><label>Expected unit cost</label><input type="number" min="0" data-item-cost="${idx}" value="${row.expected_unit_cost}" /></div>
        ${itemRows.length > 1 ? `<button class="remove-line" data-item-remove="${idx}">✕</button>` : ''}
      </div>
    `).join('');
    document.querySelectorAll('[data-item-product]').forEach(el => el.addEventListener('change', () => { itemRows[el.dataset.itemProduct].product_id = el.value; }));
    document.querySelectorAll('[data-item-qty]').forEach(el => el.addEventListener('input', () => { itemRows[el.dataset.itemQty].quantity_ordered = Number(el.value); }));
    document.querySelectorAll('[data-item-cost]').forEach(el => el.addEventListener('input', () => { itemRows[el.dataset.itemCost].expected_unit_cost = Number(el.value); }));
    document.querySelectorAll('[data-item-remove]').forEach(el => el.addEventListener('click', () => { itemRows.splice(Number(el.dataset.itemRemove), 1); renderItems(); }));
  }
  renderItems();
  // FRONT-TO-BACK ALIGNMENT: the server hard-caps a purchase order at
  // MAX_PO_ITEMS (200) line items and refuses anything larger with
  // HTTP 413 / PO_ITEMS_TOO_MANY (see worker/src/routes/purchaseOrders.js
  // and worker/src/lib/d1Limits.js for why the cap exists — Cloudflare
  // Workers Free-plan subrequest and D1 bound-parameter ceilings). The
  // UI stops the buyer at the same number rather than letting them type
  // out a 250-line order and only discover the refusal on submit.
  const MAX_PO_ITEMS = 200;
  document.getElementById('po-add-item').addEventListener('click', () => {
    if (itemRows.length >= MAX_PO_ITEMS) {
      UI.toast(`A single purchase order is limited to ${MAX_PO_ITEMS} line items — raise the rest as a second order.`, 'error');
      return;
    }
    itemRows.push({ product_id: '', quantity_ordered: 1, expected_unit_cost: '' }); renderItems();
  });

  UI.guardedClick(document.getElementById('po-create'), async () => {
    const items = itemRows.filter(r => r.product_id);
    if (!items.length) { UI.toast('Add at least one product line', 'error'); return; }
    try {
      const po = await Api.post('/purchase-orders', {
        branch_id: branchId,
        supplier_id: document.getElementById('po-supplier').value || undefined,
        notes: document.getElementById('po-notes').value,
        items,
      }, { allowOfflineQueue: false });
      UI.toast('Purchase order created', 'success');
      location.hash = `#/purchase-orders/${po.id}`;
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}

async function renderPoDetail(view, poId) {
  const po = await Api.get(`/purchase-orders/${poId}`);
  const statusColor = po.status === 'RECEIVED' ? 'green' : po.status === 'CANCELLED' ? 'red' : po.status === 'PARTIALLY_RECEIVED' ? 'amber' : 'amber';
  view.innerHTML = `
    <a href="#/purchase-orders" style="font-size:12px;color:var(--green-700);">← Back to purchase orders</a>
    <h2 class="page-title">Purchase Order — ${UI.badge(po.status, statusColor)}</h2>
    <p class="page-subtitle">Ordered ${UI.shortDate(po.ordered_at)}</p>
    <div class="card">
      <h3>Items Ordered</h3>
      ${Exporter.toolbar('po-detail', { label: 'this purchase order' })}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Qty Ordered</th><th>Qty Received</th><th>Remaining</th><th>Expected Cost</th></tr></thead>
          <tbody>${po.items.map(i => `<tr><td>${UI.escapeHtml(i.product_name)}</td><td>${i.quantity_ordered}</td><td>${i.quantity_received || 0}</td><td>${i.quantity_ordered - (i.quantity_received || 0)}</td><td>${i.expected_unit_cost != null ? UI.money(i.expected_unit_cost) : '—'}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    ${po.receipts && po.receipts.length ? `
    <div class="card">
      <h3>Receiving History</h3>
      <p class="page-subtitle">Every delivery recorded against this order — a supplier shipping in multiple lots (partial deliveries) shows one row per delivery here.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Received</th><th>By</th><th>Cost Total</th><th>On Credit</th></tr></thead>
          <tbody>${po.receipts.map(r => `<tr><td>${UI.shortDate(r.received_at)}</td><td>${UI.escapeHtml(r.received_by_name || '—')}</td><td>${UI.money(r.total_cost)}</td><td>${r.on_credit ? UI.badge('Yes', 'amber') : UI.badge('No', 'gray')}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}
    ${po.status === 'PENDING' && State.isManager() ? `
    <div class="card" style="border-left:4px solid var(--amber-500);">
      <h3>Cancel this order</h3>
      <p class="page-subtitle">Nothing has been received against this order yet. Cancel it if the supplier cannot fulfil it, so it stops counting as stock you are still expecting. Once any goods arrive it can no longer be cancelled.</p>
      <div class="form-inline">
        <div class="form-row" style="min-width:280px;">
          <label>Reason (required)</label>
          <input id="po-cancel-reason" placeholder="e.g. Supplier out of stock; reordering elsewhere" />
        </div>
        <button class="btn btn-danger" id="po-cancel-btn">Cancel Order</button>
      </div>
    </div>` : ''}
    ${po.status !== 'RECEIVED' && po.status !== 'CANCELLED' ? `
    <div class="card">
      <h3>Receive Stock</h3>
      <p class="page-subtitle">${po.status === 'PARTIALLY_RECEIVED' ? 'This order has already been partially received — record another delivery below for whatever arrives now (only the REMAINING unreceived quantity per line can be accepted).' : 'Record actual batch numbers, expiry dates, and prices as goods arrive. This creates new batch-tracked stock. If only part of the order has arrived, receive just that quantity now — you can record the rest in a later delivery.'}</p>
      <div id="receive-items"></div>
      <button class="btn btn-secondary btn-sm" id="receive-add-batch" style="margin-top:8px;">+ Add batch line</button>
      <div class="form-row" style="margin-top:10px;"><label><input type="checkbox" id="receive-on-credit" style="width:auto;display:inline;margin-right:6px;" />Received on supplier credit (adds to creditor ledger)</label></div>
      <button class="btn btn-primary" id="receive-submit" style="margin-top:10px;">Confirm Receipt</button>
    </div>` : ''}
  `;

  Exporter.wireToolbar('po-detail', {
    print: () => Exporter.printDocument(
      Exporter.documentHeader('Purchase Order', `${po.supplier_name || ''} · ${po.branch_name || ''}`)
      + `<table class="print-summary" style="margin:0 0 10px 0;"><tbody>
           <tr><th>PO Number</th><td>${Exporter.escapeHtml(String(po.id).slice(0, 8).toUpperCase())}</td></tr>
           <tr><th>Ordered</th><td>${Exporter.escapeHtml(UI.shortDate(po.ordered_at))}</td></tr>
           <tr><th>Supplier</th><td>${Exporter.escapeHtml(po.supplier_name || '—')}</td></tr>
           <tr><th>Status</th><td>${Exporter.escapeHtml(po.status)}</td></tr>
         </tbody></table>`
      + `<div class="print-section"><h3>Items Ordered</h3>
          <table class="print-table">
            <thead><tr><th>Product</th><th style="text-align:right">Ordered</th><th style="text-align:right">Received</th><th style="text-align:right">Remaining</th><th style="text-align:right">Expected Unit Cost</th></tr></thead>
            <tbody>${po.items.map((i) => `<tr>
              <td>${Exporter.escapeHtml(i.product_name)}</td>
              <td style="text-align:right">${i.quantity_ordered}</td>
              <td style="text-align:right">${i.quantity_received || 0}</td>
              <td style="text-align:right">${i.quantity_ordered - (i.quantity_received || 0)}</td>
              <td style="text-align:right">${i.expected_unit_cost != null ? Exporter.escapeHtml(UI.money(i.expected_unit_cost)) : '—'}</td>
            </tr>`).join('')}</tbody>
          </table></div>`
      + (po.receipts && po.receipts.length ? `<div class="print-section"><h3>Receiving History</h3>
          <table class="print-table">
            <thead><tr><th>Received</th><th>By</th><th style="text-align:right">Cost Total</th><th>On Credit</th></tr></thead>
            <tbody>${po.receipts.map((r) => `<tr>
              <td>${Exporter.escapeHtml(UI.shortDate(r.received_at))}</td>
              <td>${Exporter.escapeHtml(r.received_by_name || '—')}</td>
              <td style="text-align:right">${Exporter.escapeHtml(UI.money(r.total_cost))}</td>
              <td>${r.on_credit ? 'Yes' : 'No'}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : '')
      + `<table class="print-summary"><tbody>
           <tr><th>Expected Order Value</th><td style="text-align:right">${Exporter.escapeHtml(UI.money(po.items.reduce((a, i) => a + Number(i.quantity_ordered || 0) * Number(i.expected_unit_cost || 0), 0)))}</td></tr>
         </tbody></table>`
      + Exporter.documentFooter('Goods must be checked against this order on delivery.'),
      { title: `Purchase Order ${String(po.id).slice(0, 8)}` }
    ),
    csv: () => Exporter.downloadCSV(`purchase-order-${String(po.id).slice(0, 8)}`,
      [ { key: 'product_name', label: 'Product' }, { key: 'quantity_ordered', label: 'Qty Ordered' },
        { key: 'quantity_received', label: 'Qty Received' }, { key: 'expected_unit_cost', label: 'Expected Unit Cost' } ],
      po.items.map((i) => ({ ...i, quantity_received: i.quantity_received || 0 }))),
  });

  // BUG 54: `CANCELLED` was a designed PO status that no route could set
  // and no screen offered — the receive route already refused a cancelled
  // order, but nothing could ever put one in that state. A supplier that
  // cannot fulfil left the order PENDING forever, overstating incoming
  // stock in every reorder decision.
  UI.guardedClick(document.getElementById('po-cancel-btn'), async () => {
    const el = document.getElementById('po-cancel-reason');
    const reason = (el && el.value ? el.value : '').trim();
    if (reason.length < 4) {
      UI.toast('Give a reason for cancelling — it is the only record of why goods that were ordered never arrived.', 'error', 6000);
      return;
    }
    try {
      await Api.post(`/purchase-orders/${po.id}/cancel`, { reason }, { allowOfflineQueue: false });
      UI.toast('Purchase order cancelled', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error', 6000); }
  });

  if (po.status !== 'RECEIVED' && po.status !== 'CANCELLED') {
    // Only pre-fill lines that still have quantity remaining to
    // receive (a partially-received PO may have some lines already
    // fully delivered), and default the quantity to what REMAINS, not
    // the full original quantity_ordered — a real bug this partial-
    // receiving feature specifically closes: pre-filling the full
    // ordered amount on a second/third delivery would silently invite
    // an over-receive rejection on every partial delivery after the
    // first.
    let batchRows = po.items
      .filter(i => (i.quantity_ordered - (i.quantity_received || 0)) > 0)
      .map(i => ({ product_id: i.product_id, product_name: i.product_name, batch_no: '', expiry_date: '', receive_unit: 'CARTON', receive_quantity: 1, packs_per_carton: '', units_per_pack: '', total_cost: '', selling_pattern: 'PIECE', quantity_received: i.quantity_ordered - (i.quantity_received || 0), cost_price_per_unit: i.expected_unit_cost || '', selling_price_per_unit: '', pack_price: '', carton_price: '' }));
    // SECURITY (found and fixed during this audit): `batch_no` is a
    // free-text field the user types directly into the Batch No. input
    // below, then this function re-renders the WHOLE list (e.g. when a
    // line is added/removed) by re-injecting every row's current values
    // — including batch_no — straight back into `value="${...}"`
    // attributes via innerHTML with no escaping. A value like
    // `" onfocus="..." autofocus x="` breaks out of the `value="..."`
    // attribute and injects live `onfocus`/`autofocus` attributes onto
    // the real `<input>` element the browser creates — `autofocus`
    // fires the injected handler immediately with no user interaction
    // needed beyond typing the value and triggering ANY re-render
    // (verified live with jsdom). This is a self-XSS in this specific
    // instance (only the typing user's own input round-trips back to
    // them), but is fixed anyway for defense-in-depth consistency with
    // every other free-text field in this codebase, and because a
    // future feature (e.g. showing another user's in-progress draft)
    // could turn this into a genuine stored/reflected XSS on the exact
    // same code path.
    // Minimum selectable expiry. Uses WAT (UTC+1, no DST) to match the
    // backend's own boundary check, so a batch expiring "today" in Lagos is
    // not rejected client-side while the server would accept it.
    const todayIso = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

    function renderBatches() {
      document.getElementById('receive-items').innerHTML = batchRows.map((r, idx) => `
        <div class="card" style="background:var(--gray-50);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <b>${UI.escapeHtml(r.product_name)}</b>
            ${batchRows.length > 1 ? `<button class="remove-line" data-b-remove="${idx}" aria-label="Remove batch line">✕</button>` : ''}
          </div>
          <div class="form-inline" style="margin-top:8px;">
            <div class="form-row"><label>Batch No. <span style="color:var(--red-500)">*</span></label>
              <input data-b-batch="${idx}" value="${UI.escapeHtml(r.batch_no)}" placeholder="e.g. PDX-24A" ${r.no_expiry ? '' : 'required'} /></div>
            <div class="form-row"><label>Expiry Date <span style="color:var(--red-500)">*</span></label>
              <input type="date" data-b-expiry="${idx}" value="${UI.escapeHtml(r.expiry_date)}" min="${todayIso}" ${r.no_expiry ? 'disabled' : 'required'} /></div>
          </div>
          <!-- BUG 112 — RECEIVE IN THE UNIT THE DELIVERY ARRIVED IN.
               A supplier delivers "10 cartons, 10 packs to a carton, 10 to a
               pack" and invoices one total. This used to demand base units
               only, so the storekeeper multiplied it out by hand at the
               delivery door. Now: pick the unit, then only the questions that
               unit actually raises appear, and the conversion is shown live
               before anything is saved. -->
          <div class="form-inline" style="margin-top:6px;">
            <div class="form-row"><label>Arrived as</label>
              <select data-b-unit="${idx}">
                <option value="CARTON" ${r.receive_unit === 'CARTON' ? 'selected' : ''}>Cartons</option>
                <option value="PACK"   ${r.receive_unit === 'PACK' ? 'selected' : ''}>Packs</option>
                <option value="PIECE"  ${r.receive_unit === 'PIECE' ? 'selected' : ''}>Pieces</option>
              </select></div>
            <div class="form-row"><label>How many ${r.receive_unit === 'CARTON' ? 'cartons' : r.receive_unit === 'PACK' ? 'packs' : 'pieces'}?</label>
              <input type="number" data-b-count="${idx}" value="${r.receive_quantity}" min="1" step="1" /></div>
            ${r.receive_unit === 'CARTON' ? `
            <div class="form-row"><label>Packs in a carton</label>
              <input type="number" data-b-ppc="${idx}" value="${r.packs_per_carton || ''}" min="1" step="1" /></div>` : ''}
            ${r.receive_unit === 'CARTON' || r.receive_unit === 'PACK' ? `
            <div class="form-row"><label>Pieces in a pack</label>
              <input type="number" data-b-upp="${idx}" value="${r.units_per_pack || ''}" min="1" step="1" /></div>` : ''}
          </div>
          <div class="form-inline">
            <div class="form-row"><label>Total paid for this line</label>
              <input type="number" data-b-total="${idx}" value="${r.total_cost}" placeholder="the figure on the invoice" /></div>
            <div class="form-row"><label>Sold over the counter as</label>
              <select data-b-pattern="${idx}">
                <option value="PIECE"  ${r.selling_pattern === 'PIECE' ? 'selected' : ''}>Pieces</option>
                <option value="PACK"   ${r.selling_pattern === 'PACK' ? 'selected' : ''}>Packs</option>
                <option value="CARTON" ${r.selling_pattern === 'CARTON' ? 'selected' : ''}>Cartons</option>
              </select></div>
          </div>
          <div class="receive-preview" data-b-preview="${idx}"></div>
          <div class="form-row" style="margin-top:-4px;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
              <input type="checkbox" data-b-noexp="${idx}" ${r.no_expiry ? 'checked' : ''} style="width:auto;display:inline;" />
              This item does not expire (device, dressing, sundry — not a medicine)
            </label>
          </div>
          <div class="form-inline">
            <div class="form-row"><label>Selling price per piece</label><input type="number" data-b-sell="${idx}" value="${r.selling_price_per_unit}" placeholder="can be set later" /></div>
            <div class="form-row"><label>Pack price (optional)</label><input type="number" data-b-pack="${idx}" value="${r.pack_price}" placeholder="derived if left blank" /></div>
            <div class="form-row"><label>Carton price (optional)</label><input type="number" data-b-carton="${idx}" value="${r.carton_price}" placeholder="derived if left blank" /></div>
          </div>
        </div>
      `).join('');
      // Ticking "does not expire" is an EXPLICIT recorded decision, not an
      // empty field — the backend distinguishes the two (see lib/stockEntry.js).
      document.querySelectorAll('[data-b-noexp]').forEach(el => el.addEventListener('change', () => {
        const row = batchRows[el.dataset.bNoexp];
        row.no_expiry = el.checked;
        if (el.checked) row.expiry_date = '';
        renderBatches();
      }));
      document.querySelectorAll('[data-b-batch]').forEach(el => el.addEventListener('input', () => batchRows[el.dataset.bBatch].batch_no = el.value));
      document.querySelectorAll('[data-b-expiry]').forEach(el => el.addEventListener('input', () => batchRows[el.dataset.bExpiry].expiry_date = el.value));
      // Bug 112 — the unit picker. Changing the UNIT re-renders, because the
      // questions that follow it change; the other fields update in place and
      // only refresh the preview, so typing is never interrupted.
      document.querySelectorAll('[data-b-unit]').forEach(el => el.addEventListener('change', () => {
        const row = batchRows[el.dataset.bUnit];
        row.receive_unit = el.value;
        // A selling pattern the new unit cannot support would be rejected by
        // the server; step it down here so the form never offers an
        // impossible combination in the first place.
        if (row.receive_unit === 'PIECE') row.selling_pattern = 'PIECE';
        else if (row.receive_unit === 'PACK' && row.selling_pattern === 'CARTON') row.selling_pattern = 'PACK';
        renderBatches();
      }));
      const liveFields = [
        ['data-b-count', 'bCount', 'receive_quantity', Number],
        ['data-b-ppc', 'bPpc', 'packs_per_carton', Number],
        ['data-b-upp', 'bUpp', 'units_per_pack', Number],
        ['data-b-total', 'bTotal', 'total_cost', Number],
      ];
      liveFields.forEach(([attr, key, prop, cast]) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => el.addEventListener('input', () => {
          batchRows[el.dataset[key]][prop] = el.value === '' ? '' : cast(el.value);
          updatePreview(el.dataset[key]);
        }));
      });
      document.querySelectorAll('[data-b-pattern]').forEach(el => el.addEventListener('change', () => {
        batchRows[el.dataset.bPattern].selling_pattern = el.value;
        updatePreview(el.dataset.bPattern);
      }));
      document.querySelectorAll('[data-b-sell]').forEach(el => el.addEventListener('input', () => batchRows[el.dataset.bSell].selling_price_per_unit = Number(el.value)));
      document.querySelectorAll('[data-b-pack]').forEach(el => el.addEventListener('input', () => batchRows[el.dataset.bPack].pack_price = el.value ? Number(el.value) : null));
      document.querySelectorAll('[data-b-carton]').forEach(el => el.addEventListener('input', () => batchRows[el.dataset.bCarton].carton_price = el.value ? Number(el.value) : null));
      document.querySelectorAll('[data-b-remove]').forEach(el => el.addEventListener('click', () => { batchRows.splice(Number(el.dataset.bRemove), 1); renderBatches(); }));
      batchRows.forEach((_, i) => updatePreview(i));
    }

    // LIVE CONVERSION. Shows what will actually be stored, and what each
    // carton/pack/piece cost, BEFORE the operator commits.
    //
    // The arithmetic deliberately mirrors worker/src/lib/receiving.js rather
    // than inventing its own: a preview that says 1,000 while the server
    // stores 10 is precisely the bug this feature exists to end. The SERVER
    // remains the authority — this only shows the same sum early.
    function updatePreview(idx) {
      const el = document.querySelector(`[data-b-preview="${idx}"]`);
      if (!el) return;
      const r = batchRows[idx];
      const unit = r.receive_unit || 'PIECE';
      const count = Number(r.receive_quantity) || 0;
      const upp = unit === 'PIECE' ? 1 : (Number(r.units_per_pack) || 0);
      const ppc = unit === 'CARTON' ? (Number(r.packs_per_carton) || 0) : 1;
      if (count <= 0 || (unit !== 'PIECE' && upp <= 0) || (unit === 'CARTON' && ppc <= 0)) {
        el.innerHTML = '<span class="rp-wait">Fill in the quantities above to see the conversion.</span>';
        return;
      }
      const pieces = count * upp * ppc;
      const total = Number(r.total_cost) || 0;
      const perPiece = pieces > 0 ? total / pieces : 0;
      const money = (v) => UI.money(Math.round(v * 100) / 100);
      const sum = unit === 'CARTON'
        ? `${count.toLocaleString()} cartons &times; ${ppc.toLocaleString()} packs &times; ${upp.toLocaleString()} pieces`
        : unit === 'PACK'
          ? `${count.toLocaleString()} packs &times; ${upp.toLocaleString()} pieces`
          : `${count.toLocaleString()} pieces`;
      el.innerHTML = `<strong>${sum} = ${pieces.toLocaleString()} pieces</strong> onto the shelf`
        + (total > 0
          ? ` &middot; cost ${money(perPiece)}/piece`
            + (unit !== 'PIECE' ? ` &middot; ${money(perPiece * upp)}/pack` : '')
            + (unit === 'CARTON' ? ` &middot; ${money(perPiece * upp * ppc)}/carton` : '')
          : ' &middot; <span class="rp-wait">enter the total paid to work out unit costs</span>');
    }
    renderBatches();

    document.getElementById('receive-add-batch').addEventListener('click', () => {
      // Adds an extra batch line for splitting a single ordered product
      // across multiple batches/expiry dates (common when a delivery
      // arrives in more than one lot).
      const first = po.items[0];
      batchRows.push({ product_id: first.product_id, product_name: first.product_name, batch_no: '', expiry_date: '', receive_unit: 'CARTON', receive_quantity: 1, packs_per_carton: '', units_per_pack: '', total_cost: '', selling_pattern: 'PIECE', quantity_received: 1, cost_price_per_unit: '', selling_price_per_unit: '', pack_price: '', carton_price: '' });
      renderBatches();
    });

    UI.guardedClick(document.getElementById('receive-submit'), async () => {
      // BUG FOUND AND FIXED during this audit pass: an empty Pack
      // Price / Carton Price field (left blank, the normal/common
      // case for a batch with no pack/carton pricing) round-tripped as
      // the literal string '' here, not `null` — and the backend's
      // `pack_price != null` check treats a non-null EMPTY STRING as
      // "the caller explicitly provided a value", which then fails
      // `Number.isFinite('')` and rejects the entire receive with a
      // confusing "pack_price must be a non-negative number" error —
      // even though the user never touched that field at all. This
      // was invisible in the pre-existing race-condition test (which
      // deliberately triggers a 409 before ever reaching this code
      // path) but is fully reachable on any ordinary, successful
      // receive. Fixed by normalizing blank pack/carton price fields
      // to `null` before sending, matching what the backend's own
      // validation already expects for "not provided".
      // Bug 112: send the delivery AS RECEIVED. The server converts to base
      // units and derives the unit costs from the invoice total — the same
      // arithmetic the preview showed, computed by the authority rather than
      // trusted from the browser.
      //
      // The old filter required a per-unit cost, which no longer exists as an
      // input; the line is now complete once it has a quantity and a total.
      // A selling price may legitimately be left for later ("a place to later
      // set the selling price"), so it is no longer required here — the batch
      // lands with 0 and the shelf price is set on the Stock screen.
      const batches = batchRows
        .filter(r => Number(r.receive_quantity) > 0 && r.total_cost !== '' && Number(r.total_cost) >= 0)
        .map(r => ({
          product_id: r.product_id, batch_no: r.batch_no, expiry_date: r.expiry_date,
          no_expiry: !!r.no_expiry,
          receive_unit: r.receive_unit,
          receive_quantity: Number(r.receive_quantity),
          units_per_pack: r.units_per_pack === '' ? undefined : Number(r.units_per_pack),
          packs_per_carton: r.packs_per_carton === '' ? undefined : Number(r.packs_per_carton),
          total_cost: Number(r.total_cost),
          selling_pattern: r.selling_pattern || 'PIECE',
          selling_price_per_unit: r.selling_price_per_unit === '' ? 0 : Number(r.selling_price_per_unit),
          pack_price: r.pack_price === '' ? null : r.pack_price,
          carton_price: r.carton_price === '' ? null : r.carton_price,
        }));
      if (!batches.length) { UI.toast('Enter how much arrived and the total paid for at least one line', 'error'); return; }

      // DISPENSING-SAFETY pre-check. The backend enforces this authoritatively
      // (lib/stockEntry.js) — this mirror exists so the storekeeper sees which
      // line is wrong immediately, instead of one server error for a form with
      // eight batch rows on it.
      for (const b of batches) {
        const name = (batchRows.find(r => r.product_id === b.product_id) || {}).product_name || 'this item';
        if (!b.no_expiry) {
          if (!b.expiry_date) {
            UI.toast(`Expiry date is required for ${name}. Without it this stock can never be flagged as expired or blocked from sale. Tick "does not expire" only for non-medicines.`, 'error', 8000);
            return;
          }
          if (b.expiry_date.slice(0, 10) < todayIso) {
            UI.toast(`Expiry date for ${name} is in the past. Do not receive expired stock into sellable inventory.`, 'error', 8000);
            return;
          }
          if (!String(b.batch_no || '').trim()) {
            UI.toast(`Batch number is required for ${name} — NAFDAC recalls are issued by batch number.`, 'error', 8000);
            return;
          }
        }
      }
      try {
        await Api.post(`/purchase-orders/${poId}/receive`, { batches, on_credit: document.getElementById('receive-on-credit').checked }, { allowOfflineQueue: false });
        UI.toast('Stock received', 'success');
        renderPoDetail(view, poId);
      } catch (e) {
        UI.toast(e.message, 'error');
        // FUNCTIONAL GAP (found during this audit pass): a 409
        // PO_NOT_RECEIVABLE — e.g. this exact PO was just received by
        // someone else on another device a moment ago, or this is a
        // stale double-click racing against an already-in-flight
        // request — previously left the stale "Receive Stock" form on
        // screen showing the OLD (still-PENDING-looking) state, with
        // nothing stopping the user from immediately retrying against
        // a PO that has, in reality, already moved on. Re-fetching and
        // re-rendering the real current PO state after ANY receive
        // failure (not just this specific code) means the screen
        // always reflects reality — if it's now RECEIVED, the whole
        // "Receive Stock" form correctly disappears instead of
        // inviting a confused repeat attempt.
        if (e.code === 'PO_NOT_RECEIVABLE') renderPoDetail(view, poId);
      }
    });
  }
}
// Products (master catalog) management screen.
//
// FUNCTIONAL GAP CLOSED (found during a production audit — "does the
// frontend use 100% of what the backend supports?"): the backend has
// always fully supported creating, editing, soft-deleting a product,
// and setting a branch-level default price override
// (POST/PUT/DELETE /api/products, PUT /api/products/:id/price-override/
// :branchId — implemented identically and manager-gated on BOTH
// deployment targets, and heavily covered by backend integration
// tests), but there was NO screen anywhere in the frontend to reach any
// of it. The only place `GET /api/products` was ever called was to
// POPULATE a dropdown inside the Purchase Orders screen — there was
// literally no way for a client to add a brand-new product to their
// own catalog through the app at all. A paying client would have been
// permanently stuck with only the demo-seeded product list, unable to
// add their own real inventory items — a showstopper gap for a system
// whose entire purpose is managing a pharmacy's product catalog.
