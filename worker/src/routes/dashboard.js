const { Hono } = require('hono');
const { authRequired, managerOnly, resolveScopedBranchId } = require('../lib/auth');
const { getClientSettings, activeBranchCount, activeStaffCount, effectiveMaxBranches, contactLine } = require('../lib/planLimits');
const { getStorageHealth } = require('../lib/storageHealth');
const attendanceService = require('../services/attendanceService');

const dashboard = new Hono();
dashboard.use('*', authRequired);

// TIMEZONE: see the identical fix + full write-up in the original design
// and migration 009's comment — this is a Nigeria-only product, "today"
// means the calendar date in West Africa Time (UTC+1, no DST), and the
// v_daily_sales_by_branch/v_daily_sales_total views already bucket by WAT,
// so every "today"/"last N days" comparison here must match.
const TODAY_WAT = "date('now', '+1 hours')";

dashboard.get('/summary', async (c) => {
  const db = c.env.DB;
  const branchId = resolveScopedBranchId(c);

  const salesToday = branchId
    ? await db.prepare(`SELECT * FROM v_daily_sales_by_branch WHERE branch_id = ? AND sale_date = ${TODAY_WAT}`).bind(branchId).first()
    : await db.prepare(`SELECT * FROM v_daily_sales_total WHERE sale_date = ${TODAY_WAT}`).first();

  let stockValue;
  if (branchId) {
    stockValue = await db.prepare('SELECT * FROM v_stock_value_by_branch WHERE branch_id = ?').bind(branchId).first();
  } else {
    const { results: rows } = await db.prepare('SELECT * FROM v_stock_value_by_branch').all();
    stockValue = rows.reduce((acc, r) => ({
      stock_value_at_cost: (acc.stock_value_at_cost || 0) + (r.stock_value_at_cost || 0),
      stock_value_at_retail: (acc.stock_value_at_retail || 0) + (r.stock_value_at_retail || 0),
    }), {});
  }

  const expiryAlerts = branchId
    ? await db.prepare('SELECT COUNT(*) AS n FROM v_expiry_alerts WHERE branch_id = ? AND days_to_expiry <= 90').bind(branchId).first()
    : await db.prepare('SELECT COUNT(*) AS n FROM v_expiry_alerts WHERE days_to_expiry <= 90').first();

  const lowStock = branchId
    ? await db.prepare('SELECT COUNT(*) AS n FROM v_low_stock_alerts WHERE branch_id = ?').bind(branchId).first()
    : await db.prepare('SELECT COUNT(*) AS n FROM v_low_stock_alerts').first();

  const debtors = branchId
    ? await db.prepare('SELECT COALESCE(SUM(balance_owed),0) AS total FROM v_debtor_balances WHERE branch_id = ?').bind(branchId).first()
    : await db.prepare('SELECT COALESCE(SUM(balance_owed),0) AS total FROM v_debtor_balances').first();

  const creditors = branchId
    ? await db.prepare('SELECT COALESCE(SUM(balance_owed),0) AS total FROM v_creditor_balances WHERE branch_id = ?').bind(branchId).first()
    : await db.prepare('SELECT COALESCE(SUM(balance_owed),0) AS total FROM v_creditor_balances').first();

  const licenseAlerts = branchId
    ? await db.prepare('SELECT COUNT(*) AS n FROM v_license_expiry_alerts WHERE branch_id = ?').bind(branchId).first()
    : await db.prepare('SELECT COUNT(*) AS n FROM v_license_expiry_alerts').first();

  const flaggedPlaceholders = attendanceService.FLAGGED_STATUSES.map(() => '?').join(',');
  const flaggedAttendanceSql = branchId
    ? `SELECT COUNT(*) AS n FROM staff_attendance WHERE branch_id = ? AND is_deleted = 0 AND manager_override_by IS NULL AND (clock_in_status IN (${flaggedPlaceholders}) OR clock_out_status IN (${flaggedPlaceholders}))`
    : `SELECT COUNT(*) AS n FROM staff_attendance WHERE is_deleted = 0 AND manager_override_by IS NULL AND (clock_in_status IN (${flaggedPlaceholders}) OR clock_out_status IN (${flaggedPlaceholders}))`;
  const flaggedAttendance = branchId
    ? await db.prepare(flaggedAttendanceSql).bind(branchId, ...attendanceService.FLAGGED_STATUSES, ...attendanceService.FLAGGED_STATUSES).first()
    : await db.prepare(flaggedAttendanceSql).bind(...attendanceService.FLAGGED_STATUSES, ...attendanceService.FLAGGED_STATUSES).first();


  return c.json({
    scope: branchId ? { branch_id: branchId } : { all_branches: true },
    sales_today: salesToday || { transaction_count: 0, gross_sales: 0, total_discount: 0 },
    stock_value: stockValue || { stock_value_at_cost: 0, stock_value_at_retail: 0 },
    expiry_alerts_90d: expiryAlerts.n,
    low_stock_alerts: lowStock.n,
    total_owed_by_debtors: debtors.total,
    total_owed_to_suppliers: creditors.total,
    license_expiry_alerts: licenseAlerts.n,
    flagged_attendance_pending_review: flaggedAttendance.n,
  });
});

dashboard.get('/license-expiry-alerts', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const sql = branchId ? 'SELECT * FROM v_license_expiry_alerts WHERE branch_id = ?' : 'SELECT * FROM v_license_expiry_alerts';
  const { results } = branchId ? await c.env.DB.prepare(sql).bind(branchId).all() : await c.env.DB.prepare(sql).all();
  return c.json(results);
});

dashboard.get('/void-audit', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const sql = branchId
    ? 'SELECT * FROM v_void_audit_by_user WHERE branch_id = ? ORDER BY void_rate_pct DESC'
    : 'SELECT * FROM v_void_audit_by_user ORDER BY void_rate_pct DESC';
  const { results } = branchId ? await c.env.DB.prepare(sql).bind(branchId).all() : await c.env.DB.prepare(sql).all();
  return c.json(results);
});

// UNRECONCILED CASH — cash sales that belong to no till session.
//
// Live cash checkout now requires an open till (BUG 37), but a queued
// OFFLINE sale replaying after its shift closed is deliberately still
// accepted unlinked: refusing it would only delete the record of money
// already taken (see the X-Offline-Replay note in routes/sales.js). That
// exemption is only safe if the unlinked cash is VISIBLE — otherwise it is
// exactly the silent hole the guard was written to close.
//
// Manager-and-above, matching the other money-position reads.
dashboard.get('/unreconciled-cash', managerOnly, async (c) => {
  const branchId = resolveScopedBranchId(c);
  const where = branchId ? 'AND s.branch_id = ?' : '';
  const sql = `
    SELECT s.id            AS sale_id,
           s.branch_id     AS branch_id,
           b.name          AS branch_name,
           u.full_name     AS served_by_name,
           s.created_at    AS created_at,
           SUM(sp.amount)  AS cash_amount
    FROM sales s
    JOIN sale_payments sp ON sp.sale_id = s.id AND sp.method = 'CASH' AND sp.is_deleted = 0
    JOIN branches b ON b.id = s.branch_id
    LEFT JOIN users u ON u.id = s.served_by
    WHERE s.till_session_id IS NULL
      AND s.status = 'COMPLETED'
      AND s.is_deleted = 0
      ${where}
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT 200
  `;
  const { results } = branchId
    ? await c.env.DB.prepare(sql).bind(branchId).all()
    : await c.env.DB.prepare(sql).all();
  const total = (results || []).reduce((sum, r) => sum + Number(r.cash_amount || 0), 0);
  return c.json({
    count: (results || []).length,
    total_cash: Math.round(total * 100) / 100,
    rows: results || [],
  });
});

dashboard.get('/branches-breakdown', managerOnly, async (c) => {
  const db = c.env.DB;
  // CLOUDFLARE FREE-TIER SUBREQUEST SAFETY NET (found and fixed during a
  // production audit — same bug class as the sales engine's Bugs 1/2 and
  // the stocktake-close bug): this endpoint previously issued 2 D1 reads
  // PER BRANCH inside a JS loop (one for that branch's today's-sales
  // view row, one for its stock-value view row). For a growing
  // multi-branch client — which is the entire point of this product —
  // as few as ~21 branches would push a single request over the
  // Workers Free plan's hard 50-subrequest-per-invocation ceiling, on
  // top of the ~7-8 fixed subrequests already spent on auth/
  // subscription-gate middleware and the branch list itself. Live-
  // verified: a 35-branch org previously cost ~78 subrequests for this
  // one endpoint call — comfortably over the limit — while appearing to
  // work fine locally against `wrangler dev` (which does not enforce
  // this specific production quota). Fixed by reading BOTH views in
  // full (one query each, already branch-scoped by their own GROUP BY)
  // and joining them to the branch list in JS, dropping the per-request
  // cost from 2N+~8 to a small constant (~10) regardless of branch
  // count.
  const { results: branches } = await db.prepare('SELECT id, name FROM branches WHERE is_deleted = 0').all();
  const { results: salesRows } = await db.prepare(`SELECT * FROM v_daily_sales_by_branch WHERE sale_date = ${TODAY_WAT}`).all();
  const { results: stockRows } = await db.prepare('SELECT * FROM v_stock_value_by_branch').all();
  const salesByBranch = new Map(salesRows.map((r) => [r.branch_id, r]));
  const stockByBranch = new Map(stockRows.map((r) => [r.branch_id, r]));

  const result = branches.map((b) => ({
    branch_id: b.id, branch_name: b.name,
    sales_today: salesByBranch.get(b.id) || { transaction_count: 0, gross_sales: 0, total_discount: 0 },
    stock_value: stockByBranch.get(b.id) || { stock_value_at_cost: 0, stock_value_at_retail: 0 },
  }));
  return c.json(result);
});

dashboard.get('/sales-trend', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const days = Number(c.req.query('days') || 14);
  const sql = branchId
    ? `SELECT sale_date, transaction_count, gross_sales, total_discount FROM v_daily_sales_by_branch WHERE branch_id = ? AND sale_date >= date('now', '+1 hours', ?) ORDER BY sale_date`
    : `SELECT sale_date, transaction_count, gross_sales, total_discount FROM v_daily_sales_total WHERE sale_date >= date('now', '+1 hours', ?) ORDER BY sale_date`;
  const { results } = branchId ? await c.env.DB.prepare(sql).bind(branchId, `-${days} days`).all() : await c.env.DB.prepare(sql).bind(`-${days} days`).all();
  return c.json(results);
});

// OWNER's (and MANAGER's) read-only view of this deployment's plan
// limits/usage/subscription status — see the write-up below's /plan
// endpoint for the full rationale.
dashboard.get('/plan', managerOnly, async (c) => {
  const db = c.env.DB;
  const settings = await getClientSettings(db);
  const branchesUsed = await activeBranchCount(db);
  const staffUsed = await activeStaffCount(db);
  const effectiveMaxBr = effectiveMaxBranches(settings);
  return c.json({
    subscription_status: settings.subscription_status,
    subscription_plan: settings.subscription_plan,
    subscription_renewal_date: settings.subscription_renewal_date,
    // Storage headroom belongs on the OWNER's plan screen alongside
    // branch/staff limits: it is the same class of fact (a ceiling this
    // deployment can hit) and the same remedy (contact support to
    // upgrade). Crucially it warns MONTHS ahead — at the ceiling D1
    // fails WRITES while reads keep working, so the pharmacy would
    // otherwise discover it only when a sale refuses to record.
    storage: await getStorageHealth(db),
    branches: { used: branchesUsed, max: effectiveMaxBr, remaining: Math.max(0, effectiveMaxBr - branchesUsed) },
    staff: { used: staffUsed, max: settings.max_staff, remaining: Math.max(0, settings.max_staff - staffUsed) },
    features: {
      attendance_module_enabled: !!settings.attendance_module_enabled,
      controlled_register_enabled: !!settings.controlled_register_enabled,
      multi_branch_enabled: !!settings.multi_branch_enabled,
    },
    branding: {
      business_name: settings.business_name || null,
      has_logo: !!settings.logo_data_url,
    },
    support_contact: {
      name: settings.admin_contact_name || null,
      phone: settings.admin_contact_phone || null,
      email: settings.admin_contact_email || null,
      display: contactLine(settings),
    },
  });
});

module.exports = dashboard;
