const { Hono } = require('hono');
const { authRequired, managerOnly, resolveMutationBranchId } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const { idempotent } = require('../lib/idempotency');
const syncService = require('../services/syncService');
const { readJsonBody } = require('../lib/http');

const sync = new Hono();
sync.use('*', authRequired);

// ARCHITECTURAL NOTE: in this Cloudflare deployment, D1 is the single
// central database reachable from every branch (unlike the Node
// deployment's model of one SQLite file per branch device that
// periodically pushes/pulls). That means the APPLICATION-LEVEL writes
// (sales, expenses, till, purchase-orders, ...) already land directly
// in D1 the moment a branch's PWA is online, via the ordinary API
// routes, each protected by the Idempotency-Key middleware for safe
// offline-queue replay — there is no "branch pushes its local writes
// up" step needed for THOSE.
//
// PUSH/CONFLICTS BELOW ARE A DIFFERENT STORY — REAL BUG FIXED DURING A
// PRODUCTION AUDIT, NOT AN INTENTIONAL ARCHITECTURAL GAP: the generic,
// side-effect-free reference-data push mechanism (currently: customers
// created/edited while offline) is a SEPARATE, ALREADY-EXISTING
// front-end feature (see public/js/offline.js's queueCustomerEdit/
// processCustomerSyncQueue and public/js/api.js's pushCustomerQueue())
// that the shared frontend calls UNCONDITIONALLY on both deployment
// targets. This Worker previously had no POST /push or GET /conflicts
// route at all, meaning: (1) a customer created offline against a
// Worker deployment would queue locally but then NEVER actually reach
// D1 — every flush attempt 404'd, and because pushCustomerQueue()
// deliberately disables the generic offline-queue fallback for this
// specific call (to avoid a "queue of queues"), the customer just sat
// in the browser's IndexedDB forever; (2) the manager Sync Status
// page's `Promise.all([Api.get('/sync/overview'), Api.get('/sync/conflicts')])`
// throws the instant the second call 404s, crashing the ENTIRE page —
// including the /sync/overview data, which DOES work correctly on this
// deployment — with a raw, unhelpful "Failed to load: Request failed
// (404)" error for every manager. Fixed by implementing the real push
// mechanism in services/syncService.js (D1-native
// `INSERT ... ON CONFLICT DO UPDATE ... WHERE excluded.updated_at >
// customers.updated_at`, atomic last-write-wins in one statement,
// batched with every other statement for the whole push into a SINGLE
// db.batch() call regardless of row count — see that file's detailed
// header comment). sync_conflicts logging IS meaningfully needed here
// too, despite D1 being one central database: the OFFLINE QUEUE that
// can produce a conflict is per-device LOCAL browser state (IndexedDB),
// not a diverged database replica — two different offline devices can
// still race to push conflicting edits to the very same shared
// customer record before either one's push lands, exactly as on Node.
//
// PULL (server pushes reference data DOWN to a branch's local replica)
// remains intentionally NOT implemented here — confirmed via `grep`
// that the frontend never calls GET /api/sync/pull on either backend,
// unlike push/conflicts which it calls unconditionally — so leaving
// pull unimplemented is still a genuine, deliberate architectural
// difference (this deployment's central-D1 model has no local replica
// for a "pull" to catch up), not a bug of the kind this audit found.
sync.post('/heartbeat', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);

  const existing = await c.env.DB.prepare('SELECT * FROM branch_sync_status WHERE branch_id = ?').bind(branchId).first();
  if (existing) {
    await c.env.DB.prepare(`
      UPDATE branch_sync_status SET device_id = ?, app_version = ?, last_heartbeat_at = datetime('now'), pending_push_count = ?, updated_at = datetime('now') WHERE branch_id = ?
    `).bind(body.device_id || null, body.app_version || null, body.pending_push_count || 0, branchId).run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO branch_sync_status (branch_id, device_id, app_version, last_heartbeat_at, pending_push_count, updated_at) VALUES (?,?,?,datetime('now'),?,datetime('now'))
    `).bind(branchId, body.device_id || null, body.app_version || null, body.pending_push_count || 0).run();
  }
  await c.env.DB.prepare(`INSERT INTO sync_change_log (id, branch_id, device_id, direction, table_name, row_count, status) VALUES (?,?,?,'HEARTBEAT',NULL,0,'SUCCESS')`)
    .bind(uuid(), branchId, body.device_id || null).run();

  return c.json(await c.env.DB.prepare('SELECT * FROM v_branch_sync_overview WHERE branch_id = ?').bind(branchId).first());
});

sync.get('/overview', managerOnly, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM v_branch_sync_overview ORDER BY connectivity_status, branch_name').all();
  return c.json(results);
});

// Generic reference-data push — see the file-header comment above and
// services/syncService.js for the full rationale/fix write-up. Mirrors the
// original implementation's POST /push contract exactly (same request body
// shape, same PUSH_BATCH_TOO_LARGE 413 behavior) so the shared frontend's
// pushCustomerQueue works identically against either backend with zero
// frontend changes.
sync.post('/push', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  if (!body.changes) return c.json({ error: 'changes object is required' }, 400);
  try {
    const summary = await syncService.applyPush(c.env.DB, {
      branchId,
      deviceId: body.device_id,
      appVersion: body.app_version,
      changes: body.changes,
      remainingAfterThisChunk: Number(body.remaining_after_this_chunk) || 0,
    });
    return c.json({ ok: true, summary });
  } catch (e) {
    // OBSERVABILITY — see syncService.recordPushFailure's comment and the
    // identical fix in the original design for the full rationale.
    // PUSH_BATCH_TOO_LARGE is deliberately not logged as a sync-health failure
    // — see Node's comment for why.
    if (e.code !== 'PUSH_BATCH_TOO_LARGE') {
      try { await syncService.recordPushFailure(c.env.DB, { branchId, deviceId: body.device_id, errorMessage: e.message }); } catch (_) { /* never let audit-logging itself break the error response */ }
    }
    return c.json({ error: e.message, code: e.code }, e.status || (e.code === 'PUSH_BATCH_TOO_LARGE' ? 413 : 400));
  }
});

// Manager-only: conflicts detected by the last-write-wins push mechanism
// that haven't been reviewed yet. Mirrors the original implementation's
// GET /conflicts exactly.
sync.get('/conflicts', managerOnly, async (c) => {
  return c.json(await syncService.getUnreviewedConflicts(c.env.DB));
});

sync.post('/conflicts/:id/review', managerOnly, async (c) => {
  const user = c.get('user');
  try {
    await syncService.reviewConflict(c.env.DB, { conflictId: c.req.param('id'), reviewedBy: user.id });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

module.exports = sync;
