const { Hono } = require('hono');
const { normaliseMoney } = require('../lib/business');
const { authRequired, managerOnly } = require('../lib/auth');
const { assertManagerPermission } = require('../lib/planLimits');
const { uuid } = require('../lib/crypto');
const { readJsonBody } = require('../lib/http');
const { DEFAULT_RETAIL_CATEGORY, RETAIL_CATEGORIES, isRetailCategory } = require('../lib/retailCategories');
const { validateBarcode } = require('../lib/barcodes');

const products = new Hono();
products.use('*', authRequired);

products.get('/', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const barcodeQuery = q ? validateBarcode(q).barcode : '';
  const retailCategory = c.req.query('retail_category');
  if (retailCategory && !isRetailCategory(retailCategory)) {
    return c.json({ error: `retail_category must be one of: ${RETAIL_CATEGORIES.map((entry) => entry.code).join(', ')}` }, 400);
  }
  const categorySql = retailCategory ? ' AND retail_category = ?' : '';
  const categoryBinds = retailCategory ? [retailCategory] : [];
  let results;
  if (q) {
    const like = `%${q}%`;
    ({ results } = await c.env.DB.prepare(`SELECT * FROM products WHERE is_deleted = 0${categorySql} AND (name LIKE ? OR generic_name LIKE ? OR nafdac_reg_no LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = products.id AND pb.is_deleted = 0 AND pb.barcode = ?)) ORDER BY name LIMIT 100`).bind(...categoryBinds, like, like, like, barcodeQuery).all());
  } else {
    ({ results } = await c.env.DB.prepare(`SELECT * FROM products WHERE is_deleted = 0${categorySql} ORDER BY name LIMIT 500`).bind(...categoryBinds).all());
  }
  return c.json(results);
});

products.get('/:id', async (c) => {
  const p = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
  if (!p) return c.json({ error: 'Product not found' }, 404);
  const { results: overrides } = await c.env.DB.prepare('SELECT * FROM product_price_overrides WHERE product_id = ? AND is_deleted = 0').bind(c.req.param('id')).all();
  const { results: barcodes } = await c.env.DB.prepare('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC, unit_type, barcode').bind(c.req.param('id')).all();
  return c.json({ ...p, price_overrides: overrides, barcodes });
});

// Exact scanner lookup. Declared before /:id so a barcode can never be
// interpreted as a product id. The returned unit_type tells POS whether the
// printed code represents one piece, a pack or a carton.
products.get('/barcode/:barcode', async (c) => {
  const checked = validateBarcode(c.req.param('barcode'));
  if (checked.error) return c.json({ error: checked.error, code: 'INVALID_BARCODE' }, 400);
  const row = await c.env.DB.prepare(`
    SELECT p.*, pb.barcode, pb.unit_type AS barcode_unit_type, pb.label AS barcode_label
      FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
     WHERE pb.barcode = ? AND pb.is_deleted = 0 AND p.is_deleted = 0
  `).bind(checked.barcode).first();
  if (!row) return c.json({ error: 'No active product is registered for this barcode. Check the product label or ask a manager to register it first.', code: 'BARCODE_NOT_FOUND' }, 404);
  return c.json(row);
});

products.get('/:id/barcodes', async (c) => {
  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
  if (!product) return c.json({ error: 'Product not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC, unit_type, barcode').bind(product.id).all();
  return c.json(results);
});

function barcodeUnitError(product, unitType) {
  if (!['BASE_UNIT', 'PACK', 'CARTON'].includes(unitType)) return { error: 'unit_type must be BASE_UNIT, PACK or CARTON.', code: 'INVALID_BARCODE_UNIT' };
  if (unitType === 'PACK' && Number(product.units_per_pack) <= 1) return { error: 'Set units per pack above one before registering a pack barcode.', code: 'BARCODE_PACKAGING_REQUIRED' };
  if (unitType === 'CARTON' && Number(product.packs_per_carton) <= 1) return { error: 'Set packs per carton above one before registering a carton barcode.', code: 'BARCODE_PACKAGING_REQUIRED' };
  return null;
}

function barcodeConflict(error) {
  return /(?:product_barcodes\.barcode|UNIQUE constraint failed: product_barcodes\.barcode)/i.test(String(error && error.message));
}

async function saveBarcode(c, product, { barcode, unitType, label, primary }) {
  const id = uuid();
  const statements = [];
  if (primary) statements.push(c.env.DB.prepare("UPDATE product_barcodes SET is_primary = 0, updated_at = datetime('now') WHERE product_id = ? AND is_deleted = 0").bind(product.id));
  statements.push(c.env.DB.prepare(`INSERT INTO product_barcodes (id, product_id, barcode, unit_type, label, is_primary) VALUES (?,?,?,?,?,?)`).bind(id, product.id, barcode, unitType, label || null, primary ? 1 : 0));
  await c.env.DB.batch(statements);
  return c.env.DB.prepare('SELECT * FROM product_barcodes WHERE id = ?').bind(id).first();
}

products.post('/:id/barcodes', managerOnly, async (c) => {
  const product = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
  if (!product) return c.json({ error: 'Product not found' }, 404);
  const body = await readJsonBody(c);
  const checked = validateBarcode(body.barcode);
  if (checked.error) return c.json({ error: checked.error, code: 'INVALID_BARCODE' }, 400);
  const unitType = body.unit_type || 'BASE_UNIT';
  const unitError = barcodeUnitError(product, unitType);
  if (unitError) return c.json(unitError, 400);
  // `barcode` has a database UNIQUE constraint across every row, including
  // retired labels. This prevents a historic receipt from ever becoming
  // ambiguous if an old sticker is scanned or re-used on another product.
  const existing = await c.env.DB.prepare('SELECT id FROM product_barcodes WHERE barcode = ?').bind(checked.barcode).first();
  if (existing) return c.json({ error: 'This barcode has already been registered and cannot be reused. Create a new barcode label instead.', code: 'BARCODE_ALREADY_REGISTERED' }, 409);
  try {
    return c.json(await saveBarcode(c, product, {
      barcode: checked.barcode, unitType, label: body.label ? String(body.label).trim() : null, primary: body.is_primary === true,
    }), 201);
  } catch (error) {
    // The database is the final authority: this covers two users submitting
    // the same code at the same time after both passed the pre-check above.
    if (barcodeConflict(error)) return c.json({ error: 'This barcode has already been registered and cannot be reused. Create a new barcode label instead.', code: 'BARCODE_ALREADY_REGISTERED' }, 409);
    throw error;
  }
});

// Generates a non-GS1, in-house code and persists it in the same request.
// We intentionally do not manufacture EAN/GTIN numbers: those must come from
// their legitimate GS1 allocation. The generated `PRD-…` code is printable as
// Code 128 and scans through the same POS lookup as a supplier barcode.
products.post('/:id/barcodes/generate', managerOnly, async (c) => {
  const product = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
  if (!product) return c.json({ error: 'Product not found' }, 404);
  const body = await readJsonBody(c);
  const unitType = body.unit_type || 'BASE_UNIT';
  const unitError = barcodeUnitError(product, unitType);
  if (unitError) return c.json(unitError, 400);
  const primary = body.is_primary === true;
  const label = body.label ? String(body.label).trim() : null;
  // 64 random bits per attempt makes a collision extraordinarily unlikely;
  // the UNIQUE database constraint and retry are still mandatory safeguards.
  for (let attempt = 0; attempt < 5; attempt++) {
    const barcode = `PRD-${uuid().slice(0, 16).toUpperCase()}`;
    try {
      return c.json(await saveBarcode(c, product, { barcode, unitType, label, primary }), 201);
    } catch (error) {
      if (!barcodeConflict(error)) throw error;
    }
  }
  return c.json({ error: 'A unique internal barcode could not be reserved. Please try again.', code: 'BARCODE_GENERATION_RETRY' }, 503);
});

products.delete('/:id/barcodes/:barcodeId', managerOnly, async (c) => {
  const barcode = await c.env.DB.prepare('SELECT * FROM product_barcodes WHERE id = ? AND product_id = ? AND is_deleted = 0').bind(c.req.param('barcodeId'), c.req.param('id')).first();
  if (!barcode) return c.json({ error: 'Barcode not found for this product.', code: 'BARCODE_NOT_FOUND' }, 404);
  await c.env.DB.prepare("UPDATE product_barcodes SET is_deleted = 1, is_primary = 0, updated_at = datetime('now') WHERE id = ?").bind(barcode.id).run();
  return c.body(null, 204);
});

products.post('/', managerOnly, async (c) => {
  const body = await readJsonBody(c);
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const primaryBarcode = body.primary_barcode == null || body.primary_barcode === '' ? null : validateBarcode(body.primary_barcode);
  if (primaryBarcode && primaryBarcode.error) return c.json({ error: primaryBarcode.error, code: 'INVALID_BARCODE' }, 400);
  const primaryUnitType = body.primary_barcode_unit_type || 'BASE_UNIT';
  if (!['BASE_UNIT', 'PACK', 'CARTON'].includes(primaryUnitType)) return c.json({ error: 'primary_barcode_unit_type must be BASE_UNIT, PACK or CARTON.', code: 'INVALID_BARCODE_UNIT' }, 400);
  const retailCategory = body.retail_category == null ? DEFAULT_RETAIL_CATEGORY : String(body.retail_category).trim();
  if (!isRetailCategory(retailCategory)) {
    return c.json({ error: `retail_category must be one of: ${RETAIL_CATEGORIES.map((entry) => entry.code).join(', ')}`, code: 'INVALID_RETAIL_CATEGORY' }, 400);
  }
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
  const productStatement = c.env.DB.prepare(`
    INSERT INTO products (id, name, generic_name, retail_category, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level, nafdac_catalog_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, body.name, body.generic_name || null, retailCategory, body.category || null, body.nafdac_reg_no || null, body.is_controlled ? 1 : 0,
          body.dispensing_type || 'OTC', body.base_unit || 'tablet', body.units_per_pack || 1, body.packs_per_carton || null, body.reorder_level || 0, catalogId);
  const barcodeStatement = primaryBarcode ? c.env.DB.prepare(`INSERT INTO product_barcodes (id, product_id, barcode, unit_type, label, is_primary) VALUES (?,?,?,?,?,1)`)
    .bind(uuid(), id, primaryBarcode.barcode, primaryUnitType, body.primary_barcode_label ? String(body.primary_barcode_label).trim() : null) : null;
  try { await c.env.DB.batch(barcodeStatement ? [productStatement, barcodeStatement] : [productStatement]); }
  catch (e) {
    if (String(e.message).includes('product_barcodes.barcode')) return c.json({ error: 'This barcode is already registered to another active product/unit.', code: 'BARCODE_ALREADY_REGISTERED' }, 409);
    throw e;
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first(), 201);
});

products.put('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Product not found' }, 404);
  const body = await readJsonBody(c);
  if (body.retail_category !== undefined && !isRetailCategory(body.retail_category)) {
    return c.json({ error: `retail_category must be one of: ${RETAIL_CATEGORIES.map((entry) => entry.code).join(', ')}`, code: 'INVALID_RETAIL_CATEGORY' }, 400);
  }
  if (body.units_per_pack !== undefined && body.units_per_pack != null && (!Number.isInteger(body.units_per_pack) || body.units_per_pack < 1)) {
    return c.json({ error: 'units_per_pack must be a positive whole number' }, 400);
  }
  if (body.packs_per_carton !== undefined && body.packs_per_carton != null && (!Number.isInteger(body.packs_per_carton) || body.packs_per_carton < 1)) {
    return c.json({ error: 'packs_per_carton must be a positive whole number (or null if this product is never sold by the carton)' }, 400);
  }
  if (body.reorder_level !== undefined && body.reorder_level != null && (!Number.isInteger(body.reorder_level) || body.reorder_level < 0)) {
    return c.json({ error: 'reorder_level must be a non-negative whole number' }, 400);
  }
  const fields = ['name', 'generic_name', 'retail_category', 'category', 'nafdac_reg_no', 'is_controlled', 'dispensing_type', 'base_unit', 'units_per_pack', 'packs_per_carton', 'reorder_level'];
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
