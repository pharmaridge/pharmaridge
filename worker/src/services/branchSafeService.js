// BRANCH SAFE — cash held at a branch OUTSIDE the counter drawer.
//
// WHY THIS EXISTS. Bug 96 established that a CASH expense may never exceed the
// money in the till, because a cash box cannot hold negative money. That guard
// is right, but on its own it made a routine transaction impossible: a branch
// cannot buy a N50,000 delivery, or pay N80,000 rent, out of a drawer floating
// N25,000 — yet Nigerian pharmacies do exactly that every week, from the shop
// safe. The safe is the missing counterpart, not a workaround.
//
// Two pots of cash at a shop, and they are different things:
//
//   CASH        the counter till. One open session at a time, counted and
//               reconciled at every close, the only pot a cashier touches.
//   BRANCH_SAFE the shop's reserve. Not counted at till close, never touched
//               by a sale, and the actual source of a large supplier payment.
//
// WHO MAY MOVE IT (client decision): the OWNER, a GENERAL MANAGER, and the
// BRANCH MANAGER of that branch. Never STAFF — a cashier moving money between
// drawer and safe unsupervised is the oldest shrinkage route in retail. STAFF
// may READ the balance, because they need to know whether a purchase can be
// funded before they ask anyone.
//
// The ledger is append-only, like debtor_ledger and creditor_ledger: the
// balance is always SUM(signed amounts), never a stored figure that can drift
// out of step with its own history.
const { round2 } = require('../lib/business');
const uuid = () => crypto.randomUUID().replace(/-/g, '');

// Signed convention, stated once: positive adds to the safe, negative removes.
// Stored signed rather than magnitude+direction so the balance is a plain
// SUM() and no reader can misinterpret it.
const INFLOW = new Set(['DEPOSIT']);
const OUTFLOW = new Set(['WITHDRAWAL', 'EXPENSE_PAID', 'SUPPLIER_PAID']);

async function safeBalance(db, branchId) {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS bal FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0'
  ).bind(branchId).first();
  return round2(Number((row && row.bal) || 0));
}

async function allBalances(db) {
  const { results } = await db.prepare(
    'SELECT * FROM v_branch_safe_balances ORDER BY branch_name'
  ).all();
  return results || [];
}

async function listMovements(db, branchId, limit = 100) {
  const { results } = await db.prepare(`
    SELECT sl.*, u.full_name AS recorded_by_name, b.name AS branch_name
    FROM branch_safe_ledger sl
    JOIN branches b ON b.id = sl.branch_id
    LEFT JOIN users u ON u.id = sl.recorded_by
    WHERE sl.branch_id = ? AND sl.is_deleted = 0
    ORDER BY sl.created_at DESC
    LIMIT ?
  `).bind(branchId, Math.min(Number(limit) || 100, 500)).all();
  return results || [];
}

// MAY THIS PERSON MOVE THIS BRANCH'S SAFE?
//
// Deliberately its own function rather than reusing managerOnly, because the
// rule is narrower in one direction and wider in another: a MANAGER pinned to
// Lagos may move Lagos's safe and nobody else's, while an org-wide GENERAL
// MANAGER and the OWNER may move any. ADMIN is the vendor's support seat and
// is refused outright — vendor staff have no business moving a client's cash,
// and this is the one place where "ADMIN can fix anything" would be wrong.
function assertCanMoveSafe(user, branchId) {
  if (!user) return { error: 'Authentication required.', code: 'UNAUTHENTICATED', status: 401 };
  if (user.role === 'ADMIN') {
    return {
      error: 'PharmaRidge support cannot move money in or out of your safe. '
        + 'Only the Owner, a General Manager, or this branch\'s own Branch Manager can.',
      code: 'VENDOR_CANNOT_MOVE_CASH', status: 403,
    };
  }
  if (user.role === 'STAFF') {
    return {
      error: 'Only a manager or the Owner can move money in or out of the safe. '
        + 'You can see the balance, but ask a manager to record the movement.',
      code: 'SAFE_REQUIRES_MANAGER', status: 403,
    };
  }
  if (user.role === 'MANAGER' && user.branch_id && user.branch_id !== branchId) {
    return {
      error: 'As a Branch Manager you can only move the safe at your own branch.',
      code: 'BRANCH_SCOPE_VIOLATION', status: 403,
    };
  }
  return null;
}

// Builds the statements for a safe movement. Returned rather than executed so
// a movement that funds an expense or a supplier payment commits atomically
// with the thing it funded — a safe debit whose expense failed to insert would
// be money that left the reserve for nothing.
function movementStatements(db, { branchId, entryType, amount, reason, recordedBy, sourceType = null, sourceId = null }) {
  const magnitude = round2(Math.abs(Number(amount)));
  const signed = OUTFLOW.has(entryType) ? -magnitude
    : INFLOW.has(entryType) ? magnitude
      // TILL_TRANSFER carries its own sign from the caller: moving cash from
      // the drawer INTO the safe is positive, topping the drawer up is negative.
      : round2(Number(amount));
  const id = uuid();
  return {
    id,
    signed,
    statements: [db.prepare(`
      INSERT INTO branch_safe_ledger (id, branch_id, entry_type, amount, source_type, source_id, reason, recorded_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(id, branchId, entryType, signed, sourceType, sourceId, reason, recordedBy)],
  };
}

// The safe cannot go negative for the same reason the drawer cannot: a
// physical cash reserve does not hold negative money, and a negative balance
// would make every later reconciliation meaningless. Mirrors the Bug 96 guard
// on the drawer deliberately — the two pots follow the same rule.
async function assertSufficientFunds(db, branchId, amount, { label = 'this payment' } = {}) {
  const available = await safeBalance(db, branchId);
  const needed = round2(Math.abs(Number(amount)));
  if (needed > available + 0.005) {
    return {
      error: `The safe does not hold enough cash for ${label}. It has N${available.toFixed(2)} `
        + `and this needs N${needed.toFixed(2)}. Record a deposit into the safe first, `
        + 'or pay by bank transfer instead.',
      code: 'SAFE_INSUFFICIENT_FUNDS',
      safe_balance: available,
      requested: needed,
      status: 400,
    };
  }
  return null;
}

module.exports = {
  safeBalance, allBalances, listMovements,
  assertCanMoveSafe, movementStatements, assertSufficientFunds,
  INFLOW, OUTFLOW,
};
