// LOGIN BRUTE-FORCE THROTTLE + AUTHENTICATION AUDIT TRAIL.
//
// FOUND AND FIXED DURING A PRODUCTION AUDIT. Reproduced live against
// real workerd + D1: 60 consecutive wrong PINs against the `owner`
// account all returned a plain 401 in 1,150ms total (19ms each), with no
// lockout, no throttle, and no record that it happened. The correct PIN
// worked immediately afterwards.
//
// This product authenticates with SHORT NUMERIC PINs — 4 characters
// minimum, and 4 digits is the norm on a shared pharmacy terminal where
// staff type them dozens of times a shift in front of customers. That is
// a 10,000-value keyspace: ~190 seconds to exhaust at the measured rate,
// and trivially parallelisable. Usernames are not secret either (the
// Users screen lists them; the login screen advertises the demo
// accounts). So anyone who could reach the login page could take over a
// live pharmacy's OWNER account in about three minutes, silently.
//
// DESIGN DECISIONS, each deliberate:
//
//   * THROTTLE ON USERNAME, NOT IP. A Nigerian pharmacy's staff commonly
//     share one mobile hotspot, and carrier-grade NAT is widespread, so
//     IP-based lockout would lock out the whole shop because one cashier
//     fat-fingered a PIN. Username scoping targets the account actually
//     under attack. The IP is still RECORDED for the audit trail.
//
//   * THROTTLE UNKNOWN USERNAMES IDENTICALLY. If a nonexistent username
//     answered instantly forever while a real one locked out, the
//     endpoint becomes a username oracle. Attempts are recorded and
//     counted before we know whether the account exists.
//
//   * TEMPORARY LOCKOUT, NEVER PERMANENT. A permanent lock is a denial
//     of service an attacker can trigger deliberately: guess wrong at
//     the owner ten times and the pharmacy cannot open its till. The
//     lock expires on its own, and the response says exactly when.
//
//   * A SUCCESSFUL LOGIN CLEARS THE COUNTER. Otherwise a cashier who
//     mistypes twice a day accumulates failures across a whole week and
//     is eventually locked out for no reason.
//
//   * FAIL OPEN, NOT CLOSED. If the throttle's own bookkeeping query
//     throws (a D1 blip, or login_attempts missing because the schema has not
//     been applied yet), authentication proceeds normally. A pharmacy
//     being unable to sell because the *rate limiter* is broken is a
//     worse, and far more likely, outcome than the brute-force attack
//     this defends against. Every such failure is logged to the console
//     so it surfaces in `wrangler tail`.

// Fail this many times within the window and the account locks.
// 8 is comfortably above real-world mistyping (a cashier who gets it
// wrong 8 times running has forgotten the PIN and needs a manager
// anyway) and far below what makes a 10,000-value keyspace searchable.
const MAX_FAILED_ATTEMPTS = 8;

// How far back we count failures, and how long a lock lasts. Both 15
// minutes: with 8 attempts per 15 minutes, exhausting a 4-digit PIN
// would take over a month of uninterrupted attacking instead of three
// minutes.
const WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

class LoginLockedError extends Error {
  constructor(retryAfterSeconds) {
    const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      `Too many failed sign-in attempts for this account. For security it has been temporarily locked. `
      + `Please try again in about ${mins} minute${mins === 1 ? '' : 's'}, or ask a manager to reset your PIN.`
    );
    this.status = 429;
    this.code = 'TOO_MANY_LOGIN_ATTEMPTS';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Throws LoginLockedError when `username` currently has too many recent
 * failures. Call BEFORE verifying the PIN.
 *
 * Fails open: any internal error allows the login to proceed.
 */
async function assertLoginAllowed(db, username) {
  if (!username) return;
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
      FROM login_attempts
      WHERE username = ?
        AND succeeded = 0
        AND attempted_at > datetime('now', ?)
    `).bind(username, `-${WINDOW_MINUTES} minutes`).first();

    if (!row || row.failures < MAX_FAILED_ATTEMPTS) return;

    // Lock runs from the most recent failure, so continuing to hammer
    // the endpoint keeps extending it rather than letting an attacker
    // wait out a fixed window while still guessing.
    const unlockAt = await db.prepare(
      `SELECT datetime(?, ?) AS unlock_at, datetime('now') AS now_at`
    ).bind(row.last_failure, `+${LOCKOUT_MINUTES} minutes`).first();

    const remainingSeconds = Math.max(
      1,
      Math.round((Date.parse(unlockAt.unlock_at + 'Z') - Date.parse(unlockAt.now_at + 'Z')) / 1000)
    );
    if (remainingSeconds <= 0) return;
    throw new LoginLockedError(remainingSeconds);
  } catch (e) {
    if (e instanceof LoginLockedError) throw e;
    // FAIL OPEN — see the header comment.
    console.error('[loginThrottle] check failed, allowing login:', e && e.message);
  }
}

/**
 * Records one authentication attempt. Never throws — an audit-trail
 * failure must not break a legitimate sign-in.
 */
async function recordLoginAttempt(db, { username, userId, succeeded, ipAddress, userAgent }) {
  try {
    await db.prepare(`
      INSERT INTO login_attempts (username, user_id, succeeded, ip_address, user_agent)
      VALUES (?,?,?,?,?)
    `).bind(
      String(username || '').slice(0, 120),
      userId || null,
      succeeded ? 1 : 0,
      ipAddress ? String(ipAddress).slice(0, 60) : null,
      userAgent ? String(userAgent).slice(0, 200) : null
    ).run();

    // A successful sign-in clears the slate, so ordinary mistyping never
    // accumulates into a lockout days later.
    if (succeeded) {
      await db.prepare('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0')
        .bind(username).run();
    }
  } catch (e) {
    console.error('[loginThrottle] could not record attempt:', e && e.message);
  }
}

/**
 * Clears the failed-attempt counter for a username, unlocking it
 * immediately. Called by a HIGHER-RANKED account from the Users screen.
 *
 * OPERATIONAL NECESSITY, not a convenience: the lock is deliberately
 * username-scoped and time-based, which means a legitimate owner who
 * mistypes 8 times is locked out of their own pharmacy for 15 minutes —
 * potentially mid-queue, unable to open the till. Waiting it out is not
 * an acceptable answer for a shop floor, so someone who outranks the
 * locked user can clear it instantly. Authority mirrors PIN-reset
 * exactly (assertCanModifyUser in routes/users.js), so this grants no
 * new power: anyone who can clear a lock could already reset that
 * user's PIN outright.
 *
 * The audit trail is NOT deleted — only the failure rows that feed the
 * throttle. Successful logins and the fact that an unlock happened
 * remain visible.
 */
async function clearLoginLock(db, username) {
  const result = await db.prepare('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0')
    .bind(username).run();
  return (result && result.meta && result.meta.changes) || 0;
}

/**
 * Current lock state for a username — used to show a manager WHICH
 * accounts are locked, so they do not have to wait for a phone call
 * from a cashier who cannot sign in.
 */
async function getLockState(db, username) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
    FROM login_attempts
    WHERE username = ? AND succeeded = 0 AND attempted_at > datetime('now', ?)
  `).bind(username, `-${WINDOW_MINUTES} minutes`).first();
  const failures = (row && row.failures) || 0;
  return {
    failed_attempts: failures,
    is_locked: failures >= MAX_FAILED_ATTEMPTS,
    last_failed_at: (row && row.last_failure) || null,
  };
}

module.exports = {
  assertLoginAllowed,
  recordLoginAttempt,
  clearLoginLock,
  getLockState,
  LoginLockedError,
  MAX_FAILED_ATTEMPTS,
  WINDOW_MINUTES,
  LOCKOUT_MINUTES,
};
