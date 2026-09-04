const { Hono } = require('hono');
const { authRequired, managerOnly, assertBranchActive, pinnedBranchIdOf, roleLabel } = require('../lib/auth');
const { uuid, hashPin, verifyPin } = require('../lib/crypto');

// The PIN every seeded demo account ships with (see worker/seed.sql).
const DEFAULT_DEMO_PIN = '1234';
const { assertCanAddStaff, PlanLimitError } = require('../lib/planLimits');
const { clearLoginLock, getLockState } = require('../lib/loginThrottle');
const { readJsonBody, isExplicitFalse } = require('../lib/http');
const userTransferService = require('../services/userTransferService');
const attendanceService = require('../services/attendanceService');
const { withD1Retry } = require('../lib/d1Retry');

const users = new Hono();
users.use('*', authRequired);

// See the original design for the full rationale — this file is kept
// structurally parallel to it.
const LOCKOUT_GUARD_ROLES = ['MANAGER', 'OWNER'];

// BUG 70 — THE SOLE OWNER COULD REMOVE THEMSELVES, PERMANENTLY.
//
// LOCKOUT_GUARD_ROLES above counts MANAGER and OWNER *together*: it refuses the
// removal only when fewer than two such accounts remain. With any manager
// present that count is >= 2, so the guard never fired for the only OWNER.
//
// Live-reproduced end to end (1 owner, 2 managers):
//     owner PUT /users/:self {is_active:false}            -> 200
//     owner login                                          -> 401
//     manager PUT /settings/vat                            -> 403
//     manager PUT /settings/manager-permissions            -> 403
//     manager PUT /users/:owner {is_active:true}           -> 403
//
// The business is then permanently unable to change its own tax position, its
// withholding-tax rates, or what its managers may do — because those are
// `ownerOnly`, and the rank guard stops any manager from reinstating the owner.
// Only the vendor support seat can undo it. For a pharmacy that has just paid
// for the product, that is an unrecoverable self-inflicted lockout caused by
// one plausible click ("deactivate the account I no longer use").
//
// The fix is a SEPARATE, stricter rule for OWNER: an owner may be removed only
// while another ACTIVE owner exists. Managers do not substitute for an owner,
// because they cannot do the things only an owner can do. This is deliberately
// asymmetric with the manager rule and that asymmetry is the whole point.
const OWNER_ONLY_CAPABILITIES = 'VAT, withholding-tax rates, and manager/cashier permissions';

async function wouldRemoveLastOwner(db, existing) {
  if (existing.role !== 'OWNER') return null;
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM users
      WHERE role = 'OWNER' AND is_active = 1 AND is_deleted = 0 AND id != ?`
  ).bind(existing.id).first();
  if (Number(row && row.n) > 0) return null;
  return `This is the only active Owner account. Removing it would leave nobody able to change ${OWNER_ONLY_CAPABILITIES} — a manager cannot do those, and cannot restore an Owner either. Create or re-activate another Owner account first.`;
}

function canAssignRole(actingRole, targetRole) {
  if (targetRole === 'ADMIN') return false;
  if (actingRole === 'ADMIN' || actingRole === 'OWNER') return true;
  if (actingRole === 'MANAGER') return targetRole !== 'OWNER';
  return false;
}

// PRIVILEGE-ESCALATION HOLE FOUND AND FIXED DURING A PRODUCTION AUDIT
// (reproduced end-to-end over real HTTP against live workerd + D1 —
// the full chain was executed, not theorised):
//
//   1. MANAGER calls PUT /api/users/<owner id> { "pin": "7777" }  -> 200
//   2. MANAGER logs in as `owner` with 7777                       -> 200
//   3. Now holding an OWNER token, calls PUT /api/settings/vat     -> 200
//      (the very endpoint that returned 403 to them one step earlier)
//
// `canAssignRole` correctly stopped a MANAGER from CREATING an OWNER,
// and the ADMIN row was correctly hidden from non-ADMINs — but nothing
// governed MUTATING an existing higher-privileged account. Any MANAGER
// could seize the proprietor's seat, then change VAT (a figure that
// feeds every receipt and the GL), edit plan-adjacent settings, and act
// with the owner's identity in the audit trail. On a product where the
// OWNER is the business's proprietor and the MANAGER is hired staff,
// that is a total collapse of the role model.
//
// The rule now enforced: you may only modify an account whose rank is
// STRICTLY BELOW your own — with one deliberate exception, self-service
// (a user editing their own row, e.g. changing their own PIN), which is
// legitimate and must not be blocked.
//
// Rank order (higher number = more authority):
//   ADMIN(4)  the vendor's support seat
//   OWNER(3)  the pharmacy proprietor
//   MANAGER(2)
//   STAFF(1)
// So: MANAGER may edit STAFF and themselves; OWNER may edit MANAGER and
// STAFF; ADMIN may edit anyone. A MANAGER can no longer touch a peer
// MANAGER either — two managers resetting each other's PINs is the same
// lateral-takeover problem in a milder form, and a real pharmacy has an
// OWNER (or PharmaRidge support) to arbitrate that.
const ROLE_RANK = { ADMIN: 4, OWNER: 3, MANAGER: 2, STAFF: 1 };

function rankOf(role) {
  return ROLE_RANK[role] || 0;
}

// Returns an error message when `requester` may NOT modify `target`,
// or null when the action is permitted.
function assertCanModifyUser(requester, target) {
  if (requester.id === target.id) return null; // self-service is always allowed
  if (rankOf(requester.role) > rankOf(target.role)) return null;
  if (requester.role === 'MANAGER' && target.role === 'MANAGER') {
    return 'A manager cannot modify another manager\'s account. Ask the Owner (or PharmaRidge support) to make this change.';
  }
  return `You do not have permission to modify a ${target.role} account.`;
}

users.get('/', managerOnly, async (c) => {
  const requester = c.get('user');
  const adminClause = requester.role === 'ADMIN' ? '' : `AND u.role != 'ADMIN'`;
  // CROSS-BRANCH LEAK FOUND AND FIXED (live-reproduced): a manager pinned
  // to Minna saw the Lagos staff roster. A branch manager has no business
  // reading another branch's employee list — and, worse, the ids returned
  // here are exactly what the takeover below needed.
  // Org-wide accounts (OWNER, and org-wide MANAGERs) stay visible so a
  // branch manager can still see who their superiors are.
  const pinned = pinnedBranchIdOf(requester);
  const branchClause = pinned ? 'AND (u.branch_id = ? OR u.branch_id IS NULL)' : '';
  const branchParams = pinned ? [pinned] : [];
  // DATA-SAFETY — see the write-up below.
  const { results } = await c.env.DB.prepare(`
    SELECT u.id, u.branch_id, b.name AS branch_name, u.full_name, u.phone, u.username, u.role, u.job_title, u.is_active, u.created_at
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.is_deleted = 0 ${adminClause} ${branchClause} ORDER BY u.role, u.full_name LIMIT 2000
  `).bind(...branchParams).all();
  // role_label is DERIVED server-side (see roleLabel in lib/auth.js) so
  // every client renders the same wording without reimplementing the
  // "General Manager vs Branch Manager" rule.
  // Surface lock state so a manager can see WHO is locked out without
  // waiting for a phone call from a cashier who cannot sign in. One
  // query per row would be an N+1; instead aggregate all of them at once.
  const locked = new Map();
  try {
    const { results: lockRows } = await c.env.DB.prepare(`
      SELECT username, COUNT(*) AS failures, MAX(attempted_at) AS last_failure
      FROM login_attempts
      WHERE succeeded = 0 AND attempted_at > datetime('now', '-15 minutes')
      GROUP BY username
    `).all();
    for (const r of lockRows) locked.set(r.username, r);
  } catch (e) {
    // Fail open: a missing/erroring login_attempts table must never break
    // the Users screen (see lib/loginThrottle.js's fail-open rationale).
  }
  return c.json(results.map((u) => {
    const l = locked.get(u.username);
    const failures = l ? l.failures : 0;
    return {
      ...u,
      role_label: roleLabel(u),
      failed_login_attempts: failures,
      is_login_locked: failures >= 8,
    };
  }));
});

users.get('/me', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT id, full_name, username, role, branch_id, job_title FROM users WHERE id = ?').bind(user.id).first();
  return c.json(row ? { ...row, role_label: roleLabel(row) } : row);
});

users.post('/', managerOnly, async (c) => {
  const requester = c.get('user');
  const body = await readJsonBody(c);
  const { branch_id, full_name, phone, username, pin, role, job_title } = body;
  if (!full_name || !username || !pin || !role) return c.json({ error: 'full_name, username, pin, role are required' }, 400);
  if (String(pin).length < 4) return c.json({ error: 'PIN must be at least 4 characters.' }, 400);
  // ADMIN accounts can never be created through the ordinary user-management
  // API, by anyone — see the rationale below.
  if (!['OWNER', 'MANAGER', 'STAFF'].includes(role)) return c.json({ error: "role must be 'OWNER', 'MANAGER', or 'STAFF'" }, 400);
  if (!canAssignRole(requester.role, role)) return c.json({ error: 'You do not have permission to assign this role.' }, 403);
  if (role === 'STAFF' && !branch_id) return c.json({ error: 'branch_id required for STAFF' }, 400);
  // BRANCH-SCOPED MANAGERS (migration 0003): a MANAGER may now optionally
  // be pinned to one branch. Omitting branch_id keeps the previous
  // org-wide behaviour, so nothing existing changes. OWNER and ADMIN
  // remain strictly org-wide — the proprietor and the vendor seat are not
  // branch employees, and the schema CHECK enforces this independently.
  if (role === 'OWNER' && branch_id) return c.json({ error: 'An OWNER account is org-wide and must not be tied to a branch.' }, 400);
  // A branch-scoped MANAGER cannot create users outside their own branch,
  // and can never create an org-wide (unpinned) manager — that would let
  // them escalate past their own scope.
  {
    const pinned = pinnedBranchIdOf(requester);
    if (pinned) {
      if (role === 'OWNER') return c.json({ error: 'A Branch Manager cannot create an Owner account.', code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);
      if (!branch_id || branch_id !== pinned) {
        return c.json({
          error: 'As a Branch Manager you can only create accounts assigned to your own branch.',
          code: 'BRANCH_SCOPE_VIOLATION',
        }, 403);
      }
    }
  }

  // DATA-INTEGRITY / OPERATIONAL-INTEGRITY (real gap found and fixed
  // during this audit — mirrors the identical Node-deployment fix for
  // parity, see that file's full write-up): assigning a new STAFF
  // account to a deactivated (closed) branch previously succeeded
  // outright.
  if (branch_id) {
    const branch = await c.env.DB.prepare('SELECT id, is_active FROM branches WHERE id = ? AND is_deleted = 0').bind(branch_id).first();
    if (!branch) return c.json({ error: `Unknown branch ${branch_id}` }, 400);
    try {
      await assertBranchActive(c.env.DB, branch_id, 'have a new staff member assigned to it');
    } catch (e) {
      return c.json({ error: e.message, code: e.code }, e.status || 403);
    }
  }

  try {
    await assertCanAddStaff(c.env.DB);
  } catch (e) {
    if (e instanceof PlanLimitError) return c.json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  const id = uuid();
  const pinHash = await hashPin(pin);
  try {
    await c.env.DB.prepare(`INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, role === 'OWNER' ? null : (branch_id || null), full_name, phone || null, username, pinHash, role, job_title || null).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      // BUG 73 — say WHICH kind of clash it is, because the two have completely
      // different remedies and the operator cannot tell them apart otherwise.
      // Three genuinely different situations, three different remedies. The
      // old code collapsed all of them into "Username already exists", which
      // told an operator following the deactivate-and-recreate instruction
      // nothing at all about why it had just failed.
      const clash = await c.env.DB
        .prepare('SELECT is_deleted, is_active, full_name FROM users WHERE username = ?')
        .bind(username).first();
      if (clash && (clash.is_deleted || !clash.is_active)) {
        const state = clash.is_deleted ? 'deleted' : 'deactivated';
        return c.json({
          error: `The username "${username}" belongs to a ${state} account (${clash.full_name}) and stays reserved, so that person's existing sales, tills and shifts remain attributable to them. `
            + 'Choose a different username for the new account — the old records keep the old name, and the staff slot has already been freed.',
          code: 'USERNAME_HELD_BY_CLOSED_ACCOUNT',
        }, 409);
      }
      return c.json({
        error: `The username "${username}" is already in use by an active account. Choose a different one.`,
        code: 'USERNAME_TAKEN',
      }, 409);
    }
    throw e;
  }
  const createdBranchId = role === 'OWNER' ? null : (branch_id || null);
  return c.json({ id, full_name, username, role, branch_id: createdBranchId, job_title, role_label: roleLabel({ role, branch_id: createdBranchId }) }, 201);
});

users.put('/:id', managerOnly, async (c) => {
  const requester = c.get('user');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing || (existing.role === 'ADMIN' && requester.role !== 'ADMIN')) return c.json({ error: 'User not found' }, 404);


  // CROSS-BRANCH ACCOUNT TAKEOVER FOUND AND FIXED (live-reproduced): a
  // manager pinned to Minna reset the Lagos cashier's PIN to 9999 and
  // then logged in as them (verified: login returned 200). That is a
  // full account takeover across a branch boundary — every sale, void and
  // till action taken afterwards would be attributed to the Lagos
  // cashier. The same manager could also deactivate them, halting that
  // branch's trading.
  //
  // A pinned manager may only act on accounts belonging to their own
  // branch. Org-wide accounts (OWNER / org-wide MANAGER) are already out
  // of reach via the rank guard below, but are excluded here too so the
  // rule reads the same way in both directions.
  {
    const pinnedActor = pinnedBranchIdOf(requester);
    if (pinnedActor && existing.branch_id !== pinnedActor) {
      return c.json({
        error: 'As a Branch Manager you can only change accounts assigned to your own branch.',
        code: 'BRANCH_SCOPE_VIOLATION',
      }, 403);
    }
  }

  // Rank guard — see assertCanModifyUser's write-up above for the
  // live-reproduced MANAGER -> OWNER takeover this closes.
  const forbidden = assertCanModifyUser(requester, existing);
  if (forbidden) return c.json({ error: forbidden, code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);

  const body = await readJsonBody(c);
  const { full_name, phone, job_title, is_active, pin } = body;

  // SILENT-IGNORE FIX (found during an OWNER/MANAGER alignment audit).
  //
  // `role` and `branch_id` are NOT editable here — and that is correct.
  // Changing a role is how a MANAGER would promote themselves to OWNER;
  // changing branch_id is how a Branch Manager would re-pin themselves to
  // a branch they were never given. Neither belongs in a general "edit
  // this user" call, and both were already impossible: the fields are
  // simply absent from the UPDATE below.
  //
  // But the route accepted them and returned 200 with the user's UNCHANGED
  // record. Reproduced live: a MANAGER sent {"role":"OWNER"} against their
  // own account and got 200 back. No escalation occurred — a follow-up
  // login confirmed they were still MANAGER, and every OWNER-only endpoint
  // still refused them — but an operator reading that 200 would reasonably
  // conclude the promotion had worked. The same shape would hide a real
  // contract drift after any future rename, and it is indistinguishable
  // from success in a log.
  //
  // Refuse explicitly, and say where the change actually belongs.
  //
  // BUG 73 — THE ADVICE THESE MESSAGES GAVE WAS IMPOSSIBLE TO FOLLOW.
  //
  // The role message said "Deactivate this account and create the new one".
  // Executed end to end, that fails:
  //     PUT  /users/:id {branch_id: minna}  -> 400 BRANCH_NOT_EDITABLE
  //     PUT  /users/:id {is_active: false}  -> 200
  //     POST /users {username: 'lagos.staff', ...} -> 409 Username already exists
  // `users.username` is UNIQUE across the WHOLE table, and both deactivate and
  // delete are soft, so the username is held forever. An owner moving a cashier
  // from Lagos to Minna followed the instruction, hit a 409 with no explanation,
  // and was left inventing "lagos.staff.minna" — giving one human two identities
  // and splitting their record across both.
  //
  // Verified separately, and it is why the username MUST stay held: after a
  // delete the person's sales are still attributed by name ("Bisi Adewale"),
  // and the void-audit still names them. Releasing the username would let a
  // different human inherit that identity. The billing slot IS correctly freed.
  //
  // So the constraint is right and the ADVICE was wrong. These messages now
  // describe the path that actually works, and name the real trade-off.
  //
  // BUG 75 — THE REFUSAL WAS BOTH UNNECESSARY AND WRONGLY JUSTIFIED.
  //
  // These two branches used to answer 400 and tell the operator to
  // "deactivate this account and create a NEW one". Two things were wrong
  // with that, both established by execution rather than argument:
  //
  //   1. The instruction cannot be followed correctly. `users.username` is
  //      UNIQUE table-wide and removals are soft, so the old username is held
  //      forever; the operator ends up inventing a second identity for one
  //      human, and attendance/payroll (grouped by user_id) then counts them
  //      as two employees.
  //   2. The stated reason — that a move would corrupt history — is false.
  //      Every historical table carries its OWN branch_id. Forcing a user
  //      from Lagos to Minna and re-reading their earlier Lagos sale showed
  //      branch_id unchanged, served_by_name unchanged, trial balance still
  //      balanced. History is anchored per row, never derived from the user's
  //      current branch.
  //
  // So role and branch ARE changeable — but not HERE. A transfer carries
  // invariants a general "edit this user" call has no business enforcing (an
  // open till blocks it, an open shift must be closed at the old branch, the
  // last Owner cannot be demoted) and it must be recorded in
  // user_assignment_history with a reason. That is POST /users/:id/transfer.
  //
  // This route still refuses, deliberately: silently accepting role/branch
  // here would bypass every one of those invariants and leave no audit trail.
  // The refusal now names the action that actually works.
  if (body.role !== undefined && body.role !== existing.role) {
    return c.json({
      error: 'Use the Transfer & Promote action to change someone\'s role, so the change is recorded with a reason and the person keeps one account. '
        + 'Their existing sales, tills and shifts keep the authority they were made under — the transfer record is what shows when the change took effect.',
      code: 'USE_TRANSFER_ENDPOINT',
      transfer_endpoint: `/api/users/${id}/transfer`,
    }, 400);
  }
  if (body.branch_id !== undefined && body.branch_id !== existing.branch_id) {
    return c.json({
      error: 'Use the Transfer & Promote action to move someone to another branch, so the change is recorded with a reason and the person keeps one account. '
        + 'Their existing sales, tills and shifts stay with the branch where they happened.',
      code: 'USE_TRANSFER_ENDPOINT',
      transfer_endpoint: `/api/users/${id}/transfer`,
    }, 400);
  }

  // Combined MANAGER+OWNER lockout guard — see the write-up below
  if (LOCKOUT_GUARD_ROLES.includes(existing.role) && isExplicitFalse(is_active)) {
    const activeAdmins = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role IN ('MANAGER','OWNER') AND is_active = 1 AND is_deleted = 0`).first();
    if (activeAdmins.n <= 1) return c.json({ error: 'Cannot deactivate the last remaining active manager/owner account. Create or activate another manager or owner first.' }, 400);
  }
  // BUG 70: the combined count above is satisfied by a surviving MANAGER, which
  // is not a substitute for an OWNER. Guard the owner seat on its own terms.
  if (isExplicitFalse(is_active)) {
    const lastOwner = await wouldRemoveLastOwner(c.env.DB, existing);
    if (lastOwner) return c.json({ error: lastOwner, code: 'LAST_OWNER_PROTECTED' }, 400);
  }
  // A deactivated person frees a paid seat. Reinstating them must take one
  // again; otherwise a client could bypass a downgraded staff plan merely by
  // toggling inactive records back on instead of creating new accounts.
  const reactivating = !existing.is_active && (is_active === true || is_active === 1);
  if (reactivating) {
    try { await assertCanAddStaff(c.env.DB); }
    catch (e) {
      if (e instanceof PlanLimitError) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  }
  if (pin != null && String(pin).length < 4) return c.json({ error: 'PIN must be at least 4 characters.' }, 400);

  const sets = [];
  const vals = [];
  if (full_name !== undefined) { sets.push('full_name = ?'); vals.push(full_name); }
  if (phone !== undefined) { sets.push('phone = ?'); vals.push(phone); }
  if (job_title !== undefined) { sets.push('job_title = ?'); vals.push(job_title); }
  if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
  // BUG 49: stamp the credential change so authRequired() can refuse every
  // JWT minted before this moment. Without it a PIN reset changed the PIN
  // but left sessions opened with the OLD one fully alive.
  if (pin) {
    sets.push('pin_hash = ?'); vals.push(await hashPin(pin));
    // Epoch MILLISECONDS, not datetime('now'). SQLite's datetime() has
    // whole-second resolution, which forced a choice between two wrong
    // answers: `<=` revoked every token minted in the SAME second as the
    // reset — including the user's own immediate re-login with the NEW
    // PIN (reproduced: a fresh, valid token returned 401) — while `<` left
    // that same second open to the stale token the reset exists to kill.
    // Millisecond precision removes the ambiguity entirely, so a strict
    // `<` is both safe and correct.
    sets.push('credentials_changed_at = ?'); vals.push(String(Date.now()));
  }
  if (sets.length === 0) return c.json(existing);
  sets.push("updated_at = datetime('now')");

  // BUG 74 — a deactivated employee must not be left permanently on duty.
  //
  // Live-reproduced before this fix: deactivating a clocked-in cashier
  // returned a clean 200 with no warning, and their shift then had NO closing
  // path at all (clock-out 403s for anyone but them, and they can no longer
  // sign in). The record read "Still clocked in" indefinitely, and if the
  // account was ever reactivated they were permanently blocked from clocking
  // in again by idx_attendance_one_open_per_user.
  //
  // Closed in the SAME batch as the deactivation so the two cannot diverge:
  // an account that is off but still shows an open shift is precisely the
  // inconsistent state this guards against.
  const statements = [
    c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id),
  ];
  if (isExplicitFalse(is_active)) {
    statements.push(attendanceService.autoCloseShiftStatement(c.env.DB, {
      userId: id,
      actorId: requester.id,
      reason: 'Shift closed automatically because this account was deactivated.',
    }));
  }
  await withD1Retry(() => c.env.DB.batch(statements), 'user update');
  const updated = await c.env.DB.prepare('SELECT id, full_name, username, role, branch_id, job_title, is_active FROM users WHERE id = ?').bind(id).first();
  return c.json(updated ? { ...updated, role_label: roleLabel(updated) } : updated);
});

// TRANSFER & PROMOTE  (BUG 75).
//
// Moves a person between branches and/or between STAFF / Branch Manager /
// General Manager / Owner, keeping ONE account for one human.
//
// Authority is deliberately assembled from the SAME chokepoints that govern
// every other user mutation — branch scope, then rank — so a transfer can
// never become a way around rules that PUT /users/:id already enforces. The
// additions on top are the ones unique to a move, and they live in
// userTransferService: last-Owner protection, open-till blocking, and closing
// an open shift at the OLD branch.
users.post('/:id/transfer', managerOnly, async (c) => {
  const requester = c.get('user');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing || (existing.role === 'ADMIN' && requester.role !== 'ADMIN')) return c.json({ error: 'User not found' }, 404);

  const body = await readJsonBody(c);

  // Branch scope, checked against the branch they are LEAVING. A Branch
  // Manager may not reach into another branch to move somebody out of it.
  const pinnedActor = pinnedBranchIdOf(requester);
  if (pinnedActor && existing.branch_id !== pinnedActor) {
    return c.json({
      error: 'As a Branch Manager you can only transfer people who are currently assigned to your own branch.',
      code: 'BRANCH_SCOPE_VIOLATION',
    }, 403);
  }
  // ...and against the branch they are moving TO. Without this, a Branch
  // Manager could push an unwanted employee into a branch they have no
  // authority over — a move is a write at BOTH ends, which is exactly the
  // "audit the seams" lesson from the stock-transfer fencing work.
  if (pinnedActor && body.branch_id !== undefined && (body.branch_id || null) !== pinnedActor) {
    return c.json({
      error: 'As a Branch Manager you can only move people within your own branch. Ask the Owner or a General Manager to move someone to a different branch.',
      code: 'BRANCH_SCOPE_VIOLATION',
    }, 403);
  }

  // Self-promotion is never legitimate, even for an OWNER acting on their own
  // row: it is the one case where the person deciding and the person
  // benefiting are the same, exactly like Bug 71's self-override.
  if (requester.id === existing.id) {
    return c.json({
      error: 'You cannot change your own role or branch. Ask another Owner, or PharmaRidge support, to make this change.',
      code: 'SELF_TRANSFER_FORBIDDEN',
    }, 403);
  }

  // Rank guard — you may only act on an account strictly below your own.
  const forbidden = assertCanModifyUser(requester, existing);
  if (forbidden) return c.json({ error: forbidden, code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);

  // ...and you may not GRANT a role at or above your own. assertCanModifyUser
  // governs the account being changed; canAssignRole governs the authority
  // being handed out. Both are needed: without this, a MANAGER could promote
  // a STAFF member (whom they legitimately manage) straight to OWNER and then
  // sign in as them — the same lateral-takeover shape already closed on
  // account creation and PIN reset.
  if (body.role !== undefined && body.role !== existing.role && !canAssignRole(requester.role, body.role)) {
    return c.json({ error: 'You do not have permission to assign this role.', code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);
  }

  try {
    const result = await userTransferService.transferUser(c.env.DB, { existing, actor: requester, body });
    return c.json(result);
  } catch (e) {
    if (e instanceof userTransferService.TransferError) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// BUG 108 — staged transfers awaiting the staff member's own confirmation
// ---------------------------------------------------------------------------

// What is waiting for ME. Deliberately NOT manager-gated: the whole point is
// that the person being moved can see and answer it. Mounted before the
// `/:id/...` routes so "pending" is never read as a user id.
users.get('/transfers/pending/mine', async (c) => {
  const me = c.get('user');
  return c.json(await userTransferService.listPendingForUser(c.env.DB, me.id));
});

// Everything outstanding, for a manager chasing an unanswered request. A
// pinned Branch Manager sees only moves involving their own branch — the same
// scoping every other list on this screen already uses.
users.get('/transfers/pending', managerOnly, async (c) => {
  const me = c.get('user');
  const pinned = pinnedBranchIdOf(me);
  return c.json(await userTransferService.listAllPending(c.env.DB, { branchId: pinned || null }));
});

// I accept the move.
users.post('/transfers/pending/:pendingId/confirm', async (c) => {
  const me = c.get('user');
  try {
    return c.json(await userTransferService.confirmPending(c.env.DB, {
      pendingId: c.req.param('pendingId'), actor: me,
    }));
  } catch (e) {
    if (e instanceof userTransferService.TransferError) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
    throw e;
  }
});

// I cannot take it, and here is why.
users.post('/transfers/pending/:pendingId/decline', async (c) => {
  const me = c.get('user');
  const body = await readJsonBody(c);
  try {
    return c.json(await userTransferService.declinePending(c.env.DB, {
      pendingId: c.req.param('pendingId'), actor: me, reason: body.reason,
    }));
  } catch (e) {
    if (e instanceof userTransferService.TransferError) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
    throw e;
  }
});

// The manager withdraws their own request.
users.post('/transfers/pending/:pendingId/cancel', managerOnly, async (c) => {
  const me = c.get('user');
  try {
    return c.json(await userTransferService.cancelPending(c.env.DB, {
      pendingId: c.req.param('pendingId'), actor: me,
    }));
  } catch (e) {
    if (e instanceof userTransferService.TransferError) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
    throw e;
  }
});

// FORCE IT THROUGH — the escape hatch, and deliberately a narrow one.
//
// Confirmation-first must not become a new way to get permanently stuck: a
// person who has resigned, lost their phone or simply will not answer would
// otherwise leave the transfer unresolvable forever (the same class of
// dead-end as Bug 107). Restricted to an ORG-WIDE authority — an Owner or a
// General Manager, never a pinned Branch Manager — and recorded as FORCED, so
// "they agreed" and "it was imposed on them" are never confused later.
users.post('/transfers/pending/:pendingId/force', managerOnly, async (c) => {
  const me = c.get('user');
  const orgWide = me.role === 'OWNER' || (me.role === 'MANAGER' && !pinnedBranchIdOf(me));
  if (!orgWide) {
    return c.json({
      error: 'Only an Owner or a General Manager can force a transfer through without the staff member confirming it.',
      code: 'FORCE_REQUIRES_ORG_WIDE_AUTHORITY',
    }, 403);
  }
  try {
    return c.json(await userTransferService.confirmPending(c.env.DB, {
      pendingId: c.req.param('pendingId'), actor: me, forced: true,
    }));
  } catch (e) {
    if (e instanceof userTransferService.TransferError) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
    throw e;
  }
});

// The transfer/promotion history for one person — who moved them, when, from
// what to what, and why. Manager-gated exactly like the user list it belongs
// to, and branch-scoped the same way.
users.get('/:id/assignment-history', managerOnly, async (c) => {
  const requester = c.get('user');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, branch_id, role FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing || (existing.role === 'ADMIN' && requester.role !== 'ADMIN')) return c.json({ error: 'User not found' }, 404);
  const pinnedActor = pinnedBranchIdOf(requester);
  if (pinnedActor && existing.branch_id !== pinnedActor) {
    return c.json({ error: 'As a Branch Manager you can only view people assigned to your own branch.', code: 'BRANCH_SCOPE_VIOLATION' }, 403);
  }
  return c.json(await userTransferService.listAssignmentHistory(c.env.DB, id));
});

users.delete('/:id', managerOnly, async (c) => {
  const requester = c.get('user');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing || (existing.role === 'ADMIN' && requester.role !== 'ADMIN')) return c.json({ error: 'User not found' }, 404);


  // CROSS-BRANCH ACCOUNT TAKEOVER FOUND AND FIXED (live-reproduced): a
  // manager pinned to Minna reset the Lagos cashier's PIN to 9999 and
  // then logged in as them (verified: login returned 200). That is a
  // full account takeover across a branch boundary — every sale, void and
  // till action taken afterwards would be attributed to the Lagos
  // cashier. The same manager could also deactivate them, halting that
  // branch's trading.
  //
  // A pinned manager may only act on accounts belonging to their own
  // branch. Org-wide accounts (OWNER / org-wide MANAGER) are already out
  // of reach via the rank guard below, but are excluded here too so the
  // rule reads the same way in both directions.
  {
    const pinnedActor = pinnedBranchIdOf(requester);
    if (pinnedActor && existing.branch_id !== pinnedActor) {
      return c.json({
        error: 'You manage a single branch and can only change accounts assigned to that branch.',
        code: 'BRANCH_SCOPE_VIOLATION',
      }, 403);
    }
  }

  // Rank guard — deleting a higher-ranked account is the same
  // escalation/denial-of-service problem as editing one. Note this also
  // stops a MANAGER from deleting the OWNER outright, which the
  // lockout guard below would NOT have caught whenever a second
  // manager/owner existed.
  const forbiddenDelete = assertCanModifyUser(requester, existing);
  if (forbiddenDelete) return c.json({ error: forbiddenDelete, code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);

  if (LOCKOUT_GUARD_ROLES.includes(existing.role)) {
    const activeAdmins = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role IN ('MANAGER','OWNER') AND is_active = 1 AND is_deleted = 0`).first();
    if (activeAdmins.n <= 1) return c.json({ error: 'Cannot delete the last remaining active manager/owner account. Create or activate another manager or owner first.' }, 400);
  }
  // BUG 70: same gap, but permanent here — this sets is_deleted = 1.
  {
    const lastOwner = await wouldRemoveLastOwner(c.env.DB, existing);
    if (lastOwner) return c.json({ error: lastOwner, code: 'LAST_OWNER_PROTECTED' }, 400);
  }
  // BUG 74 — same rule as deactivation above, and more important here because
  // deletion is permanent: a deleted employee left "Still clocked in" can
  // never be resolved by anyone, since the account can no longer sign in and
  // no other route may clock them out.
  await withD1Retry(() => c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET is_deleted = 1, is_active = 0, updated_at = datetime('now') WHERE id = ?`).bind(id),
    attendanceService.autoCloseShiftStatement(c.env.DB, {
      userId: id,
      actorId: requester.id,
      reason: 'Shift closed automatically because this account was deleted.',
    }),
  ]), 'user delete');
  return c.body(null, 204);
});

// UNLOCK A BRUTE-FORCE LOCKOUT.
//
// The throttle in lib/loginThrottle.js locks an account for 15 minutes
// after 8 failed sign-ins. That is correct against an attacker and
// genuinely painful for a real shop: an owner who mistypes 8 times is
// locked out of their own pharmacy, potentially mid-queue with the till
// shut. Waiting it out is not an acceptable answer on a shop floor.
//
// Authority is EXACTLY the same rank rule as a PIN reset
// (assertCanModifyUser), so this grants no new power — anyone who can
// clear a lock could already reset that user's PIN outright. Manager
// unlocks staff; Owner unlocks managers; PharmaRidge Support unlocks
// the Owner. Self-unlock is meaningless (you cannot call an
// authenticated endpoint while locked out of signing in) but is
// harmless and left to the shared rule rather than special-cased.
users.post('/:id/unlock', managerOnly, async (c) => {
  const requester = c.get('user');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing || (existing.role === 'ADMIN' && requester.role !== 'ADMIN')) return c.json({ error: 'User not found' }, 404);

  // Branch scoping: a Branch Manager may only unlock their own branch's
  // staff, exactly as for every other user-management action.
  {
    const pinnedActor = pinnedBranchIdOf(requester);
    if (pinnedActor && existing.branch_id !== pinnedActor) {
      return c.json({
        error: 'As a Branch Manager you can only change accounts assigned to your own branch.',
        code: 'BRANCH_SCOPE_VIOLATION',
      }, 403);
    }
  }
  const forbidden = assertCanModifyUser(requester, existing);
  if (forbidden) return c.json({ error: forbidden, code: 'INSUFFICIENT_ROLE_AUTHORITY' }, 403);

  const cleared = await clearLoginLock(c.env.DB, existing.username);
  const state = await getLockState(c.env.DB, existing.username);
  return c.json({ ok: true, username: existing.username, cleared_attempts: cleared, ...state });
});

// DEFAULT-CREDENTIAL WARNING (client decision: warn loudly, do not block).
//
// The seed ships six demo accounts on PIN 1234 so an evaluator can try
// the system immediately. Every document says to change them; nothing
// enforced it, and a busy pharmacy going live is exactly the situation
// where that step gets skipped. Blocking was rejected deliberately — it
// would break demo/evaluation installs, which are how this product gets
// sold — so instead the risk is made impossible to miss for the people
// who can actually fix it.
//
// Verification is done by ACTUALLY TESTING the stored hash against the
// known default, not by guessing from metadata: PINs are PBKDF2 hashes
// with per-user salts, so there is no way to tell from the row alone.
// Manager-gated because it enumerates which accounts are weak.
users.get('/default-pin-warning', managerOnly, async (c) => {
  const requester = c.get('user');
  const pinned = pinnedBranchIdOf(requester);
  const adminClause = requester.role === 'ADMIN' ? '' : `AND role != 'ADMIN'`;
  const branchClause = pinned ? 'AND (branch_id = ? OR branch_id IS NULL)' : '';
  const params = pinned ? [pinned] : [];
  const { results } = await c.env.DB.prepare(`
    SELECT id, username, full_name, role, branch_id, pin_hash
    FROM users WHERE is_deleted = 0 AND is_active = 1 ${adminClause} ${branchClause}
    ORDER BY role, full_name LIMIT 200
  `).bind(...params).all();

  const offenders = [];
  for (const u of results) {
    // verifyPin is intentionally slow (PBKDF2). 200 rows is the hard cap
    // above; a real pharmacy has far fewer, and this endpoint is called
    // once per Users-screen render, not per request.
    if (await verifyPin(DEFAULT_DEMO_PIN, u.pin_hash)) {
      offenders.push({ id: u.id, username: u.username, full_name: u.full_name, role_label: roleLabel(u) });
    }
  }
  return c.json({ default_pin_accounts: offenders, count: offenders.length });
});

module.exports = users;
