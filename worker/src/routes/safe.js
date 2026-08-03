// BRANCH SAFE — the shop's cash reserve, held outside the counter drawer.
//
// Bug 96 correctly stopped a CASH expense exceeding the till. This is the
// counterpart that makes the legitimate version of that transaction possible:
// a branch buying a N50,000 delivery out of the safe rather than pretending
// N50,000 came out of a N25,000 drawer.
//
// AUTHORISATION, stated once and enforced in branchSafeService.assertCanMoveSafe:
//   OWNER            may move any branch's safe
//   GENERAL MANAGER  may move any branch's safe (org-wide, no branch pin)
//   BRANCH MANAGER   may move ONLY their own branch's safe
//   STAFF            may READ the balance, never move it
//   ADMIN (vendor)   may read, never move — vendor support has no business
//                    touching a client's physical cash
const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, resolveScopedBranchId, assertBranchAccess, assertBranchActive } = require('../lib/auth');
const { readJsonBody, rejectUnknownFields } = require('../lib/http');
const tillService = require('../services/tillService');
const { validateMoneyAmount, validateTextLength, normaliseMoney, MAX_TEXT } = require('../lib/business');
const safeService = require('../services/branchSafeService');
const glService = require('../services/glService');

const safe = new Hono();
safe.use('*', authRequired);

// Balance for one branch, or every branch the caller can see.
// READABLE BY STAFF ON PURPOSE: a cashier asked to buy something needs to know
// whether the money exists before troubling a manager.
safe.get('/', async (c) => {
  const scoped = resolveScopedBranchId(c);
  if (scoped) {
    return c.json({
      branch_id: scoped,
      safe_balance: await safeService.safeBalance(c.env.DB, scoped),
      movements: await safeService.listMovements(c.env.DB, scoped, c.req.query('limit')),
    });
  }
  return c.json(await safeService.allBalances(c.env.DB));
});

safe.get('/:branchId/movements', async (c) => {
  const branchId = c.req.param('branchId');
  try { assertBranchAccess(c, branchId); }
  catch (e) { return c.json({ error: e.message, code: e.code || 'BRANCH_SCOPE_VIOLATION' }, e.status || 403); }
  return c.json({
    branch_id: branchId,
    safe_balance: await safeService.safeBalance(c.env.DB, branchId),
    movements: await safeService.listMovements(c.env.DB, branchId, c.req.query('limit')),
  });
});

// Move money INTO or OUT OF the safe.
//
// One endpoint for both directions rather than /deposit and /withdraw, because
// the two are the same event with opposite signs and splitting them duplicates
// every guard.
safe.post('/movements', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const unknown = rejectUnknownFields(body, ['branch_id', 'entry_type', 'amount', 'reason'],
    { label: 'a safe movement' });
  if (unknown) return c.json(unknown, 400);

  const branchId = body.branch_id || resolveScopedBranchId(c) || user.branch_id;
  if (!branchId) return c.json({ error: 'branch_id is required — say which branch\'s safe this is.' }, 400);

  const denied = safeService.assertCanMoveSafe(user, branchId);
  if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);

  try { await assertBranchActive(c.env.DB, branchId, 'move money in the safe'); }
  catch (e) { return c.json({ error: e.message, code: e.code || 'BRANCH_INACTIVE' }, e.status || 400); }

  const ENTRY_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TILL_TRANSFER'];
  const entryType = body.entry_type;
  if (!ENTRY_TYPES.includes(entryType)) {
    return c.json({
      error: `entry_type must be one of: ${ENTRY_TYPES.join(', ')}. `
        + 'EXPENSE_PAID and SUPPLIER_PAID are written automatically when the safe funds an expense or a supplier payment — they are never recorded by hand.',
      code: 'INVALID_ENTRY_TYPE',
    }, 400);
  }

  const moneyErr = validateMoneyAmount(Math.abs(Number(body.amount)), 'amount');
  if (moneyErr) return c.json({ error: moneyErr, code: 'INVALID_MONEY_AMOUNT' }, 400);
  const amount = normaliseMoney(Math.abs(Number(body.amount)));

  // Every movement carries a reason, for the same reason a void and a
  // force-close do: it is the only record an owner has six weeks later of why
  // cash left the reserve.
  const reason = String(body.reason || '').trim();
  // BUG 103: there was a minimum but no maximum. A 200,000-character reason
  // was accepted and stored verbatim, then loaded into every list that shows
  // the movement — on a phone, over a mobile connection.
  {
    const tooLong = validateTextLength(reason, 'The reason', MAX_TEXT.reason);
    if (tooLong) return c.json({ error: tooLong, code: 'TEXT_TOO_LONG' }, 400);
  }
  if (reason.length < 4) {
    return c.json({
      error: 'Give a reason for this safe movement — it is the only record of why the money moved.',
      code: 'SAFE_REASON_REQUIRED',
    }, 400);
  }

  // Direction. DEPOSIT adds; WITHDRAWAL removes; TILL_TRANSFER is signed by
  // the caller's own sign, so a manager can sweep the drawer into the safe
  // (positive) or top the drawer back up (negative) with one verb.
  const signed = entryType === 'DEPOSIT' ? amount
    : entryType === 'WITHDRAWAL' ? -amount
      : normaliseMoney(Number(body.amount));

  // A safe cannot go negative, for exactly the reason a drawer cannot.
  if (signed < 0) {
    const short = await safeService.assertSufficientFunds(c.env.DB, branchId, signed, { label: 'this withdrawal' });
    if (short) return c.json(short, short.status);
  }

  // BUG 117 — AND THE DRAWER CANNOT GO NEGATIVE EITHER.
  //
  // Exposed by fixing Bug 116. Once safe <-> till transfers actually moved
  // the drawer's expected cash, it became possible to move MORE out of the
  // drawer than it holds: N999,999 swept from a till holding N29,277 was
  // accepted (201) and left expected cash at **-N970,721**.
  //
  // A cash EXPENSE larger than the drawer has been refused since Bug 96,
  // precisely because an unclosable till is worse than a rejected purchase.
  // A sweep into the safe is the same physical act — money leaving the
  // drawer — and had no such guard, so the protection could simply be walked
  // around by choosing the other verb. The asymmetry existed because, before
  // Bug 116, a transfer did not touch the drawer's figure at all.
  //
  // Only the drawer-emptying direction is checked: topping the drawer UP is
  // limited by the safe, which the block above already enforces.
  if (entryType === 'TILL_TRANSFER' && signed > 0) {
    const openTill = await c.env.DB.prepare(
      "SELECT id FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0",
    ).bind(branchId).first();
    if (openTill) {
      const available = await tillService.computeExpectedCash(c.env.DB, openTill.id);
      if (signed > Number(available) + 0.005) {
        return c.json({
          error: `This is more cash than the drawer holds. The till has N${Number(available).toFixed(2)} `
            + `and you are moving N${signed.toFixed(2)} out of it. `
            + 'Move a smaller amount, or count and close the till first.',
          code: 'TILL_TRANSFER_EXCEEDS_DRAWER',
        }, 400);
      }
    }
  }

  const mv = safeService.movementStatements(c.env.DB, {
    branchId, entryType, amount: signed, reason, recordedBy: user.id,
  });
  const gl = await glService.postSafeMovement(c.env.DB, {
    branchId, movementId: mv.id, recordedBy: user.id, signedAmount: mv.signed, memo: reason,
  });
  const statements = [...mv.statements];
  if (gl && gl.statements) statements.push(...gl.statements);
  await withD1Retry(() => c.env.DB.batch(statements), 'safe movement');

  return c.json({
    id: mv.id,
    branch_id: branchId,
    entry_type: entryType,
    amount: mv.signed,
    reason,
    safe_balance: await safeService.safeBalance(c.env.DB, branchId),
  }, 201);
});

module.exports = safe;
