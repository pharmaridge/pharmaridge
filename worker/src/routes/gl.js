// General Ledger reporting routes for the Cloudflare D1 deployment —
// mirrors the original design exactly for full backend parity. See the
// original implementation's "GENERAL LEDGER & CHART OF ACCOUNTS" section
// and worker/src/services/glService.js for the full accounting rationale.
//
// VISIBILITY: managerOnly (MANAGER/OWNER/ADMIN) — see the identical
// rationale in the original design.
const { Hono } = require('hono');
const { authRequired, managerOnly, resolveScopedBranchId } = require('../lib/auth');
const glService = require('../services/glService');
const { RETAIL_CATEGORIES, isRetailCategory, retailCategoryLabel } = require('../lib/retailCategories');

const gl = new Hono();
gl.use('*', authRequired);
gl.use('*', managerOnly);

gl.get('/chart-of-accounts', async (c) => {
  return c.json(await glService.getChartOfAccounts(c.env.DB));
});

gl.get('/trial-balance', async (c) => {
  const branchId = resolveScopedBranchId(c);
  return c.json(await glService.getTrialBalance(c.env.DB, branchId));
});

gl.get('/profit-loss', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  if (!startDate || !endDate) {
    return c.json({ error: 'start_date and end_date query parameters are required (YYYY-MM-DD)' }, 400);
  }
  return c.json(await glService.getProfitAndLoss(c.env.DB, { branchId, startDate, endDate }));
});

gl.get('/balance-sheet', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const asOfDate = c.req.query('as_of_date') || new Date().toISOString().slice(0, 10);
  return c.json(await glService.getBalanceSheet(c.env.DB, { branchId, asOfDate }));
});

// Retail category GL analysis. Uses dimensions saved on sale-related journal
// lines, so it reports the category at sale time even after a product is later
// reclassified. Payment-method lines are intentionally untagged: a split cash/
// transfer tender belongs to the whole basket, not one category.
gl.get('/retail-category-summary', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const startDate = c.req.query('start_date') || '1970-01-01';
  const endDate = c.req.query('end_date') || '2999-12-31';
  const retailCategory = c.req.query('retail_category');
  if (retailCategory && !isRetailCategory(retailCategory)) {
    return c.json({ error: `retail_category must be one of: ${RETAIL_CATEGORIES.map((entry) => entry.code).join(', ')}`, code: 'INVALID_RETAIL_CATEGORY' }, 400);
  }
  let sql = `
    SELECT gjl.retail_category,
           COALESCE(SUM(CASE WHEN ga.code = 'SALES_REVENUE' THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS revenue_net_of_vat,
           COALESCE(SUM(CASE WHEN ga.code = 'SALES_DISCOUNTS' THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS discounts,
           COALESCE(SUM(CASE WHEN ga.code = 'COST_OF_GOODS_SOLD' THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS cost_of_goods_sold,
           COALESCE(SUM(CASE WHEN ga.code = 'VAT_PAYABLE' THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS vat_collected
      FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.account_id
     WHERE gjl.retail_category IS NOT NULL
       AND gje.status = 'POSTED' AND gje.is_deleted = 0
       AND gje.source_type IN ('SALE', 'SALE_VOID')
       AND date(gje.entry_date, '+1 hours') >= date(?)
       AND date(gje.entry_date, '+1 hours') <= date(?)
  `;
  const params = [startDate, endDate];
  if (branchId) { sql += ' AND gje.branch_id = ?'; params.push(branchId); }
  if (retailCategory) { sql += ' AND gjl.retail_category = ?'; params.push(retailCategory); }
  sql += ' GROUP BY gjl.retail_category ORDER BY revenue_net_of_vat DESC, gjl.retail_category';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results.map((row) => {
    const revenue = Number(row.revenue_net_of_vat || 0);
    const discounts = Number(row.discounts || 0);
    const cogs = Number(row.cost_of_goods_sold || 0);
    return {
      ...row,
      retail_category_label: retailCategoryLabel(row.retail_category),
      net_revenue: Math.round((revenue - discounts) * 100) / 100,
      gross_profit: Math.round((revenue - discounts - cogs) * 100) / 100,
    };
  }));
});

// Drill-down: every journal entry for a given source event — see the
// identical endpoint + rationale in the original design.
//
// CLOUDFLARE FREE-TIER SUBREQUEST SAFETY NET: fetching each entry's lines
// with a separate per-entry query (N+1) would risk exceeding the Workers
// Free plan's 50-subrequest-per-invocation ceiling on an unfiltered call
// (up to 200 entries = 200 extra reads) — the exact bug class already
// found and fixed in worker/src/services/stocktakeService.js's
// closeStocktake. Fixed the same way: one bulk query for ALL entries'
// lines via `IN (...)`, chunked at D1's own 100-bound-parameters-per-query
// ceiling, instead of one query per entry.
gl.get('/journal-entries', async (c) => {
  const db = c.env.DB;
  const branchId = resolveScopedBranchId(c);
  const sourceType = c.req.query('source_type');
  const sourceId = c.req.query('source_id');
  let sql = `
    SELECT je.*, u.full_name AS posted_by_name
    FROM gl_journal_entries je
    LEFT JOIN users u ON u.id = je.posted_by
    WHERE je.is_deleted = 0 AND je.status = 'POSTED'
  `;
  const params = [];
  if (branchId) { sql += ' AND je.branch_id = ?'; params.push(branchId); }
  if (sourceType) { sql += ' AND je.source_type = ?'; params.push(sourceType); }
  if (sourceId) { sql += ' AND je.source_id = ?'; params.push(sourceId); }
  sql += ' ORDER BY je.created_at DESC LIMIT 200';
  const { results: entries } = await db.prepare(sql).bind(...params).all();

  const linesByEntryId = new Map();
  const entryIds = entries.map((e) => e.id);
  const CHUNK = 100;
  for (let i = 0; i < entryIds.length; i += CHUNK) {
    const chunk = entryIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const { results: lines } = await db.prepare(`
      SELECT gjl.*, ga.code AS account_code, ga.name AS account_name
      FROM gl_journal_lines gjl JOIN gl_accounts ga ON ga.id = gjl.account_id
      WHERE gjl.journal_entry_id IN (${placeholders})
    `).bind(...chunk).all();
    for (const line of lines) {
      if (!linesByEntryId.has(line.journal_entry_id)) linesByEntryId.set(line.journal_entry_id, []);
      linesByEntryId.get(line.journal_entry_id).push(line);
    }
  }
  for (const e of entries) e.lines = linesByEntryId.get(e.id) || [];

  return c.json(entries);
});

module.exports = gl;
