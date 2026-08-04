const { Hono } = require('hono');
const { hashPin, verifyPin, signToken, uuid } = require('../lib/crypto');
const { assertLoginAllowed, recordLoginAttempt } = require('../lib/loginThrottle');
const { readJsonBody } = require('../lib/http');
const { authRequired, roleLabel } = require('../lib/auth');

const auth = new Hono();

auth.post('/login', async (c) => {
  const body = await readJsonBody(c);
  const { username, pin } = body;
  if (!username || !pin) return c.json({ error: 'username and pin are required' }, 400);

  // BRUTE-FORCE THROTTLE (see lib/loginThrottle.js for the live-
  // reproduced attack this closes: 60 wrong PINs in 1.15s with no
  // lockout, making a 4-digit keyspace exhaustible in ~3 minutes).
  // Checked BEFORE the password comparison so a locked account costs an
  // attacker a cheap 429 rather than a PBKDF2 verification.
  const ipAddress = c.req.header('CF-Connecting-IP') || null;
  const userAgent = c.req.header('User-Agent') || null;
  try {
    await assertLoginAllowed(c.env.DB, username);
  } catch (e) {
    if (e.code === 'TOO_MANY_LOGIN_ATTEMPTS') {
      c.header('Retry-After', String(e.retryAfterSeconds));
      return c.json({ error: e.message, code: e.code }, 429);
    }
    throw e;
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ? AND is_deleted = 0').bind(username).first();
  if (!user || !user.is_active) {
    // Recorded even for an unknown/inactive username: otherwise the
    // endpoint becomes a username oracle (unknown names never lock).
    await recordLoginAttempt(c.env.DB, { username, userId: user ? user.id : null, succeeded: false, ipAddress, userAgent });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPin(pin, user.pin_hash);
  if (!valid) {
    await recordLoginAttempt(c.env.DB, { username, userId: user.id, succeeded: false, ipAddress, userAgent });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  await recordLoginAttempt(c.env.DB, { username, userId: user.id, succeeded: true, ipAddress, userAgent });

  // One account owns one active device session. SQLite/D1's UPSERT is the
  // atomic handover: when the same person signs in elsewhere, the previous
  // session id is replaced and that previous device is rejected by
  // authRequired() on its next request.
  const sessionId = uuid();
  await c.env.DB.prepare(`
    INSERT INTO user_sessions (user_id, session_id, issued_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      session_id = excluded.session_id,
      issued_at = excluded.issued_at,
      updated_at = excluded.updated_at
  `).bind(user.id, sessionId).run();

  const token = await signToken({ id: user.id, username: user.username, role: user.role, branch_id: user.branch_id, full_name: user.full_name, sid: sessionId }, c.env.JWT_SECRET);
  const branch = user.branch_id ? await c.env.DB.prepare('SELECT id, name FROM branches WHERE id = ?').bind(user.branch_id).first() : null;

  return c.json({
    token,
    user: { id: user.id, full_name: user.full_name, username: user.username, role: user.role, branch_id: user.branch_id, job_title: user.job_title, role_label: roleLabel(user) },
    branch,
  });
});

// Explicit sign-out revokes the current server-side session immediately.
// The WHERE includes session_id so a stale device can never delete the newer
// device's session after that newer device has already taken over the account.
auth.post('/logout', authRequired, async (c) => {
  const user = c.get('user');
  const sessionId = c.get('sessionId');
  await c.env.DB.prepare(
    'DELETE FROM user_sessions WHERE user_id = ? AND session_id = ?'
  ).bind(user.id, sessionId).run();
  return c.json({ ok: true });
});

module.exports = auth;
