// Offline-first sync engine — Cloudflare D1 port of the original
// implementation's generic table-level PUSH mechanism.
//
// FOUND AND FIXED DURING A PRODUCTION AUDIT (real cross-backend parity
// gap, not a design choice): the shared frontend (public/js/views/
// customers.js's offline fallback, public/js/api.js's pushCustomerQueue,
// and public/js/views/sync.js's manager Sync Status page) unconditionally
// calls POST /api/sync/push and GET /api/sync/conflicts on BOTH deployment
// targets — but this Worker previously had NEITHER route at all.
// Live-reproduced: (1) creating a customer while offline against a Worker
// deployment queued locally as designed, but every subsequent flush
// attempt hit a 404 and, because pushCustomerQueue disables the generic
// offline-queue fallback for this call (`allowOfflineQueue: false`,
// correctly avoiding an infinite queue-of-queues), the customer would
// NEVER actually reach the database — it just sat in IndexedDB
// permanently, with the UI misleadingly still showing "queued, will sync
// automatically" every single sync cycle; (2) the manager Sync Status
// page's `Promise.all([Api.get('/sync/overview'),
// Api.get('/sync/conflicts')])` throws the instant the second call 404s,
// so the ENTIRE page (including the /sync/overview data, which DOES work
// correctly on this deployment) crashed with a raw "Failed to load:
// Request failed (404)" error for every manager on every Worker-deployed
// client.
//
// FIXED by implementing the real push mechanism here, using D1's native
// `INSERT... ON CONFLICT DO UPDATE... WHERE excluded.updated_at >
// customers.updated_at` pattern (this is the exact idiom the client
// originally requested for this feature) instead of Node's
// read-then-conditionally-write approach — the WHERE clause makes
// last-write-wins a single atomic SQL statement rather than two
// round-trips, and (like every other D1 write path in this codebase) the
// whole push commits as ONE db.batch call regardless of how many rows it
// contains, keeping this in line with the Workers Free plan's
// subrequest-count discipline established by the sales-engine audit fixes
// (see salesService.js's loadStockPools/MAX_SALE_ITEMS comments for the
// full rationale).
//
// sync_conflicts logging is included for full behavioral parity with Node
// (the same genuinely-possible scenario — two different offline branches
// editing the same shared customer record before either syncs — can occur
// here too, since D1 is a single central database but the OFFLINE QUEUE
// itself is per-device local state, exactly like on Node; D1 being
// centrally consistent only means there's no "diverged local SQLite
// replica" risk, not that two devices can't still race to push conflicting
// edits to the SAME record).
//
// PULL (server pushes reference data DOWN to a branch's local replica) is
// intentionally NOT implemented here — see worker/src/routes/sync.js for
// why: this deployment's central-D1 model has no local replica for the API
// to catch up, the frontend already reads directly from D1 on every
// request, and (confirmed via grep) the frontend never calls GET
// /api/sync/pull on either backend today. PUSH and CONFLICTS are
// different: the frontend DOES unconditionally call both today, so unlike
// pull, leaving them unimplemented here was a genuine bug, not an
// intentional architectural difference.
const { uuid } = require('../lib/crypto');
const { withD1Retry } = require('../lib/d1Retry');

const PUSHABLE_TABLES = [
  {
    name: 'customers',
    pk: 'id',
    deviceTrackingColumn: 'last_write_device_id',
    // BUG 45 — COLUMN ALLOW-LIST (live-reproduced).
    //
    // The upsert used to be built from `Object.keys(row)` intersected with
    // the table's real columns, so a device could write ANY column it
    // named. `branch_id` was already force-scoped server-side by an
    // earlier audit fix, but nothing constrained the rest — and
    // `is_deleted` is a column.
    //
    // Reproduced end to end: a STAFF device pushed
    // `{id, name, is_deleted: 1}` for a customer holding a ₦100 credit
    // balance. HTTP 200. The debtor vanished from the customer list, their
    // balance endpoint began returning 404, and the receivable became
    // unrecoverable through the UI — while the credit sale still pointed
    // at the now-hidden row. A cashier could erase the evidence of who
    // owes the pharmacy money, from a phone, offline.
    //
    // The decisive fact: **there is no DELETE route for customers at all.**
    // Deleting a customer is not a designed capability of this product,
    // and PUT /customers/:id already writes through an explicit field
    // allow-list (`['name','phone','address','id_type','id_number']`).
    // Sync was the only path that ignored that discipline, so it granted
    // powers the API deliberately withholds.
    //
    // This list mirrors that PUT allow-list plus the sync-mechanical
    // columns. Anything not named here is dropped from the write, never
    // silently applied. Deny-by-default is the point: adding a column to
    // the schema must not silently widen what a device may overwrite.
    writableColumns: [
      'id',                    // primary key — required to target the row
      'name', 'phone', 'address', 'id_type', 'id_number', // same fields PUT allows
      'created_at', 'updated_at',                          // last-write-wins timestamps
      'branch_id',             // present only so the server can FORCE-scope it below
      'last_write_device_id',  // set by the server from the pushing device
    ],
  },
];

// Mirrors the original implementation's MAX_PUSH_ROWS_PER_TABLE exactly —
// see that file's detailed comment for the full rationale (this number is
// deliberately shared/identical across both backends, not independently
// tuned, so client-side chunking logic in public/js/offline.js needs only
// one constant to design around regardless of which backend a given
// deployment runs).
const MAX_PUSH_ROWS_PER_TABLE = 100;

async function columnsOf(db, table) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  return results.map((c) => c.name);
}

async function applyPush(db, { branchId, deviceId, appVersion, changes, remainingAfterThisChunk = 0 }) {
  for (const tableDef of PUSHABLE_TABLES) {
    const rows = changes[tableDef.name];
    if (rows && rows.length > MAX_PUSH_ROWS_PER_TABLE) {
      throw Object.assign(
        new Error(
          `Too many ${tableDef.name} rows in one push (${rows.length}); the limit is ${MAX_PUSH_ROWS_PER_TABLE} per table per request. ` +
          `Split this into smaller batches and push them one at a time (see public/js/offline.js's chunked push helper).`
        ),
        { code: 'PUSH_BATCH_TOO_LARGE', status: 413 }
      );
    }
  }

  const summary = {};
  const statements = [];

  for (const tableDef of PUSHABLE_TABLES) {
    const rows = changes[tableDef.name];
    if (!rows || !rows.length) continue;

    const cols = await columnsOf(db, tableDef.name);
    const ids = rows.map((r) => r[tableDef.pk]).filter((id) => id != null);

    // Bulk-preload every touched row's CURRENT state in one query (see
    // the file-header comment — this is the same "one query for the
    // whole batch, never one query per row" discipline the sales
    // engine's audit fix established), used ONLY for conflict
    // detection and the inserted/updated/skipped summary counts below;
    // the actual last-write-wins decision is enforced independently
    // and atomically by the SQL WHERE clause in the upsert statement
    // itself, so a race between this read and the real write can never
    // corrupt data — at worst it makes the summary counts describe
    // what WAS ABOUT to happen rather than the exact final outcome,
    // which is a purely cosmetic/telemetry concern.
    let existingById = new Map();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const { results: existingRows } = await db.prepare(
        `SELECT * FROM ${tableDef.name} WHERE ${tableDef.pk} IN (${placeholders})`
      ).bind(...ids).all();
      existingById = new Map(existingRows.map((r) => [r[tableDef.pk], r]));
    }

    let inserted = 0, updated = 0, skipped = 0, crossBranchSkipped = 0;
    for (const incomingRow of rows) {
      // TENANT-ISOLATION BUG FOUND AND FIXED DURING THE PRE-LAUNCH AUDIT
      // (reproduced end-to-end over real HTTP against the real route):
      //
      // Every other write path in this codebase decides `branch_id` on the
      // SERVER from the caller's own identity — see routes/customers.js's
      // `const effectiveBranch = user.role === 'STAFF' ? user.branch_id : ...`.
      // This push path did not: it took `branch_id` verbatim from the pushed
      // row, so a STAFF account authenticated for Branch A could plant (or
      // silently re-parent) a customer record into Branch B simply by
      // setting the field in the JSON body. That is a cross-tenant write on
      // a single-tenant-per-client product, and it also corrupts the
      // receiving branch's debtor list and its customer-balance reporting.
      //
      // The caller's authenticated branch is authoritative: every pushed row
      // is force-scoped to it, exactly matching the rest of the codebase.
      // `branchId` is derived server-side in routes/sync.js from the JWT for
      // STAFF, and is required for everyone else.
      const row = (branchId && cols.includes('branch_id'))
        ? { ...incomingRow, branch_id: branchId }
        : incomingRow;

      // BUG 87 — FORCE-SCOPING PROTECTED NEW ROWS BUT SILENTLY STOLE EXISTING ONES.
      //
      // The force-scope above is correct for an INSERT: a device may only
      // create records in its own branch. But applied to an UPDATE it does
      // something quite different — it REPARENTS a row that already belongs to
      // another branch, because the incoming branch_id is simply replaced with
      // the pusher's own.
      //
      // Live-reproduced end to end: a Lagos device pushed a customer id
      // belonging to MINNA. The push returned 200 "updated: 1", the customer's
      // name and phone were overwritten with the Lagos device's values, and the
      // row was MOVED into Lagos. Worse, that customer owed Minna ₦110: after
      // the push the debt stayed recorded against Minna while the customer
      // themselves appeared in the LAGOS list, visible to a Lagos cashier who
      // could read their balance. One branch's debtor silently became another
      // branch's, and Minna lost sight of who owed them money.
      //
      // A pushed id is attacker-controlled — it is just a string in a JSON body
      // — so "the client would never send another branch's id" is not a
      // defence. This is the same class as the cross-branch holes already
      // closed on adjustments, transfers, attendance and user management: the
      // authority check must be made against the EXISTING row's branch, not
      // against what the caller claims.
      //
      // The right answer is to REFUSE, not to reparent. Skipping is safe: the
      // pushing device has no legitimate business editing another branch's
      // customer, and its own queue entry is simply not applied. The skip is
      // counted and logged so it is visible rather than silent.
      const existingForScope = existingById.get(row[tableDef.pk]);
      if (existingForScope && branchId && cols.includes('branch_id')
          && existingForScope.branch_id && existingForScope.branch_id !== branchId) {
        skipped++;
        crossBranchSkipped++;
        continue;
      }
      // BUG 45: intersect with the table's ALLOW-LIST as well as its real
      // columns. `cols` alone means "any column that exists", which let a
      // device set is_deleted = 1 and erase a debtor (see PUSHABLE_TABLES).
      const allowed = tableDef.writableColumns;
      // SILENT-LOSS ANALYSIS (BUG 53 investigation — no code change).
      //
      // The concern: whole-row last-write-wins means two devices editing the
      // same customer offline lose one version, recoverable only by a human
      // retyping it from the sync_conflicts JSON.
      //
      // That is a REAL property of this upsert, and it is why sync_conflicts
      // exists. But it is NOT reachable from the shipped client, and the
      // reason matters:
      //
      //   * This queue carries exactly ONE operation — creating a customer
      //     while offline (public/js/views/customers.js is the sole caller
      //     of Offline.queueCustomerEdit). Every field in that payload is
      //     the creating device's own input, so there is no other version
      //     to lose.
      //   * EDITING a customer goes through PUT /api/customers/:id, which is
      //     online-only (allowOfflineQueue is not used there) and writes a
      //     five-field allow-list. Two devices cannot queue competing edits
      //     to one record because edits are never queued at all.
      //
      // A per-column merge was implemented and then REVERTED here, because
      // it cannot work from the server side alone: the client sends the
      // whole row, so a field the device merely echoed back is byte-identical
      // in shape to a deliberate revert. Distinguishing them needs the CLIENT
      // to send only changed fields (or a base version, or per-field
      // timestamps). Adding the machinery without the client half would have
      // produced a merge that looks principled and silently guesses.
      //
      // If offline customer EDITING is ever added, the client must send a
      // changed-fields-only patch and this upsert must apply exactly those.
      // Asserted in test/audit.sync.js so the constraint cannot be forgotten.
      const rowCols = Object.keys(row).filter((k) => cols.includes(k) && (!allowed || allowed.includes(k)));
      if (!rowCols.includes(tableDef.pk)) {
        throw Object.assign(new Error(`Row for ${tableDef.name} missing primary key ${tableDef.pk}`), { status: 400 });
      }
      const existing = existingById.get(row[tableDef.pk]);
      const deviceCol = tableDef.deviceTrackingColumn;
      const insertCols = deviceCol && !rowCols.includes(deviceCol) ? [...rowCols, deviceCol] : rowCols;
      const insertVals = insertCols.map((c) => (c === deviceCol && !rowCols.includes(c) ? (deviceId || null) : row[c]));

      if (!existing) {
        inserted++;
      } else {
        const incomingUpdated = row.updated_at || row.created_at || null;
        const existingUpdated = existing.updated_at || existing.created_at || null;
        const willApply = !incomingUpdated || !existingUpdated || incomingUpdated > existingUpdated;
        if (!willApply) {
          skipped++;
        } else {
          updated++;
          // Same conflict-detection rule as Node: only log when the
          // row being overwritten was last written by a DIFFERENT
          // device (NULL last_write_device_id = unknown provenance,
          // not logged, to avoid false positives on data created via
          // the ordinary online API rather than this push mechanism).
          if (deviceCol && existing[deviceCol] && deviceId && existing[deviceCol] !== deviceId) {
            statements.push(db.prepare(`
              INSERT INTO sync_conflicts (id, table_name, row_id, branch_id, device_id, losing_version_json, winning_version_json)
              VALUES (?,?,?,?,?,?,?)
            `).bind(uuid(), tableDef.name, row[tableDef.pk], branchId || null, deviceId || null, JSON.stringify(existing), JSON.stringify(row)));
          }
        }
      }

      const updateSetCols = rowCols.filter((c) => c !== tableDef.pk);
      const finalUpdateCols = deviceCol && !updateSetCols.includes(deviceCol) ? [...updateSetCols, deviceCol] : updateSetCols;
      const updateSetClause = finalUpdateCols.map((c) => `${c} = excluded.${c}`).join(', ');
      const placeholders = insertCols.map(() => '?').join(',');

      // The `WHERE excluded.updated_at > <table>.updated_at` guard is
      // the actual, atomic, race-proof last-write-wins enforcement —
      // everything computed above (existingById, willApply) is a
      // best-effort PREDICTION for logging/telemetry only. If the
      // pushed row has no updated_at/created_at at all, fall back to
      // always applying (matches Node's `incomingUpdated &&
      // existingUpdated` short-circuit, which also always applies when
      // either timestamp is missing).
      const hasTimestamp = rowCols.includes('updated_at') || rowCols.includes('created_at');
      const sql = hasTimestamp
        ? `INSERT INTO ${tableDef.name} (${insertCols.join(',')}) VALUES (${placeholders})
           ON CONFLICT(${tableDef.pk}) DO UPDATE SET ${updateSetClause}
           WHERE excluded.${rowCols.includes('updated_at') ? 'updated_at' : 'created_at'} > ${tableDef.name}.${rowCols.includes('updated_at') ? 'updated_at' : 'created_at'}
              OR ${tableDef.name}.${rowCols.includes('updated_at') ? 'updated_at' : 'created_at'} IS NULL`
        : `INSERT INTO ${tableDef.name} (${insertCols.join(',')}) VALUES (${placeholders})
           ON CONFLICT(${tableDef.pk}) DO UPDATE SET ${updateSetClause}`;
      statements.push(db.prepare(sql).bind(...insertVals));
    }

    // BUG 87: report cross-branch refusals separately. A bare `skipped` count
    // would hide a device repeatedly trying to write another branch's records,
    // which is exactly the signal an owner would want to see.
    summary[tableDef.name] = { received: rows.length, inserted, updated, skipped };
    if (crossBranchSkipped > 0) summary[tableDef.name].skipped_other_branch = crossBranchSkipped;
    statements.push(db.prepare(`
      INSERT INTO sync_change_log (id, branch_id, device_id, direction, table_name, row_count, status)
      VALUES (?,?,?,'PUSH',?,?,'SUCCESS')
    `).bind(uuid(), branchId, deviceId, tableDef.name, rows.length));
  }

  const existingStatus = await db.prepare('SELECT branch_id FROM branch_sync_status WHERE branch_id = ?').bind(branchId).first();
  if (existingStatus) {
    statements.push(db.prepare(`
      UPDATE branch_sync_status
      SET device_id = ?, app_version = ?, last_heartbeat_at = datetime('now'), last_push_at = datetime('now'), pending_push_count = ?, last_sync_error = NULL, updated_at = datetime('now')
      WHERE branch_id = ?
    `).bind(deviceId, appVersion || null, remainingAfterThisChunk, branchId));
  } else {
    statements.push(db.prepare(`
      INSERT INTO branch_sync_status (branch_id, device_id, app_version, last_heartbeat_at, last_push_at, pending_push_count, updated_at)
      VALUES (?,?,?,datetime('now'),datetime('now'),?,datetime('now'))
    `).bind(branchId, deviceId, appVersion || null, remainingAfterThisChunk));
  }

  // Everything commits as ONE db.batch() call regardless of row count
  // (still subject to D1's own 100KB-per-statement / 100-bound-
  // parameter-per-statement limits on each INDIVIDUAL statement inside
  // the batch, which the MAX_PUSH_ROWS_PER_TABLE=100 cap above already
  // keeps every push comfortably under).
  if (statements.length > 0) {
    await withD1Retry(() => db.batch(statements), 'sync push');
  }

  return summary;
}

async function getUnreviewedConflicts(db) {
  const { results } = await db.prepare(`
    SELECT sc.*, b.name AS branch_name
    FROM sync_conflicts sc
    LEFT JOIN branches b ON b.id = sc.branch_id
    WHERE sc.reviewed_by IS NULL
    ORDER BY sc.detected_at DESC
  `).all();
  return results.map((r) => ({
    ...r,
    losing_version: JSON.parse(r.losing_version_json),
    winning_version: JSON.parse(r.winning_version_json),
  }));
}

async function reviewConflict(db, { conflictId, reviewedBy }) {
  const result = await db.prepare(`
    UPDATE sync_conflicts SET reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND reviewed_by IS NULL
  `).bind(reviewedBy, conflictId).run();
  if (result.meta.changes === 0) throw Object.assign(new Error('Conflict not found or already reviewed.'), { status: 400 });
}

// OBSERVABILITY GAP (found during a systematic sweep of every
// CHECK-constraint enum for unreachable values) — see the write-up below's
// recordPushFailure for the full rationale: sync_change_log.status has
// always supported 'FAILED' and both sync_change_log.error_message and
// branch_sync_status.last_sync_error are columns the manager's Sync Status
// dashboard (public/js/views/sync.js) has always rendered, but nothing on
// the Worker deployment ever wrote to them either — a genuinely failed
// push was just as invisible here as on Node before this fix.
async function recordPushFailure(db, { branchId, deviceId, errorMessage }) {
  const msg = String(errorMessage || 'Unknown error').slice(0, 2000);
  const statements = [
    db.prepare(`
      INSERT INTO sync_change_log (id, branch_id, device_id, direction, table_name, row_count, status, error_message)
      VALUES (?,?,?,'PUSH',NULL,0,'FAILED',?)
    `).bind(uuid(), branchId || null, deviceId || null, msg),
  ];
  if (branchId) {
    const existingStatus = await db.prepare('SELECT branch_id FROM branch_sync_status WHERE branch_id = ?').bind(branchId).first();
    if (existingStatus) {
      statements.push(db.prepare(`UPDATE branch_sync_status SET last_sync_error = ?, updated_at = datetime('now') WHERE branch_id = ?`).bind(msg, branchId));
    } else {
      statements.push(db.prepare(`INSERT INTO branch_sync_status (branch_id, last_sync_error, updated_at) VALUES (?,?,datetime('now'))`).bind(branchId, msg));
    }
  }
  await withD1Retry(() => db.batch(statements), 'sync push');
}

module.exports = { applyPush, getUnreviewedConflicts, reviewConflict, recordPushFailure, PUSHABLE_TABLES, MAX_PUSH_ROWS_PER_TABLE };
