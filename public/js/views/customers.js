async function renderCustomers(view) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const customers = await Api.get(branchId ? `/customers?branch_id=${branchId}` : '/customers');

  view.innerHTML = `
    <h2 class="page-title">Customers / Debtor Ledger</h2>
    <p class="page-subtitle">Track credit sales and repayments per customer — balances are derived from the append-only debtor ledger.</p>
    ${Exporter.toolbar('customers', { label: 'the debtor ledger' })}
    <div class="card">
      <h3>Add Customer</h3>
      <div class="form-inline">
        <div class="form-row"><label>Name</label><input id="cust-name" /></div>
        <div class="form-row"><label>Phone</label><input id="cust-phone" /></div>
        <div class="form-row"><label>ID Type</label><input id="cust-idtype" placeholder="NIN / Voter's card" /></div>
        <div class="form-row"><label>ID Number</label><input id="cust-idnum" /></div>
        <button class="btn btn-primary" id="cust-add">Add</button>
      </div>
    </div>
    <div class="card">
      <h3>Customers</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Balance Owed</th><th>Credit Limit</th><th></th></tr></thead>
          <tbody id="customers-tbody"><tr><td colspan="5" class="empty-state">Loading balances…</td></tr></tbody>
        </table>
      </div>
    </div>
    <!-- BUG 95 — CHANGE WE OWE CUSTOMERS.
         Deliberately visible to STAFF, unlike the debtor aging block below.
         The person who meets the returning customer IS the cashier, usually
         alone and often not the one who took the original sale. Putting this
         behind a manager would guarantee the cashier pays out of the drawer
         and tells nobody, which is the untracked state this feature exists to
         end. Placed above the aging report because it is used far more often
         and by more people. -->
    <div class="card">
      <h3>Change We Owe Customers</h3>
      <p class="page-subtitle">When there was no note to give as change, the money stays in the till and the
        customer keeps a 7-digit claim code. Search by that code, or by their name or phone number if the slip is lost.</p>
      <div class="form-inline">
        <div class="form-row">
          <label>Claim code, name or phone</label>
          <input id="co-search" placeholder="e.g. 3884284, or Adaeze, or 08031234567" autocomplete="off" />
        </div>
        <button class="btn btn-secondary" id="co-search-btn">Search</button>
        <button class="btn btn-ghost" id="co-show-all">Show all outstanding</button>
      </div>
      <div id="co-content" class="empty-state" style="margin-top:10px;">Loading…</div>
    </div>
    ${State.isManager() ? `
    <div class="card">
      <h3>Debtor Aging</h3>
      <p class="page-subtitle">How OLD each debt is, not just how large. A balance owed since last week is
        normal trading; the same figure owed since March usually is not. Measured from each customer's oldest unpaid debit.</p>
      <div id="aging-content" class="empty-state">Loading…</div>
    </div>` : ''}
  `;

  // ---- BUG 95: change we owe customers ---------------------------------
  // Loaded after the shell paints, like the aging block, so a slow or failing
  // report can never take the whole screen down with it.
  async function loadChangeOwed(query) {
    const el = document.getElementById('co-content');
    if (!el) return;
    el.textContent = 'Loading…';
    el.classList.add('empty-state');
    try {
      // A 7-digit all-numeric query is the claim code a customer reads off
      // their slip, so try the direct lookup FIRST: it is one indexed hit and
      // it returns a specific, actionable error when the claim belongs to
      // another branch ("collect it at Ikeja") instead of an empty list that
      // tells the customer nothing.
      let rows = null;
      if (/^\d{7}$/.test(query || '')) {
        try {
          const one = await Api.get(`/change-owed/code/${encodeURIComponent(query)}`);
          rows = one ? [one] : [];
        } catch (e) {
          // 404 = no such code; 409 = it exists but belongs to another branch.
          // Both are worth showing verbatim rather than falling back silently.
          el.textContent = e.message || 'No claim found for that code.';
          return;
        }
      }
      if (rows === null) {
        const qs = query ? `?q=${encodeURIComponent(query)}&status=ALL` : '?status=OUTSTANDING';
        const claims = await Api.get(Api.withScope('/change-owed' + qs));
        rows = Array.isArray(claims) ? claims : [];
      }
      if (!rows.length) {
        el.textContent = query
          ? 'No claim found for that code, name or number.'
          : 'No change is currently owed to any customer.';
        return;
      }
      const outstanding = rows.filter((r) => r.status === 'OUTSTANDING');
      const total = outstanding.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      el.classList.remove('empty-state');
      el.innerHTML = `
        ${outstanding.length ? `<p style="margin:0 0 10px;font-weight:600;">Outstanding: ${UI.money(total)} across ${outstanding.length} customer(s)</p>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>Code</th><th>Customer</th><th>Phone</th><th>Amount</th><th>For</th><th>When</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td><b>${UI.escapeHtml(r.claim_code)}</b></td>
              <td>${UI.escapeHtml(r.customer_name || '—')}</td>
              <td>${UI.escapeHtml(r.customer_phone || '—')}</td>
              <td style="font-weight:600;">${UI.money(r.amount)}</td>
              <td style="font-size:12px;color:var(--gray-600);">${UI.escapeHtml(r.sale_summary || '—')}</td>
              <td>${UI.shortDate(r.created_at)}</td>
              <td>${r.status === 'OUTSTANDING' ? UI.badge('Outstanding', 'amber')
                    : r.status === 'SETTLED' ? UI.badge('Paid', 'green') : UI.badge('Written off', 'gray')}</td>
              <td>${r.status === 'OUTSTANDING' ? `
                <button class="btn btn-primary btn-sm" data-co-pay="${r.id}" data-amount="${r.amount}" data-name="${UI.escapeHtml(r.customer_name || '')}">Pay out</button>
                ${State.isOwner() ? `<button class="btn btn-secondary btn-sm" data-co-writeoff="${r.id}" data-name="${UI.escapeHtml(r.customer_name || '')}">Write off</button>` : ''}
              ` : `<span style="font-size:12px;color:var(--gray-600);">${UI.escapeHtml(r.settled_notes || '')}</span>`}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;

      el.querySelectorAll('[data-co-pay]').forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.coPay;
        if (!confirm(`Pay ${UI.money(Number(btn.dataset.amount))} to ${btn.dataset.name || 'this customer'}?\n\nTake the cash from the drawer and hand it over. This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          const res = await Api.post(`/change-owed/${id}/settle`, { method: 'CASH_PAID' }, { allowOfflineQueue: false });
          UI.toast(`Paid ${UI.money(Number(btn.dataset.amount))}. Claim ${res.claim_code} is now closed.`, 'success', 6000);
          loadChangeOwed(document.getElementById('co-search').value.trim());
        } catch (e) { UI.toast(e.message || 'Could not settle this claim', 'error', 7000); btn.disabled = false; }
      }));
      el.querySelectorAll('[data-co-writeoff]').forEach((btn) => btn.addEventListener('click', async () => {
        const reason = prompt(`Write off the change owed to ${btn.dataset.name || 'this customer'}?\n\nThis turns their money into pharmacy income. Give a reason:`);
        if (reason == null) return;
        try {
          await Api.post(`/change-owed/${btn.dataset.coWriteoff}/write-off`, { reason }, { allowOfflineQueue: false });
          UI.toast('Written off to other income.', 'success');
          loadChangeOwed(document.getElementById('co-search').value.trim());
        } catch (e) { UI.toast(e.message || 'Could not write this off', 'error', 7000); }
      }));
    } catch (e) {
      el.classList.add('empty-state');
      el.textContent = 'Could not load change claims: ' + (e.message || 'unknown error');
    }
  }
  UI.on('co-search-btn', 'click', () => loadChangeOwed(document.getElementById('co-search').value.trim()));
  UI.on('co-show-all', 'click', () => { document.getElementById('co-search').value = ''; loadChangeOwed(''); });
  UI.on('co-search', 'keydown', (e) => { if (e.key === 'Enter') loadChangeOwed(document.getElementById('co-search').value.trim()); });
  loadChangeOwed('');

  // Aging is loaded after the shell is painted so a slow report never delays
  // the customer list, and a failure here can never take the screen down.
  if (State.isManager()) {
    (async () => {
      const el = document.getElementById('aging-content');
      try {
        const aging = await Api.get(Api.withScope('/customers/aging'));
        const rows = (aging && aging.rows) || [];
        if (!rows.length) { el.textContent = 'Nobody currently owes money.'; return; }
        const t = aging.totals || {};
        el.classList.remove('empty-state');
        el.innerHTML = `
          <div class="stat-row" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            ${[['0–30 days', t.current, 'green'], ['31–60', t['31_60'], 'amber'],
               ['61–90', t['61_90'], 'amber'], ['Over 90 days', t.over_90, 'red']]
              .map(([label, val, kind]) => `<div class="card" style="flex:1;min-width:120px;margin:0;">
                 <div class="page-subtitle" style="margin:0;">${label}</div>
                 <div style="font-weight:700;color:var(--${kind}-500);">${UI.money(val || 0)}</div>
               </div>`).join('')}
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Phone</th><th>Owed</th><th>Oldest debt</th><th>Age</th><th></th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr>
                <td>${UI.escapeHtml(r.customer_name)}</td>
                <td>${UI.escapeHtml(r.customer_phone || '—')}</td>
                <td style="color:var(--red-500);">${UI.money(r.balance_owed)}</td>
                <td>${r.oldest_debt_at ? UI.shortDate(r.oldest_debt_at) : '—'}</td>
                <td>${Number(r.oldest_debt_age_days || 0)}d ${
                  r.bucket === 'over_90' ? UI.badge('over 90 days', 'red')
                  : r.bucket === '61_90' ? UI.badge('61–90', 'amber') : ''}</td>
                <td>${r.over_limit ? UI.badge('over limit', 'red') : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          <p class="page-subtitle" style="margin-top:10px;">Total outstanding: <b>${UI.money(aging.total_outstanding || 0)}</b></p>`;
      } catch (e) {
        el.textContent = 'Could not load the aging report.';
      }
    })();
  }

  UI.guardedClick(document.getElementById('cust-add'), async () => {
    const name = document.getElementById('cust-name').value.trim();
    if (!name) { UI.toast('Name is required', 'error'); return; }
    const payload = {
      name,
      phone: document.getElementById('cust-phone').value,
      id_type: document.getElementById('cust-idtype').value,
      id_number: document.getElementById('cust-idnum').value,
      branch_id: branchId || undefined,
    };
    try {
      await Api.post('/customers', payload, { allowOfflineQueue: false });
      UI.toast('Customer added', 'success');
      Router.navigate();
    } catch (e) {
      // A genuine network failure (offline) — not a validation error the
      // server rejected — falls back to the OTHER offline queue: unlike
      // sales/expenses (which replay through the exact original API
      // call once online), a new customer is plain reference data with
      // no derived side effects, so it goes through the generic,
      // chunked /api/sync/push mechanism instead (see offline.js's
      // queueCustomerEdit/processCustomerSyncQueue and
      // api.js's pushCustomerQueue). This closes a real gap: before this
      // fix, creating a customer while offline failed outright with no
      // recovery path, even though the server-side sync-push mechanism
      // existed specifically to support exactly this case.
      if (e instanceof TypeError) {
        await Offline.queueCustomerEdit({
          id: (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`),
          branch_id: payload.branch_id || null,
          name: payload.name,
          phone: payload.phone || null,
          id_type: payload.id_type || null,
          id_number: payload.id_number || null,
          is_deleted: 0,
        });
        UI.updateOfflineBanner();
        UI.toast('You are offline. This customer has been queued and will sync automatically once connection returns.', 'warn');
        Router.navigate();
      } else {
        UI.toast(e.message, 'error');
      }
    }
  });

  const tbody = document.getElementById('customers-tbody');
  if (!customers.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No customers yet</td></tr>';
    // Still wire the export so the buttons are never dead — an empty ledger is
    // a legitimate thing to print ("nil return") rather than a broken button.
    Exporter.wireTableReport('customers', {
      title: 'Debtor Ledger',
      subtitle: branchId ? 'Selected branch' : 'All branches',
      filename: 'debtor-ledger',
      columns: [
        { key: 'name', label: 'Customer' }, { key: 'phone', label: 'Phone' },
        { key: 'id_type', label: 'ID Type' }, { key: 'id_number', label: 'ID Number' },
        { key: 'balance_owed', label: 'Balance Owed', align: 'right', format: (v) => UI.money(v || 0) },
      ],
      rows: [],
      emptyMessage: 'No customers on file.',
    });
    return;
  }
  const balances = await Promise.all(customers.map(c => Api.get(`/customers/${c.id}/balance`)));
  tbody.innerHTML = customers.map((c, idx) => `
    <tr>
      <td>${UI.escapeHtml(c.name)}</td>
      <td>${UI.escapeHtml(c.phone || '—')}</td>
      <td style="color:${balances[idx].balance_owed > 0 ? 'var(--red-500)' : 'inherit'}">${UI.money(balances[idx].balance_owed)}</td>
      <td>${Number(c.credit_limit || 0) > 0
        ? UI.money(c.credit_limit) + (Number(balances[idx].balance_owed || 0) > Number(c.credit_limit || 0) ? ' ' + UI.badge('over limit', 'red') : '')
        : UI.badge('Cash only', 'gray')}</td>
      <td>
        <button class="btn btn-secondary btn-sm" data-history="${c.id}" data-name="${UI.escapeHtml(c.name)}">History</button>
        <button class="btn btn-secondary btn-sm" data-edit-customer="${c.id}">Edit</button>
        ${balances[idx].balance_owed > 0 ? `<button class="btn btn-secondary btn-sm" data-pay="${c.id}" data-name="${UI.escapeHtml(c.name)}" data-owed="${balances[idx].balance_owed}" data-customer-branch="${c.branch_id || ''}">Record Payment</button>` : ''}
      </td>
    </tr>
  `).join('');

  // Export is wired HERE, not at render time: balances are fetched
  // asynchronously per customer AFTER the table shell is painted, so wiring it
  // earlier would have exported a "Balance Owed" column that was silently
  // blank for every row. The exported rows merge the resolved balances.
  const customersWithBalances = customers.map((c, idx) => ({
    ...c, balance_owed: balances[idx] ? balances[idx].balance_owed : 0,
  }));
  Exporter.wireTableReport('customers', {
    title: 'Debtor Ledger',
    subtitle: branchId ? 'Selected branch' : 'All branches',
    filename: 'debtor-ledger',
    columns: [
      { key: 'name', label: 'Customer' },
      { key: 'phone', label: 'Phone' },
      { key: 'id_type', label: 'ID Type' },
      { key: 'id_number', label: 'ID Number' },
      { key: 'balance_owed', label: 'Balance Owed', align: 'right', format: (v) => UI.money(v || 0) },
    ],
    rows: customersWithBalances,
    summary: [
      { label: 'Customers', value: String(customersWithBalances.length) },
      { label: 'Total Outstanding', value: UI.money(customersWithBalances.reduce((a, c) => a + Number(c.balance_owed || 0), 0)) },
    ],
    emptyMessage: 'No customers on file.',
  });

  // FUNCTIONAL GAP CLOSED (found during a production audit): the
  // /api/customers/:id/balance endpoint has ALWAYS returned the full,
  // append-only debtor ledger `history` (every credit-sale DEBIT and every
  // PAYMENT, in order — see the write-up below /
  // worker/src/routes/customers.js) alongside the computed `balance_owed`,
  // but the frontend only ever read `balance_owed` and silently discarded
  // `history` — there was no way for a manager to see WHY a customer owes
  // what they owe, or review their repayment history, even though this exact
  // data has always been available with zero extra API calls needed (it's
  // already fetched above to compute the balances column). Reuses the
  // already-fetched `balances[idx]` array by index rather than a redundant
  // lookup.
  tbody.querySelectorAll('[data-history]').forEach((btn, idx) => btn.addEventListener('click', () => {
    openHistoryModal(btn.dataset.name, balances[idx].history);
  }));

  // FUNCTIONAL GAP CLOSED (found during a production audit): every
  // other master-data entity in this codebase (users, products,
  // suppliers, branches) has always supported editing, but customers
  // never did — a cashier mistyping a customer's NIN or phone number
  // during a rushed POS credit-sale transaction had NO way to ever
  // correct it, permanently, even though `id_type`/`id_number` exist
  // specifically for controlled-drug-dispensing KYC record-keeping.
  // Fixed with a real Edit modal calling the previously-nonexistent
  // (now added) PUT /api/customers/:id on both backends.
  tbody.querySelectorAll('[data-edit-customer]').forEach((btn) => btn.addEventListener('click', () => {
    const customer = customers.find((c) => c.id === btn.dataset.editCustomer);
    openEditCustomerModal(customer);
  }));

  tbody.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', async () => {
    // SECURITY: btn.dataset.name is the RAW (HTML-decoded) customer name, even
    // though it was written into the data-name="..." attribute via
    // UI.escapeHtml above — reading a data-* attribute back through.dataset
    // always yields the decoded string, so it must be re-escaped here before
    // going into innerHTML again. Skipping this re-escape was a real
    // stored-XSS bug: a customer named e.g. `<img src=x onerror=...>` would
    // execute arbitrary JS (and could exfiltrate the session token from
    // localStorage) the moment any staff member clicked "Record Payment" for
    // that customer. Found and fixed during this audit pass.
    //
    // FUNCTIONAL/DATA-INTEGRITY GAP CLOSED (real bug found and fixed during
    // this audit): a shared/org-wide customer (no branch of their own — an
    // intentional, already-supported design) recorded by a MANAGER/OWNER/ADMIN
    // (whose own account also has no branch_id, by design) previously had NO
    // way to resolve which branch's books this repayment belongs to, leaking a
    // raw "NOT NULL constraint failed" error from the backend. The backend fix
    // (see the write-up below's POST /:id/payments) now accepts an optional
    // branch_id in this exact scenario — this modal surfaces that as a real
    // branch-picker dropdown only when it's actually needed (a STAFF user, or
    // any customer that already has its own branch, never sees this extra
    // field at all).
    const needsBranchPicker = !btn.dataset.customerBranch && session.user.role !== 'STAFF';
    let branchOptions = [];
    if (needsBranchPicker) {
      branchOptions = await Api.get('/branches');
    }
    const modal = UI.openModal(`
      <h3>Record Payment — ${UI.escapeHtml(btn.dataset.name)}</h3>
      <div class="form-row"><label>Amount</label><input type="number" id="pay-amount" min="1" /></div>
      ${needsBranchPicker ? `
        <div class="form-row">
          <label>Attribute to Branch</label>
          <select id="pay-branch">${branchOptions.filter(b => b.is_active).map(b => `<option value="${b.id}">${UI.escapeHtml(b.name)}</option>`).join('')}</select>
        </div>
      ` : ''}
      <div class="form-row"><label>Notes</label><input id="pay-notes" /></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="pay-cancel">Cancel</button>
        <button class="btn btn-primary" id="pay-save">Save</button>
      </div>
    `);
    modal.querySelector('#pay-cancel').addEventListener('click', () => UI.closeModal(modal));
    UI.guardedClick(modal.querySelector('#pay-save'), async () => {
      const amount = Number(modal.querySelector('#pay-amount').value);
      if (!amount || amount <= 0) { UI.toast('Enter a valid amount', 'error'); return; }
      // BUG 81: the server now refuses a repayment larger than the outstanding
      // debt (REPAYMENT_EXCEEDS_DEBT), because overpaying drives the ledger
      // negative and there is no refund mechanism to release the cash. Warned
      // here first, where the figure is on screen.
      const owedNow = Number(btn.dataset.owed || 0);
      if (owedNow > 0 && amount > owedNow + 0.004) {
        UI.toast(`That is more than is owed. This customer owes ${UI.money(owedNow)} at this branch.`, 'error', 7000);
        return;
      }
      const payload = { amount, notes: modal.querySelector('#pay-notes').value };
      const branchSelect = modal.querySelector('#pay-branch');
      if (branchSelect) payload.branch_id = branchSelect.value;
      try {
        await Api.post(`/customers/${btn.dataset.pay}/payments`, payload, { allowOfflineQueue: false });
        UI.toast('Payment recorded', 'success');
        UI.closeModal(modal);
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }));
}

function openHistoryModal(customerName, history) {
  const modal = UI.openModal(`
    <h3>Ledger History — ${UI.escapeHtml(customerName)}</h3>
    <p class="page-subtitle">Every credit-sale debit and repayment for this customer, most recent first. The balance shown on the main list is derived entirely from this append-only log.</p>
    <div class="table-wrap" style="max-height:400px;overflow-y:auto;">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead>
        <tbody>
          ${history.length ? history.map(h => `
            <tr>
              <td>${UI.shortDate(h.created_at)}</td>
              <td>${h.entry_type === 'DEBIT' ? UI.badge('Credit Sale', 'red') : UI.badge('Payment', 'green')}</td>
              <td style="color:${h.entry_type === 'DEBIT' ? 'var(--red-500)' : 'var(--green-700)'}">${h.entry_type === 'DEBIT' ? '+' : '-'}${UI.money(h.amount)}</td>
              <td>${UI.escapeHtml(h.notes || '—')}</td>
            </tr>
          `).join('') : `<tr><td colspan="4" class="empty-state">No ledger activity yet</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="history-close">Close</button>
    </div>
  `);
  modal.querySelector('#history-close').addEventListener('click', () => UI.closeModal(modal));
}

function openEditCustomerModal(customer) {
  const modal = UI.openModal(`
    <h3>Edit Customer — ${UI.escapeHtml(customer.name)}</h3>
    <div class="form-row"><label>Name</label><input id="ec-name" value="${UI.escapeHtml(customer.name)}" /></div>
    <div class="form-row"><label>Phone</label><input id="ec-phone" value="${UI.escapeHtml(customer.phone || '')}" /></div>
    <div class="form-row"><label>Address</label><input id="ec-address" value="${UI.escapeHtml(customer.address || '')}" /></div>
    <div class="form-row"><label>ID Type</label><input id="ec-idtype" placeholder="NIN / Voter's card" value="${UI.escapeHtml(customer.id_type || '')}" /></div>
    <div class="form-row"><label>ID Number</label><input id="ec-idnum" value="${UI.escapeHtml(customer.id_number || '')}" /></div>
    ${State.isManager() ? `
      <div class="form-row">
        <label for="ec-credit">Credit limit (0 = cash only)</label>
        <input type="number" id="ec-credit" min="0" step="0.01" value="${Number(customer.credit_limit || 0)}" />
        <p class="page-subtitle" style="margin:6px 0 0;">
          BUG 83: the most this customer may owe at any one time. A credit sale that would take them past
          this figure is refused; a manager can still authorise going over it, with a reason recorded on the sale.
        </p>
      </div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="ec-cancel">Cancel</button>
      <button class="btn btn-primary" id="ec-save">Save</button>
    </div>
  `);
  modal.querySelector('#ec-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#ec-save'), async () => {
    const name = modal.querySelector('#ec-name').value.trim();
    if (!name) { UI.toast('Name is required', 'error'); return; }
    try {
      await Api.put(`/customers/${customer.id}`, {
        name,
        phone: modal.querySelector('#ec-phone').value.trim() || null,
        address: modal.querySelector('#ec-address').value.trim() || null,
        id_type: modal.querySelector('#ec-idtype').value.trim() || null,
        id_number: modal.querySelector('#ec-idnum').value.trim() || null,
        // Only sent when the field is present: the server refuses credit_limit
        // from a cashier (CREDIT_LIMIT_MANAGER_ONLY), so a cashier's ordinary
        // edit must not carry the key at all.
        ...(modal.querySelector('#ec-credit')
          ? { credit_limit: Number(modal.querySelector('#ec-credit').value || 0) }
          : {}),
      }, { allowOfflineQueue: false });
      UI.toast('Customer updated', 'success');
      UI.closeModal(modal);
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
