// Thin helpers around the D1 binding to keep route code readable.
// D1's API is async and batch-oriented (no interactive transactions —
// see the architectural note in migrations/0001 and salesService.js),
// so these wrap the common patterns: single-row fetch, list fetch, and
// atomic multi-statement batches.

function one(stmt) {
  return stmt.first();
}

function all(stmt) {
  return stmt.all().then((r) => r.results);
}

// Runs an array of already-prepared D1 statements as a single atomic
// batch — either all succeed or none do. This is the ONLY way D1
// offers multi-statement atomicity; there is no BEGIN/COMMIT available
// to application code.
//
// BUG 65 (second half) — THIS WAS A TRAP, NOT A CONVENIENCE.
//
// It had ZERO callers: every real batch site in the codebase (13 files)
// calls db.batch() directly, wrapped in withD1Retry(). But it sat in the
// "obvious helpers" module under an inviting name, so the natural thing for
// a future route to do — `const { runBatch } = require('../lib/db')` — would
// have silently opted that route OUT of transient-fault tolerance, which is
// exactly the gap that produced this bug in attendanceService.
//
// Rather than delete it (and lose the useful atomicity note above), it now
// carries the retry itself, so reaching for it is safe by default. Callers
// that need to inspect `meta.changes` for a compare-and-swap still get the
// raw batch result array back, unchanged.
async function runBatch(db, statements, label = 'batch') {
  const { withD1Retry } = require('./d1Retry');
  return withD1Retry(() => db.batch(statements), label);
}

module.exports = { one, all, runBatch };
