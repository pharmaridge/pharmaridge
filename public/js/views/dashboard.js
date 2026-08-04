async function renderDashboard(view) {
  const isManager = State.isManager();

  const [summary, trend] = await Promise.all([
    Api.get(Api.withScope('/dashboard/summary')),
    Api.get(Api.withScope('/dashboard/sales-trend?days=14')),
  ]);

  let branchBreakdown = [];
  let licenseAlerts = [];
  let voidAudit = [];
  if (isManager) {
    branchBreakdown = await Api.get('/dashboard/branches-breakdown');
  }
  licenseAlerts = await Api.get(Api.withScope('/dashboard/license-expiry-alerts'));
  voidAudit = await Api.get(Api.withScope('/dashboard/void-audit'));

  // Cash sales attached to no till session. Live checkout can no longer
  // create these, but a queued OFFLINE sale replaying after its shift was
  // closed still can — deliberately, because rejecting a replay would
  // erase money that was already taken. That exemption is only safe while
  // the result is visible to a manager, which is what this panel is for.
  // Manager-and-above only, like every other money-position read.
  let unreconciled = { count: 0, total_cash: 0, rows: [] };
  if (isManager) {
    unreconciled = await Api.get(Api.withScope('/dashboard/unreconciled-cash'));
  }

  const scopeLabel = summary.scope.all_branches ? 'All branches (organization total)' : 'Single branch view';
  const storage = summary.storage;
  const storageNotice = storage && storage.available && storage.status !== 'OK'
    ? `<div class="card" style="border-left:4px solid ${storage.status === 'CRITICAL' ? 'var(--red-500)' : 'var(--amber-500)'};background:${storage.status === 'CRITICAL' ? 'var(--tint-red)' : 'var(--tint-amber)'};margin-bottom:16px;">
        <h3 style="margin:0 0 6px;">${storage.status === 'CRITICAL' ? 'Storage almost full' : 'Storage is filling up'}</h3>
        <p style="margin:0 0 7px;font-size:13px;">${UI.escapeHtml(storage.message || '')}</p>
        <p style="margin:0;font-size:13px;"><strong>${storage.megabytes} MB</strong> of ${storage.limit_megabytes} MB estimated (${storage.percent_used}%). ${State.isOwner() ? 'Open My Plan to review the Owner-only data-management options.' : 'Tell the Owner so they can review capacity and retention choices.'}</p>
      </div>`
    : '';

  view.innerHTML = `
    <h2 class="page-title">Dashboard</h2>
    <p class="page-subtitle">${scopeLabel} — ${UI.shortDate(new Date().toISOString())}</p>
    ${storageNotice}
    ${Exporter.toolbar('dashboard', { label: 'this management summary' })}

    <div class="grid grid-4">
      <div class="stat-card">
        <div class="label">Sales Today</div>
        <div class="value">${UI.money(summary.sales_today.gross_sales)}</div>
        <div class="meta" style="font-size:11px;color:var(--gray-600);margin-top:4px;">${summary.sales_today.transaction_count || 0} transactions</div>
      </div>
      <div class="stat-card">
        <div class="label">Stock Value (Cost)</div>
        <div class="value">${UI.money(summary.stock_value.stock_value_at_cost || (summary.stock_value.total && summary.stock_value.total.stock_value_at_cost))}</div>
      </div>
      <div class="stat-card">
        <div class="label">Stock Value (Retail)</div>
        <div class="value">${UI.money(summary.stock_value.stock_value_at_retail || (summary.stock_value.total && summary.stock_value.total.stock_value_at_retail))}</div>
      </div>
      <div class="stat-card warn">
        <div class="label">Expiring ≤ 90 days</div>
        <div class="value">${summary.expiry_alerts_90d} batch(es)</div>
      </div>
      <div class="stat-card ${summary.low_stock_alerts > 0 ? 'danger' : ''}">
        <div class="label">Low Stock Alerts</div>
        <div class="value">${summary.low_stock_alerts} product(s)</div>
      </div>
    </div>

    <div class="grid grid-4" style="margin-top:16px;">
      <div class="stat-card">
        <div class="label">Owed BY Customers (Debtors)</div>
        <div class="value">${UI.money(summary.total_owed_by_debtors)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Owed TO Suppliers (Creditors)</div>
        <div class="value">${UI.money(summary.total_owed_to_suppliers)}</div>
      </div>
      <div class="stat-card ${summary.license_expiry_alerts > 0 ? 'danger' : ''}">
        <div class="label">Licence Renewals Due</div>
        <div class="value">${summary.license_expiry_alerts} branch(es)</div>
      </div>
      <div class="stat-card ${summary.flagged_attendance_pending_review > 0 ? 'warn' : ''}">
        <div class="label">Attendance Pending Review</div>
        <div class="value">${summary.flagged_attendance_pending_review}</div>
      </div>
      <!-- BUG 95. Cash sitting in the drawer that is NOT the pharmacy's — the
           customer could walk in for it today. Shown next to the debtor and
           creditor tiles because it is the same kind of figure: an amount owed,
           in the opposite direction. Filled in after paint so a slow query
           never delays the dashboard. -->
      <div class="stat-card" id="dash-change-owed-card">
        <div class="label">Change We Owe Customers</div>
        <div class="value" id="dash-change-owed">—</div>
      </div>
    </div>

    ${licenseAlerts.length ? `
    <div class="card" style="border-left:4px solid var(--red-500);margin-top:16px;">
      <h3>⚠ Licence Renewals Due Soon</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Branch</th><th>PCN Licence Expiry</th><th>Superintendent Registration Expiry</th></tr></thead>
          <tbody>
            ${licenseAlerts.map(a => `
              <tr>
                <td>${UI.escapeHtml(a.branch_name)}</td>
                <td>${a.pcn_license_expiry_date ? `${a.pcn_license_expiry_date} ${a.pcn_days_to_expiry < 0 ? UI.badge('EXPIRED', 'red') : UI.badge(a.pcn_days_to_expiry + 'd left', 'amber')}` : '—'}</td>
                <td>${a.superintendent_registration_expiry_date ? `${a.superintendent_registration_expiry_date} ${a.superintendent_days_to_expiry < 0 ? UI.badge('EXPIRED', 'red') : UI.badge(a.superintendent_days_to_expiry + 'd left', 'amber')}` : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="card" style="margin-top:16px;">
      <h3>Sales Trend (last 14 days)</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Transactions</th><th>Gross Sales</th><th>Discount</th></tr></thead>
          <tbody>
            ${trend.length ? trend.map(t => `
              <tr><td>${t.sale_date}</td><td>${t.transaction_count}</td><td>${UI.money(t.gross_sales)}</td><td>${UI.money(t.total_discount)}</td></tr>
            `).join('') : '<tr><td colspan="4" class="empty-state">No sales recorded yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    ${isManager ? `
    <div class="card">
      <h3>Per-Branch Breakdown (today)</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Branch</th><th>Transactions</th><th>Gross Sales</th><th>Stock Value (Cost)</th><th>Stock Value (Retail)</th><th></th></tr></thead>
          <tbody>
            ${branchBreakdown.map(b => `
              <tr>
                <td>${UI.escapeHtml(b.branch_name)}</td>
                <td>${b.sales_today.transaction_count || 0}</td>
                <td>${UI.money(b.sales_today.gross_sales)}</td>
                <td>${UI.money(b.stock_value.stock_value_at_cost)}</td>
                <td>${UI.money(b.stock_value.stock_value_at_retail)}</td>
                <td><button class="btn btn-secondary btn-sm" data-drill="${b.branch_id}">Drill in</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${isManager && unreconciled.count ? `
    <div class="card" style="border-left:4px solid var(--red-500);">
      <h3>Unreconciled Cash — ${UI.money(unreconciled.total_cash)} across ${unreconciled.count} sale(s)</h3>
      <p class="page-subtitle">These cash sales are not attached to any till session, so they are invisible to till reconciliation. This normally means a sale was rung up offline and synced after its shift was already closed. Check the cash was banked, then note it against the right shift.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Branch</th><th>Served By</th><th>Cash</th></tr></thead>
          <tbody>
            ${unreconciled.rows.map(r => `
              <tr>
                <td>${UI.shortDate(r.created_at)}</td>
                <td>${UI.escapeHtml(r.branch_name || '')}</td>
                <td>${UI.escapeHtml(r.served_by_name || '—')}</td>
                <td>${UI.money(r.cash_amount)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="card">
      <h3>Void/Refund Audit — Fraud &amp; Shrinkage Signal</h3>
      <p class="page-subtitle">Staff with an unusually high void rate relative to their total sales are worth a closer look.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Staff</th><th>Total Sales</th><th>Voided</th><th>Voided Value</th><th>Void Rate</th></tr></thead>
          <tbody>
            ${voidAudit.length ? voidAudit.map(v => `
              <tr>
                <td>${UI.escapeHtml(v.user_full_name)}</td>
                <td>${v.total_sales}</td>
                <td>${v.voided_sales}</td>
                <td>${UI.money(v.voided_value)}</td>
                <td>${v.void_rate_pct >= 10 ? UI.badge(v.void_rate_pct + '%', 'red') : v.void_rate_pct > 0 ? UI.badge(v.void_rate_pct + '%', 'amber') : v.void_rate_pct + '%'}</td>
              </tr>
            `).join('') : `<tr><td colspan="5" class="empty-state">No sales data yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // The dashboard is a MANAGEMENT SUMMARY, not one table — the printed form
  // composes the headline figures plus the sales trend, so an owner can file
  // or email a period snapshot.
  Exporter.wireToolbar('dashboard', {
    print: () => Exporter.printDocument(
      Exporter.documentHeader('Management Summary', scopeLabel)
      + `<table class="print-summary" style="margin:0 0 12px 0;"><tbody>
           <tr><th>Sales Today</th><td style="text-align:right">${Exporter.escapeHtml(UI.money(summary.sales_today.gross_sales))}</td></tr>
           <tr><th>Transactions Today</th><td style="text-align:right">${summary.sales_today.transaction_count || 0}</td></tr>
         </tbody></table>`
      + `<div class="print-section"><h3>Sales Trend (last 14 days)</h3>
          <table class="print-table">
            <thead><tr><th>Date</th><th style="text-align:right">Transactions</th><th style="text-align:right">Gross Sales</th><th style="text-align:right">Discount</th></tr></thead>
            <tbody>${trend.length ? trend.map((t) => `<tr>
              <td>${Exporter.escapeHtml(t.sale_date)}</td>
              <td style="text-align:right">${t.transaction_count}</td>
              <td style="text-align:right">${Exporter.escapeHtml(UI.money(t.gross_sales))}</td>
              <td style="text-align:right">${Exporter.escapeHtml(UI.money(t.total_discount))}</td>
            </tr>`).join('') : '<tr><td colspan="4" style="text-align:center">No sales recorded yet</td></tr>'}</tbody>
          </table></div>`
      + (licenseAlerts.length ? `<div class="print-section"><h3>Licence Expiry Alerts</h3>
          <table class="print-table"><thead><tr><th>Branch</th><th>Licence</th><th>Expires</th><th style="text-align:right">Days</th></tr></thead>
          <tbody>${licenseAlerts.map((a) => `<tr>
            <td>${Exporter.escapeHtml(a.branch_name || '')}</td>
            <td>${Exporter.escapeHtml(a.license_type || a.alert_type || '')}</td>
            <td>${Exporter.escapeHtml(a.expiry_date || '')}</td>
            <td style="text-align:right">${a.days_to_expiry != null ? a.days_to_expiry : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '')
      + Exporter.documentFooter(''),
      { title: 'Management Summary' }
    ),
    csv: () => Exporter.downloadCSV('sales-trend',
      [ { key: 'sale_date', label: 'Date' }, { key: 'transaction_count', label: 'Transactions' },
        { key: 'gross_sales', label: 'Gross Sales' }, { key: 'total_discount', label: 'Discount' } ],
      trend),
  });

  view.querySelectorAll('[data-drill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      State.setViewBranch(btn.dataset.drill);
      window.App.refreshBranchSwitcher();
      Router.navigate();
    });
  });

  // BUG 95 tile. Loaded after paint, and any failure leaves the dash-
  // board fully usable — a supplementary figure must never be able to take
  // the main screen down with it.
  (async () => {
    const el = document.getElementById('dash-change-owed');
    if (!el) return;
    try {
      const s = await Api.get(Api.withScope('/change-owed/summary'));
      const total = Number((s && s.total_owed) || 0);
      el.textContent = UI.money(total);
      if (total > 0) {
        const card = document.getElementById('dash-change-owed-card');
        if (card) card.classList.add('warn');
        el.insertAdjacentHTML('afterend',
          `<div class="page-subtitle" style="margin:2px 0 0;font-size:12px;">${Number(s.claim_count || 0)} customer(s) can collect</div>`);
      }
    } catch (e) { el.textContent = '—'; }
  })();
}
