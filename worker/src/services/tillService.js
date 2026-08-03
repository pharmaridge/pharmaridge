// Till (cash drawer) reconciliation for the D1 deployment.
const { uuid } = require('../lib/crypto');
const { withD1Retry } = require('../lib/d1Retry');
const { round2 } = require('../lib/business');
const glService = require('./glService');


async function openTill(db, { branchId, openedBy, openingCash }) {
  const id = uuid();
  try {
    // The database-level guarantee (idx_till_sessions_one_open_per_branch,
    // a partial UNIQUE index WHERE status='OPEN') is what actually
    // prevents two concurrent opens for the same branch — not this
    // pre-check, which exists only to return a clean, friendly error
    // instead of a raw constraint-violation message in the common case.
    await db.prepare(`INSERT INTO till_sessions (id, branch_id, opened_by, opening_cash, status) VALUES (?,?,?,?,'OPEN')`)
      .bind(id, branchId, openedBy, round2(openingCash || 0)).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) {
      throw Object.assign(new Error('A till session is already open for this branch'), { code: 'TILL_ALREADY_OPEN' });
    }
    throw e;
  }
  return db.prepare('SELECT * FROM till_sessions WHERE id = ?').bind(id).first();
}

async function computeExpectedCash(db, tillSessionId) {
  const till = await db.prepare('SELECT * FROM till_sessions WHERE id = ?').bind(tillSessionId).first();
  if (!till) throw Object.assign(new Error('Till session not found'), { status: 404 });

  const cashIn = await db.prepare(`
    SELECT COALESCE(SUM(sp.amount), 0) AS total
    FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
    WHERE s.till_session_id = ? AND sp.method = 'CASH' AND s.status = 'COMPLETED' AND sp.is_deleted = 0
  `).bind(tillSessionId).first();

  // ONLY THE DRAWER'S SHARE.
  //
  // A purchase may be funded from the drawer AND the safe at once (see
  // lib/cashSources.js). Such a row is stored with paid_by_method = 'CASH',
  // because the column names one method and every existing report reads it —
  // but subtracting its FULL amount here charges the drawer for money that
  // came out of the reserve. Live-reproduced on a N20,000 split (N8,000 drawer
  // + N12,000 safe): the drawer's expected figure fell by the whole N20,000,
  // so the cashier would have shown a N12,000 SHORTAGE for a purchase they
  // recorded honestly — the same phantom-discrepancy class as Bugs 79 and 96.
  //
  // The safe's share is already recorded against the expense in
  // branch_safe_ledger, so it is subtracted back out here. A single-source
  // cash expense has no safe row and is unaffected.
  const cashExpenses = await db.prepare(`
    SELECT COALESCE(SUM(e.amount), 0)
           - COALESCE((
               SELECT SUM(ABS(sl.amount)) FROM branch_safe_ledger sl
               WHERE sl.source_type = 'EXPENSE' AND sl.is_deleted = 0
                 AND sl.source_id IN (
                   SELECT e2.id FROM expenses e2
                   WHERE e2.branch_id = ? AND e2.paid_by_method = 'CASH' AND e2.is_deleted = 0
                     AND e2.no_open_till_at_record = 0
                     AND e2.created_at >= ? AND (? IS NULL OR e2.created_at <= ?)
                 )
             ), 0) AS total
    FROM expenses e
    WHERE e.branch_id = ? AND e.paid_by_method = 'CASH' AND e.is_deleted = 0
      -- BUG 118: an expense recorded while NO till was open belongs to no
      -- shift. Without this it is swept into the NEXT session's window and
      -- charged to a cashier who never spent it.
      AND e.no_open_till_at_record = 0
      AND e.created_at >= ? AND (? IS NULL OR e.created_at <= ?)
  `).bind(
    till.branch_id, till.opened_at, till.closed_at, till.closed_at,
    till.branch_id, till.opened_at, till.closed_at, till.closed_at,
  ).first();

  // BUG 79 — TWO REAL CASH MOVEMENTS WERE MISSING FROM THE DRAWER RECONCILIATION.
  //
  // Expected cash counted sale payments and cash expenses, and nothing else.
  // But a pharmacy takes and pays out cash through two other doors, and BOTH
  // post to the GL's CASH account unconditionally:
  //
  //   debtor_ledger   PAYMENT  -> glService.postCustomerPayment(..., method:'CASH')
  //   creditor_ledger PAYMENT  -> glService.postSupplierPayment(...) credits CASH
  //
  // Live-reproduced: a till opened with a ₦10,000 float, a debtor repaid ₦500 in
  // cash, the drawer physically held ₦10,500 — and closing it reported
  // expected 10,000 / counted 10,500 / **discrepancy +500**. The GL had the
  // ₦500 correctly; only the reconciliation was blind to it. The cashier is
  // accused of an overage for money they took in properly, and that phantom
  // difference posts permanently to CASH_OVER_SHORT.
  //
  // The same applies in reverse for a supplier paid in cash out of the drawer:
  // the cashier would show a shortage for money the owner authorised.
  //
  // Neither ledger stores a payment method (verified against the schema), and
  // both GL posters hardcode CASH, so every ledger PAYMENT row in the window is
  // by definition a cash movement. If a non-cash method is ever added to those
  // ledgers, this query must gain the same `method = 'CASH'` filter the sale
  // and expense legs already have — see the note in routes/customers.js.
  const debtorCashIn = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM debtor_ledger
    WHERE branch_id = ? AND entry_type = 'PAYMENT' AND is_deleted = 0
      AND created_at >= ? AND (? IS NULL OR created_at <= ?)
  `).bind(till.branch_id, till.opened_at, till.closed_at, till.closed_at).first();

  // Same correction as cashExpenses above: a supplier payment split across the
  // drawer and the safe must only charge the drawer for its own share.
  //
  // NOTE the pre-existing asymmetry this preserves: creditor_ledger stores no
  // payment method, so EVERY payment row in the window is treated as cash (see
  // the Bug 79 note below). That is still true for the drawer's share; the
  // safe's share is now netted off, which is strictly more correct than before
  // and never less.
  const supplierCashOut = await db.prepare(`
    SELECT COALESCE(SUM(cl.amount), 0)
           - COALESCE((
               SELECT SUM(ABS(sl.amount)) FROM branch_safe_ledger sl
               WHERE sl.source_type = 'SUPPLIER_PAYMENT' AND sl.is_deleted = 0
                 AND sl.source_id IN (
                   SELECT cl2.id FROM creditor_ledger cl2
                   WHERE cl2.branch_id = ? AND cl2.entry_type = 'PAYMENT' AND cl2.is_deleted = 0
                     AND cl2.created_at >= ? AND (? IS NULL OR cl2.created_at <= ?)
                 )
             ), 0) AS total
    FROM creditor_ledger cl
    WHERE cl.branch_id = ? AND cl.entry_type = 'PAYMENT' AND cl.is_deleted = 0
      AND cl.created_at >= ? AND (? IS NULL OR cl.created_at <= ?)
  `).bind(
    till.branch_id, till.opened_at, till.closed_at, till.closed_at,
    till.branch_id, till.opened_at, till.closed_at, till.closed_at,
  ).first();

  // BUG 95 — RETAINED CHANGE IS REAL CASH IN THE DRAWER.
  //
  // When the shop cannot make change, the customer's whole note stays in the
  // till: goods N400, tendered N500, no N100 available, so N500 is physically
  // in the box. `cashIn` above sums sale_payments.amount, which is the N400
  // APPLIED to the sale — it has no idea the extra N100 never left. Without
  // this leg the drawer expects N400 against N500 counted and reports a N100
  // OVERAGE for money the cashier handled correctly, which is exactly the
  // phantom-discrepancy class Bug 79 fixed for debtor and supplier payments.
  // Measured before this leg existed: expected N508.30, physically N608.30.
  //
  // Scoped to claims RAISED during this session, matching how every other leg
  // here is windowed. A claim SETTLED in cash during the session is the money
  // leaving again, so it is subtracted — otherwise a customer collecting their
  // change would look like a shortage.
  const changeRetained = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM change_owed
    WHERE branch_id = ? AND is_deleted = 0
      AND created_at >= ? AND (? IS NULL OR created_at <= ?)
  `).bind(till.branch_id, till.opened_at, till.closed_at, till.closed_at).first();

  const changePaidOut = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM change_owed
    WHERE branch_id = ? AND is_deleted = 0
      AND status = 'SETTLED' AND settlement_method = 'CASH_PAID'
      AND settled_at >= ? AND (? IS NULL OR settled_at <= ?)
  `).bind(till.branch_id, till.opened_at, till.closed_at, till.closed_at).first();

  // BUG 116 — CASH MOVED BETWEEN THE SAFE AND THE DRAWER WAS INVISIBLE.
  //
  // Every other door cash uses is counted here: sales, debtor repayments,
  // retained change, expenses, supplier payments. The one movement that
  // exists ONLY to change how much is in the drawer was not.
  //
  // Live-reproduced: a manager moved N30,000 from the branch safe into the
  // till (accepted, 200, correctly recorded in branch_safe_ledger and the
  // GL) and the drawer's expected cash did not move. The cashier then could
  // not spend it — CASH_EXPENSE_EXCEEDS_DRAWER refused a N1,000 purchase
  // against a drawer physically holding N30,033 — and at close-of-day the
  // count would have shown a N30,000 OVERAGE for money the manager put in
  // deliberately. The same phantom-discrepancy class as Bugs 79, 95 and 96,
  // on the one leg nobody had checked.
  //
  // This is the reason the safe exists: take the day's takings out of an
  // open drawer, and refill the drawer for change. Both halves were broken.
  //
  // TILL_TRANSFER carries its DIRECTION IN THE SIGN (see branchSafeService):
  // a POSITIVE amount moves cash drawer -> safe, so the drawer falls; a
  // NEGATIVE amount moves safe -> drawer, so the drawer rises. Subtracting
  // the signed sum therefore handles both directions with no branching.
  const safeTransfers = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM branch_safe_ledger
    WHERE branch_id = ? AND entry_type = 'TILL_TRANSFER' AND is_deleted = 0
      AND created_at >= ? AND (? IS NULL OR created_at <= ?)
  `).bind(till.branch_id, till.opened_at, till.closed_at, till.closed_at).first();

  return round2(
    till.opening_cash
    + cashIn.total
    + debtorCashIn.total
    + changeRetained.total
    - changePaidOut.total
    - cashExpenses.total
    - supplierCashOut.total
    - safeTransfers.total,
  );
}

async function closeTill(db, { tillSessionId, closedBy, countedClosingCash, notes, forceClose = false, forceReason = null }) {
  const till = await db.prepare('SELECT * FROM till_sessions WHERE id = ?').bind(tillSessionId).first();
  if (!till) throw Object.assign(new Error('Till session not found'), { status: 404 });
  if (till.status !== 'OPEN') throw Object.assign(new Error('Till session is already closed'), { status: 400 });

  // Claim the close first (guarded UPDATE, checked via meta.changes),
  // exactly like voidSale's phase-1 claim — prevents two concurrent
  // "close till" calls from both computing/recording a close.
  //
  // BUG FOUND AND FIXED DURING THE PRE-LAUNCH AUDIT (reproduced against
  // a real database): this claim previously set ONLY `closed_at` while
  // guarding on `status = 'OPEN'`. Because it never actually changed the
  // column it guards on, the row still satisfied `status = 'OPEN'` after
  // the claim, so a second concurrent close matched the guard too and
  // `meta.changes` was 1 for BOTH callers. Both proceeded to phase 2,
  // producing TWO TILL_CLOSE journal entries — a ₦100 till shortage was
  // posted to CASH_OVER_SHORT as ₦200, silently corrupting the books
  // (and double-counting every cash discrepancy in the P&L).
  //
  // The fix is to claim on a column the guard itself tests, exactly as
  // voidSale does. `closed_by` is NULL for every open session, so
  // "set closed_by WHERE status='OPEN' AND closed_by IS NULL" is a true
  // compare-and-swap: the winner's write makes the row stop matching, so
  // the loser gets changes=0 and a clean 409. This deliberately avoids
  // inventing a new status value, since till_sessions.status is
  // constrained by schema CHECK (status IN ('OPEN','CLOSED')) and a
  // transient third state would violate it.
// BUG 65 — a CAS claim batch left unwrapped turns a routine D1 blip into a
// FALSE conflict. Cloudflare documents faults like "Network connection lost."
// as expected noise; unwrapped, the claim throws and the caller reports a 409
// "someone else did this at the same time" when nobody did. Retrying is safe
// precisely BECAUSE it is a compare-and-swap: if the first attempt actually
// committed, the re-run matches no rows and yields changes=0, which the
// existing guard below already handles as the loser. Only Cloudflare's
// documented transient list is retried; a real conflict is untouched.
  const claim = await withD1Retry(() => db.batch([
    db.prepare(`UPDATE till_sessions SET closed_by = ?, closed_at = datetime('now') WHERE id = ? AND status = 'OPEN' AND closed_by IS NULL`).bind(closedBy, tillSessionId),
  ]), 'till close claim');
  if (claim[0]?.meta?.changes !== 1) {
    throw Object.assign(new Error('Till session was already closed by another request.'), { status: 409 });
  }

  const expected = await computeExpectedCash(db, tillSessionId);
  const discrepancy = round2(countedClosingCash - expected);

  // A force-close (manager closing on behalf of a cashier who left
  // without closing their own till — see routes/till.js) is recorded in
  // its own dedicated columns rather than just backdating closed_by to
  // the manager, so every later listing/report can still tell the
  // difference between a normal self-close and a manager intervention.
  const statements = [
    db.prepare(`
      UPDATE till_sessions
      SET status = 'CLOSED', closed_by = ?, expected_closing_cash = ?, counted_closing_cash = ?, discrepancy = ?, notes = ?,
          force_closed_by = ?, force_closed_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(closedBy, expected, round2(countedClosingCash), discrepancy, notes || null,
            forceClose ? closedBy : null, forceClose ? (forceReason || 'Force-closed by manager') : null,
            tillSessionId),
  ];

  // GENERAL LEDGER (real gap found and fixed during this audit pass — see
  // the write-up below's Node-deployment counterpart for the full write-up):
  // appended to this same batch so it commits atomically with the till-close
  // UPDATE above — see glService.postTillClose.
  const glResult = await glService.postTillClose(db, { branchId: till.branch_id, tillSessionId, closedBy, discrepancy });
  if (glResult) statements.push(...glResult.statements);

  await withD1Retry(() => db.batch(statements), 'till');

  return db.prepare('SELECT * FROM till_sessions WHERE id = ?').bind(tillSessionId).first();
}

module.exports = { openTill, closeTill, computeExpectedCash };
