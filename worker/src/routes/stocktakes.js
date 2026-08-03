const { Hono } = require('hono');
const { authRequired, assertBranchAccess, assertBranchActive, resolveMutationBranchId, resolveScopedBranchId } = require('../lib/auth');
const stocktakeService = require('../services/stocktakeService');
const { assertStaffCanAdjust } = require('../lib/planLimits');
const { readJsonBody } = require('../lib/http');


const stocktakes = new Hono();
stocktakes.use('*', authRequired);

stocktakes.get('/', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `
    SELECT ss.*, u.full_name AS started_by_name
    FROM stocktake_sessions ss JOIN users u ON u.id = ss.started_by
    WHERE ss.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND ss.branch_id = ?'; params.push(branchId); }
  sql += ' ORDER BY ss.started_at DESC LIMIT 50';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

stocktakes.get('/:id', async (c) => {
  const s = await stocktakeService.getStocktake(c.env.DB, c.req.param('id'));
  if (!s) return c.json({ error: 'Stocktake not found' }, 404);
  try {
    assertBranchAccess(c, s.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  return c.json(s);
});

stocktakes.post('/', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  try {
    await assertBranchActive(c.env.DB, branchId, 'start a stocktake');
    const result = await stocktakeService.startStocktake(c.env.DB, { branchId, startedBy: user.id, notes: body.notes, productIds: body.product_ids });
    return c.json(result, 201);
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || (e.code ? 409 : 400));
  }
});


stocktakes.put('/lines/:lineId/count', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const line = await c.env.DB.prepare(`
      SELECT ss.branch_id FROM stocktake_lines sl JOIN stocktake_sessions ss ON ss.id = sl.stocktake_id WHERE sl.id = ?
    `).bind(c.req.param('lineId')).first();
    if (!line) return c.json({ error: 'Stocktake line not found' }, 404);
    assertBranchAccess(c, line.branch_id);
    const result = await stocktakeService.recordCount(c.env.DB, { lineId: c.req.param('lineId'), countedQuantity: body.counted_quantity, countedBy: user.id, notes: body.notes });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

// Closing a stocktake is normally the same staff member who started it,
// but a MANAGER may also close ANY branch's still-open stocktake on their
// behalf — see the rationale below (mirrored here,
// including the real cross-branch authorization bug this closes).
stocktakes.post('/:id/close', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const session = await c.env.DB.prepare('SELECT branch_id, started_by, status FROM stocktake_sessions WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!session) return c.json({ error: 'Stocktake session not found' }, 404);
    assertBranchAccess(c, session.branch_id);

    // BUG 38 (live-reproduced) — same dead-guard class as BUG 36 in
    // routes/till.js. The `user.role !== 'STAFF'` term made this 403
    // unreachable for every role: STAFF short-circuited it to false, and
    // the senior roles are in the allow list anyway. A second Lagos
    // cashier closed a colleague's OPEN stocktake (HTTP 200) and became
    // its `closed_by`.
    //
    // Closing a stocktake is not clerical — it writes stock_adjustments
    // rows for every counted variance (see the write-up below), so the
    // closer decides what the shelf officially holds and whose count is
    // blamed for the shrinkage. One cashier must not be able to finalise
    // another's count.
    const closingSomeoneElses = session.started_by !== user.id;
    if (closingSomeoneElses && user.role === 'STAFF') {
      return c.json({
        error: 'You can only close a stocktake you started yourself. Ask a manager to close this one.',
        code: 'STAFF_CLOSE_NOT_OWN_STOCKTAKE',
      }, 403);
    }
    const isForceClose = closingSomeoneElses && session.status === 'OPEN';

    // BUG 51 (class) — see routes/till.js. Force-closing someone else's
    // count finalises what the shelf officially holds and whose count is
    // blamed for the shrinkage, so it must carry an explanation rather
    // than defaulting to a generic string.
    if (isForceClose) {
      const fr = typeof body.force_reason === 'string' ? body.force_reason.trim() : '';
      if (fr.length < 4) {
        return c.json({
          error: 'Give a reason for closing someone else\'s stocktake — it is the only record of why this count was finalised by a manager rather than the person who took it.',
          code: 'FORCE_REASON_REQUIRED',
        }, 400);
      }
    }

    // STAFF WRITE-OFF CAP — BYPASS CLOSED (live-reproduced).
    //
    // A cashier is capped at staff_adjustment_max_units on a direct stock
    // adjustment, because "take the goods, record DAMAGE" is how theft is
    // disguised as breakage. Closing a stocktake writes
    // stock_adjustments rows DIRECTLY (see stocktakeService.closeStocktake)
    // and never passes through the capped route — so the same loss could
    // be booked with a different label.
    //
    // Reproduced: a cashier capped at 5 units was refused a -500
    // adjustment, then started a stocktake, counted a batch as 0, closed
    // it, and wrote off 100 units of a CONTROLLED drug (codeine linctus)
    // as STOCKTAKE_VARIANCE. Same shrinkage, same cashier, no cap.
    //
    // COUNTING stays open to cashiers — walking the shelves is exactly
    // their job, and requiring a manager to hold the clipboard would make
    // the feature unusable. It is COMMITTING the variance that moves
    // stock, so the cap is applied to the largest variance about to be
    // posted. A count that matches the system (or is off by a unit or
    // two) closes normally; anything bigger needs a manager, who can then
    // close the very same session with the counts already recorded.
    if (user.role === 'STAFF') {
      const variances = await stocktakeService.previewVariances(c.env.DB, c.req.param('id'));
      const largest = variances.reduce((max, v) => Math.max(max, Math.abs(v.variance)), 0);
      const staffErr = await assertStaffCanAdjust(c.env.DB, user, largest);
      if (staffErr) {
        return c.json({
          error: 'Closing this count would write off more stock than a cashier may adjust unaided '
            + `(largest difference: ${largest} unit${largest === 1 ? '' : 's'}). `
            + 'Your counts are saved — ask a manager to review and close this stocktake.',
          code: staffErr.code,
          largest_variance: largest,
        }, staffErr.status);
      }
    }

    const result = await stocktakeService.closeStocktake(c.env.DB, {
      stocktakeId: c.req.param('id'), closedBy: user.id, forceClose: isForceClose, forceReason: body.force_reason,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

// Cancels an OPEN stocktake with zero stock impact — see the write-up
// below for the full rationale (mirrored here, closing the same
// schema-defined-but- unreachable CANCELLED value found during this
// audit's CHECK- constraint enum sweep).
stocktakes.post('/:id/cancel', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const session = await c.env.DB.prepare('SELECT branch_id, started_by, status FROM stocktake_sessions WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!session) return c.json({ error: 'Stocktake session not found' }, 404);
    assertBranchAccess(c, session.branch_id);

    // BUG 38 (live-reproduced) — see the identical dead-guard fix on the
    // /close route above. Cancelling someone else's count discards their
    // work and, because only one stocktake may be open per branch at a
    // time, is also a denial-of-service against a colleague mid-count.
    const cancellingSomeoneElses = session.started_by !== user.id;
    if (cancellingSomeoneElses && user.role === 'STAFF') {
      return c.json({
        error: 'You can only cancel a stocktake you started yourself. Ask a manager to cancel this one.',
        code: 'STAFF_CANCEL_NOT_OWN_STOCKTAKE',
      }, 403);
    }
    const isForceCancel = cancellingSomeoneElses && session.status === 'OPEN';

    const result = await stocktakeService.cancelStocktake(c.env.DB, {
      stocktakeId: c.req.param('id'), cancelledBy: user.id, forceCancel: isForceCancel, reason: body.reason,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

module.exports = stocktakes;
