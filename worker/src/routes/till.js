const { Hono } = require('hono');
const { authRequired, assertBranchAccess, assertBranchActive, ForbiddenError, assertNotVendorSeat, resolveMutationBranchId, resolveScopedBranchId } = require('../lib/auth');
const { idempotent } = require('../lib/idempotency');
const tillService = require('../services/tillService');
const { readJsonBody } = require('../lib/http');


const till = new Hono();
till.use('*', authRequired);

till.get('/current', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  const row = await c.env.DB.prepare(`
    SELECT t.*, u.full_name AS opened_by_name
    FROM till_sessions t JOIN users u ON u.id = t.opened_by
    WHERE t.branch_id = ? AND t.status = 'OPEN' AND t.is_deleted = 0
  `).bind(branchId).first();
  return c.json(row || null);
});

till.get('/', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `
    SELECT t.*, u.full_name AS opened_by_name, fc.full_name AS force_closed_by_name
    FROM till_sessions t
    JOIN users u ON u.id = t.opened_by
    LEFT JOIN users fc ON fc.id = t.force_closed_by
    WHERE t.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND t.branch_id = ?'; params.push(branchId); }
  sql += ' ORDER BY t.opened_at DESC LIMIT 100';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

till.post('/open', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  // The vendor's support seat must never hold cash accountability — see
  // assertNotVendorSeat in lib/auth.js for the live-reproduced bug where
  // a till was opened as "PharmaRidge Support" with the client's money.
  // ADMIN can still close/force-close and read every till record.
  const vendorErr = assertNotVendorSeat(user, 'open a cash till');
  if (vendorErr) return c.json({ error: vendorErr.message, code: vendorErr.code }, vendorErr.status);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  // FINANCIAL-INTEGRITY: see the identical fix + full exploit write-up in
  // the original design — `body.opening_cash || 0` silently discarded a
  // non-numeric/negative opening_cash down to 0 with zero error,
  // understating every later expected-cash calculation for that till
  // session's entire lifetime.
  if (body.opening_cash !== undefined && (!Number.isFinite(body.opening_cash) || body.opening_cash < 0)) {
    return c.json({ error: 'opening_cash must be a non-negative number' }, 400);
  }
  try {
    await assertBranchActive(c.env.DB, branchId, 'open a till');
    const result = await tillService.openTill(c.env.DB, { branchId, openedBy: user.id, openingCash: body.opening_cash || 0 });
    return c.json(result, 201);
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || (e.code ? 409 : 400));
  }
});


// Closing a till is normally the same cashier who opened it, but a MANAGER
// may also close ANY branch's till on the cashier's behalf — see the
// write-up below for the full rationale (mirrored here, including the real
// cross-branch authorization bug this closes).
till.post('/:id/close', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const till_ = await c.env.DB.prepare('SELECT branch_id, opened_by, status FROM till_sessions WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!till_) return c.json({ error: 'Till session not found' }, 404);
    assertBranchAccess(c, till_.branch_id);

    // FINANCIAL-INTEGRITY: see the identical fix + full exploit write-up in
    // the original design — a missing/ null/non-numeric counted_closing_cash
    // previously returned a clean 200, recording a FABRICATED 0-counted-cash
    // figure and a FICTITIOUS discrepancy that then posts PERMANENTLY to the
    // General Ledger's Cash Over/Short account.
    if (!Number.isFinite(body.counted_closing_cash) || body.counted_closing_cash < 0) {
      return c.json({ error: 'counted_closing_cash must be a non-negative number' }, 400);
    }

    // CASH ACCOUNTABILITY — BUG 36 (live-reproduced).
    //
    // This previously read:
    //   const isForceClose = user.role !== 'STAFF' && till_.opened_by !== user.id && ...
    //   if (isForceClose && !['MANAGER','OWNER','ADMIN'].includes(user.role)) -> 403
    //
    // The `user.role !== 'STAFF'` term made the 403 UNREACHABLE FOR EVERY
    // ROLE: for STAFF, isForceClose was forced false so the check was
    // skipped entirely; for MANAGER/OWNER/ADMIN the role is in the allow
    // list anyway. Truth-tabled all 8 role x opener combinations — the
    // branch never returns 403. A second Lagos cashier closed a colleague's
    // till (HTTP 200) and became `closed_by` on their shift.
    //
    // Why that matters commercially: the till close is the moment cash
    // accountability is fixed. Whoever closes it decides the counted figure
    // and owns the resulting over/short posted to CASH_OVER_SHORT. Letting
    // any cashier close a colleague's drawer lets them shift a shortage
    // onto that colleague's shift, and the schema comment on
    // till_sessions.force_closed_by already states the intended rule:
    // "a MANAGER (never STAFF)".
    //
    // Correct rule: a STAFF user may close ONLY the session they opened.
    // Anyone senior closing someone else's OPEN session is a force-close
    // and is recorded as such.
    const closingSomeoneElses = till_.opened_by !== user.id;
    if (closingSomeoneElses && user.role === 'STAFF') {
      return c.json({
        error: 'You can only close the till session you opened yourself. Ask a manager to close this one.',
        code: 'STAFF_CLOSE_NOT_OWN_TILL',
      }, 403);
    }
    const isForceClose = closingSomeoneElses && till_.status === 'OPEN';

    // BUG 51 (class). A force-close is a manager overriding another
    // person's cash accountability: whoever closes a drawer fixes the
    // counted figure and owns the over/short posted to CASH_OVER_SHORT.
    // The reason was optional and silently defaulted to the generic
    // "Force-closed by manager", which explains nothing to a proprietor
    // asking six weeks later why a cashier's shift was closed by someone
    // else with a 3,000 shortage. The UI already demands a reason here —
    // the server never did, so any direct API call skipped it.
    if (isForceClose) {
      const fr = typeof body.force_reason === 'string' ? body.force_reason.trim() : '';
      if (fr.length < 4) {
        return c.json({
          error: 'Give a reason for force-closing someone else\'s till — it is the only record of why this drawer was closed by a manager rather than the cashier who opened it.',
          code: 'FORCE_REASON_REQUIRED',
        }, 400);
      }
    }

    const result = await tillService.closeTill(c.env.DB, {
      tillSessionId: c.req.param('id'), closedBy: user.id, countedClosingCash: body.counted_closing_cash, notes: body.notes,
      forceClose: isForceClose, forceReason: body.force_reason,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

till.get('/:id/expected', async (c) => {
  try {
    const till_ = await c.env.DB.prepare('SELECT branch_id FROM till_sessions WHERE id = ?').bind(c.req.param('id')).first();
    if (!till_) return c.json({ error: 'Till session not found' }, 404);
    assertBranchAccess(c, till_.branch_id);
    const expected = await tillService.computeExpectedCash(c.env.DB, c.req.param('id'));
    return c.json({ expected_closing_cash: expected });
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

module.exports = till;
