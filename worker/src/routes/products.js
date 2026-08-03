const { Hono } = require('hono');
const { normaliseMoney } = require('../lib/business');
const { authRequired, managerOnly } = require('../lib/auth');
const { assertManagerPermission } = require('../lib/planLimits');
const { uuid } = require('../lib/crypto');
const { readJsonBody } = require('../lib/http');

const products = new Hono();
products.use('*', authRequired);

products.get('/', async (c) => {
  const q = (c.req.query('q') || '').trim();
  let results;
  if (q) {
    const like = `%${q}%`;
    ({ results } = await c.env.DB.prepare(`SELECT * FROM products WHERE is_deleted = 0 AND (name LIKE ? OR generic_name LIKE ? OR nafdac_reg_no LIKE ?) ORDER BY name LIMIT 100`).bind(like, like, like).all());
  } else {
    ({ results } = await c.env.DB.prepare('SELECT * FROM products WHERE is_deleted = 0 ORDER BY name LIMIT 500').all());
  }
  return c.json(results);
});

products.get('/:id', async (c) => {
  const p = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
  if (!p) return c.json({ error: 'Product not found' }, 404);
  const { results: overrides } = await c.env.DB.prepare('SELECT * FROM product_price_overrides WHERE product_id = ? AND is_deleted = 0').bind(c.req.param('id')).all();
  return c.json({ ...p, price_overrides: overrides });
});

products.post('/', managerOnly, async (c) => {
  const body = await readJsonBody(c);
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  // FINANCIAL/DATA-INTEGRITY: see the full explanation below.
  if (body.units_per_pack != null && (!Number.isInteger(body.units_per_pack) || body.units_per_pack < 1)) {
    return c.json({ error: 'units_per_pack must be a positive whole number' }, 400);
  }
  if (body.packs_per_carton != null && (!Number.isInteger(body.packs_per_carton) || body.packs_per_carton < 1)) {
    return c.json({ error: 'packs_per_carton must be a positive whole number (or omitted entirely if this product is never sold by the carton)' }, 400);
  }
  if (body.reorder_level != null && (!Number.isInteger(body.reorder_level) || body.reorder_level < 0)) {
    return c.json({ error: 'reorder_level must be a non-negative whole number' }, 400);
  }
  // NAFDAC CATALOG LINK (optional). When the product was created by picking a
  // row from the approved-product catalog, the client sends that row's id and
  // we record the provenance. Validated rather than trusted: a bogus id would
  // otherwise fail later as a raw foreign-key 500 at INSERT time.
  //
  // Deliberately optional — a product that is NOT in the catalog (a new
  // registration, an imported item, a non-drug shelf product) is added exactly
  // as before with this left NULL. That manual path is first-class, not a
  // fallback, and is covered by its own regression test.
  let catalogId = null;
  if (body.nafdac_catalog_id != null && body.nafdac_catalog_id !== '') {
    const n = Number(body.nafdac_catalog_id);
    if (!Number.isInteger(n) || n < 1) {
      return c.json({ error: 'nafdac_catalog_id must be a positive whole number' }, 400);
    }
    const exists = await c.env.DB.prepare('SELECT id FROM nafdac_catalog WHERE id = ?').bind(n).first();
    if (!exists) return c.json({ error: 'nafdac_catalog_id does not match any catalog entry' }, 400);
    catalogId = n;
  }

  const id = uuid();
  await c.env.DB.prepare(`
    INSERT INTO products (id, name, generic_name, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level, nafdac_catalog_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, body.name, body.generic_name || null, body.category || null, body.nafdac_reg_no || null, body.is_controlled ? 1 : 0,
          body.dispensing_type || 'OTC', body.base_unit || 'tablet', body.units_per_pack || 1, body.packs_per_carton || null, body.reorder_level || 0, catalogId).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first(), 201);
});

products.put('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Product not found' }, 404);
  const body = await readJsonBody(c);
  if (body.units_per_pack !== undefined && body.units_per_pack != null && (!Number.isInteger(body.units_per_pack) || body.units_per_pack < 1)) {
    return c.json({ error: 'units_per_pack must be a positive whole number' }, 400);
  }
  if (body.packs_per_carton !== undefined && body.packs_per_carton != null && (!Number.isInteger(body.packs_per_carton) || body.packs_per_carton < 1)) {
    return c.json({ error: 'packs_per_carton must be a positive whole number (or null if this product is never sold by the carton)' }, 400);
  }
  if (body.reorder_level !== undefined && body.reorder_level != null && (!Number.isInteger(body.reorder_level) || body.reorder_level < 0)) {
    return c.json({ error: 'reorder_level must be a non-negative whole number' }, 400);
  }
  const fields = ['name', 'generic_name', 'category', 'nafdac_reg_no', 'is_controlled', 'dispensing_type', 'base_unit', 'units_per_pack', 'packs_per_carton', 'reorder_level'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (updates.length === 0) return c.json(existing);
  const setClause = updates.map((f) => `${f} = ?`).join(', ');
  // DATA-INTEGRITY: see the full explanation below — unlike POST above, this
  // raw-bound `is_controlled` as whatever JS type the client sent (a genuine
  // boolean, exactly what this app's own Products management UI naturally
  // sends when toggling the controlled-substance flag). D1 is more lenient
  // than better-sqlite3 about binding a raw boolean (it does not throw), but
  // SQLite still stores it inconsistently depending on the driver's own
  // boolean-to-SQLite-type coercion rather than the explicit, intentional
  // 1/0 INTEGER this column's schema and every other write path expects — so
  // this coercion is applied here too for correctness/parity, not just to
  // avoid a crash.
  const vals = updates.map((f) => (f === 'is_controlled' ? (body[f] ? 1 : 0) : body[f]));
  await c.env.DB.prepare(`UPDATE products SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).bind(...vals, id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first());
});

products.delete('/:id', managerOnly, async (c) => {
  await c.env.DB.prepare(`UPDATE products SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?`).bind(c.req.param('id')).run();
  return c.body(null, 204);
});

products.put('/:id/price-override/:branchId', managerOnly, async (c) => {
  const { id, branchId } = c.req.param();
  const body = await readJsonBody(c);
  // OWNER-CONTROLLED MANAGER PERMISSION (migration 0003): a branch price
  // override directly sets what customers are charged.
  {
    const permErr = await assertManagerPermission(c.env.DB, c.get('user'), 'managers_can_edit_prices');
    if (permErr) return c.json({ error: permErr.message, code: permErr.code }, permErr.status);
  }
  if (body.default_selling_price == null) return c.json({ error: 'default_selling_price is required' }, 400);
  // FINANCIAL-INTEGRITY: see the full explanation below.
  if (!Number.isFinite(body.default_selling_price) || body.default_selling_price < 0) {
    return c.json({ error: 'default_selling_price must be a non-negative number' }, 400);
  }
  if (body.pack_price != null && (!Number.isFinite(body.pack_price) || body.pack_price < 0)) {
    return c.json({ error: 'pack_price must be a non-negative number' }, 400);
  }
  if (body.carton_price != null && (!Number.isFinite(body.carton_price) || body.carton_price < 0)) {
    return c.json({ error: 'carton_price must be a non-negative number' }, 400);
  }

  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!product) return c.json({ error: 'Product not found' }, 404);
  const branch = await c.env.DB.prepare('SELECT id FROM branches WHERE id = ? AND is_deleted = 0').bind(branchId).first();
  if (!branch) return c.json({ error: 'Branch not found' }, 404);

  const existing = await c.env.DB.prepare('SELECT * FROM product_price_overrides WHERE product_id = ? AND branch_id = ?').bind(id, branchId).first();
  const user = c.get('user');
  // BUG 52: a price is money and must be kobo-exact before storage. An
  // override of 33.333333333 would otherwise become the unit price FEFO
  // charges, and every line total computed from it inherits a figure the
  // REAL column cannot represent — the one place where un-rounded input
  // propagates into future sales rather than a single record.
  const overridePrice = normaliseMoney(body.default_selling_price);
  const overridePack = body.pack_price == null ? null : normaliseMoney(body.pack_price);
  const overrideCarton = body.carton_price == null ? null : normaliseMoney(body.carton_price);
  if (existing) {
    await c.env.DB.prepare(`
      UPDATE product_price_overrides SET default_selling_price = ?, pack_price = ?, carton_price = ?, updated_by = ?, is_deleted = 0, updated_at = datetime('now') WHERE id = ?
    `).bind(overridePrice, overridePack, overrideCarton, user.id, existing.id).run();
    return c.json(await c.env.DB.prepare('SELECT * FROM product_price_overrides WHERE id = ?').bind(existing.id).first());
  }
  const newId = uuid();
  await c.env.DB.prepare(`INSERT INTO product_price_overrides (id, branch_id, product_id, default_selling_price, pack_price, carton_price, updated_by) VALUES (?,?,?,?,?,?,?)`)
    .bind(newId, branchId, id, overridePrice, overridePack, overrideCarton, user.id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM product_price_overrides WHERE id = ?').bind(newId).first(), 201);
});

module.exports = products;
