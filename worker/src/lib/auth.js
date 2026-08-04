// Auth middleware for Hono, mirroring the original implementation in the
// original design (same JWT-per-request re-validation policy: a token's
// claims are never trusted on their own — the live user row is always
// re-fetched so a deactivated account or role/branch change takes effect
// immediately, not just on next login/token-expiry).
const { verifyToken, signToken } = require('./crypto');

async function authRequired(c, next) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'Missing auth token' }, 401);

  let payload;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch (e) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const liveUser = await c.env.DB.prepare(
    'SELECT id, branch_id, full_name, username, role, is_active, credentials_changed_at FROM users WHERE id = ? AND is_deleted = 0'
  ).bind(payload.id).first();

  if (!liveUser) return c.json({ error: 'Account no longer exists' }, 401);
  if (!liveUser.is_active) return c.json({ error: 'Account has been deactivated' }, 401);

  // ONE ACTIVE DEVICE / SESSION PER ACCOUNT.
  //
  // A username and PIN identify a PERSON, not a device pool. Allowing two
  // browsers to stay active under that one identity means one cashier can sell
  // while another voids or closes a till and every audit row names the same
  // person. user_sessions carries the one current random session id; a fresh
  // login replaces it atomically and the displaced device is rejected on its
  // next request. Tokens from before this migration deliberately have no sid
  // and are refused, forcing a clean sign-in rather than silently preserving
  // the old multi-device behaviour.
  if (!payload.sid || typeof payload.sid !== 'string') {
    return c.json({
      error: 'Your session needs to be refreshed. Please sign in again.',
      code: 'SESSION_REFRESH_REQUIRED',
    }, 401);
  }
  const activeSession = await c.env.DB.prepare(
    'SELECT session_id FROM user_sessions WHERE user_id = ?'
  ).bind(liveUser.id).first();
  if (!activeSession || activeSession.session_id !== payload.sid) {
    return c.json({
      error: 'This account was signed in on another device. Please sign in again to continue.',
      code: 'SESSION_REPLACED',
    }, 401);
  }

  // BUG 49 — a PIN reset must kill sessions opened with the OLD PIN.
  //
  // Live-reproduced: after a manager reset a cashier's PIN, the old PIN
  // returned 401 but the old TOKEN still returned 200. A PIN reset is the
  // emergency lever a pharmacy pulls when a PIN is compromised — whoever
  // held the live session could keep selling, voiding and taking cash for
  // the rest of the day, which is precisely what the reset was meant to
  // stop. Deactivation and deletion already revoked instantly (verified);
  // credential rotation was the one gap.
  //
  // `iat` is the second the token was minted. Any token minted at or
  // before the credential change is refused. The <= comparison is
  // deliberate: SQLite stores datetime('now') at whole-second resolution,
  // so a token minted in the SAME second as the reset must be treated as
  // pre-reset rather than trusted.
  if (liveUser.credentials_changed_at && typeof payload.iat === 'number') {
    // Stored as epoch MILLISECONDS (see routes/users.js).
    //
    // Prefer the token's millisecond mint time (`imt`, added by
    // signToken). `iat` is whole seconds, so a stale token minted at
    // N.000 and a fresh one minted at N.950 are IDENTICAL by iat —
    // second-resolution comparison must therefore either let the
    // compromised session live or reject the user's own re-login. `imt`
    // removes that ambiguity.
    //
    // A token predating this fix has no `imt`; it falls back to iat and is
    // compared at the END of its second (+999), which errs toward keeping
    // a session alive rather than logging out a legitimate cashier
    // mid-sale. Those tokens all expire within 12 hours anyway.
    const changedAtMs = Number(liveUser.credentials_changed_at);
    const mintedMs = typeof payload.imt === 'number' ? payload.imt : (payload.iat * 1000 + 999);
    if (Number.isFinite(changedAtMs) && mintedMs < changedAtMs) {
      return c.json({
        error: 'Your PIN was changed. Please sign in again with your new PIN.',
        code: 'CREDENTIALS_CHANGED',
      }, 401);
    }
  }

  c.set('user', {
    id: liveUser.id,
    username: liveUser.username,
    role: liveUser.role,
    branch_id: liveUser.branch_id,
    full_name: liveUser.full_name,
  });
  c.set('sessionId', payload.sid);

  // SLIDING SESSION (client decision, after a live audit demonstration).
  //
  // The JWT is a hard 12-hour expiry with no renewal — verified: a
  // correctly-signed token one hour past expiry is rejected outright,
  // with no grace period. A pharmacy trading 08:00–21:00 that signs in
  // at opening is therefore logged out at 20:00, DURING trade, and a
  // 24-hour pharmacy loses its session mid-shift every single day. The
  // in-progress POS cart is lost with it.
  //
  // Fix: once a token is past the halfway point of its life, quietly
  // issue a fresh one on the next authenticated request and hand it back
  // in a response header. The client swaps it in silently. An actively
  // used terminal therefore never expires mid-shift, while an idle or
  // stolen device still dies 12 hours after its LAST use — the security
  // property that matters is preserved.
  //
  // Revocation is unaffected: authRequired re-reads the live user row on
  // every single request (see above), so a deactivated account, role
  // change or branch change still takes effect immediately regardless of
  // what any outstanding token claims.
  //
  // Deliberately a HEADER, not a body field: it must work for every
  // endpoint — including 204s and file/CSV responses — without changing
  // a single response shape, and without any route knowing about it.
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const issuedAt = typeof payload.iat === 'number' ? payload.iat : null;
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : null;
    if (issuedAt && expiresAt) {
      const halfLife = issuedAt + Math.floor((expiresAt - issuedAt) / 2);
      if (nowSeconds >= halfLife) {
        const renewed = await signToken({
          id: liveUser.id,
          username: liveUser.username,
          role: liveUser.role,
          branch_id: liveUser.branch_id,
          full_name: liveUser.full_name,
          sid: payload.sid,
        }, c.env.JWT_SECRET);
        c.header('X-Renewed-Token', renewed);
        // Browsers cannot read a custom header on a cross-origin response
        // unless it is explicitly exposed. Same-origin deployments do not
        // need this, but the Pages+Worker split documented in
        // DEPLOYMENT-CLOUDFLARE.md is cross-origin, so without this the
        // renewal would silently never reach the client on exactly the
        // topology the deploy guide recommends.
        c.header('Access-Control-Expose-Headers', 'X-Renewed-Token');
      }
    }
  } catch (e) {
    // A renewal failure must NEVER break an otherwise valid request —
    // the caller simply keeps their existing, still-valid token.
    console.error('[auth] token renewal failed:', e && e.message);
  }

  await next();
}

async function managerOnly(c, next) {
  const user = c.get('user');
  // MANAGER, OWNER, and ADMIN all pass this gate — see the rationale
  // below.
  if (!['MANAGER', 'OWNER', 'ADMIN'].includes(user.role)) {
    return c.json({ error: 'Manager access required' }, 403);
  }
  await next();
}

// Strictly the vendor's own seat — used only for /api/admin/*. See the
// original implementation's adminOnly for the full rationale (mirrored
// here).
async function adminOnly(c, next) {
  const user = c.get('user');
  if (user.role !== 'ADMIN') return c.json({ error: 'Admin Portal access required' }, 403);
  await next();
}

// The pharmacy's own proprietor seat, PLUS the vendor's ADMIN seat — see
// the write-up below's ownerOnly for the full rationale (mirrored here).
async function ownerOnly(c, next) {
  const user = c.get('user');
  if (!['OWNER', 'ADMIN'].includes(user.role)) return c.json({ error: 'Only the account owner (or PharmaRidge support) can change this setting.' }, 403);
  await next();
}

// BRANCH-SCOPED MANAGERS (migration 0003, client decision after a live
// audit demonstration that any MANAGER could read any branch's money —
// verified: stock_value_at_retail = 275,000 at a branch the manager was
// never assigned to).
//
// A user is "branch-pinned" when their own row carries a branch_id:
//   STAFF                      -> always pinned (schema-enforced)
//   MANAGER with branch_id     -> pinned to that branch (NEW)
//   MANAGER with NULL branch   -> org-wide (unchanged default)
//   OWNER / ADMIN              -> always org-wide (schema-enforced)
//
// Centralising the test here means every route that already called
// resolveScopedBranchId()/assertBranchAccess() — the two chokepoints the
// whole codebase routes branch authorisation through — picks up the new
// rule without touching 24 route files, and no route can accidentally
// opt out.
function pinnedBranchIdOf(user) {
  if (!user) return null;
  if (user.role === 'OWNER' || user.role === 'ADMIN') return null;
  return user.branch_id || null;
}

// HUMAN-READABLE ROLE LABELS (client naming decision).
//
// The client asked for two distinct manager titles:
//   "General Manager" -> org-wide manager  (branch_id IS NULL)
//   "Branch Manager"  -> pinned to one branch (branch_id SET)
//
// DELIBERATELY DERIVED, NOT STORED. The stored `role` stays 'MANAGER'
// and the distinction continues to come from branch_id alone, because:
//
//   * branch_id is ALREADY the single source of truth — every
//     authorisation decision in this codebase routes through
//     pinnedBranchIdOf(). Introducing a second column (or a second role
//     value) that also encodes "is this manager scoped?" would create
//     two facts that can silently disagree, and the security-relevant
//     one is branch_id. A GENERAL_MANAGER row carrying a branch_id, or a
//     BRANCH_MANAGER row without one, would be unrepresentable nonsense
//     the schema would then have to police.
//   * Promoting a Branch Manager to General Manager becomes a one-field
//     change (clear branch_id) rather than a role migration.
//   * It avoids a THIRD rebuild of the `users` table (30 tables carry
//     REFERENCES users(id); migration 0003 already did this once and it
//     is the highest-risk migration in the repo), and avoids
//     invalidating every JWT already issued with role='MANAGER'.
//
// Every surface that shows a role to a human must use this helper so the
// wording can never drift between screens, exports and the API.
const ROLE_LABELS = {
  ADMIN: 'PharmaRidge Support',
  OWNER: 'Owner',
  STAFF: 'Staff',
};

function roleLabel(user) {
  if (!user || !user.role) return '';
  if (user.role === 'MANAGER') {
    return user.branch_id ? 'Branch Manager' : 'General Manager';
  }
  return ROLE_LABELS[user.role] || user.role;
}

// Resolves the effective branch_id a request should be scoped to:
//  - Anyone PINNED to a branch (STAFF, or a branch-scoped MANAGER) is
//    always forced to their own branch_id, regardless of query params.
//  - An org-wide MANAGER/OWNER/ADMIN may pass ?branch_id=... to drill
//    into one branch, or omit it for an org-wide view (null).
function resolveScopedBranchId(c) {
  const user = c.get('user');
  const pinned = pinnedBranchIdOf(user);
  if (pinned) return pinned;
  return c.req.query('branch_id') || null;
}

// Authorizes access to a SPECIFIC resource that already belongs to a known
// branch — see the write-up below's assertBranchAccess for the full
// rationale (mirrored here, including the real cross-branch authorization
// bug this closes on both backends). resourceBranchId of null/undefined (a
// shared/org-wide record) is open to any authenticated user.
class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
  }
}
function assertBranchAccess(c, resourceBranchId) {
  const user = c.get('user');
  // Now covers branch-scoped MANAGERs too, not just STAFF.
  const pinned = pinnedBranchIdOf(user);
  if (!pinned) return;
  if (resourceBranchId == null) return;
  if (resourceBranchId === pinned) return;
  throw new ForbiddenError('You do not have access to this branch\'s records.');
}

// COMPLIANCE/OPERATIONAL-INTEGRITY — see the identical fix + full
// scoping-decision writeup in the original design for the full rationale:
// branches.is_active was settable via PUT /api/branches/:id but never
// enforced anywhere on either backend — a "deactivated" branch's own staff
// could still clock in, open a till, receive purchase orders, sell, and
// transfer stock completely normally. Blocks every NEW branch-scoped
// mutating action; historical data stays fully readable forever.
class FeatureDisabledLikeError extends Error {
  constructor(message, code) {
    super(message);
    this.status = 403;
    this.code = code;
  }
}
async function assertBranchActive(db, branchId, actionLabel) {
  if (!branchId) return;
  const branch = await db.prepare('SELECT is_active FROM branches WHERE id = ? AND is_deleted = 0').bind(branchId).first();
  if (!branch) return; // a nonexistent branch_id is a different validation error, already handled by each route's own FK/lookup logic
  if (!branch.is_active) {
    throw new FeatureDisabledLikeError(
      `This branch has been deactivated (closed) and can no longer ${actionLabel || 'record new activity'}. Historical data remains viewable, but no new activity can be recorded here until a manager reactivates it.`,
      'BRANCH_INACTIVE'
    );
  }
}

// THE VENDOR SEAT IS NOT A PHARMACY EMPLOYEE.
//
// BUG FOUND AND FIXED DURING A PRODUCTION AUDIT (reproduced live against
// real workerd + D1, then confirmed in the database and in the client's
// own reports): `managerOnly` deliberately admits ADMIN so PharmaRidge
// support can administer a client's deployment. But several routes are
// not administration at all — they are PERSONAL, EMPLOYEE-SCOPED acts
// that write the actor into the pharmacy's operational records:
//
//   POST /api/attendance/clock-in   -> wrote a `staff_attendance` row for
//                                      the vendor. "PharmaRidge Support"
//                                      then appeared in the manager's own
//                                      staff attendance register,
//                                      alongside real employees.
//   POST /api/till/open             -> opened a real cash till owned by
//                                      the vendor. The till list showed
//                                      "opened_by: PharmaRidge Support"
//                                      with ₦1,000 of the client's money
//                                      attributed to a non-employee.
//
// Both were verified live (201 Created, rows present in staff_attendance
// and till_sessions, both visible to the client's MANAGER).
//
// Why this matters commercially: staff_attendance is the payroll and
// labour-compliance record — a PCN inspector or a wage dispute reads it
// as "who was on duty". till_sessions is the cash-accountability chain;
// an open till in a non-employee's name breaks shift reconciliation and
// leaves a shortage with nobody accountable. Neither record can be
// explained to a client, and neither is something vendor support should
// ever be able to create by accident.
//
// This is the same principle the codebase ALREADY applies to billing:
// lib/planLimits.js's activeStaffCount() counts only
// ('STAFF','MANAGER','OWNER') precisely because the ADMIN seat is not a
// pharmacy employee and must not consume a client's paid staff slot.
// This guard extends that established rule from billing to payroll and
// cash custody.
//
// NOTE this deliberately does NOT restrict ADMIN's supervisory reach:
// ADMIN can still READ attendance and till history, still perform
// manager overrides, close/force-close tills, register devices, and run
// every report — all of which are genuine support actions. Only the two
// acts of *becoming* an employee are refused.
function assertNotVendorSeat(user, actionLabel) {
  if (user.role !== 'ADMIN') return null;
  return Object.assign(
    new Error(
      `The PharmaRidge Support (Admin Portal) account is not a member of this pharmacy's staff and cannot ${actionLabel}. ` +
      'Use a MANAGER, OWNER, or STAFF account for this action — support access remains available for every administrative and reporting function.'
    ),
    { status: 403, code: 'VENDOR_SEAT_NOT_AN_EMPLOYEE' }
  );
}

// Resolves the branch a MUTATION should be written to.
//
// Replaces the `user.role === 'STAFF' ? user.branch_id : body.branch_id`
// idiom that was repeated verbatim in 19 route handlers. That idiom
// silently gave a branch-scoped MANAGER the ability to WRITE into any
// branch by putting a different branch_id in the request body, because
// it only ever pinned STAFF. Routing every mutation through one helper
// makes the rule impossible to forget and impossible to bypass.
//
// A pinned user's own branch always wins; the body value is ignored
// rather than rejected, exactly matching how STAFF has always behaved.
function resolveMutationBranchId(c, bodyBranchId) {
  const user = c.get('user');
  const pinned = pinnedBranchIdOf(user);
  if (pinned) return pinned;
  return bodyBranchId || null;
}

module.exports = { roleLabel, ROLE_LABELS, authRequired, managerOnly, adminOnly, ownerOnly, resolveScopedBranchId, resolveMutationBranchId, pinnedBranchIdOf, assertBranchAccess, assertBranchActive, assertNotVendorSeat, ForbiddenError };
