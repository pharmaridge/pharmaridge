const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, ownerOnly, resolveScopedBranchId, assertBranchAccess } = require('../lib/auth');
const { readJsonBody, rejectUnknownFields } = require('../lib/http');
const { validateMoneyAmount } = require('../lib/business');
const changeOwedService = require('../services/changeOwedService');
const glService = require('../services/glService');

const changeOwed = new Hono();
changeOwed.use('*', authRequired);

// LIST / SEARCH — by claim code, customer name, or phone number.
// The client was explicit that a lost slip must not lose the money:
// "if the customer misplaced the seven digit number the person name or
// number can be used to pay the customer change".
changeOwed.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const claims = await changeOwedService.findClaims(c.env.DB, {
    branchId,
    query: c.req.query('q'),
    status: c.req.query('status') || 'OUTSTANDING',
    limit: c.req.query('limit'),
  });
  return c.json(claims);
});

// Totals for the dashboard tile and the till screen.
changeOwed.get('/summary', async (c) => {
  const branchId = resolveScopedBranchId(c);
  return c.json(await changeOwedService.outstandingTotal(c.env.DB, branchId));
});

// Single claim by its 7-digit code — the fast counter path.
changeOwed.get('/code/:code', async (c) => {
  const claim = await changeOwedService.getClaimByCode(c.env.DB, c.req.param('code'));
  if (!claim) {
    return c.json({
      error: 'No change claim found with that code. Try searching by the customer\'s name or phone number instead.',
      code: 'CHANGE_CLAIM_NOT_FOUND',
    }, 404);
  }
  const scoped = resolveScopedBranchId(c);
  if (scoped && claim.branch_id !== scoped) {
    // Deliberately NOT a 404: pretending the claim does not exist would send
    // the customer away empty-handed. Name the branch that holds their money.
    return c.json({
      error: `This change was recorded at ${claim.branch_name} and must be collected there. `
        + 'Each branch settles its own drawer, so it cannot be paid out from here.',
      code: 'CHANGE_CLAIM_OTHER_BRANCH',
      branch_name: claim.branch_name,
    }, 409);
  }
  return c.json(claim);
});

// SETTLE — the customer collects, in cash or against a new purchase.
changeOwed.post('/:id/settle', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const unknown = rejectUnknownFields(body, ['method', 'notes', 'applied_sale_id'], { label: 'settling a change claim' });
  if (unknown) return c.json(unknown, 400);

  const claim = await changeOwedService.getClaim(c.env.DB, c.req.param('id'));
  const err = changeOwedService.assertSettleable(claim);
  if (err) return c.json({ error: err.message, code: err.code }, err.status);

  try { assertBranchAccess(c, claim.branch_id); }
  catch (e) { return c.json({ error: e.message, code: e.code || 'BRANCH_SCOPE_VIOLATION' }, e.status || 403); }

  const method = body.method === 'APPLIED_TO_SALE' ? 'APPLIED_TO_SALE' : 'CASH_PAID';
  if (method === 'APPLIED_TO_SALE' && !body.applied_sale_id) {
    return c.json({
      error: 'Give the sale this change was applied to, so the money can be traced from the original purchase to the one it paid for.',
      code: 'APPLIED_SALE_REQUIRED',
    }, 400);
  }

  const statements = [c.env.DB.prepare(`
    UPDATE change_owed
       SET status = 'SETTLED', settlement_method = ?, settled_sale_id = ?, settled_at = datetime('now'),
           settled_by = ?, settled_notes = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'OUTSTANDING' AND is_deleted = 0
  `).bind(method, method === 'APPLIED_TO_SALE' ? body.applied_sale_id : null,
    user.id, (body.notes || '').trim() || null, claim.id)];

  const gl = await glService.postChangeSettlement(c.env.DB, {
    branchId: claim.branch_id, claimId: claim.id, settledBy: user.id,
    amount: claim.amount, appliedToSale: method === 'APPLIED_TO_SALE',
  });
  // `{ entryId, statements }`, not an array — see the note in salesService.
  if (gl && gl.statements) statements.push(...gl.statements);

  await withD1Retry(() => c.env.DB.batch(statements), 'change settle');
  const updated = await changeOwedService.getClaim(c.env.DB, claim.id);
  return c.json({
    ...updated,
    receipt: {
      // The client asked for a receipt for the payout itself, not only for the
      // original sale. This is the payload the printable slip renders from.
      kind: 'CHANGE_PAYOUT',
      claim_code: claim.claim_code,
      amount: claim.amount,
      customer_name: claim.customer_name,
      customer_phone: claim.customer_phone,
      branch_name: claim.branch_name,
      original_purchase: claim.sale_summary,
      original_sale_at: claim.created_at,
      settled_at: updated.settled_at,
      settled_by_name: updated.settled_by_name,
      method,
    },
  });
});

// WRITE OFF — OWNER only, always deliberate, never automatic.
//
// Client decision: unclaimed change NEVER expires on its own. There is no
// cron, no age threshold. Someone with authority decides, states why, and the
// money moves to OTHER_INCOME where it is visible as a windfall rather than
// disappearing into sales.
changeOwed.post('/:id/write-off', ownerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const unknown = rejectUnknownFields(body, ['reason'], { label: 'writing off a change claim' });
  if (unknown) return c.json(unknown, 400);

  const reason = (body.reason || '').trim();
  if (reason.length < 4) {
    return c.json({
      error: 'Give a reason for writing off this customer\'s change — it is the only record of why money owed to a named person became the pharmacy\'s income.',
      code: 'WRITE_OFF_REASON_REQUIRED',
    }, 400);
  }

  const claim = await changeOwedService.getClaim(c.env.DB, c.req.param('id'));
  const err = changeOwedService.assertSettleable(claim);
  if (err) return c.json({ error: err.message, code: err.code }, err.status);

  const statements = [c.env.DB.prepare(`
    UPDATE change_owed
       SET status = 'WRITTEN_OFF', settlement_method = 'WRITTEN_OFF', settled_at = datetime('now'),
           settled_by = ?, settled_notes = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'OUTSTANDING' AND is_deleted = 0
  `).bind(user.id, reason, claim.id)];
  const gl = await glService.postChangeWriteOff(c.env.DB, {
    branchId: claim.branch_id, claimId: claim.id, writtenOffBy: user.id, amount: claim.amount,
  });
  if (gl && gl.statements) statements.push(...gl.statements);
  await withD1Retry(() => c.env.DB.batch(statements), 'change write-off');
  return c.json(await changeOwedService.getClaim(c.env.DB, claim.id));
});

module.exports = changeOwed;
