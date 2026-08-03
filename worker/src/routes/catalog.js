const { Hono } = require('hono');
const { authRequired, resolveScopedBranchId } = require('../lib/auth');

const catalog = new Hono();
catalog.use('*', authRequired);

// Every list endpoint here is hard-capped. The catalog is ~6.8k rows and a
// client could otherwise ask for all of it on a metered mobile connection,
// which is exactly the unbounded-payload class of bug the audit already fixed
// on /api/suppliers.
const MAX_LIMIT = 50;

function clampLimit(raw, fallback = 20) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

// GET /api/catalog?q=para&limit=20
//
// Autocomplete. Matches against search_blob, a pre-computed lowercase haystack
// of name + ingredient + strength + form + NAFDAC no. + manufacturer, so ONE
// index serves brand-name, generic-name, and registration-number lookups.
//
// Ranking matters more than it looks: a cashier typing "para" must see
// "Paracetamol" before "Isosorbide (paracetamol-free)". Prefix matches on the
// product name rank first, then prefix matches on the ingredient, then
// anything else containing the term.
catalog.get('/', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const limit = clampLimit(c.req.query('limit'));

  if (!q) {
    // No search term: a small, stable sample so the UI can show something
    // useful before the user types. Never the whole table.
    const { results } = await c.env.DB.prepare(
      `SELECT id, nafdac_reg_no, product_name, ingredient_name, strength, dosage_form,
              manufacturer, pack_size, category, base_unit, is_controlled, dispensing_type
       FROM nafdac_catalog ORDER BY product_name LIMIT ?`
    ).bind(limit).all();
    return c.json(results);
  }

  // Two characters is the shortest useful prefix; one character would match
  // thousands of rows and return noise.
  if (q.length < 2) return c.json([]);

  const like = `%${q}%`;
  const prefix = `${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, nafdac_reg_no, product_name, ingredient_name, strength, dosage_form,
            manufacturer, pack_size, category, base_unit, is_controlled, dispensing_type
     FROM nafdac_catalog
     WHERE search_blob LIKE ?
     ORDER BY
       CASE
         WHEN lower(product_name) LIKE ? THEN 0
         WHEN lower(ingredient_name) LIKE ? THEN 1
         WHEN lower(product_name) LIKE ? THEN 2
         ELSE 3
       END,
       length(product_name),
       product_name
     LIMIT ?`
  ).bind(like, prefix, prefix, like, limit).all();

  return c.json(results);
});

// GET /api/catalog/alternatives?ingredient_key=paracetamol&exclude_id=123
//
// "Same active ingredient" — the therapeutic-alternatives lookup. Answers
// "this brand is out of stock, what else can I dispense?" and is why
// ingredient_key exists as a normalised column: raw-string matching fails on
// "Amoxicillin/Clavulanic acid" vs "Amoxicillin + Clavulanic Acid", which
// collapse to the same key.
//
// Declared BEFORE /:id so "alternatives" is never swallowed as an id.
catalog.get('/alternatives', async (c) => {
  const key = (c.req.query('ingredient_key') || '').trim().toLowerCase();
  const excludeId = c.req.query('exclude_id') || null;
  const limit = clampLimit(c.req.query('limit'));
  if (!key) return c.json({ error: 'ingredient_key is required' }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT id, nafdac_reg_no, product_name, ingredient_name, strength, dosage_form,
            manufacturer, pack_size, category, base_unit, is_controlled, dispensing_type
     FROM nafdac_catalog
     WHERE ingredient_key = ? AND (? IS NULL OR id != ?)
     ORDER BY product_name
     LIMIT ?`
  ).bind(key, excludeId, excludeId, limit).all();

  return c.json(results);
});

// GET /api/catalog/in-stock-alternatives?ingredient_key=...&branch_id=...
//
// The POS-facing version of the above: of the products sharing this active
// ingredient, which ones does THIS BRANCH actually have on the shelf right
// now? Joins the client's own products/stock, so unlike the rest of this
// route it IS branch-scoped.
//
// STAFF are pinned to their own branch; a manager may pass branch_id to look
// at another. This mirrors the scoping rule used by every other branch-aware
// route (see routes/sales.js).
catalog.get('/in-stock-alternatives', async (c) => {
  const user = c.get('user');
  const key = (c.req.query('ingredient_key') || '').trim().toLowerCase();
  const branchId = resolveScopedBranchId(c);
  const limit = clampLimit(c.req.query('limit'));
  if (!key) return c.json({ error: 'ingredient_key is required' }, 400);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);

  // A product qualifies if it is linked to a catalog row with this ingredient
  // OR its own generic_name matches — the latter covers manually-added
  // products that were never linked to the catalog at all, which must not be
  // invisible to this lookup.
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.generic_name, p.base_unit, p.is_controlled, p.dispensing_type,
            COALESCE(SUM(sb.quantity_remaining), 0) AS quantity_available
     FROM products p
     LEFT JOIN nafdac_catalog nc ON nc.id = p.nafdac_catalog_id
     LEFT JOIN stock_batches sb
            ON sb.product_id = p.id
           AND sb.branch_id = ?
           AND sb.is_deleted = 0
           AND sb.quantity_remaining > 0
           AND (sb.expiry_date IS NULL OR date(sb.expiry_date) >= date('now'))
     WHERE p.is_deleted = 0
       AND (nc.ingredient_key = ? OR lower(REPLACE(COALESCE(p.generic_name,''), '-', ' ')) LIKE ?)
     GROUP BY p.id
     HAVING quantity_available > 0
     ORDER BY quantity_available DESC, p.name
     LIMIT ?`
  ).bind(branchId, key, `%${key}%`, limit).all();

  return c.json(results);
});

// GET /api/catalog/ingredients?q=amox
//
// Distinct active ingredients, for an ingredient-first browse ("show me
// everything with amoxicillin"). Returns how many registered products carry
// each one, which is a useful signal of how substitutable it is.
catalog.get('/ingredients', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const limit = clampLimit(c.req.query('limit'));
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT ingredient_key, ingredient_name, COUNT(*) AS product_count
     FROM nafdac_catalog
     WHERE ingredient_key IS NOT NULL AND (? = '' OR ingredient_key LIKE ?)
     GROUP BY ingredient_key
     ORDER BY (CASE WHEN ingredient_key LIKE ? THEN 0 ELSE 1 END), product_count DESC, ingredient_name
     LIMIT ?`
  ).bind(q, like, `${q}%`, limit).all();
  return c.json(results);
});

// GET /api/catalog/stats — small dashboard/reassurance payload ("6,801
// NAFDAC-approved products available"), also used by the tests as a cheap
// health probe that the catalog migration actually ran.
catalog.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total_products,
            COUNT(DISTINCT ingredient_key) AS total_ingredients,
            SUM(CASE WHEN is_controlled = 1 THEN 1 ELSE 0 END) AS controlled_products,
            SUM(CASE WHEN dispensing_type = 'POM' THEN 1 ELSE 0 END) AS pom_products
     FROM nafdac_catalog`
  ).first();
  return c.json(row);
});

// GET /api/catalog/:id — full detail for one catalog entry, used when the user
// picks a suggestion and the form pre-fills.
catalog.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM nafdac_catalog WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Catalog entry not found' }, 404);

  // Does this client already stock it? Prevents the #1 duplicate-entry
  // mistake: adding "Panadol Extra" twice under slightly different names.
  const existing = await c.env.DB.prepare(
    `SELECT id, name FROM products WHERE is_deleted = 0 AND (nafdac_catalog_id = ? OR lower(name) = lower(?)) LIMIT 1`
  ).bind(row.id, row.product_name).first();

  return c.json({ ...row, already_in_inventory: existing || null });
});

module.exports = catalog;
// CHANGE OWED TO CUSTOMERS — BUG 95.
//
// "Goods are N400, the customer gives N500, and there is no N100 note."
// See migrations/0003_change_owed.sql and services/changeOwedService.js.
//
// AUTHORISATION, and why it differs from creditors.js:
//
// Suppliers/creditors are manager-only because a cashier has no business
// knowing what the pharmacy owes its wholesalers. This is the opposite case.
// The person who meets the returning customer IS the cashier, usually alone,
// often a different one from the person who took the original sale. Locking
// lookup or payout behind a manager would guarantee the feature is bypassed —
// the cashier would pay out of the drawer and tell nobody, which is precisely
// the untracked state this exists to end.
//
// So: STAFF may find a claim and settle it. Only the OWNER may write one off,
// because that converts a customer's money into the pharmacy's income.
