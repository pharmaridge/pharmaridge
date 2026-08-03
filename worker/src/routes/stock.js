const { Hono } = require('hono');
const { authRequired, resolveScopedBranchId } = require('../lib/auth');

const stock = new Hono();
stock.use('*', authRequired);

stock.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const productId = c.req.query('product_id');
  const limit = Math.min(Number(c.req.query('limit')) || 500, 2000);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  let sql = `
    SELECT sb.*, p.name AS product_name, p.base_unit, p.units_per_pack, p.packs_per_carton, b.name AS branch_name
    FROM stock_batches sb JOIN products p ON p.id = sb.product_id JOIN branches b ON b.id = sb.branch_id
    WHERE sb.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND sb.branch_id = ?'; params.push(branchId); }
  if (productId) { sql += ' AND sb.product_id = ?'; params.push(productId); }
  sql += ' ORDER BY CASE WHEN sb.expiry_date IS NULL THEN 1 ELSE 0 END, sb.expiry_date ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

stock.get('/expiry-alerts', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const days = c.req.query('within_days') ? Number(c.req.query('within_days')) : null;
  const limit = Math.min(Number(c.req.query('limit')) || 1000, 5000);
  let rows;
  if (branchId) {
    ({ results: rows } = await c.env.DB.prepare('SELECT * FROM v_expiry_alerts WHERE branch_id = ?').bind(branchId).all());
  } else {
    ({ results: rows } = await c.env.DB.prepare('SELECT * FROM v_expiry_alerts').all());
  }
  if (days != null) rows = rows.filter((r) => r.days_to_expiry <= days);
  return c.json(rows.slice(0, limit));
});

stock.get('/low-stock', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const limit = Math.min(Number(c.req.query('limit')) || 1000, 5000);
  let rows;
  if (branchId) {
    ({ results: rows } = await c.env.DB.prepare('SELECT * FROM v_low_stock_alerts WHERE branch_id = ?').bind(branchId).all());
  } else {
    ({ results: rows } = await c.env.DB.prepare('SELECT * FROM v_low_stock_alerts').all());
  }
  return c.json(rows.slice(0, limit));
});

stock.get('/value', async (c) => {
  const branchId = resolveScopedBranchId(c);
  if (branchId) {
    const row = await c.env.DB.prepare('SELECT * FROM v_stock_value_by_branch WHERE branch_id = ?').bind(branchId).first();
    return c.json(row || { branch_id: branchId, stock_value_at_cost: 0, stock_value_at_retail: 0 });
  }
  const { results: rows } = await c.env.DB.prepare('SELECT * FROM v_stock_value_by_branch').all();
  const totals = rows.reduce((acc, r) => ({
    stock_value_at_cost: acc.stock_value_at_cost + (r.stock_value_at_cost || 0),
    stock_value_at_retail: acc.stock_value_at_retail + (r.stock_value_at_retail || 0),
  }), { stock_value_at_cost: 0, stock_value_at_retail: 0 });
  return c.json({ by_branch: rows, total: totals });
});

module.exports = stock;
