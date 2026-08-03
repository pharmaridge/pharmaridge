// Periodic housekeeping for D1 tables that grow unboundedly over the
// lifetime of a production deployment. Called from the Cron Trigger
// handler in worker/src/index.js, alongside the existing idempotency-key
// pruning.
//
// PARITY GAP FOUND AND FIXED (real, previously-undetected backend-parity
// gap found during this audit pass): the original design has pruned
// sync_change_log (retaining 90 days) as part of its periodic housekeeping
// since this feature was first added, but the Worker's Cron Trigger
// handler only ever pruned idempotency_keys — nothing on this deployment
// ever pruned sync_change_log at all. Every heartbeat, push, and pull for
// every branch permanently inserts a new sync_change_log row (see
// worker/src/routes/sync.js / worker/src/services/syncService.js), so on a
// real production D1 database running for months, this table would grow
// completely unboundedly, which a production deployment cannot tolerate — a genuine "one
// backend behind the other" gap, not merely a cosmetic difference, since
// D1 databases have a hard 500MB (Free) / 10GB (Paid) size ceiling
// (verified via web_search against Cloudflare's own documentation) that an
// ever-growing technical log table would eventually contribute to
// exhausting, for zero long-term audit value once entries are more than a
// few months old.
async function pruneSyncChangeLog(db, retainDays = 90) {
  await db.prepare(`DELETE FROM sync_change_log WHERE synced_at < datetime('now', ?)`).bind(`-${retainDays} days`).run();
}

// Authentication audit trail (login_attempts, created in 0001). Kept for 90 days, the
// same retention as sync_change_log: long enough that a proprietor
// investigating "who has been trying to get into my account?" has real
// history, short enough that a login endpoint under sustained attack
// cannot fill a 500MB free-tier D1 database. The throttle itself only
// ever looks back 15 minutes, so pruning can never weaken it.
async function pruneLoginAttempts(db, retainDays = 90) {
  await db.prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', ?)`).bind(`-${retainDays} days`).run();
}

// BUG 47 (second half). sync_conflicts grows one row per overwrite whenever
// two devices edit the same customer — trading activity, not setup — and
// NOTHING pruned it. `POST /sync/conflicts/:id/review` only stamps
// reviewed_at: it hides the row from the manager's list, it does not delete
// it. Live-reproduced: 12 alternating-device edits to ONE customer left 11
// rows behind, at a MEASURED 726 bytes each (the most expensive row in the
// system — it stores two complete JSON snapshots of the disputed record).
//
// The retention rule is deliberately asymmetric, and the asymmetry is the
// point:
//
//   UNREVIEWED conflicts are NEVER pruned, at any age. They are an open
//   question about a customer's record that no human has answered yet.
//   Deleting one would silently discard the only evidence that two people
//   disagreed — and a manager who was on leave for four months must still
//   find it waiting.
//
//   REVIEWED conflicts are pruned after 180 days. Once a manager has looked
//   at it and accepted the winning version, the two JSON snapshots are
//   spent: the surviving customer row IS the decision. 180 days (twice the
//   90-day sync_change_log window) leaves a comfortable margin to revisit a
//   decision within the same financial year before the evidence goes.
async function pruneReviewedSyncConflicts(db, retainDays = 180) {
  await db.prepare(
    `DELETE FROM sync_conflicts
      WHERE reviewed_at IS NOT NULL
        AND reviewed_at < datetime('now', ?)`
  ).bind(`-${retainDays} days`).run();
}

module.exports = { pruneSyncChangeLog, pruneLoginAttempts, pruneReviewedSyncConflicts };
