const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, managerOnly, resolveMutationBranchId, resolveScopedBranchId, assertBranchActive } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const safeService = require('../services/branchSafeService');
const tillService = require('../services/tillService');
const { resolveCashSources, assertStaffSafeSpend } = require('../lib/cashSources');
const wht = require('../lib/wht');
const { validateMoneyAmount, normaliseMoney } = require('../lib/business');
const { readJsonBody } = require('../lib/http');


const creditors = new Hono();
creditors.use('*', authRequired);

// MANAGER-AND-ABOVE (client decision after a live audit demonstration).
// A cashier has no reason to know what the pharmacy owes its suppliers —
// reproduced live: a STAFF token read a ₦50,000 supplier debt. This
// matches how the GL, Users and Accounting screens are already closed to
// STAFF. The Suppliers screen is manager-facing; a cashier never opens it.
creditors.get('/balances', managerOnly, async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `SELECT cb.*, s.name AS supplier_name FROM v_creditor_balances cb JOIN suppliers s ON s.id = cb.supplier_id`;
  const params = [];
  if (branchId) { sql += ' WHERE cb.branch_id = ?'; params.push(branchId); }
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

// AUTHORIZATION: see the full explanation below — a plain STAFF token
// could previously record an arbitrary payment against a supplier's
// creditor account with no gate at all, a real fraud/financial- integrity
// vector. Mirrored here.
creditors.post('/:supplierId/payments', managerOnly, idempotent, async (c) => {
  const user = c.get('user');
  const supplierId = c.req.param('supplierId');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id and positive amount required' }, 400);
  // DATA-INTEGRITY — see the write-up below.
  // BUG 41: `> 0` alone allowed a sub-kobo payment through to the GL,
  // which rounds to 2dp and then threw a zero-value-line error as a raw 500.
  {
    const moneyErr = validateMoneyAmount(body.amount, 'amount');
    if (moneyErr) return c.json({ error: moneyErr, code: 'INVALID_MONEY_AMOUNT' }, 400);
  }
  // BUG 52: snap to kobo before the ledger row and the GL posting are built.
  body.amount = normaliseMoney(body.amount);
  // CLOSED-BRANCH MONEY MOVEMENT (live-reproduced). Sales and expenses are
  // refused on a deactivated branch with 403 BRANCH_INACTIVE, but this route
  // had no such guard: a ₦50 supplier payment was accepted against a branch
  // that had just been closed, and a SUPPLIER_PAYMENT journal entry was
  // POSTED to its ledger. A closed branch's books must stay closed —
  // otherwise the final balances an owner signs off keep moving after the
  // shop has shut.
  try {
    await assertBranchActive(c.env.DB, branchId, 'record a supplier payment');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }
  // BUG 55 — A SUPPLIER CANNOT BE PAID MORE THAN IS OWED.
  //
  // Live-reproduced: a supplier owed 1,500 was paid 101,500. HTTP 201. The
  // creditor ledger then held purchased=0, paid=101,500, net = -103,000 —
  // and the v_creditor_balances view hides it, because that view ends in
  // `HAVING balance_owed > 0`. So 100,000 of real cash left the business
  // and the supplier simply DISAPPEARED from the payables screen: no debt,
  // no credit, no trace anywhere a manager looks.
  //
  // That is the worst shape an error can take — it is invisible in exactly
  // the report a proprietor would use to find it. A genuine prepayment or
  // an overpayment to be refunded is a real business event, but it must be
  // recorded deliberately, not arrive as an unnoticed side effect of a
  // mistyped figure.
  //
  // Computed with the SAME arithmetic as the ledger (DEBIT adds, everything
  // else subtracts) rather than reading the view, precisely because the
  // view's HAVING clause is what concealed the problem.
  {
    const owedRow = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END), 0) AS owed
        FROM creditor_ledger
       WHERE supplier_id = ? AND branch_id = ? AND is_deleted = 0
    `).bind(supplierId, branchId).first();
    const owed = normaliseMoney(Number((owedRow && owedRow.owed) || 0));
    if (body.amount > owed) {
      return c.json({
        error: owed <= 0
          ? `This supplier is not owed anything at this branch, so there is nothing to pay. Record a purchase or receive an order on credit first.`
          : `You cannot pay more than is owed. This supplier is owed N${owed.toFixed(2)} at this branch; you entered N${body.amount.toFixed(2)}.`,
        code: 'PAYMENT_EXCEEDS_BALANCE',
        balance_owed: owed,
      }, 400);
    }
  }

  // WITHHOLDING TAX ON A SUPPLIER PAYMENT. `amount` is the GROSS invoice
  // value being settled — the supplier's account clears by that figure
  // whether or not tax was withheld. Only the cash leaving is reduced;
  // the difference becomes a debt to the revenue authority. Clearing the
  // supplier by the NET instead would leave a permanent phantom balance
  // equal to every deduction ever made. See lib/wht.js.
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

  // PAID FROM THE BRANCH SAFE.
  //
  // This is the transaction the safe primarily exists for: a delivery worth
  // more than the counter drawer ever holds. Same two rules as a safe-funded
  // expense — the reserve must hold the money, and only a manager or the Owner
  // may spend it.
  const PAY_METHODS = ['CASH', 'SAFE', 'TRANSFER', 'POS_CARD'];
  const paidByMethod = body.paid_by_method || 'CASH';
  if (!PAY_METHODS.includes(paidByMethod)) {
    return c.json({ error: `paid_by_method must be one of: ${PAY_METHODS.join(', ')}`, code: 'INVALID_PAY_METHOD' }, 400);
  }
  // A delivery is the transaction most likely to be funded from BOTH pots:
  // whatever was in the drawer, and the rest out of the reserve. Resolved by
  // the same shared helper the expense route uses, so the two cannot drift.
  const { sources: cashSources, error: sourceError } = resolveCashSources(body, body.amount);
  if (sourceError) return c.json(sourceError, sourceError.status);
  const drawerPart = cashSources.find((x) => x.source === 'CASH');
  const safePart = cashSources.find((x) => x.source === 'SAFE');
  const netRatio = deduction ? (deduction.net / body.amount) : 1;

  if (drawerPart) {
    const openTill = await c.env.DB.prepare(
      `SELECT id FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0 LIMIT 1`
    ).bind(branchId).first();
    if (openTill) {
      const available = await tillService.computeExpectedCash(c.env.DB, openTill.id);
      const drawerOut = Math.round(drawerPart.amount * netRatio * 100) / 100;
      if (drawerOut > Number(available) + 0.005) {
        return c.json({
          error: `This is more cash than the drawer holds. The till has N${Number(available).toFixed(2)} `
            + `and this needs N${drawerOut.toFixed(2)} from it. `
            + 'Take the rest from the branch safe, or pay by transfer.',
          code: 'CASH_PAYMENT_EXCEEDS_DRAWER',
          drawer_cash: Number(Number(available).toFixed(2)), requested: drawerOut,
        }, 400);
      }
    }
  }
  if (safePart) {
    const safeOut = Math.round(safePart.amount * netRatio * 100) / 100;
    if (user.role === 'STAFF') {
      const capped = await assertStaffSafeSpend(c.env.DB, user, safeOut);
      if (capped) return c.json(capped, capped.status);
    } else {
      const denied = safeService.assertCanMoveSafe(user, branchId);
      if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    }
    const short = await safeService.assertSufficientFunds(c.env.DB, branchId, safeOut,
      { label: 'this supplier payment' });
    if (short) return c.json(short, short.status);
  }

  const id = uuid();
  const statements = [
    c.env.DB.prepare(`INSERT INTO creditor_ledger (id, branch_id, supplier_id, purchase_order_id, entry_type, amount, recorded_by, notes) VALUES (?,?,?,?,'PAYMENT',?,?,?)`)
      .bind(id, branchId, supplierId, body.purchase_order_id || null, body.amount, user.id, body.notes || 'Payment to supplier'),
  ];

  // Reserve debit in the SAME batch as the payment, for the same reason as the
  // expense path: neither may exist without the other. Only the NET leaves the
  // safe when WHT is withheld.
  if (safePart) {
    // Only the safe's share, apportioned by the net — see the same note in
    // routes/expenses.js. The withheld tax never leaves the branch.
    const mv = safeService.movementStatements(c.env.DB, {
      branchId, entryType: 'SUPPLIER_PAID',
      amount: Math.round(safePart.amount * netRatio * 100) / 100,
      reason: (body.notes || 'Payment to supplier')
        + (drawerPart ? ` (safe share of a N${Number(body.amount).toFixed(2)} payment)` : ''),
      recordedBy: user.id, sourceType: 'SUPPLIER_PAYMENT', sourceId: id,
    });
    statements.push(...mv.statements);
  }

  if (deduction) {
    const supplier = await c.env.DB.prepare('SELECT name FROM suppliers WHERE id = ?').bind(supplierId).first();
    statements.push(wht.buildEntryStatement(c.env.DB, {
      id: uuid(), branchId, direction: 'PAYABLE', sourceType: 'SUPPLIER_PAYMENT', sourceId: id,
      deduction,
      supplierId,
      counterpartyName: supplier ? supplier.name : null,
      counterpartyTin: body.wht_counterparty_tin || null,
      recordedBy: user.id,
      notes: 'WHT on supplier payment',
    }));
  }

  // GENERAL LEDGER: Accounts Payable debited by the GROSS, Cash credited
  // by the NET, WHT Payable credited with the deduction — see
  // worker/src/services/glService.js's postSupplierPayment().
  const glResult = await glService.postSupplierPayment(c.env.DB, {
    branchId, paymentId: id, recordedBy: user.id, amount: body.amount,
    whtAmount: deduction ? deduction.wht : 0,
    paidByMethod: cashSources.length > 1 ? 'CASH' : (cashSources[0] ? cashSources[0].source : paidByMethod),
    cashSources,
  });
  if (glResult) statements.push(...glResult.statements);

  await withD1Retry(() => c.env.DB.batch(statements), 'supplier payment');
  const saved = await c.env.DB.prepare('SELECT * FROM creditor_ledger WHERE id = ?').bind(id).first();
  if (deduction) {
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

module.exports = creditors;
