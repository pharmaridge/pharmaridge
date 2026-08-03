async function renderAccounting(view, path) {
  if (!State.isManager()) {
    view.innerHTML = `<div class="card"><p>This page is only available to managers, owners, and admins.</p></div>`;
    return;
  }

  const rawTabSegment = path.split('/')[2] || 'chart-of-accounts';
  const [tab, tabQuery] = rawTabSegment.split('?');
  const tabParams = new URLSearchParams(tabQuery || '');
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  const scopeQuery = branchId ? `?branch_id=${branchId}` : '';
  const scopeAmp = branchId ? `&branch_id=${branchId}` : '';

  // A printed financial statement MUST say what it covers. "Trial Balance"
  // with no scope is ambiguous once it is off the screen — one branch or the
  // whole business? This label goes into every export's letterhead.
  const branchList = await Api.get('/branches').catch(() => []);
  const scopeSubtitle = () => {
    if (!branchId) return 'All Branches (organisation-wide)';
    const b = (branchList || []).find((x) => x.id === branchId);
    return b ? b.name : 'Selected Branch';
  };

  view.innerHTML = `
    <h2 class="page-title">Accounting &amp; General Ledger</h2>
    <p class="page-subtitle">Double-entry Chart of Accounts, Trial Balance, Profit &amp; Loss, and Balance Sheet — automatically posted from every sale, purchase, payment, and stock adjustment.</p>
    <div class="tabs">
      <div class="tab ${tab === 'chart-of-accounts' ? 'active' : ''}" data-tab="chart-of-accounts">Chart of Accounts</div>
      <div class="tab ${tab === 'trial-balance' ? 'active' : ''}" data-tab="trial-balance">Trial Balance</div>
      <div class="tab ${tab === 'profit-loss' ? 'active' : ''}" data-tab="profit-loss">Profit &amp; Loss</div>
      <div class="tab ${tab === 'balance-sheet' ? 'active' : ''}" data-tab="balance-sheet">Balance Sheet</div>
      <div class="tab ${tab === 'journal-entries' ? 'active' : ''}" data-tab="journal-entries">Journal Entries</div>
      <div class="tab ${tab === 'withholding-tax' ? 'active' : ''}" data-tab="withholding-tax">Withholding Tax</div>
    </div>
    <div id="accounting-tab-content"></div>
  `;

  view.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    location.hash = `#/accounting/${t.dataset.tab}`;
  }));

  const content = document.getElementById('accounting-tab-content');

  function accountTypeBadge(type) {
    const kind = { ASSET: 'gray', LIABILITY: 'amber', EQUITY: 'gray', REVENUE: 'green', EXPENSE: 'red' }[type] || 'gray';
    return UI.badge(type, kind);
  }

  if (tab === 'chart-of-accounts') {
    const accounts = await Api.get('/gl/chart-of-accounts');
    const byType = {};
    for (const a of accounts) {
      (byType[a.account_type] = byType[a.account_type] || []).push(a);
    }
    const order = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
    content.innerHTML = `
      <div class="card">
        <p style="font-size:13px;color:var(--gray-600);margin-top:0;">Every sale, purchase, payment, and stock write-off is automatically posted here as a balanced double-entry — nothing here is ever entered manually.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Parent</th><th></th></tr></thead>
            <tbody>
              ${order.flatMap((type) => (byType[type] || []).map((a) => `
                <tr>
                  <td><code>${UI.escapeHtml(a.code)}</code></td>
                  <td>${UI.escapeHtml(a.name)}</td>
                  <td>${accountTypeBadge(a.account_type)}</td>
                  <td>${a.parent_id ? UI.escapeHtml((accounts.find((p) => p.id === a.parent_id) || {}).name || '—') : '—'}</td>
                  <td>${a.is_system ? UI.badge('System', 'gray') : UI.badge('Auto-created', 'green')}</td>
                </tr>
              `)).join('') || `<tr><td colspan="5" class="empty-state">No accounts</td></tr>`}
            </tbody>
          </table>
        </div>
        ${Exporter.toolbar('coa', { label: 'the chart of accounts' })}
      </div>
    `;
    Exporter.wireTableReport('coa', {
      title: 'Chart of Accounts', subtitle: scopeSubtitle(), filename: 'chart-of-accounts',
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Account Name' },
        { key: 'account_type', label: 'Type' },
        { key: 'description', label: 'Description' },
      ],
      rows: accounts,
    });
  } else if (tab === 'trial-balance') {
    const rows = await Api.get(`/gl/trial-balance${scopeQuery}`);
    const totalDebits = rows.reduce((s, r) => s + r.total_debits, 0);
    const totalCredits = rows.reduce((s, r) => s + r.total_credits, 0);
    const balanced = Math.abs(totalDebits - totalCredits) < 0.01;
    content.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Trial Balance</h3>
          ${balanced ? UI.badge('Balanced ✓', 'green') : UI.badge('OUT OF BALANCE', 'red')}
        </div>
        <p style="font-size:12px;color:var(--gray-600);margin:8px 0 0;">Click any account to see the individual journal entries behind its balance.</p>
        ${Exporter.toolbar('tb', { label: 'the trial balance' })}
        <div class="table-wrap" style="margin-top:12px;">
          <table>
            <thead><tr><th>Account</th><th>Type</th><th style="text-align:right;">Total Debits</th><th style="text-align:right;">Total Credits</th><th style="text-align:right;">Balance</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="clickable-row" data-account-code="${UI.escapeHtml(r.account_code)}" style="cursor:pointer;">
                  <td><code>${UI.escapeHtml(r.account_code)}</code> ${UI.escapeHtml(r.account_name)}</td>
                  <td>${accountTypeBadge(r.account_type)}</td>
                  <td style="text-align:right;">${UI.money(r.total_debits)}</td>
                  <td style="text-align:right;">${UI.money(r.total_credits)}</td>
                  <td style="text-align:right;font-weight:600;">${UI.money(r.balance)}</td>
                </tr>
              `).join('') || `<tr><td colspan="5" class="empty-state">No journal activity yet</td></tr>`}
            </tbody>
            <tfoot>
              <tr style="font-weight:700;border-top:2px solid var(--gray-300);">
                <td colspan="2">Total</td>
                <td style="text-align:right;">${UI.money(totalDebits)}</td>
                <td style="text-align:right;">${UI.money(totalCredits)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;
    Exporter.wireTableReport('tb', {
      title: 'Trial Balance', subtitle: scopeSubtitle(), filename: 'trial-balance',
      columns: [
        { key: 'account_code', label: 'Code' },
        { key: 'account_name', label: 'Account' },
        { key: 'account_type', label: 'Type' },
        { key: 'total_debits', label: 'Total Debits', align: 'right', format: (v) => UI.money(v) },
        { key: 'total_credits', label: 'Total Credits', align: 'right', format: (v) => UI.money(v) },
        { key: 'balance', label: 'Balance', align: 'right', format: (v) => UI.money(v) },
      ],
      rows,
      summary: [
        { label: 'Total Debits', value: UI.money(totalDebits) },
        { label: 'Total Credits', value: UI.money(totalCredits) },
        { label: 'Status', value: balanced ? 'Balanced' : 'OUT OF BALANCE' },
      ],
      note: balanced ? '' : 'WARNING: this trial balance does not balance. Investigate before filing.',
    });
    content.querySelectorAll('[data-account-code]').forEach((row) => row.addEventListener('click', () => {
      location.hash = `#/accounting/journal-entries?account=${encodeURIComponent(row.dataset.accountCode)}`;
    }));
  } else if (tab === 'profit-loss') {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + '01';
    content.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <label>Start date<br/><input type="date" id="pl-start" value="${monthStart}"></label>
          <label>End date<br/><input type="date" id="pl-end" value="${today}"></label>
          <button class="btn btn-primary" id="pl-run">Run Report</button>
        </div>
      </div>
      <div id="pl-results"></div>
    `;
    async function runPL() {
      const start = document.getElementById('pl-start').value;
      const end = document.getElementById('pl-end').value;
      if (!start || !end) return;
      const pl = await Api.get(`/gl/profit-loss?start_date=${start}&end_date=${end}${scopeAmp}`);
      document.getElementById('pl-results').innerHTML = `
        <div class="grid grid-2" style="margin-top:16px;">
          <div class="stat-card">
            <div class="label">Total Revenue</div>
            <div class="value">${UI.money(pl.total_revenue)}</div>
          </div>
          <div class="stat-card ${pl.net_profit < 0 ? 'danger' : ''}">
            <div class="label">Net Profit</div>
            <div class="value">${UI.money(pl.net_profit)}</div>
          </div>
        </div>
        <div class="grid grid-2" style="margin-top:16px;">
          <div class="card">
            <h3>Revenue</h3>
            <div class="table-wrap">
              <table>
                <tbody>
                  ${pl.revenue.map((r) => `<tr><td>${UI.escapeHtml(r.account_name)}</td><td style="text-align:right;">${UI.money(r.amount)}</td></tr>`).join('') || `<tr><td class="empty-state">No revenue in this period</td></tr>`}
                </tbody>
                <tfoot><tr style="font-weight:700;"><td>Total</td><td style="text-align:right;">${UI.money(pl.total_revenue)}</td></tr></tfoot>
              </table>
            </div>
          </div>
          <div class="card">
            <h3>Expenses</h3>
            <div class="table-wrap">
              <table>
                <tbody>
                  ${pl.expenses.map((e) => `<tr><td>${UI.escapeHtml(e.account_name)}</td><td style="text-align:right;">${UI.money(e.amount)}</td></tr>`).join('') || `<tr><td class="empty-state">No expenses in this period</td></tr>`}
                </tbody>
                <tfoot><tr style="font-weight:700;"><td>Total</td><td style="text-align:right;">${UI.money(pl.total_expenses)}</td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>
        ${Exporter.toolbar('pl', { label: 'this profit & loss statement' })}
      `;
      // A P&L is a STATEMENT, not a flat table — revenue and expense sections
      // with their own subtotals and a net figure. buildTableReport() would
      // flatten that into one meaningless list, so this composes the document
      // directly while still using the shared letterhead/footer.
      const period = `${start} to ${end}`;
      const section = (heading, lines, totalLabel, totalValue) => `
        <div class="print-section">
          <h3>${Exporter.escapeHtml(heading)}</h3>
          <table class="print-table"><tbody>
            ${lines.length ? lines.map((l) => `<tr><td>${Exporter.escapeHtml(l.account_name)}</td><td style="text-align:right">${Exporter.escapeHtml(UI.money(l.amount))}</td></tr>`).join('')
              : `<tr><td colspan="2" style="text-align:center">None in this period</td></tr>`}
            <tr style="font-weight:700;background:var(--tint-gray);"><td>${Exporter.escapeHtml(totalLabel)}</td><td style="text-align:right">${Exporter.escapeHtml(UI.money(totalValue))}</td></tr>
          </tbody></table>
        </div>`;

      Exporter.wireToolbar('pl', {
        print: () => Exporter.printDocument(
          Exporter.documentHeader('Profit & Loss Statement', `${scopeSubtitle()} · ${period}`)
          + section('Revenue', pl.revenue, 'Total Revenue', pl.total_revenue)
          + section('Expenses', pl.expenses, 'Total Expenses', pl.total_expenses)
          + `<table class="print-summary"><tbody>
               <tr><th>Net ${pl.net_profit < 0 ? 'Loss' : 'Profit'}</th>
                   <td style="text-align:right">${Exporter.escapeHtml(UI.money(pl.net_profit))}</td></tr>
             </tbody></table>`
          + Exporter.documentFooter(`Period: ${period}`),
          { title: 'Profit and Loss' }
        ),
        csv: () => Exporter.downloadCSV(`profit-loss-${start}-to-${end}`,
          [ { key: 'section', label: 'Section' }, { key: 'account_name', label: 'Account' }, { key: 'amount', label: 'Amount' } ],
          [
            ...pl.revenue.map((r) => ({ section: 'Revenue', account_name: r.account_name, amount: r.amount })),
            { section: 'Revenue', account_name: 'TOTAL REVENUE', amount: pl.total_revenue },
            ...pl.expenses.map((e) => ({ section: 'Expenses', account_name: e.account_name, amount: e.amount })),
            { section: 'Expenses', account_name: 'TOTAL EXPENSES', amount: pl.total_expenses },
            { section: 'Result', account_name: 'NET PROFIT', amount: pl.net_profit },
          ]),
      });
    }
    UI.guardedClick(document.getElementById('pl-run'), runPL);
    await runPL();
  } else if (tab === 'balance-sheet') {
    const today = new Date().toISOString().slice(0, 10);
    content.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <label>As of date<br/><input type="date" id="bs-date" value="${today}"></label>
          <button class="btn btn-primary" id="bs-run">Run Report</button>
        </div>
      </div>
      <div id="bs-results"></div>
    `;
    async function runBS() {
      const asOf = document.getElementById('bs-date').value;
      if (!asOf) return;
      const bs = await Api.get(`/gl/balance-sheet?as_of_date=${asOf}${scopeAmp}`);
      document.getElementById('bs-results').innerHTML = `
        <div style="margin-top:16px;">
          ${bs.balances ? UI.badge('Assets = Liabilities + Equity ✓', 'green') : UI.badge('OUT OF BALANCE — contact support', 'red')}
        </div>
        <div class="grid grid-2" style="margin-top:16px;">
          <div class="card">
            <h3>Assets</h3>
            <div class="table-wrap">
              <table>
                <tbody>
                  ${bs.assets.map((a) => `<tr><td>${UI.escapeHtml(a.account_name)}</td><td style="text-align:right;">${UI.money(a.amount)}</td></tr>`).join('') || `<tr><td class="empty-state">No assets recorded</td></tr>`}
                </tbody>
                <tfoot><tr style="font-weight:700;"><td>Total Assets</td><td style="text-align:right;">${UI.money(bs.total_assets)}</td></tr></tfoot>
              </table>
            </div>
          </div>
          <div class="card">
            <h3>Liabilities &amp; Equity</h3>
            <div class="table-wrap">
              <table>
                <tbody>
                  <tr><td colspan="2"><strong>Liabilities</strong></td></tr>
                  ${bs.liabilities.map((l) => `<tr><td>${UI.escapeHtml(l.account_name)}</td><td style="text-align:right;">${UI.money(l.amount)}</td></tr>`).join('') || `<tr><td class="empty-state">No liabilities recorded</td></tr>`}
                  <tr><td>Total Liabilities</td><td style="text-align:right;font-weight:600;">${UI.money(bs.total_liabilities)}</td></tr>
                  <tr><td colspan="2">&nbsp;</td></tr>
                  <tr><td colspan="2"><strong>Equity</strong></td></tr>
                  ${bs.equity.map((e) => `<tr><td>${UI.escapeHtml(e.account_name)}</td><td style="text-align:right;">${UI.money(e.amount)}</td></tr>`).join('') || `<tr><td class="empty-state">No equity recorded</td></tr>`}
                  <tr><td>Total Equity</td><td style="text-align:right;font-weight:600;">${UI.money(bs.total_equity)}</td></tr>
                </tbody>
                <tfoot><tr style="font-weight:700;border-top:2px solid var(--gray-300);"><td>Total Liabilities + Equity</td><td style="text-align:right;">${UI.money(bs.total_liabilities + bs.total_equity)}</td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>
        ${Exporter.toolbar('bs', { label: 'this balance sheet' })}
      `;
      const sect = (heading, lines, totalLabel, totalValue) => `
        <div class="print-section">
          <h3>${Exporter.escapeHtml(heading)}</h3>
          <table class="print-table"><tbody>
            ${lines.length ? lines.map((l) => `<tr><td>${Exporter.escapeHtml(l.account_name)}</td><td style="text-align:right">${Exporter.escapeHtml(UI.money(l.amount))}</td></tr>`).join('')
              : `<tr><td colspan="2" style="text-align:center">None recorded</td></tr>`}
            <tr style="font-weight:700;background:var(--tint-gray);"><td>${Exporter.escapeHtml(totalLabel)}</td><td style="text-align:right">${Exporter.escapeHtml(UI.money(totalValue))}</td></tr>
          </tbody></table>
        </div>`;

      Exporter.wireToolbar('bs', {
        print: () => Exporter.printDocument(
          Exporter.documentHeader('Balance Sheet', `${scopeSubtitle()} · as at ${asOf}`)
          + sect('Assets', bs.assets, 'Total Assets', bs.total_assets)
          + sect('Liabilities', bs.liabilities, 'Total Liabilities', bs.total_liabilities)
          + sect('Equity', bs.equity, 'Total Equity', bs.total_equity)
          + `<table class="print-summary"><tbody>
               <tr><th>Total Assets</th><td style="text-align:right">${Exporter.escapeHtml(UI.money(bs.total_assets))}</td></tr>
               <tr><th>Total Liabilities + Equity</th><td style="text-align:right">${Exporter.escapeHtml(UI.money(bs.total_liabilities + bs.total_equity))}</td></tr>
               <tr><th>Balanced</th><td style="text-align:right">${bs.balances ? 'Yes' : 'NO — INVESTIGATE'}</td></tr>
             </tbody></table>`
          + Exporter.documentFooter(bs.balances ? `As at ${asOf}` : 'WARNING: this balance sheet does not balance.'),
          { title: 'Balance Sheet' }
        ),
        csv: () => Exporter.downloadCSV(`balance-sheet-${asOf}`,
          [ { key: 'section', label: 'Section' }, { key: 'account_name', label: 'Account' }, { key: 'amount', label: 'Amount' } ],
          [
            ...bs.assets.map((a) => ({ section: 'Assets', account_name: a.account_name, amount: a.amount })),
            { section: 'Assets', account_name: 'TOTAL ASSETS', amount: bs.total_assets },
            ...bs.liabilities.map((l) => ({ section: 'Liabilities', account_name: l.account_name, amount: l.amount })),
            { section: 'Liabilities', account_name: 'TOTAL LIABILITIES', amount: bs.total_liabilities },
            ...bs.equity.map((e) => ({ section: 'Equity', account_name: e.account_name, amount: e.amount })),
            { section: 'Equity', account_name: 'TOTAL EQUITY', amount: bs.total_equity },
          ]),
      });
    }
    UI.guardedClick(document.getElementById('bs-run'), runBS);
    await runBS();
  } else if (tab === 'journal-entries') {
    // FUNCTIONAL GAP CLOSED (found during a production audit — "does
    // the frontend use 100% of what the backend supports?"):
    // GET /api/gl/journal-entries (the audit-trail drill-down endpoint
    // — "why does this account have this balance, exactly which real
    // sale/expense/payment/adjustment caused it") has always existed,
    // fully implemented and manager-gated identically on both
    // backends, but was never called anywhere in the frontend. Trial
    // Balance rows now link here with the clicked account pre-filled.
    const accountFilter = tabParams.get('account') || '';
    const sourceTypeFilter = tabParams.get('source_type') || '';
    const accounts = await Api.get('/gl/chart-of-accounts');
    content.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <label>Account<br/>
            <select id="je-account">
              <option value="">All accounts</option>
              ${accounts.map((a) => `<option value="${UI.escapeHtml(a.code)}" ${a.code === accountFilter ? 'selected' : ''}>${UI.escapeHtml(a.code)} — ${UI.escapeHtml(a.name)}</option>`).join('')}
            </select>
          </label>
          <label>Source type<br/>
            <select id="je-source-type">
              <option value="">All types</option>
              ${['SALE', 'SALE_VOID', 'PO_RECEIVE', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER_OUT', 'STOCK_TRANSFER_IN', 'TILL_CLOSE'].map((t) => `<option value="${t}" ${t === sourceTypeFilter ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </label>
          <button class="btn btn-primary" id="je-run">Filter</button>
        </div>
      </div>
      <div id="je-results"></div>
    `;
    async function runJE() {
      const account = document.getElementById('je-account').value;
      const sourceType = document.getElementById('je-source-type').value;
      // The backend's GET /gl/journal-entries only supports filtering
      // by branch_id/source_type/source_id server-side — account-code
      // filtering (this screen's own addition, since one entry can
      // touch multiple accounts) is applied client-side against the
      // returned page, matching this endpoint's existing 200-row cap.
      let qs = scopeQuery;
      if (sourceType) qs += (qs ? '&' : '?') + `source_type=${encodeURIComponent(sourceType)}`;
      const entries = await Api.get(`/gl/journal-entries${qs}`);
      const filtered = account ? entries.filter((e) => e.lines.some((l) => l.account_code === account)) : entries;
      document.getElementById('je-results').innerHTML = `
        <div class="card" style="margin-top:16px;">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Posted By</th><th>Lines</th></tr></thead>
              <tbody>
                ${filtered.map((e) => `
                  <tr>
                    <td>${UI.escapeHtml((e.entry_date || '').slice(0, 19))}</td>
                    <td>${UI.badge(e.source_type, 'gray')}</td>
                    <td>${UI.escapeHtml(e.description || '—')}</td>
                    <td>${UI.escapeHtml(e.posted_by_name || 'System')}</td>
                    <td>
                      ${e.lines.map((l) => `<div style="font-size:12px;"><code>${UI.escapeHtml(l.account_code)}</code> ${l.debit > 0 ? `Dr ${UI.money(l.debit)}` : `Cr ${UI.money(l.credit)}`}</div>`).join('')}
                    </td>
                  </tr>
                `).join('') || `<tr><td colspan="5" class="empty-state">No journal entries match this filter</td></tr>`}
              </tbody>
            </table>
          </div>
          ${Exporter.toolbar('je', { label: 'these journal entries' })}
        </div>
      `;
      // Each journal ENTRY has many LINES. For a printable/spreadsheet audit
      // trail the natural grain is one row per LINE (that is what an auditor
      // reconciles against), so the entry header repeats down its lines.
      const flat = filtered.flatMap((e) => e.lines.map((l) => ({
        entry_date: (e.entry_date || '').slice(0, 19),
        source_type: e.source_type,
        description: e.description || '',
        posted_by: e.posted_by_name || 'System',
        account_code: l.account_code,
        account_name: l.account_name || '',
        debit: l.debit || 0,
        credit: l.credit || 0,
        memo: l.memo || '',
      })));
      Exporter.wireTableReport('je', {
        title: 'General Journal', subtitle: scopeSubtitle(), filename: 'journal-entries',
        columns: [
          { key: 'entry_date', label: 'Date' },
          { key: 'source_type', label: 'Source' },
          { key: 'description', label: 'Description' },
          { key: 'account_code', label: 'Account' },
          { key: 'debit', label: 'Debit', align: 'right', format: (v) => (v > 0 ? UI.money(v) : '') },
          { key: 'credit', label: 'Credit', align: 'right', format: (v) => (v > 0 ? UI.money(v) : '') },
          { key: 'posted_by', label: 'Posted By' },
        ],
        rows: flat,
        summary: [
          { label: 'Total Debits', value: UI.money(flat.reduce((a, r) => a + r.debit, 0)) },
          { label: 'Total Credits', value: UI.money(flat.reduce((a, r) => a + r.credit, 0)) },
        ],
        emptyMessage: 'No journal entries match this filter.',
      });
    }
    UI.guardedClick(document.getElementById('je-run'), runJE);
    await runJE();
  } else if (tab === 'withholding-tax') {
    // FUNCTIONAL GAP CLOSED (found during a production audit — "does the
    // frontend use 100% of what the backend supports?"). GET
    // /api/wht/entries returns the deduction register: every WHT amount
    // withheld or suffered, with the counterparty and TIN that a credit
    // note requires and the remittance state the 21st-of-the-month
    // deadline is measured against.
    //
    // It had no screen at all. Every other ledger in this app — debtors,
    // creditors, the controlled-substance register, stock adjustments —
    // is viewable AND exportable, because a Nigerian pharmacy has to hand
    // these to someone. The WHT register is the one an owner is most
    // likely to be asked for by the revenue authority, and it was the one
    // that could only be read through the API.
    const summary = await Api.get('/wht/summary').catch(() => null);
    const entries = await Api.get(
      branchId ? `/wht/entries?branch_id=${encodeURIComponent(branchId)}` : '/wht/entries'
    ).catch(() => []);

    const payable = entries.filter((e) => e.direction === 'PAYABLE');
    const receivable = entries.filter((e) => e.direction === 'RECEIVABLE');
    const outstanding = payable.filter((e) => !e.remitted_at);

    content.innerHTML = `
      ${summary ? `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="flex:1;min-width:200px;padding:12px;border-radius:8px;background:var(--tint-amber);border-left:4px solid var(--amber-500);">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Owed to the tax authority</div>
          <div style="font-size:22px;font-weight:700;">${UI.money(summary.payable_outstanding)}</div>
          <div style="font-size:12px;">Remit by <strong>${UI.escapeHtml(summary.next_remittance_due || '')}</strong></div>
        </div>
        <div style="flex:1;min-width:200px;padding:12px;border-radius:8px;background:var(--tint-green);border-left:4px solid var(--green-600);">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Credit you can reclaim</div>
          <div style="font-size:22px;font-weight:700;">${UI.money(summary.receivable_credit)}</div>
          <div style="font-size:12px;">Withheld from you by customers</div>
        </div>
        <div style="flex:1;min-width:200px;padding:12px;border-radius:8px;background:var(--gray-100);">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Already remitted</div>
          <div style="font-size:22px;font-weight:700;">${UI.money(summary.payable_remitted_to_date)}</div>
          <div style="font-size:12px;">Lifetime, this scope</div>
        </div>
      </div>
      <p style="font-size:12px;margin:0 0 14px;">These two figures are <strong>never netted off</strong> against each other: one is money you are holding on behalf of the revenue authority, the other is credit you offset against your own income tax.</p>
      ` : ''}
      ${Exporter.toolbar('wht', { label: 'this withholding tax register' })}
      ${outstanding.length ? `
        <div class="card" style="margin-bottom:14px;">
          <h3 style="margin-top:0;">Remit outstanding deductions</h3>
          <p style="font-size:13px;margin:0 0 10px;">${outstanding.length} deduction${outstanding.length === 1 ? '' : 's'} totalling <strong>${UI.money(outstanding.reduce((a, e) => a + Number(e.wht_amount || 0), 0))}</strong> ${branchId ? '' : '— select a single branch to remit'}</p>
          ${branchId ? `
            <div class="form-inline">
              <div class="form-row"><label>Remittance reference</label><input id="wht-ref" placeholder="e.g. FIRS receipt no." /></div>
              <button class="btn btn-primary" id="wht-remit">Mark as remitted</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Direction</th><th>Category</th><th>Counterparty</th><th>TIN</th><th style="text-align:right;">Gross</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Tax</th><th style="text-align:right;">Net</th><th>Status</th></tr></thead>
          <tbody>
            ${entries.length ? entries.map((e) => `
              <tr>
                <td>${UI.shortDate(e.entry_date)}</td>
                <td>${e.direction === 'PAYABLE' ? UI.badge('You withheld', 'amber') : UI.badge('Withheld from you', 'green')}</td>
                <td>${UI.escapeHtml(e.rate_code)}</td>
                <td>${UI.escapeHtml(e.supplier_name || e.customer_name || e.counterparty_name || '—')}</td>
                <td>${UI.escapeHtml(e.counterparty_tin || '—')}</td>
                <td style="text-align:right;">${UI.money(e.gross_amount)}</td>
                <td style="text-align:right;">${e.rate_percent}%</td>
                <td style="text-align:right;"><strong>${UI.money(e.wht_amount)}</strong></td>
                <td style="text-align:right;">${UI.money(e.net_amount)}</td>
                <td>${e.direction === 'RECEIVABLE' ? UI.badge('Reclaimable', 'blue') : (e.remitted_at ? UI.badge('Remitted', 'green') : UI.badge('Due', 'amber'))}</td>
              </tr>
            `).join('') : `<tr><td colspan="10" class="empty-state">No withholding tax recorded${branchId ? ' for this branch' : ''}.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p style="font-size:12px;margin-top:10px;">
        Withholding tax you deduct must reach the revenue authority by the <strong>21st of the month following</strong> the deduction,
        and every payee is entitled to a credit note for the amount withheld.
        Tax withheld <em>from you</em> is not a loss — it is an advance payment of your own income tax, reclaimable with the customer's credit note.
      </p>
    `;

    Exporter.wireTableReport('wht', {
      title: 'Withholding Tax Register',
      subtitle: scopeSubtitle(),
      filename: 'withholding-tax-register',
      columns: [
        { key: 'entry_date', label: 'Date', format: (v) => UI.shortDate(v) },
        { key: 'direction', label: 'Direction' },
        { key: 'rate_code', label: 'Category' },
        { key: 'counterparty', label: 'Counterparty' },
        { key: 'counterparty_tin', label: 'TIN' },
        { key: 'gross_amount', label: 'Gross', align: 'right', format: (v) => UI.money(v) },
        { key: 'rate_percent', label: 'Rate %', align: 'right' },
        { key: 'wht_amount', label: 'Tax', align: 'right', format: (v) => UI.money(v) },
        { key: 'net_amount', label: 'Net', align: 'right', format: (v) => UI.money(v) },
        { key: 'status', label: 'Status' },
      ],
      rows: entries.map((e) => ({
        ...e,
        counterparty: e.supplier_name || e.customer_name || e.counterparty_name || '',
        status: e.direction === 'RECEIVABLE' ? 'Reclaimable' : (e.remitted_at ? 'Remitted' : 'Due'),
      })),
      summary: [
        { label: 'Withheld by you (outstanding)', value: UI.money(outstanding.reduce((a, e) => a + Number(e.wht_amount || 0), 0)) },
        { label: 'Withheld by you (total)', value: UI.money(payable.reduce((a, e) => a + Number(e.wht_amount || 0), 0)) },
        { label: 'Withheld from you (reclaimable)', value: UI.money(receivable.reduce((a, e) => a + Number(e.wht_amount || 0), 0)) },
      ],
      emptyMessage: 'No withholding tax recorded.',
    });

    UI.guardedClick(document.getElementById('wht-remit'), async () => {
      try {
        const res = await Api.post('/wht/remit', {
          branch_id: branchId,
          entry_ids: outstanding.map((e) => e.id),
          remittance_ref: (document.getElementById('wht-ref') || {}).value || undefined,
        }, { allowOfflineQueue: false });
        UI.toast(`Remitted ${UI.money(res.total_remitted)} across ${res.remitted_count} deduction${res.remitted_count === 1 ? '' : 's'}`, 'success');
        Router.navigate();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }
}
