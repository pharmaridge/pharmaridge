async function renderExpenses(view) {
  // MANAGER-AND-ABOVE. The nav link is hidden for STAFF, but a hash URL
  // can still be typed or bookmarked, and the backend now refuses these
  // reads — so show a plain explanation instead of a screen full of
  // failed requests.
  // BUG 99 — A CAPABILITY STAFF HAVE, WITH NO WAY TO REACH IT.
  //
  // This screen was closed to STAFF entirely, because LISTING the pharmacy's
  // whole cost base is manager-only (a cashier has no business reading the
  // rent). But RECORDING a purchase never was: POST /api/expenses accepts a
  // cashier and always has — verified live, 201 — because the person actually
  // sent to buy diesel or pay the okada is the cashier.
  //
  // So the backend allowed something the frontend offered no route to, which is
  // exactly the front-to-back gap this audit exists to close. It also made the
  // whole point of the drawer/safe split unreachable for the role that needs it
  // most. A cashier now gets the RECORD form and nothing else: no list, no
  // totals, no export, no approvals.
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const canSeeAll = State.isManager();
  const expenses = canSeeAll
    ? await Api.get(branchId ? `/expenses?branch_id=${branchId}` : '/expenses')
    : [];
  // WHT rate schedule for the optional deduction below. Fails soft: a
  // pharmacy that does not withhold must still be able to record expenses.
  let whtRates = [];
  try {
    whtRates = (await Api.get('/wht/rates')).filter((r) => r.is_active && r.direction !== 'RECEIVABLE');
  } catch (e) { /* older backend or transient error — the field simply hides */ }

  view.innerHTML = `
    <h2 class="page-title">Expenses</h2>
    <p class="page-subtitle">${canSeeAll
      ? 'Rent, generator fuel, salaries, transport, and other operating costs — feeds into till cash reconciliation when paid in cash.'
      : 'Record what you spent on the pharmacy\'s behalf — transport, fuel, small purchases. Your manager sees the full cost report.'}</p>
    ${canSeeAll ? Exporter.toolbar('expenses', { label: 'this expense report' }) : ''}
    ${branchId ? `
    <div class="card">
      <h3>Record Expense</h3>
      <div class="form-inline">
        <div class="form-row"><label>Category</label><input id="exp-category" placeholder="Rent, Generator Fuel, Salary..." /></div>
        <div class="form-row"><label>Amount</label><input type="number" id="exp-amount" min="0" /></div>
        <div class="form-row">
          <label>Paid via</label>
          <!-- 'Safe' is a distinct pot from 'Cash' (the counter drawer): it is
               what pays a delivery or the rent that the till could never cover.
               Choosing Cash for money that actually came from the safe is what
               drove a till to an impossible negative balance (Bug 96). -->
          <select id="exp-method"><option value="CASH">Cash (from the till drawer)</option><option value="SAFE">Safe (branch cash reserve)</option><option value="BOTH">Both — part drawer, part safe</option><option value="POS_CARD">POS Card</option><option value="TRANSFER">Transfer</option></select>
        </div>
        <!-- A purchase is often funded from BOTH pots: whatever was in the
             drawer, and the rest out of the safe. Forcing one method made the
             operator misstate one of them, and the misstatement lands in the
             accounts. Shown only when "Both" is chosen so the ordinary case
             stays a single click. -->
        <div class="form-row hidden" id="exp-split-row">
          <label>From the drawer (N)</label>
          <input type="number" id="exp-from-cash" min="0" placeholder="0" />
          <small class="muted" style="display:block;margin-top:4px;font-size:12px;"
                 id="exp-split-hint">The rest comes from the safe.</small>
        </div>
        <div class="form-row"><label>Description</label><input id="exp-desc" /></div>
        ${whtRates.length ? `
        <div class="form-row">
          <label>Withholding tax</label>
          <select id="exp-wht-rate">
            <option value="">None</option>
            ${whtRates.map((r) => `<option value="${UI.escapeHtml(r.code)}" data-rate="${r.rate_percent}">${UI.escapeHtml(r.name)} — ${r.rate_percent}%</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Payee TIN <span style="font-weight:400;font-size:11px;">(for the credit note)</span></label><input id="exp-wht-tin" placeholder="e.g. 12345678-0001" /></div>
        ` : ''}
        <button class="btn btn-primary" id="exp-add">Save</button>
      </div>
      ${whtRates.length ? `<p id="exp-wht-preview" style="margin:8px 0 0;font-size:13px;"></p>` : ''}
    </div>` : `<div class="card"><p>Select a specific branch to record an expense there.</p></div>`}
    ${canSeeAll ? `
    <div class="card">
      <h3>Expense History</h3>
      <div class="table-wrap">
        <table>
          <thead><tr>${branchId ? '' : '<th>Branch</th>'}<th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Method</th><th>Recorded By</th><th>Approved</th></tr></thead>
          <tbody>
            ${expenses.map(e => `
              <tr>
                ${branchId ? '' : `<td>${UI.escapeHtml(e.branch_name)}</td>`}
                <td>${UI.shortDate(e.expense_date)}</td>
                <td>${UI.escapeHtml(e.category)}</td>
                <td>${UI.escapeHtml(e.description || '—')}</td>
                <td>${UI.money(e.amount)}</td>
                <td>${e.paid_by_method || '—'}</td>
                <td>${UI.escapeHtml(e.recorded_by_name)}</td>
                <td>${e.approved_by ? UI.badge('Approved', 'green') : (State.isManager() ? `<button class="btn btn-secondary btn-sm" data-approve="${e.id}">Approve</button>` : UI.badge('Pending', 'amber'))}</td>
              </tr>
            `).join('') || `<tr><td colspan="8" class="empty-state">No expenses recorded</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;

  // LIVE SPLIT PREVIEW. A cashier about to hand over cash needs to see the
  // actual amount leaving before committing, not discover it afterwards.
  // Mirrors the server's arithmetic in lib/wht.js exactly: WHT is computed
  // from the gross and net is derived by SUBTRACTION, never rounded twice.
  const whtSelect = document.getElementById('exp-wht-rate');
  const whtPreview = document.getElementById('exp-wht-preview');
  function refreshWhtPreview() {
    if (!whtSelect || !whtPreview) return;
    const amount = Number(document.getElementById('exp-amount').value);
    const opt = whtSelect.options[whtSelect.selectedIndex];
    const pct = opt ? Number(opt.dataset.rate) : 0;
    if (!whtSelect.value || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(pct) || pct <= 0) {
      whtPreview.innerHTML = '';
      return;
    }
    const gross = Math.round(amount * 100) / 100;
    const tax = Math.round(((gross * pct) / 100) * 100) / 100;
    const net = Math.round((gross - tax) * 100) / 100;
    whtPreview.innerHTML = `Expense recorded at <strong>${UI.money(gross)}</strong> (your full cost). `
      + `You pay the payee <strong>${UI.money(net)}</strong> and owe the tax authority <strong>${UI.money(tax)}</strong>, `
      + `due by the 21st of next month. Issue the payee a WHT credit note for ${UI.money(tax)}.`;
  }
  if (whtSelect) {
    whtSelect.addEventListener('change', refreshWhtPreview);
    const amtEl = document.getElementById('exp-amount');
    if (amtEl) amtEl.addEventListener('input', refreshWhtPreview);
  }

  // Reveal the split field only when "Both" is chosen, and keep a live note of
  // what the safe will cover, so the operator never has to do the subtraction.
  (function wireSplit() {
    const method = document.getElementById('exp-method');
    const row = document.getElementById('exp-split-row');
    const fromCash = document.getElementById('exp-from-cash');
    const amountEl = document.getElementById('exp-amount');
    const hint = document.getElementById('exp-split-hint');
    if (!method || !row) return;
    function refresh() {
      const isSplit = method.value === 'BOTH';
      row.classList.toggle('hidden', !isSplit);
      if (!isSplit || !hint) return;
      const total = Number(amountEl.value || 0);
      const cash = Number(fromCash.value || 0);
      const safe = Math.round((total - cash) * 100) / 100;
      hint.textContent = total > 0 && cash > 0 && cash < total
        ? `The safe covers the remaining ${UI.money(safe)}.`
        : 'The rest comes from the safe.';
    }
    method.addEventListener('change', refresh);
    if (fromCash) fromCash.addEventListener('input', refresh);
    if (amountEl) amountEl.addEventListener('input', refresh);
    refresh();
  }());

  UI.guardedClick(document.getElementById('exp-add'), async () => {
    const category = document.getElementById('exp-category').value.trim();
    const amount = Number(document.getElementById('exp-amount').value);
    if (!category || !amount) { UI.toast('Category and amount are required', 'error'); return; }
    if (document.getElementById('exp-method').value === 'BOTH') {
      const fromCash = Number(document.getElementById('exp-from-cash').value || 0);
      if (!(fromCash > 0) || fromCash >= amount) {
        UI.toast('For a split, say how much came from the drawer — more than zero and less than the total. The safe covers the rest.', 'error', 7000);
        return;
      }
    }
    try {
      const saved = await Api.post('/expenses', {
        branch_id: branchId,
        category,
        amount,
        ...(function cashSourcesFor() {
          const method = document.getElementById('exp-method').value;
          if (method !== 'BOTH') return { paid_by_method: method };
          // The operator types what came out of the DRAWER; the safe covers the
          // remainder. Asking for one figure rather than two removes the most
          // likely error — two numbers that do not add up to the total, which
          // the server refuses outright.
          const fromCash = Number(document.getElementById('exp-from-cash').value || 0);
          const fromSafe = Math.round((amount - fromCash) * 100) / 100;
          const sources = [];
          if (fromCash > 0) sources.push({ source: 'CASH', amount: fromCash });
          if (fromSafe > 0) sources.push({ source: 'SAFE', amount: fromSafe });
          return { cash_sources: sources };
        }()),
        description: document.getElementById('exp-desc').value,
        wht_rate_code: whtSelect && whtSelect.value ? whtSelect.value : undefined,
        wht_counterparty_tin: (document.getElementById('exp-wht-tin') || {}).value || undefined,
      });
      if (saved && saved.wht) {
        UI.toast(`Expense ${UI.money(saved.wht.gross_amount)} recorded — pay ${UI.money(saved.wht.net_paid)}, remit ${UI.money(saved.wht.wht_amount)}`, 'success');
        // The small-company exemption hint is advisory (never blocking) but
        // it is long and legally consequential, so it is shown INLINE and
        // left on screen rather than in a toast that vanishes after four
        // seconds before an owner has finished reading it.
        if (saved.wht.exemption_hint && whtPreview) {
          whtPreview.innerHTML = `<span style="display:block;padding:10px;border-radius:6px;background:var(--tint-amber);border-left:4px solid var(--amber-500);">${UI.escapeHtml(saved.wht.exemption_hint)}</span>`;
          return; // keep the notice visible instead of re-rendering it away
        }
      } else {
        UI.toast('Expense recorded', 'success');
      }
      Router.navigate();
    } catch (e) {
      if (e.queued) UI.toast(e.message, 'warn', 6000); else UI.toast(e.message, 'error');
    }
  });

  if (canSeeAll) Exporter.wireTableReport('expenses', {
    title: 'Expense Report', subtitle: 'Operating costs', filename: 'expenses',
    columns: [
      { key: 'expense_date', label: 'Date', format: (v, r) => UI.shortDate(v || r.created_at) },
      { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' },
      { key: 'paid_by_method', label: 'Paid By' },
      { key: 'recorded_by_name', label: 'Recorded By' },
      { key: 'amount', label: 'Amount', align: 'right', format: (v) => UI.money(v) },
      { key: 'approved_by', label: 'Approved', format: (v) => (v ? 'Yes' : 'Pending') },
    ],
    rows: expenses,
    summary: [
      { label: 'Entries', value: String(expenses.length) },
      { label: 'Total', value: UI.money(expenses.reduce((a, e) => a + Number(e.amount || 0), 0)) },
      { label: 'Cash Total', value: UI.money(expenses.filter((e) => e.paid_by_method === 'CASH').reduce((a, e) => a + Number(e.amount || 0), 0)) },
      { label: 'Paid from Safe', value: UI.money(expenses.filter((e) => e.paid_by_method === 'SAFE').reduce((a, e) => a + Number(e.amount || 0), 0)) },
    ],
  });

  view.querySelectorAll('[data-approve]').forEach((btn) => UI.guardedClick(btn, async () => {
    try {
      await Api.post(`/expenses/${btn.dataset.approve}/approve`, {}, { allowOfflineQueue: false });
      UI.toast('Expense approved', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  }));
}
