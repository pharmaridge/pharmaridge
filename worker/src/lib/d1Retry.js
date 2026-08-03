// TRANSIENT D1 FAULT TOLERANCE.
//
// FOUND DURING A LONG-TERM PRODUCTION-FITNESS AUDIT. Cloudflare's own
// documentation lists a family of D1 errors as expected operational
// noise rather than bugs, and explicitly recommends retrying them:
//
//   "D1 DB reset because its code was updated."            -> Retry the operation
//   "Internal error while starting up D1 DB storage..."     -> Retry the operation
//   "Network connection lost."                              -> Retry the operation
//   "Internal error in D1 DB storage caused object to be reset." -> Retry
//   "Cannot resolve D1 DB due to transient issue on remote node." -> Retry
//   — https://developers.cloudflare.com/d1/observability/debug-d1/
//
// And from the Cloudflare docs issue tracker, on real-world frequency:
//   "errors are 'not unexpected' ... a handful of errors every several
//    hours is not unexpected ... focus on building idempotency into your
//    apps if they scale with D1"
//
// WHY THIS MATTERED HERE (reproduced by executing the real offline
// queue): a transient blip surfaces through app.onError as a bare 500.
// The PWA's Offline.flush() treats any numeric .status as "the server
// gave a definitive answer" and moves the request into the
// permanently-failed queue. Three genuine offline sales were quarantined
// by a fault Cloudflare describes as routine — recoverable only if a
// human notices the banner and clicks Retry on each one.
//
// Two independent fixes were applied. This module is the FIRST: absorb
// the blip server-side so it never becomes a 500 at all. The second is
// in public/js/offline.js, which no longer quarantines a 5xx.
//
// SAFETY — why retrying a WRITE here cannot double-charge anyone:
//   * Every money-mutating route is already behind the Idempotency-Key
//     middleware, and a 5xx explicitly RELEASES the idempotency claim
//     (see lib/idempotency.js) so a retry re-runs rather than replaying.
//   * D1's db.batch() is atomic: a batch that fails transiently has
//     committed NOTHING, so re-running it cannot apply anything twice.
//   * Only errors matching the documented transient list are retried.
//     A CHECK/UNIQUE/FOREIGN KEY violation, an INSUFFICIENT_STOCK guard,
//     or any application error is re-thrown immediately and untouched.

// Matched against the error message. Deliberately narrow: anything not on
// Cloudflare's own "retry the operation" list is treated as a real,
// permanent failure and surfaces unchanged.
const TRANSIENT_PATTERNS = [
  /network connection lost/i,
  /storage caused object to be reset/i,
  /caused object to be reset/i,
  /reset because its code was updated/i,
  /error while starting up d1 db storage/i,
  /cannot resolve d1 db/i,
  /transient issue on remote node/i,
  /d1 db is overloaded/i,
  /requests queued for too long/i,
  /too many requests queued/i,
];

// Two retries (three attempts total). Enough to ride out a Durable Object
// restart, while staying far inside a Worker's wall-clock budget and the
// cashier's patience — a sale that cannot commit in three attempts is a
// real outage, and saying so is better than hanging the till.
const MAX_ATTEMPTS = 3;

// Short, escalating backoff. These are measured against a Durable Object
// restarting, not a rate limit, so hundreds of milliseconds is the right
// scale; seconds would just stall the POS.
const BACKOFF_MS = [50, 200];

function isTransientD1Error(err) {
  const msg = String((err && err.message) || err || '');
  if (!msg) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

/**
 * Runs `fn`, retrying only on Cloudflare's documented transient D1 faults.
 *
 * `fn` MUST be idempotent-safe to re-run. In this codebase that holds
 * because every caller wraps a single atomic db.batch() (all-or-nothing)
 * or a single statement — see the safety note in the header.
 *
 * @param {Function} fn        async operation to run
 * @param {string}   label     short description, used only for logging
 */
async function withD1Retry(fn, label = 'd1 operation') {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientD1Error(err) || attempt === MAX_ATTEMPTS) throw err;
      // Surfaced in `wrangler tail` so a real infrastructure problem is
      // visible rather than silently absorbed. If these appear constantly
      // rather than occasionally, that is a signal worth acting on.
      console.warn(`[d1Retry] transient failure on ${label} (attempt ${attempt}/${MAX_ATTEMPTS}): ${err && err.message}`);
      const delay = BACKOFF_MS[attempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

module.exports = { withD1Retry, isTransientD1Error, MAX_ATTEMPTS, TRANSIENT_PATTERNS };
