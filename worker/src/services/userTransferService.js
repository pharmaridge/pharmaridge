// USER TRANSFER & PROMOTION  (BUG 75)
//
// Moving a person between branches, and promoting/demoting them between
// STAFF / Branch Manager / General Manager / Owner, as a FIRST-CLASS action
// that keeps ONE user_id and ONE username for one human.
//
// Why this exists — see the full write-up on user_assignment_history in
// migrations/0001_initial_schema.sql. In short: the app used to refuse these
// changes outright and instruct the operator to "deactivate and recreate",
// which is impossible to follow correctly (the username is UNIQUE table-wide
// and removals are soft, so the old name is held forever) and which split one
// human into two identities that payroll then counted twice.
//
// The refusal's justification — that a move would corrupt history — was
// disproven by execution: every historical table carries its own branch_id,
// so a Lagos sale stays a Lagos sale after its cashier moves to Minna.
//
// This service is deliberately CONSERVATIVE about authority. A transfer is a
// change to what someone may do with money, so it reuses the exact same rank
// and branch-scope rules that already govern editing a user, and adds the
// invariants that only apply to a move.
const { uuid } = require('../lib/crypto');
const { withD1Retry } = require('../lib/d1Retry');
const { roleLabel } = require('../lib/auth');

class TransferError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// A transfer changes role, branch, or both. Normalising here means the route
// never has to reason about "absent means unchanged" vs "null means clear",
// which is exactly the ambiguity that makes branch changes error-prone:
// `branch_id: null` is a MEANINGFUL value (it promotes a Branch Manager to
// General Manager), so `undefined` and `null` must not be conflated.
function resolveTarget(existing, body) {
  const toRole = body.role === undefined ? existing.role : body.role;
  const toBranchId = body.branch_id === undefined ? existing.branch_id : (body.branch_id || null);
  return { toRole, toBranchId };
}

// Mirrors the users table CHECK constraint, but as a friendly message rather
// than a raw SQLITE_CONSTRAINT_CHECK. The database stays the real authority —
// this is a better error, not a substitute guard.
function assertValidCombination(toRole, toBranchId) {
  if ((toRole === 'ADMIN' || toRole === 'OWNER') && toBranchId) {
    throw new TransferError(
      `An ${toRole === 'OWNER' ? 'Owner' : 'Admin'} account is org-wide and cannot be tied to a single branch.`,
      'INVALID_ROLE_BRANCH_COMBINATION',
    );
  }
  if (toRole === 'STAFF' && !toBranchId) {
    throw new TransferError(
      'A Staff account must belong to exactly one branch. Choose the branch they will work at.',
      'INVALID_ROLE_BRANCH_COMBINATION',
    );
  }
}

// THE LAST-OWNER INVARIANT, RESTATED FOR TRANSFERS.
//
// Bug 70 protected the last owner against deactivation and deletion. A
// transfer is a THIRD way to remove an owner that did not exist when that
// guard was written: demoting the only Owner to Manager empties the owner
// seat just as effectively as deactivating them, and leaves nobody able to
// change VAT, withholding-tax rates or manager permissions.
//
// This is the "look for the class, not the incident" rule applied to my own
// earlier fix: a new code path must satisfy the old invariant, and nothing
// but an explicit check here would have enforced it.
async function assertNotRemovingLastOwner(db, existing, toRole) {
  if (existing.role !== 'OWNER' || toRole === 'OWNER') return;
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM users
      WHERE role = 'OWNER' AND is_active = 1 AND is_deleted = 0 AND id != ?`,
  ).bind(existing.id).first();
  if (Number(row && row.n) > 0) return;
  throw new TransferError(
    'This is the only active Owner account. Changing its role would leave nobody able to change VAT, withholding-tax rates, and manager/cashier permissions — a manager cannot do those, and cannot restore an Owner either. Promote another Owner first, then change this one.',
    'LAST_OWNER_PROTECTED',
  );
}

// A person cannot be moved out of a branch while they still hold that
// branch's cash drawer. The till is the strongest form of the general rule:
// whoever holds an open till owns the cash accountability for it, and that
// accountability belongs to the branch they opened it at. Reassigning them
// first would leave a drawer whose owner no longer works there.
//
// Deliberately a BLOCK with a named remedy rather than an auto-close: closing
// a till requires a counted cash figure that only a human at the drawer can
// supply, and inventing one would post a fictitious over/short to the GL —
// precisely the class of bug already fixed in till.js.
async function assertNoOpenTill(db, existing, toBranchId) {
  if (existing.branch_id === toBranchId) return; // not a branch move
  const till = await db.prepare(
    `SELECT id, branch_id FROM till_sessions
      WHERE opened_by = ? AND status = 'OPEN' AND is_deleted = 0 LIMIT 1`,
  ).bind(existing.id).first();
  if (!till) return;
  throw new TransferError(
    'This person still has an OPEN till at their current branch. Cash accountability has to be settled at the branch where the money is, so close (or force-close) that till first, then move them.',
    'OPEN_TILL_BLOCKS_TRANSFER',
    409,
  );
}

// An open SHIFT is different from an open till: it holds no money, and it is
// entirely reasonable for someone to be moved between branches while a shift
// is running (the classic case is a manager reassigned mid-day). But the
// shift must not silently follow them to the new branch, because
// staff_attendance.branch_id is payroll evidence of where they actually were.
//
// So the shift is closed AT THE OLD BRANCH as a manager intervention, using
// the same force-close machinery Bug 74 added, and the row keeps the old
// branch_id. The person can clock in at the new branch immediately after.
async function closeOpenShiftForTransfer(db, existing, toBranchId, actorId) {
  if (existing.branch_id === toBranchId) return null;
  const open = await db.prepare(
    `SELECT id, branch_id FROM staff_attendance
      WHERE user_id = ? AND clock_out_at IS NULL AND is_deleted = 0 LIMIT 1`,
  ).bind(existing.id).first();
  if (!open) return null;
  return db.prepare(`
    UPDATE staff_attendance
       SET clock_out_at = datetime('now'),
           clock_out_status = 'NO_LOCATION',
           force_closed_by = ?,
           force_closed_reason = ?,
           updated_at = datetime('now')
     WHERE id = ? AND clock_out_at IS NULL
  `).bind(actorId, 'Shift closed automatically because this person was transferred to another branch.', open.id);
}

// BUG 88 — A TRANSFER LEFT WORK BEHIND AND SAID NOTHING.
//
// The open-till guard above BLOCKS a move, because cash accountability must be
// settled where the money physically is. An open stocktake is different: it
// holds no money, and blocking a legitimate staffing decision over a count
// somebody forgot to finish would be the wrong trade — the same reasoning the
// client applied to branch closure (BUG 86: warn and list, never block).
//
// But it cannot be silent either. Live-reproduced: a cashier opened a stocktake
// at Lagos, was transferred to Minna, and the count stayed OPEN at Lagos —
// where they can no longer even see it (correctly, they are scoped to Minna
// now). Because of idx_stocktake_one_open_per_branch, that orphan then BLOCKS
// Lagos from ever starting another count: "A stocktake session is already open
// for this branch". Nobody was told, and the person who could explain it has
// gone.
//
// Same treatment for a pending purchase order they raised: it is not blocking,
// but it is theirs and the new branch manager will not be looking for it.
//
// Reported, never blocking. All of it stays recoverable — an owner or the
// branch's own manager can cancel a stocktake and a PO at any time.
async function workLeftBehind(db, userId, fromBranchId) {
  if (!fromBranchId) return null;
  const one = async (sql) => {
    const r = await db.prepare(sql).bind(userId, fromBranchId).first();
    return Number((r && r.n) || 0);
  };
  const [stocktakes, orders] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM stocktake_sessions WHERE started_by = ? AND branch_id = ? AND status = 'OPEN' AND is_deleted = 0"),
    one("SELECT COUNT(*) AS n FROM purchase_orders WHERE ordered_by = ? AND branch_id = ? AND status IN ('PENDING','PARTIALLY_RECEIVED') AND is_deleted = 0"),
  ]);
  const items = [];
  if (stocktakes) {
    items.push(`${stocktakes} stocktake${stocktakes === 1 ? '' : 's'} still open at their old branch — until it is closed or cancelled, that branch cannot start another count`);
  }
  if (orders) {
    items.push(`${orders} purchase order${orders === 1 ? '' : 's'} they raised is still outstanding at their old branch`);
  }
  if (!items.length) return null;
  return { open_stocktakes: stocktakes, pending_purchase_orders: orders, items };
}

// The transfer itself.
//
// `existing` must be the live user row; `actor` the authenticated caller.
// Authority checks (rank, branch scope, vendor seat) are performed by the
// ROUTE before calling this, exactly like every other user mutation, so that
// there is one place those rules live.
async function transferUser(db, { existing, actor, body, stage = true }) {
  const { toRole, toBranchId } = resolveTarget(existing, body);

  const roleChanged = toRole !== existing.role;
  const branchChanged = (toBranchId || null) !== (existing.branch_id || null);
  if (!roleChanged && !branchChanged) {
    throw new TransferError(
      'Nothing to change — this person already holds that role at that branch.',
      'NO_CHANGE',
    );
  }

  // The vendor's support seat is not an employee and has no branch or role to
  // move; and no transfer may ever mint an ADMIN.
  if (existing.role === 'ADMIN' || toRole === 'ADMIN') {
    throw new TransferError(
      'The PharmaRidge Support seat is not a branch employee and its role cannot be changed.',
      'VENDOR_SEAT_NOT_AN_EMPLOYEE',
      403,
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  // A reason is mandatory for the same purpose it is mandatory on a till
  // force-close and an attendance override: this is the only artefact that
  // explains, months later, why someone's authority changed.
  if (reason.length < 4) {
    throw new TransferError(
      'Give a reason for this transfer — it is the permanent record of why this person\'s branch or authority changed.',
      'TRANSFER_REASON_REQUIRED',
    );
  }

  assertValidCombination(toRole, toBranchId);
  await assertNotRemovingLastOwner(db, existing, toRole);
  await assertNoOpenTill(db, existing, toBranchId);

  if (toBranchId) {
    const branch = await db.prepare(
      'SELECT id, is_active FROM branches WHERE id = ? AND is_deleted = 0',
    ).bind(toBranchId).first();
    if (!branch) throw new TransferError(`Unknown branch ${toBranchId}`, 'UNKNOWN_BRANCH');
    if (!branch.is_active) {
      throw new TransferError(
        'That branch is closed, so nobody can be assigned to it. Re-open the branch first.',
        'BRANCH_INACTIVE',
        403,
      );
    }
  }

  // BUG 88: capture what they are leaving behind BEFORE the branch changes,
  // because afterwards the query would look at the wrong branch.
  const leftBehind = (existing.branch_id && existing.branch_id !== toBranchId)
    ? await workLeftBehind(db, existing.id, existing.branch_id)
    : null;

  // BUG 108 — A PERSON IS NOT A ROW; MOVING THEM NEEDS THEIR CONFIRMATION.
  //
  // Until now this applied instantly. A stock transfer has always required the
  // receiving branch to confirm; moving a PERSON required nobody to agree. The
  // failure mode is identical to Bug 107 and just as invisible: a cashier
  // working OFFLINE is reassigned mid-shift, and their queued sales, open till
  // and clock-in all belong to a branch they are no longer attached to. They
  // discover it when the device reconnects and the work is refused.
  //
  // The change is therefore STAGED and applied only when the person confirms
  // — they are the one who knows whether they have finished at the old
  // counter. Their access is untouched while it is pending, so nothing they do
  // offline can break. `stage: false` is the path taken once a confirmation
  // (or an Owner/GM force) has arrived, and performs the real write.
  if (stage) {
    const existingOpen = await db.prepare(`
      SELECT id FROM pending_user_transfers
       WHERE user_id = ? AND status = 'AWAITING_CONFIRMATION' AND is_deleted = 0
    `).bind(existing.id).first();
    if (existingOpen) {
      throw new TransferError(
        `${existing.full_name} already has a transfer waiting for their confirmation. Cancel that one first, or ask them to respond to it.`,
        'TRANSFER_ALREADY_PENDING',
        409,
      );
    }
    const pendingId = uuid();
    await db.prepare(`
      INSERT INTO pending_user_transfers
        (id, user_id, from_role, from_branch_id, to_role, to_branch_id, reason, requested_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(pendingId, existing.id, existing.role, existing.branch_id || null,
            toRole, toBranchId, reason, actor.id).run();
    return {
      id: existing.id,
      full_name: existing.full_name,
      username: existing.username,
      role: existing.role,
      branch_id: existing.branch_id,
      role_label: roleLabel(existing),
      pending_transfer: {
        id: pendingId,
        status: 'AWAITING_CONFIRMATION',
        from_role: existing.role,
        from_role_label: roleLabel(existing),
        from_branch_id: existing.branch_id || null,
        to_role: toRole,
        to_role_label: roleLabel({ role: toRole, branch_id: toBranchId }),
        to_branch_id: toBranchId,
        reason,
        message: `${existing.full_name} has been asked to confirm this move. Nothing changes for them until they do — they keep working at their current branch, so anything they record offline stays valid. They will see the request the next time they sign in.`,
      },
      ...(leftBehind ? {
        work_left_behind: {
          code: 'WORK_LEFT_AT_OLD_BRANCH',
          message: `Before they confirm, note that some of their work is still open at their current branch: ${leftBehind.items.join('; ')}.`,
          ...leftBehind,
        },
      } : {}),
    };
  }

  const statements = [];
  const shiftStmt = await closeOpenShiftForTransfer(db, existing, toBranchId, actor.id);
  if (shiftStmt) statements.push(shiftStmt);

  statements.push(
    db.prepare(
      `UPDATE users SET role = ?, branch_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(toRole, toBranchId, existing.id),
  );

  const historyId = uuid();
  statements.push(
    db.prepare(`
      INSERT INTO user_assignment_history
        (id, user_id, from_role, from_branch_id, to_role, to_branch_id,
         from_role_label, to_role_label, reason, changed_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      historyId, existing.id,
      existing.role, existing.branch_id || null,
      toRole, toBranchId,
      roleLabel(existing), roleLabel({ role: toRole, branch_id: toBranchId }),
      reason, actor.id,
    ),
  );

  // One batch, so the role change, the shift closure and the audit record
  // either all happen or none do. A transfer recorded without its history
  // row would be exactly the untraceable change this feature exists to end.
  // Retry-wrapped per BUG 65: every statement is idempotent under re-run
  // (the UPDATEs are absolute writes, and the INSERT carries an id generated
  // once above the retry, so a replay collides on the primary key rather than
  // writing a second history row).
  await withD1Retry(() => db.batch(statements), 'user transfer');

  const updated = await db.prepare(
    'SELECT id, full_name, username, role, branch_id, job_title, is_active FROM users WHERE id = ?',
  ).bind(existing.id).first();

  return {
    ...updated,
    role_label: roleLabel(updated),
    transfer: {
      id: historyId,
      from_role: existing.role,
      from_role_label: roleLabel(existing),
      from_branch_id: existing.branch_id || null,
      to_role: toRole,
      to_role_label: roleLabel({ role: toRole, branch_id: toBranchId }),
      to_branch_id: toBranchId,
      shift_auto_closed: !!shiftStmt,
      reason,
    },
    ...(leftBehind ? {
      work_left_behind: {
        code: 'WORK_LEFT_AT_OLD_BRANCH',
        message: `${updated.full_name} has been moved, but some of their work is still open at their old branch: ${leftBehind.items.join('; ')}. `
          + 'They can no longer see it from their new branch, so a manager there will need to finish or cancel it.',
        ...leftBehind,
      },
    } : {}),
  };
}

async function listAssignmentHistory(db, userId) {
  const { results } = await db.prepare(`
    SELECT h.*, fb.name AS from_branch_name, tb.name AS to_branch_name, cb.full_name AS changed_by_name
      FROM user_assignment_history h
      LEFT JOIN branches fb ON fb.id = h.from_branch_id
      LEFT JOIN branches tb ON tb.id = h.to_branch_id
      LEFT JOIN users cb ON cb.id = h.changed_by
     WHERE h.user_id = ?
     ORDER BY h.changed_at DESC, h.rowid DESC
     LIMIT 200
  `).bind(userId).all();
  return results;
}

// ---------------------------------------------------------------------------
// BUG 108 — resolving a staged transfer
// ---------------------------------------------------------------------------

// Every transfer waiting on a given person. Called on sign-in so the request
// is the first thing they see, and by managers to chase an unanswered one.
async function listPendingForUser(db, userId) {
  const { results } = await db.prepare(`
    SELECT p.*, b_from.name AS from_branch_name, b_to.name AS to_branch_name,
           u.full_name AS requested_by_name
      FROM pending_user_transfers p
      LEFT JOIN branches b_from ON b_from.id = p.from_branch_id
      LEFT JOIN branches b_to   ON b_to.id   = p.to_branch_id
      LEFT JOIN users u         ON u.id      = p.requested_by
     WHERE p.user_id = ? AND p.status = 'AWAITING_CONFIRMATION' AND p.is_deleted = 0
     ORDER BY p.requested_at
  `).bind(userId).all();
  return results || [];
}

// Everything outstanding across the pharmacy, so a manager can see who has
// not answered rather than having to ask each person.
async function listAllPending(db, { branchId = null } = {}) {
  const where = branchId
    ? "AND (p.from_branch_id = ? OR p.to_branch_id = ?)"
    : '';
  const binds = branchId ? [branchId, branchId] : [];
  const { results } = await db.prepare(`
    SELECT p.*, u.full_name AS user_name, u.username,
           b_from.name AS from_branch_name, b_to.name AS to_branch_name,
           r.full_name AS requested_by_name
      FROM pending_user_transfers p
      JOIN users u              ON u.id      = p.user_id
      LEFT JOIN branches b_from ON b_from.id = p.from_branch_id
      LEFT JOIN branches b_to   ON b_to.id   = p.to_branch_id
      LEFT JOIN users r         ON r.id      = p.requested_by
     WHERE p.status = 'AWAITING_CONFIRMATION' AND p.is_deleted = 0 ${where}
     ORDER BY p.requested_at
  `).bind(...binds).all();
  return results || [];
}

async function loadPending(db, pendingId) {
  const row = await db.prepare(
    "SELECT * FROM pending_user_transfers WHERE id = ? AND is_deleted = 0",
  ).bind(pendingId).first();
  if (!row) throw new TransferError('That transfer request no longer exists.', 'PENDING_NOT_FOUND', 404);
  if (row.status !== 'AWAITING_CONFIRMATION') {
    throw new TransferError(
      `That transfer was already ${row.status.toLowerCase()}.`,
      'PENDING_ALREADY_RESOLVED',
      409,
    );
  }
  return row;
}

// The person accepts. Only now does anything actually change — and it runs
// through the SAME transferUser() path, so every guard that protects a direct
// transfer (last owner, open till, closed branch, valid combination) is
// re-checked against the world as it is NOW, not as it was when the request
// was raised. A branch closed in the meantime must still stop the move.
async function confirmPending(db, { pendingId, actor, forced = false }) {
  const pending = await loadPending(db, pendingId);
  if (!forced && actor.id !== pending.user_id) {
    throw new TransferError(
      'Only the person being transferred can confirm it. An Owner or General Manager can force it through if they are unreachable.',
      'NOT_YOUR_TRANSFER',
      403,
    );
  }
  const existing = await db.prepare(
    'SELECT * FROM users WHERE id = ? AND is_deleted = 0',
  ).bind(pending.user_id).first();
  if (!existing) throw new TransferError('That user no longer exists.', 'UNKNOWN_USER', 404);

  const result = await transferUser(db, {
    existing,
    actor: { id: pending.requested_by },
    body: {
      role: pending.to_role,
      branch_id: pending.to_branch_id,
      reason: forced
        ? `${pending.reason} [forced through by ${actor.full_name || actor.id} without the staff member's confirmation]`
        : pending.reason,
    },
    stage: false,
  });

  await db.prepare(`
    UPDATE pending_user_transfers
       SET status = ?, resolved_at = datetime('now'), resolved_by = ?
     WHERE id = ?
  `).bind(forced ? 'FORCED' : 'CONFIRMED', actor.id, pendingId).run();

  return { ...result, confirmation: { id: pendingId, forced, confirmed_by: actor.id } };
}

// The person says no — they have not finished at the old counter, or they
// dispute the move. A decline is not a failure state: it is information the
// manager needs, so it is recorded with their reason rather than discarded.
async function declinePending(db, { pendingId, actor, reason }) {
  const pending = await loadPending(db, pendingId);
  if (actor.id !== pending.user_id) {
    throw new TransferError(
      'Only the person being transferred can decline it. A manager who wants to withdraw the request should cancel it instead.',
      'NOT_YOUR_TRANSFER',
      403,
    );
  }
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 4) {
    throw new TransferError(
      'Say why you cannot take this transfer — your manager needs to know what to do next.',
      'DECLINE_REASON_REQUIRED',
    );
  }
  await db.prepare(`
    UPDATE pending_user_transfers
       SET status = 'DECLINED', resolved_at = datetime('now'), resolved_by = ?, decline_reason = ?
     WHERE id = ?
  `).bind(actor.id, why, pendingId).run();
  return { id: pendingId, status: 'DECLINED', decline_reason: why };
}

// The manager withdraws their own request. Distinct from DECLINED so the
// record shows who changed their mind.
async function cancelPending(db, { pendingId, actor }) {
  const pending = await loadPending(db, pendingId);
  await db.prepare(`
    UPDATE pending_user_transfers
       SET status = 'CANCELLED', resolved_at = datetime('now'), resolved_by = ?
     WHERE id = ?
  `).bind(actor.id, pendingId).run();
  return { id: pendingId, status: 'CANCELLED', user_id: pending.user_id };
}

module.exports = {
  transferUser, listAssignmentHistory, TransferError,
  listPendingForUser, listAllPending, confirmPending, declinePending, cancelPending,
};
