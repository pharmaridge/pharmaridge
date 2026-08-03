// CLOUDFLARE D1 / WORKERS FREE-TIER PLATFORM CEILINGS — single source of truth.
//
// WHY THIS FILE EXISTS (found during a production audit): the two hard
// platform ceilings below were being re-derived, re-commented and
// re-hardcoded independently in several places (routes/gl.js,
// services/stocktakeService.js's closeStocktake, services/syncService.js),
// and — precisely because there was no shared helper to reach for —
// three other code paths were simply MISSED and shipped unbounded. Each
// one was live-reproduced against the real route/service code with the
// documented limits enforced:
//
//   1. stocktakeService.startStocktake() — `WHERE id IN (...)` built
//      from the caller's `product_ids` array with NO chunking. Exact
//      breaking point measured: 100 product ids (99 ids + 1 branch id
//      = 100 bound params passes; 100 ids => 101 params => D1 rejects
//      the whole request with "too many SQL variables"). The Stocktake
//      screen's "Pick Individual Products" / "By Category" scoped-count
//      modal renders a checkbox per product with no selection cap, so
//      any pharmacy with 100+ products in one category could trigger it
//      from the UI with no warning.
//
//   2. POST /purchase-orders — one `SELECT ... FROM products` per line
//      item (an N+1 read). Measured: 60 items => 64 subrequests, over
//      the Free plan's 50 ceiling. For POM products a SECOND per-item
//      query (the branch licence lookup) fires, halving the threshold:
//      an all-POM order of just 30 items measured 64 subrequests.
//
//   3. POST /purchase-orders/:id/receive — one query per distinct
//      product. Measured: 50 distinct products => 55 subrequests.
//
// Both ceilings are HARD platform limits, not tunables: exceeding the
// bound-parameter limit fails the individual statement; exceeding the
// subrequest limit kills the whole Worker invocation with "Script
// exceeded resource limits". Neither is enforced by `wrangler dev
// --local`, which is exactly why all three survived local testing.
//
// Sources (verified against Cloudflare's published limits, not assumed):
//   https://developers.cloudflare.com/d1/platform/limits/
//   - Maximum bound parameters per query: 100
//   - Queries per Worker invocation: 50 (Free) / 1000 (Paid)
//   - Limits on individual queries apply to EACH statement inside a
//     db.batch(), but the batch itself costs ONE subrequest.

// D1's hard ceiling on bound parameters (`?`) in a single statement.
const D1_MAX_BOUND_PARAMS = 100;

// Workers Free plan: queries per Worker invocation (a db.batch() of any
// size counts as one). Paid is 1000; we design for Free because that is
// what this product actually deploys onto.
const WORKERS_FREE_MAX_SUBREQUESTS = 50;

// Safe chunk size for an `IN (...)` list when the same statement also
// carries a few non-array bound parameters (branch_id, a status, ...).
// Deliberately below D1_MAX_BOUND_PARAMS so callers do not have to
// reason about the extra params one at a time and get it wrong — which
// is exactly how bug (1) above happened (its query bound 1 extra param
// beyond the IN list, making the true safe size 99, not 100).
const SAFE_IN_CHUNK = 90;

/**
 * Split an array of ids into chunks that can each be safely interpolated
 * into a single `IN (...)` clause without exceeding D1's 100-bound-
 * parameter ceiling.
 *
 * @param {Array} ids           the id list (deduplicated by the caller if desired)
 * @param {number} otherParams  how many OTHER bound parameters the same
 *                              statement carries (e.g. a branch_id) — these
 *                              count against the same 100 limit.
 * @returns {Array<Array>} chunks, never containing an empty chunk.
 */
function chunkIds(ids, otherParams = 0) {
  const size = Math.max(1, Math.min(SAFE_IN_CHUNK, D1_MAX_BOUND_PARAMS - otherParams));
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Enforce a hard array-size cap on a request body's array field, with an
 * actionable, staff-readable message telling the caller exactly how to
 * split the work. Mirrors syncService's PUSH_BATCH_TOO_LARGE contract so
 * every oversized-collection refusal in the API looks the same to a
 * client: HTTP 413 + a machine-readable `code` + a `max`/`received`
 * pair the UI can use to chunk automatically.
 *
 * Returns an Error to throw (with .status/.code), or null when within
 * the cap.
 */
function assertArrayWithinCap(arr, { max, code, label, guidance }) {
  const n = Array.isArray(arr) ? arr.length : 0;
  if (n <= max) return null;
  return Object.assign(
    new Error(
      `Too many ${label} in one request (${n}); the limit is ${max}. ` +
      (guidance || `Split this into batches of ${max} or fewer and submit them one at a time.`)
    ),
    { status: 413, code, max, received: n }
  );
}

module.exports = {
  D1_MAX_BOUND_PARAMS,
  WORKERS_FREE_MAX_SUBREQUESTS,
  SAFE_IN_CHUNK,
  chunkIds,
  assertArrayWithinCap,
};
