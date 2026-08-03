async function renderSuppliers(view) {
  // MANAGER-AND-ABOVE. The nav link is hidden for STAFF, but a hash URL
  // can still be typed or bookmarked, and the backend now refuses these
  // reads — so show a plain explanation instead of a screen full of
  // failed requests.
  if (!State.isManager()) {
    view.innerHTML = `<div class="card"><h2 class="page-title">Suppliers / Creditors</h2><p>This screen is available to managers and the owner. If you need something from it, ask your manager.</p></div>`;
    return;
  }
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const [suppliers, balances] = await Promise.all([
    Api.get('/suppliers'),
    Api.get(branchId ? `/creditors/balances?branch_id=${branchId}` : '/creditors/balances'),
  ]);
  // WHT rates applicable to payments OUT. Fails soft — a pharmacy that
  // does not withhold must still be able to pay its suppliers.
  let whtRates = [];
  try {
    whtRates = (await Api.get('/wht/rates')).filter((r) => r.is_active && r.direction !== 'RECEIVABLE');
  } catch (e) { /* older backend or transient error — the field simply hides */ }

  view.innerHTML = `
    <h2 class="page-title">Suppliers / Creditor Ledger</h2>
    <p class="page-subtitle">Track stock bought on credit and payments made to suppliers.</p>
    ${State.isManager() ? `
    <div class="card">
      <h3>Add Supplier</h3>
      <div class="form-inline">
        <div class="form-row"><label>Name</label><input id="sup-name" /></div>
        <div class="form-row"><label>Phone</label><input id="sup-phone" /></div>
        <div class="form-row"><label>Address</label><input id="sup-address" /></div>
        <button class="btn btn-primary" id="sup-add">Add</button>
      </div>
    </div>` : ''}
    <div class="card">
      <h3>Outstanding Balances Owed to Suppliers</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Supplier</th><th>Balance Owed</th><th></th></tr></thead>
          <tbody>
            ${balances.map(b => `
              <tr>
                <td>${UI.escapeHtml(b.supplier_name)}</td>
                <td style="color:var(--red-500)">${UI.money(b.balance_owed)}</td>
                <td>${State.isManager() ? `<button class="btn btn-secondary btn-sm" data-pay="${b.supplier_id}" data-name="${UI.escapeHtml(b.supplier_name)}" data-branch="${b.branch_id}">Record Payment</button>` : ''}</td>
              </tr>
            `).join('') || `<tr><td colspan="3" class="empty-state">No outstanding balances</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>All Suppliers</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th></th></tr></thead>
          <tbody>${suppliers.map(s => `<tr><td>${UI.escapeHtml(s.name)}</td><td>${UI.escapeHtml(s.phone || '—')}</td><td>${UI.escapeHtml(s.address || '—')}</td><td>${State.isManager() ? `<button class="btn btn-secondary btn-sm" data-edit-supplier="${s.id}">Edit</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="empty-state">No suppliers yet</td></tr>`}</tbody>
        </table>
      </div>
      ${Exporter.toolbar('suppliers', { label: 'the creditor ledger' })}
    </div>
  `;

  Exporter.wireToolbar('suppliers', {
    print: () => Exporter.printDocument(
      Exporter.documentHeader('Creditor Ledger', branchId ? 'Selected branch' : 'All branches')
      + `<div class="print-section"><h3>Outstanding Supplier Balances</h3>
          <table class="print-table">
            <thead><tr><th>Supplier</th><th style="text-align:right">Balance Owed</th></tr></thead>
            <tbody>${balances.length ? balances.map((b) => `<tr><td>${Exporter.escapeHtml(b.supplier_name)}</td><td style="text-align:right">${Exporter.escapeHtml(UI.money(b.balance_owed))}</td></tr>`).join('')
              : '<tr><td colspan="2" style="text-align:center">No outstanding supplier balances.</td></tr>'}</tbody>
          </table>
          <table class="print-summary"><tbody><tr><th>Total Owed to Suppliers</th>
            <td style="text-align:right">${Exporter.escapeHtml(UI.money(balances.reduce((a, b) => a + Number(b.balance_owed || 0), 0)))}</td></tr></tbody></table>
        </div>`
      + `<div class="print-section"><h3>Supplier Directory</h3>
          <table class="print-table">
            <thead><tr><th>Name</th><th>Phone</th><th>Address</th></tr></thead>
            <tbody>${suppliers.length ? suppliers.map((x) => `<tr><td>${Exporter.escapeHtml(x.name)}</td><td>${Exporter.escapeHtml(x.phone || '—')}</td><td>${Exporter.escapeHtml(x.address || '—')}</td></tr>`).join('')
              : '<tr><td colspan="3" style="text-align:center">No suppliers on file.</td></tr>'}</tbody>
          </table></div>`
      + Exporter.documentFooter(''),
      { title: 'Creditor Ledger' }
    ),
    csv: () => Exporter.downloadCSV('creditor-ledger',
      [ { key: 'supplier_name', label: 'Supplier' }, { key: 'phone', label: 'Phone' },
        { key: 'address', label: 'Address' }, { key: 'balance_owed', label: 'Balance Owed' } ],
      suppliers.map((x) => {
        const bal = balances.find((b) => b.supplier_id === x.id);
        return { supplier_name: x.name, phone: x.phone || '', address: x.address || '', balance_owed: bal ? bal.balance_owed : 0 };
      })),
  });

  UI.guardedClick(document.getElementById('sup-add'), async () => {
    const name = document.getElementById('sup-name').value.trim();
    if (!name) { UI.toast('Name required', 'error'); return; }
    try {
      await Api.post('/suppliers', { name, phone: document.getElementById('sup-phone').value, address: document.getElementById('sup-address').value }, { allowOfflineQueue: false });
      UI.toast('Supplier added', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  view.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', () => {
    // SECURITY: see the identical fix + explanation in views/customers.js —
    // btn.dataset.name is the raw, HTML-decoded supplier name and MUST be
    // re-escaped here before going into innerHTML, even though it was
    // already escaped once when written into the data-name attribute.
    const modal = UI.openModal(`
      <h3>Pay Supplier — ${UI.escapeHtml(btn.dataset.name)}</h3>
      <div class="form-row"><label>Amount owed being settled (gross)</label><input type="number" id="cpay-amount" min="1" /></div>
      ${whtRates.length ? `
      <div class="form-row">
        <label>Withholding tax</label>
        <select id="cpay-wht-rate">
          <option value="">None</option>
          ${whtRates.map((r) => `<option value="${UI.escapeHtml(r.code)}" data-rate="${r.rate_percent}">${UI.escapeHtml(r.name)} — ${r.rate_percent}%</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Supplier TIN <span style="font-weight:400;font-size:11px;">(for the credit note)</span></label><input id="cpay-wht-tin" /></div>
      <p id="cpay-wht-preview" style="margin:4px 0 0;font-size:12.5px;"></p>
      ` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cpay-cancel">Cancel</button>
        <button class="btn btn-primary" id="cpay-save">Save</button>
      </div>
    `);
    modal.querySelector('#cpay-cancel').addEventListener('click', () => UI.closeModal(modal));

    // LIVE SPLIT PREVIEW. The supplier's balance clears by the GROSS figure
    // entered above; only the cash leaving is reduced. Showing this before
    // the click prevents the commonest WHT mistake — entering the net and
    // leaving a permanent phantom balance on the supplier's account.
    const wr = modal.querySelector('#cpay-wht-rate');
    const wp = modal.querySelector('#cpay-wht-preview');
    function refreshPayPreview() {
      if (!wr || !wp) return;
      const amount = Number(modal.querySelector('#cpay-amount').value);
      const opt = wr.options[wr.selectedIndex];
      const pct = opt ? Number(opt.dataset.rate) : 0;
      if (!wr.value || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(pct) || pct <= 0) { wp.innerHTML = ''; return; }
      const gross = Math.round(amount * 100) / 100;
      const tax = Math.round(((gross * pct) / 100) * 100) / 100;
      const net = Math.round((gross - tax) * 100) / 100;
      wp.innerHTML = `Supplier's balance clears by <strong>${UI.money(gross)}</strong>. `
        + `You transfer <strong>${UI.money(net)}</strong> and owe the tax authority <strong>${UI.money(tax)}</strong>. `
        + `Give the supplier a WHT credit note for ${UI.money(tax)}.`;
    }
    if (wr) {
      wr.addEventListener('change', refreshPayPreview);
      modal.querySelector('#cpay-amount').addEventListener('input', refreshPayPreview);
    }

    UI.guardedClick(modal.querySelector('#cpay-save'), async () => {
      const amount = Number(modal.querySelector('#cpay-amount').value);
      if (!amount) { UI.toast('Enter an amount', 'error'); return; }
      try {
        // FUNCTIONAL BUG (found and fixed during a production audit): this
        // previously sent the page-level `branchId` (from State.getViewBranch,
        // which is undefined/null whenever a manager is viewing the org-wide "all
        // branches" balances list) instead of the SPECIFIC balance row's own
        // branch_id — meaning "Record Payment" always failed with a 400
        // ("branch_id and positive amount required") the moment a manager tried to
        // use it from the all-branches view, which is the view's own default
        // landing state. Since the same supplier can independently owe money at
        // more than one branch (v_creditor_balances is grouped by branch_id AND
        // supplier_id — see the write-up below), the button now carries its own
        // row's exact branch_id via `data-branch`, set when the balances table is
        // rendered above, so paying down one specific branch's balance always
        // works regardless of which branch (if any) is currently selected in the
        // top-level branch switcher.
        const paid = await Api.post(`/creditors/${btn.dataset.pay}/payments`, {
          amount,
          notes: modal.querySelector('#cpay-notes').value,
          branch_id: btn.dataset.branch,
          wht_rate_code: wr && wr.value ? wr.value : undefined,
          wht_counterparty_tin: (modal.querySelector('#cpay-wht-tin') || {}).value || undefined,
        }, { allowOfflineQueue: false });
        if (paid && paid.wht) {
          UI.toast(`Settled ${UI.money(paid.wht.gross_amount)} — paid ${UI.money(paid.wht.net_paid)}, withheld ${UI.money(paid.wht.wht_amount)}`, 'success');
        } else {
          UI.toast('Payment recorded', 'success');
        }
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }));

  // FUNCTIONAL GAP CLOSED (found during a production audit): the
  // backend has always fully supported editing a supplier's name/
  // phone/address (PUT /api/suppliers/:id, manager-gated, identical on
  // both deployments) but this screen previously only ever offered
  // "Add Supplier" — a manager correcting a typo'd name or updating a
  // supplier's phone/address after they moved had no UI path to do so.
  view.querySelectorAll('[data-edit-supplier]').forEach((btn) => btn.addEventListener('click', () => {
    const supplier = suppliers.find((s) => s.id === btn.dataset.editSupplier);
    openEditSupplierModal(supplier);
  }));
}

function openEditSupplierModal(supplier) {
  const modal = UI.openModal(`
    <h3>Edit Supplier — ${UI.escapeHtml(supplier.name)}</h3>
    <div class="form-row"><label>Name</label><input id="es-name" value="${UI.escapeHtml(supplier.name)}" /></div>
    <div class="form-row"><label>Phone</label><input id="es-phone" value="${UI.escapeHtml(supplier.phone || '')}" /></div>
    <div class="form-row"><label>Address</label><input id="es-address" value="${UI.escapeHtml(supplier.address || '')}" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="es-cancel">Cancel</button>
      <button class="btn btn-primary" id="es-save">Save</button>
    </div>
  `);
  modal.querySelector('#es-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#es-save'), async () => {
    const name = modal.querySelector('#es-name').value.trim();
    if (!name) { UI.toast('Name is required', 'error'); return; }
    try {
      await Api.put(`/suppliers/${supplier.id}`, {
        name,
        phone: modal.querySelector('#es-phone').value.trim() || null,
        address: modal.querySelector('#es-address').value.trim() || null,
      }, { allowOfflineQueue: false });
      UI.toast('Supplier updated', 'success');
      UI.closeModal(modal);
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
