// Idempotency middleware for D1 — same contract as the original
// implementation in the original design: a client sends the same
// `Idempotency-Key` header on every retry of one logical mutation (e.g.
// one sale), and a repeat with that key replays the original response
// instead of re-running the handler. This is what makes it safe for the
// PWA's offline queue to retry a request that actually reached the server
// and succeeded, but whose response was lost.
async function idempotent(c, next) {
  const key = c.req.header('Idempotency-Key');
  if (!key) return next();

  const user = c.get('user');
  const bodyText = await c.req.raw.clone().text();
  // SECURITY/DATA-INTEGRITY: see the identical fix + full exploit writeup in
  // the original design — the hash previously covered only the body, so a
  // key reused across two different endpoints with the same body shape would
  // silently replay the WRONG endpoint's response.
  const requestHash = await sha256Hex(`${c.req.method} ${c.req.path}\n${bodyText || ''}`);

  const existing = await c.env.DB.prepare(
    'SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?'
  ).bind(key, user.id).first();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return c.json({ error: 'This Idempotency-Key was already used for a different request.' }, 409);
    }
    if (existing.status === 'COMPLETED') {
      c.header('Idempotent-Replay', 'true');
      return c.json(JSON.parse(existing.response_body), existing.response_status);
    }
    return c.json({ error: 'A request with this Idempotency-Key is already being processed. Please retry shortly.' }, 409);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO idempotency_keys (idempotency_key, user_id, method, path, request_hash, status) VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS')`
    ).bind(key, user.id, c.req.method, c.req.path, requestHash).run();
  } catch (e) {
    // Two near-simultaneous requests with the same brand-new key raced
    // to insert; whichever loses treats it as "already in progress".
    return c.json({ error: 'A request with this Idempotency-Key is already being processed. Please retry shortly.' }, 409);
  }

  // If the downstream handler throws outright, this middleware must not
  // leave the key stranded as IN_PROGRESS — that would 409-block every
  // retry of a sale until the 6-hourly cron happens to prune it. Release
  // the claim immediately so the very next retry can re-run cleanly.
  try {
    await next();
  } catch (err) {
    await c.env.DB.prepare(
      'DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?'
    ).bind(key, user.id).run().catch(() => {});
    throw err;
  }

  // Persist whatever the downstream handler produced, keyed for replay.
  const status = c.res.status;

  // BUG FOUND AND FIXED DURING THE PRE-LAUNCH AUDIT (reproduced against
  // a real Hono app + real SQLite):
  //
  // This previously cached EVERY response, including 5xx. A transient
  // server-side failure (a D1 blip, a hiccup mid-sale) was therefore
  // frozen into idempotency_keys as a COMPLETED 500, and because the
  // PWA's offline queue reuses the SAME Idempotency-Key on every retry
  // by design, all subsequent retries — including the staff-initiated
  // "Retry" button on the Sync Status screen — replayed that stored 500
  // instead of re-running the handler. The sale became permanently
  // unrecordable: a real, silent revenue loss, and precisely the
  // scenario idempotency is supposed to protect against.
  //
  // A 5xx is by definition NOT a definitive answer about whether the
  // business operation happened, so it must not be memoised. 4xx IS
  // definitive (validation failure, insufficient stock, plan limit) and
  // is still cached, so a client hammering a genuinely-bad request
  // doesn't re-run the handler each time. On a 5xx the claim row is
  // released instead, leaving the key free for a clean retry.
  if (status >= 500) {
    await c.env.DB.prepare(
      'DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?'
    ).bind(key, user.id).run().catch(() => {});
    return;
  }

  const responseBodyText = await c.res.clone().text();
  await c.env.DB.prepare(
    `UPDATE idempotency_keys SET response_status = ?, response_body = ?, status = 'COMPLETED' WHERE idempotency_key = ? AND user_id = ?`
  ).bind(status, responseBodyText, key, user.id).run();
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Best-effort housekeeping — call from a Cron Trigger (see wrangler.jsonc).
async function pruneIdempotencyKeys(db, olderThanDays = 14) {
  await db.prepare(`DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)`).bind(`-${olderThanDays} days`).run();
  await db.prepare(`DELETE FROM idempotency_keys WHERE status = 'IN_PROGRESS' AND created_at < datetime('now', '-2 minutes')`).run();
}

module.exports = { idempotent, pruneIdempotencyKeys };
