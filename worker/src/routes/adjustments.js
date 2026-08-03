const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, assertBranchActive, resolveScopedBranchId, assertBranchAccess } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const { assertStaffCanAdjust } = require('../lib/planLimits');
const { readJsonBody } = require('../lib/http');
const { validateQuantity } = require('../lib/business');

// Mirrors the CHECK constraint on stock_adjustments.adjustment_type in
// migrations/0001_initial_schema.sql. Kept in sync by audit.workflows.js,
// which reads the enum straight out of the migration and fails if this
// list drifts from it.
const ADJUSTMENT_TYPES = ['DAMAGE', 'EXPIRED', 'THEFT_LOSS', 'MANUAL_CORRECTION', 'STOCKTAKE_VARIANCE'];

const adjustments = new Hono();
adjustments.use('*', authRequired);

adjustments.get('/', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `
    SELECT sa.*, p.name AS product_name, sb.batch_no FROM stock_adjustments sa
    JOIN stock_batches sb ON sb.id = sa.stock_batch_id JOIN products p ON p.id = sb.product_id
    WHERE sa.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND sa.branch_id = ?'; params.push(branchId); }
  sql += ' ORDER BY sa.created_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

adjustments.post('/', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const { stock_batch_id, adjustment_type, quantity_change, reason } = body;
  if (!stock_batch_id || !adjustment_type || quantity_change == null) {
    return c.json({ error: 'stock_batch_id, adjustment_type, quantity_change are required' }, 400);
  }
  // DATA-INTEGRITY — a non-numeric quantity_change
  // previously passed unrejected and was stored verbatim in
  // stock_adjustments.quantity_change, while the companion UPDATE silently
  // became a no-op (D1/SQLite's type affinity coerces a non-numeric string
  // bound parameter to 0 in arithmetic), producing a 201 "success" response
  // with a permanently corrupted audit row and NO actual stock change at
  // all.
  if (!Number.isInteger(quantity_change) || quantity_change === 0) {
    return c.json({ error: 'quantity_change must be a non-zero whole number' }, 400);
  }
  // BUG 104: an adjustment is SIGNED (a write-off is negative), so the sign
  // carries meaning and only the MAGNITUDE may be bounded — trap #95, a sign
  // is direction, not an error. Validating Math.abs keeps a legitimate
  // negative write-off working while still refusing a mis-keyed 1e15.
  const aqErr = validateQuantity(Math.abs(quantity_change), 'quantity_change');
  if (aqErr) return c.json({ error: aqErr }, 400);
  // MISLEADING-DIAGNOSIS FIX (live-reproduced). An unrecognised
  // adjustment_type used to reach the database, trip the
  // `adjustment_type IN (...)` CHECK, and get caught by the catch-all
  // handler at the bottom of this route — which reported
  // "Adjustment would drive quantity_remaining negative" for a request
  // whose quantity was POSITIVE and whose stock was untouched. Verified
  // side by side against the running Worker: a +2000 correction with a
  // bad type and a -999999 write-off with a good type returned the
  // BYTE-IDENTICAL error. That sends an owner to recount a shelf when the
  // real fault is the value being submitted.
  //
  // Validate the enum here, where the message can name the real problem
  // and list the legal values. The DB CHECK stays as the storage-level
  // backstop; this just stops it from being the FIRST line of defence.
  if (!ADJUSTMENT_TYPES.includes(adjustment_type)) {
    return c.json({
      error: `Unknown adjustment type "${adjustment_type}". Must be one of: ${ADJUSTMENT_TYPES.join(', ')}.`,
      code: 'INVALID_ADJUSTMENT_TYPE',
    }, 400);
  }
  const batch = await c.env.DB.prepare('SELECT * FROM stock_batches WHERE id = ? AND is_deleted = 0').bind(stock_batch_id).first();
  if (!batch) return c.json({ error: 'Stock batch not found' }, 404);
  // CROSS-BRANCH STOCK WRITE-OFF FOUND AND FIXED (live-reproduced): a
  // MANAGER pinned to Minna posted a -25 DAMAGE adjustment against a
  // LAGOS batch, taking it from 4,950 to 4,925 — destroying another
  // branch's inventory (and posting the shrinkage expense to their GL)
  // from a branch they cannot even see in the stock list. The batch
  // carries its own branch_id, so authorise against THAT, not the
  // caller's claim.
  try {
    assertBranchAccess(c, batch.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  try {
    await assertBranchActive(c.env.DB, batch.branch_id, 'record a stock adjustment');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }

  // OWNER-CONTROLLED STAFF PERMISSION (client decision after this was
  // live-reproduced): a plain cashier could post an unlimited DAMAGE
  // write-off with no gate. That is how theft is concealed — take the
  // goods, record them as breakage, and shrinkage looks like an accident.
  //
  // NOT a flat ban: a cashier who drops a bottle should be able to record
  // it there and then. Capped instead, so "I broke one" works and "a whole
  // carton was damaged" needs a manager. See
  // lib/planLimits.assertStaffCanAdjust.
  {
    const staffErr = await assertStaffCanAdjust(c.env.DB, user, quantity_change);
    if (staffErr) return c.json({ error: staffErr.message, code: staffErr.code }, staffErr.status);
  }

  const id = uuid();
  try {
    // The CHECK (quantity_remaining >= 0) constraint is the real
    // guarantee against a negative result; this is submitted as one
    // atomic batch exactly like the sales engine.
    const statements = [
      c.env.DB.prepare(`INSERT INTO stock_adjustments (id, branch_id, stock_batch_id, adjustment_type, quantity_change, reason, recorded_by) VALUES (?,?,?,?,?,?,?)`)
        .bind(id, batch.branch_id, stock_batch_id, adjustment_type, quantity_change, reason || null, user.id),
      c.env.DB.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(quantity_change, stock_batch_id),
    ];

    // GENERAL LEDGER: negative quantity_change (shrinkage) debits
    // Inventory Shrinkage Expense / credits Inventory Asset; positive
    // (correction) posts the reverse — see
    // worker/src/services/glService.js's postStockAdjustment().
    const glResult = await glService.postStockAdjustment(c.env.DB, {
      branchId: batch.branch_id, adjustmentId: id, recordedBy: user.id, quantityChange: quantity_change, costPricePerUnit: batch.cost_price_per_unit,
    });
    if (glResult) statements.push(...glResult.statements);

    await withD1Retry(() => c.env.DB.batch(statements), 'stock adjustment');
  } catch (e) {
    // Only claim "would go negative" when the failing constraint really is
    // the stock one. Any other CHECK is reported as itself instead of being
    // mislabelled — see the enum note above for the bug this caused.
    const msg = String(e.message);
    if (msg.includes('CHECK constraint')) {
      if (/quantity_remaining/.test(msg)) {
        return c.json({
          error: 'Adjustment would drive quantity_remaining negative',
          code: 'INSUFFICIENT_STOCK',
        }, 400);
      }
      return c.json({
        error: `Adjustment rejected by a database constraint: ${msg}`,
        code: 'CONSTRAINT_VIOLATION',
      }, 400);
    }
    throw e;
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM stock_adjustments WHERE id = ?').bind(id).first(), 201);
});

module.exports = adjustments;
