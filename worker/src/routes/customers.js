const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, managerOnly, resolveScopedBranchId, assertBranchAccess, resolveMutationBranchId, assertBranchActive } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const { validateMoneyAmount, normaliseMoney } = require('../lib/business');
const { readJsonBody } = require('../lib/http');


const customers = new Hono();
customers.use('*', authRequired);

customers.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const q = (c.req.query('q') || '').trim();
  let sql = 'SELECT * FROM customers WHERE is_deleted = 0';
  const params = [];
  if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY name LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

customers.post('/', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const effectiveBranch = resolveMutationBranchId(c, body.branch_id);
  const id = uuid();
  await c.env.DB.prepare(`INSERT INTO customers (id, branch_id, name, phone, address, id_type, id_number) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, effectiveBranch, body.name, body.phone || null, body.address || null, body.id_type || null, body.id_number || null).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first(), 201);
});

// FUNCTIONAL GAP CLOSED — customers never
// supported editing at all, unlike every other master-data entity in this
// codebase (users, products, suppliers, branches). Fixed with an identical
// PUT /:id route, gated the same way as this file's own /:id/balance and
// /:id/payments routes.
customers.put('/:id', async (c) => {
  const id = c.req.param('id');
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);
  try {
    assertBranchAccess(c, customer.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  const body = await readJsonBody(c);
  if (body.name !== undefined && !String(body.name).trim()) {
    return c.json({ error: 'name cannot be blank' }, 400);
  }
  // BUG 83 — GRANTING CREDIT IS AN AUTHORITY DECISION, NOT DATA ENTRY.
  //
  // credit_limit is deliberately NOT in the general field list below: a
  // cashier may correct a customer's phone number, but deciding how much of
  // the pharmacy's money a person may walk out with is a manager's call.
  // Handled separately, with its own guard and its own validation, so it can
  // never be swept in by a future edit to that list.
  if (body.credit_limit !== undefined) {
    const user = c.get('user');
    if (!['MANAGER', 'OWNER', 'ADMIN'].includes(user.role)) {
      return c.json({
        error: 'Only a manager or the owner can set a customer\'s credit limit.',
        code: 'CREDIT_LIMIT_MANAGER_ONLY',
      }, 403);
    }
    if (!Number.isFinite(body.credit_limit) || body.credit_limit < 0) {
      return c.json({
        error: 'credit_limit must be a non-negative amount. Use 0 for a cash-only customer.',
        code: 'INVALID_CREDIT_LIMIT',
      }, 400);
    }
    await c.env.DB.prepare("UPDATE customers SET credit_limit = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(normaliseMoney(body.credit_limit), id).run();
  }

  const fields = ['name', 'phone', 'address', 'id_type', 'id_number'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE customers SET ${updates.map((f) => f + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...updates.map((f) => body[f]), id).run();
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first());
});

// A customer with a NULL branch_id is a shared/org-wide record and stays
// open to any authenticated user — see the rationale
// below (mirrored here, including the real cross-branch authorization
// bug this closes: previously NEITHER of these two routes checked the
// customer's branch at all).
customers.get('/:id/balance', async (c) => {
  const id = c.req.param('id');
  const customer = await c.env.DB.prepare('SELECT branch_id FROM customers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);
  try {
    assertBranchAccess(c, customer.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  const row = await c.env.DB.prepare(`
    SELECT COALESCE(SUM(CASE WHEN entry_type='DEBIT' THEN amount ELSE -amount END), 0) AS balance_owed
    FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0
  `).bind(id).first();
  const { results: history } = await c.env.DB.prepare('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at DESC').bind(id).all();
  return c.json({ balance_owed: row.balance_owed, history });
});

// DEBTOR AGING (client decision) — how OLD is each debt?
//
// The balance alone does not tell an owner who to chase: 50,000 owed since
// last week is normal trading, 50,000 owed since March is probably gone. This
// buckets each customer's outstanding balance by the age of the oldest unpaid
// debit, which is the figure a pharmacy actually acts on.
//
// Manager-and-above, matching every other view of who owes the business money
// (supplier debt, WHT, expenses).
//
// Ages are computed in SQL from UTC timestamps so the buckets cannot shift
// with the viewer's clock — the same reasoning as worked_minutes in BUG 78.
customers.get('/aging', managerOnly, async (c) => {
  const branchId = resolveScopedBranchId(c);
  const scope = branchId ? 'AND dl.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  const { results } = await c.env.DB.prepare(`
    SELECT
      cu.id                AS customer_id,
      cu.name              AS customer_name,
      cu.phone             AS customer_phone,
      cu.credit_limit      AS credit_limit,
      b.name               AS branch_name,
      dl.branch_id         AS branch_id,
      ROUND(SUM(CASE WHEN dl.entry_type = 'DEBIT' THEN dl.amount ELSE -dl.amount END), 2) AS balance_owed,
      MIN(CASE WHEN dl.entry_type = 'DEBIT' THEN dl.created_at END) AS oldest_debt_at,
      CAST(julianday('now') - julianday(MIN(CASE WHEN dl.entry_type = 'DEBIT' THEN dl.created_at END)) AS INTEGER) AS oldest_debt_age_days
    FROM debtor_ledger dl
    JOIN customers cu ON cu.id = dl.customer_id
    LEFT JOIN branches b ON b.id = dl.branch_id
    WHERE dl.is_deleted = 0 ${scope}
    GROUP BY cu.id, dl.branch_id
    HAVING balance_owed > 0
    ORDER BY oldest_debt_age_days DESC, balance_owed DESC
    LIMIT 500
  `).bind(...params).all();

  // Bucket in JS rather than SQL: the boundaries are a business convention,
  // not a data property, and keeping them here makes them reviewable.
  const bucketOf = (days) => {
    const d = Number(days || 0);
    if (d <= 30) return 'current';
    if (d <= 60) return '31_60';
    if (d <= 90) return '61_90';
    return 'over_90';
  };
  const totals = { current: 0, '31_60': 0, '61_90': 0, over_90: 0 };
  const rows = results.map((r) => {
    const bucket = bucketOf(r.oldest_debt_age_days);
    totals[bucket] = Math.round((totals[bucket] + Number(r.balance_owed || 0)) * 100) / 100;
    return { ...r, bucket, over_limit: Number(r.balance_owed || 0) > Number(r.credit_limit || 0) };
  });
  return c.json({
    rows,
    totals,
    total_outstanding: Math.round(rows.reduce((a, r) => a + Number(r.balance_owed || 0), 0) * 100) / 100,
    note: 'Buckets are measured from the OLDEST unpaid debit for each customer at each branch. A debt over 90 days old is usually the point at which a pharmacy stops expecting to collect it.',
  });
});

customers.post('/:id/payments', idempotent, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await readJsonBody(c);
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);
  try {
    assertBranchAccess(c, customer.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  // DATA-INTEGRITY — a non-numeric string previously
  // passed `!body.amount || body.amount <= 0` unrejected and was inserted
  // verbatim into debtor_ledger.amount.
  // BUG 41: sub-kobo repayments rounded to zero in the GL and surfaced as a
  // raw 500 instead of a clean validation error.
  {
    const moneyErr = validateMoneyAmount(body.amount, 'amount');
    if (moneyErr) return c.json({ error: moneyErr, code: 'INVALID_MONEY_AMOUNT' }, 400);
  }
  // BUG 52: snap to kobo before the ledger row and the GL posting are built.
  body.amount = normaliseMoney(body.amount);
  // DATA-INTEGRITY (real bug found and fixed during this audit — mirrors the
  // identical fix + full explanation in the original implementation,
  // original design): for a shared/org- wide customer (branch_id IS NULL)
  // recorded by a MANAGER/OWNER/ ADMIN (whose own branch_id is ALSO always
  // null), the previous fallback resolved to null, leaking a raw NOT NULL
  // constraint error. Fixed by accepting an optional `branch_id` in the
  // request body as a final, validated fallback.
  let branchId = customer.branch_id || user.branch_id || null;
  if (!branchId && body.branch_id) {
    const branchExists = await c.env.DB.prepare('SELECT 1 FROM branches WHERE id = ? AND is_deleted = 0').bind(body.branch_id).first();
    if (!branchExists) return c.json({ error: `Unknown branch ${body.branch_id}` }, 400);
    branchId = body.branch_id;
  }
  if (!branchId) {
    return c.json({ error: 'This customer has no branch of their own — please specify which branch this payment should be recorded against (branch_id).' }, 400);
  }
  // CLOSED-BRANCH MONEY MOVEMENT (live-reproduced). Recording a sale or an
  // expense against a deactivated branch is refused with 403 BRANCH_INACTIVE,
  // but this route had no such guard: a ₦50 repayment was accepted against a
  // branch that had just been closed, and a CUSTOMER_PAYMENT journal entry
  // was POSTED to its ledger. Deactivating a branch is how a pharmacy says
  // "this shop is shut" — new money must not keep landing in its books, or
  // the closing balances the owner reconciles against will not stay closed.
  // The check goes here, AFTER branchId is finally resolved, because the
  // branch actually charged may come from the customer, the user, or the
  // request body.
  try {
    await assertBranchActive(c.env.DB, branchId, 'record a customer repayment');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }
  // BUG 81 — A DEBTOR COULD BE OVERPAID INTO A NEGATIVE BALANCE.
  //
  // Nothing compared the repayment against what the customer actually owed.
  // Live-reproduced: a customer owing ₦50 was recorded as repaying ₦500,
  // leaving debtor_ledger with DEBIT 50 / PAYMENT 500 — a **−₦450 balance**,
  // i.e. the pharmacy now owes the customer, with ₦500 of real cash booked
  // into CASH and no refund mechanism anywhere in the product to release it.
  //
  // The SUPPLIER side of the very same pattern has had this guard all along
  // (routes/creditors.js: "You cannot pay more than is owed"), which is what
  // made the omission findable — the two ledgers are mirror images and only
  // one was defended. Debtor overpayment is worse in practice, because it is
  // the shape of a cashier taking a large note, recording it against a small
  // debt, and pocketing the difference: the books balance, the customer's
  // account shows credit nobody tracks, and the till still reconciles.
  //
  // Same rule, same wording style, same 400. A genuine advance payment is a
  // real business case, but it needs its own deliberate feature (a customer
  // deposit) rather than a silently negative debt.
  {
    const owedRow = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END), 0) AS owed
        FROM debtor_ledger
       WHERE customer_id = ? AND branch_id = ? AND is_deleted = 0
    `).bind(id, branchId).first();
    const owed = normaliseMoney(Number((owedRow && owedRow.owed) || 0));
    if (body.amount > owed) {
      return c.json({
        error: owed <= 0
          ? 'This customer does not owe anything at this branch, so there is nothing to repay.'
          : `You cannot collect more than is owed. ${customer.name} owes N${owed.toFixed(2)} at this branch; you entered N${body.amount.toFixed(2)}.`,
        code: 'REPAYMENT_EXCEEDS_DEBT',
        owed,
      }, 400);
    }
  }

  const paymentId = uuid();
  const statements = [
    c.env.DB.prepare(`INSERT INTO debtor_ledger (id, branch_id, customer_id, entry_type, amount, recorded_by, notes) VALUES (?,?,?,'PAYMENT',?,?,?)`)
      .bind(paymentId, branchId, id, body.amount, user.id, body.notes || 'Debt repayment'),
  ];

  // GENERAL LEDGER: Cash debited, Accounts Receivable credited — see
  // worker/src/services/glService.js's postCustomerPayment().
  const glResult = await glService.postCustomerPayment(c.env.DB, {
    branchId, paymentId, recordedBy: user.id, amount: body.amount, method: 'CASH',
  });
  if (glResult) statements.push(...glResult.statements);

  await withD1Retry(() => c.env.DB.batch(statements), 'customer payment');
  return c.json(await c.env.DB.prepare('SELECT * FROM debtor_ledger WHERE id = ?').bind(paymentId).first(), 201);
});

module.exports = customers;
