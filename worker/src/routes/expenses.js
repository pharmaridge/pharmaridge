const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { authRequired, managerOnly, assertBranchActive, resolveMutationBranchId, resolveScopedBranchId, assertBranchAccess } = require('../lib/auth');
const { assertManagerPermission } = require('../lib/planLimits');
const { idempotent } = require('../lib/idempotency');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const tillService = require('../services/tillService');
const safeService = require('../services/branchSafeService');
const { resolveCashSources, assertStaffSafeSpend } = require('../lib/cashSources');
const wht = require('../lib/wht');
const { validateMoneyAmount, normaliseMoney } = require('../lib/business');
const { readJsonBody } = require('../lib/http');



const expenses = new Hono();
expenses.use('*', authRequired);

// MANAGER-AND-ABOVE (client decision). Reproduced live: a STAFF token
// listed every expense including a ₦100,000 rent payment. A cashier may
// still RECORD an expense (petty cash at their own branch) — they simply
// cannot browse the pharmacy's whole cost base.
expenses.get('/', managerOnly, async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `SELECT e.*, u.full_name AS recorded_by_name, b.name AS branch_name FROM expenses e
             JOIN users u ON u.id = e.recorded_by JOIN branches b ON b.id = e.branch_id WHERE e.is_deleted = 0`;
  const params = [];
  if (branchId) { sql += ' AND e.branch_id = ?'; params.push(branchId); }
  sql += ' ORDER BY e.expense_date DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

expenses.post('/', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId || !body.category || body.amount == null) return c.json({ error: 'branch_id, category, amount are required' }, 400);
  // SECURITY/FINANCIAL-INTEGRITY: see the full explanation below.
  // BUG 41: `> 0` alone let a sub-kobo amount (0.004) through to the GL,
  // which rounds to 2dp, produced a zero-value journal line, and surfaced
  // as a raw HTTP 500. validateMoneyAmount adds the one-kobo floor.
  {
    const moneyErr = validateMoneyAmount(body.amount, 'amount');
    if (moneyErr) return c.json({ error: moneyErr, code: 'INVALID_MONEY_AMOUNT' }, 400);
  }
  // BUG 52: snap to kobo BEFORE storage, so the stored expense and its own
  // GL entry (which rounds) can never disagree. See lib/business.js.
  body.amount = normaliseMoney(body.amount);

  // WHERE THE MONEY CAME FROM — the drawer, the safe, or both.
  //
  // BUG 96 established that a CASH expense may never exceed the till, because
  // a cash box cannot hold negative money. BUG 98 is the other half: the split
  // was impossible to express. A purchase funded partly from the drawer and
  // partly from the safe — which is how a shop actually buys a carton it did
  // not plan for — had to be recorded as one or the other, so one pot was
  // always misstated. Worse, sending a `payments` array returned 201 and
  // silently booked everything to CASH.
  //
  // Both pots are now checked on their own terms, in one place.
  const { sources: cashSources, error: sourceError } = resolveCashSources(body, body.amount);
  if (sourceError) return c.json(sourceError, sourceError.status);

  const drawerPart = cashSources.find((x) => x.source === 'CASH');
  const safePart = cashSources.find((x) => x.source === 'SAFE');

  // THE DRAWER. Skipped when no till is open — a branch with no session has no
  // drawer to overdraw, and blocking there would stop an owner recording
  // yesterday's costs.
  //
  // BUG 118 — BUT THAT EXPENSE MUST NOT LAND ON THE NEXT SHIFT.
  //
  // computeExpectedCash windows cash expenses by `created_at >= till.opened_at`.
  // An expense recorded while NO session was open is therefore picked up by
  // the NEXT till opened at that branch, and charged against a cashier who
  // never spent it. Reproduced on seeded data: a N75,000 rent payment made
  // with no session open left the following shift's expected cash at
  // **-N54,232** — a drawer that cannot be counted, cannot be closed without
  // forcing, and posts a fictitious N54,232 shortage to CASH_OVER_SHORT
  // against whoever happened to open next.
  //
  // Marking it settles the question of ownership at the moment it is written,
  // which is the only moment the truth is known: there was no drawer, so no
  // drawer reconciliation may claim it. See tillService.computeExpectedCash.
  let noDrawerAtRecordTime = false;
  if (drawerPart) {
    const openTill = await c.env.DB.prepare(
      `SELECT id FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0 LIMIT 1`
    ).bind(branchId).first();
    if (!openTill) noDrawerAtRecordTime = true;
    if (openTill) {
      const available = await tillService.computeExpectedCash(c.env.DB, openTill.id);
      if (drawerPart.amount > Number(available) + 0.005) {
        return c.json({
          error: `This is more cash than the drawer holds. The till has N${Number(available).toFixed(2)} `
            + `and this needs N${drawerPart.amount.toFixed(2)} from it. `
            + 'Take the rest from the branch safe, or record it as a TRANSFER if it came from the bank.',
          code: 'CASH_EXPENSE_EXCEEDS_DRAWER',
          drawer_cash: Number(Number(available).toFixed(2)),
          requested: drawerPart.amount,
        }, 400);
      }
    }
  }

  // THE SAFE. Two questions, not one: does it hold the money, and is this
  // person allowed to take it?
  if (safePart) {
    if (user.role === 'STAFF') {
      // CLIENT DECISION: staff MAY spend from the safe, within an allowance a
      // manager or the owner sets (and which may be set to no cap at all).
      // The original manager-only rule stopped a cashier doing their job.
      const capped = await assertStaffSafeSpend(c.env.DB, user, safePart.amount);
      if (capped) return c.json(capped, capped.status);
    } else {
      const denied = safeService.assertCanMoveSafe(user, branchId);
      if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    }
    const short = await safeService.assertSufficientFunds(c.env.DB, branchId, safePart.amount,
      { label: 'this expense' });
    if (short) return c.json(short, short.status);
  }

  // The stored paid_by_method still names ONE method, because that is what the
  // column is and what every existing report reads. A genuine split is stored
  // as 'CASH' with its safe leg visible in the safe ledger, which is where a
  // reader looks for "what did the safe pay for".
  if (cashSources.length > 1) body.paid_by_method = 'CASH';
  else if (cashSources.length === 1) body.paid_by_method = cashSources[0].source;

  try {
    await assertBranchActive(c.env.DB, branchId, 'record an expense');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }
  // WITHHOLDING TAX. `amount` is always the GROSS expense — rent of
  // ₦100,000 is a ₦100,000 cost even when ₦10,000 of it goes to the
  // revenue authority instead of the landlord. The deduction reduces only
  // the CASH that leaves, never the expense itself. See lib/wht.js.
  let deduction = null;
  try {
    deduction = await wht.resolveDeduction(c.env.DB, {
      grossAmount: body.amount,
      rateCode: body.wht_rate_code,
      ratePercentOverride: body.wht_rate_percent,
      direction: 'PAYABLE',
    });
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 400);
  }

  const id = uuid();
  const statements = [
    c.env.DB.prepare(`
      INSERT INTO expenses (id, branch_id, category, description, amount, paid_by_method, recorded_by, expense_date, no_open_till_at_record)
      VALUES (?,?,?,?,?,?,?, COALESCE(?, datetime('now')), ?)
    `).bind(id, branchId, body.category, body.description || null, body.amount, body.paid_by_method || null, user.id, body.expense_date || null,
            noDrawerAtRecordTime ? 1 : 0),
  ];

  // The safe ledger row goes in the SAME batch as the expense: a reserve debit
  // whose expense failed to insert would be money that left the safe for
  // nothing, and an expense whose debit failed would be a cost the safe never
  // paid. Only the NET cash actually leaves when WHT is withheld — the
  // withheld slice becomes a liability to the revenue authority, it does not
  // come out of the reserve.
  if (safePart) {
    // ONLY the safe's share leaves the reserve — not the whole expense. On a
    // split, the drawer funded the rest and the till reconciliation already
    // accounts for that leg.
    //
    // Withholding tax is apportioned rather than deducted whole from the safe:
    // the withheld slice never leaves the branch at all (it becomes a debt to
    // the revenue authority), so each pot pays its share of the NET. Taking the
    // full WHT off the safe leg would drain the reserve by money that stayed
    // put, and would leave the two pots disagreeing by exactly the deduction.
    const netRatio = deduction ? (deduction.net / body.amount) : 1;
    const safeOut = Math.round(safePart.amount * netRatio * 100) / 100;
    const mv = safeService.movementStatements(c.env.DB, {
      branchId, entryType: 'EXPENSE_PAID', amount: safeOut,
      reason: `${body.category}${body.description ? ' — ' + body.description : ''}`
        + (drawerPart ? ` (safe share of a N${Number(body.amount).toFixed(2)} purchase)` : ''),
      recordedBy: user.id, sourceType: 'EXPENSE', sourceId: id,
    });
    statements.push(...mv.statements);
  }

  if (deduction) {
    statements.push(wht.buildEntryStatement(c.env.DB, {
      id: uuid(), branchId, direction: 'PAYABLE', sourceType: 'EXPENSE', sourceId: id,
      deduction,
      supplierId: body.supplier_id || null,
      counterpartyName: body.wht_counterparty_name || body.description || body.category,
      counterpartyTin: body.wht_counterparty_tin || null,
      recordedBy: user.id,
      notes: `WHT on ${body.category}`,
    }));
  }

  // GENERAL LEDGER: per-category expense sub-account debited (auto-
  // created on first use), Cash/Bank credited depending on
  // paid_by_method — see worker/src/services/glService.js's
  // postExpense(). Appended to this same batch for atomicity, so the
  // expense, the WHT register row and the journal entry either all
  // commit or none do.
  const glResult = await glService.postExpense(c.env.DB, {
    branchId, expenseId: id, recordedBy: user.id, amount: body.amount, category: body.category, paidByMethod: body.paid_by_method,
    cashSources,
    whtAmount: deduction ? deduction.wht : 0,
  });
  if (glResult) statements.push(...glResult.statements);

  await withD1Retry(() => c.env.DB.batch(statements), 'expense');
  const saved = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first();
  if (deduction) {
    // Echo the split back so the UI can show the cashier exactly what left
    // the till versus what is now owed to the revenue authority, and warn
    // (never block) about the small-company exemption.
    saved.wht = {
      rate_code: deduction.rateCode,
      rate_percent: deduction.ratePercent,
      gross_amount: deduction.gross,
      wht_amount: deduction.wht,
      net_paid: deduction.net,
      exemption_hint: wht.exemptionHint({ grossAmount: deduction.gross, counterpartyTin: body.wht_counterparty_tin }),
    };
  }
  return c.json(saved, 201);
});

expenses.post('/:id/approve', managerOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  // DATA-INTEGRITY (real bug found and fixed during this audit — mirrors the
  // identical fix + full explanation in the original implementation,
  // original design): approving a nonexistent expense id previously returned
  // a confusing empty-body 200 instead of a clean 404. OWNER-CONTROLLED
  // MANAGER PERMISSION (migration 0003).
  const permErr = await assertManagerPermission(c.env.DB, user, 'managers_can_approve_expenses');
  if (permErr) return c.json({ error: permErr.message, code: permErr.code }, permErr.status);
  const existing = await c.env.DB.prepare('SELECT id, branch_id FROM expenses WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Expense not found' }, 404);
  // CROSS-BRANCH HOLE FOUND AND FIXED (live-reproduced): a MANAGER pinned
  // to Minna approved a 50,000 Lagos rent expense. Approval is what
  // releases money, so this let a branch manager authorise spending at a
  // branch they have no authority over. Every other :id route in this
  // codebase already guards with assertBranchAccess(); this one never did
  // because, before branch-scoped managers existed, only STAFF were
  // pinned and STAFF cannot reach a managerOnly route at all.
  try {
    assertBranchAccess(c, existing.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  await c.env.DB.prepare(`UPDATE expenses SET approved_by = ?, updated_at = datetime('now') WHERE id = ?`).bind(user.id, id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first());
});

module.exports = expenses;
