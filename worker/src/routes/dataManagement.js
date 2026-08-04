// OWNER DATA MANAGEMENT — deliberate, guarded data removal.
//
// A database-size warning must not trap a proprietor with no controlled way to
// retire old data. Equally, a cheerful "format database" button in a pharmacy
// app would be reckless: sales, VAT/WHT, controlled-drug and cash records can
// be evidence the business is required to retain. This route therefore makes
// the destructive choice explicit, previews it, blocks unresolved operations,
// requires a typed confirmation AND keeps a minimal non-personal audit log.
//
// This is an OWNER-only capability, deliberately NOT ownerOnly from auth.js:
// `ownerOnly` also admits the PharmaRidge support account for reversible
// settings assistance. Support may advise and inspect storage, but must never
// be able to erase a pharmacy's records through an ordinary browser session.
const { Hono } = require('hono');
const { authRequired } = require('../lib/auth');
const { readJsonBody, rejectUnknownFields } = require('../lib/http');
const { getStorageHealth } = require('../lib/storageHealth');
const { withD1Retry } = require('../lib/d1Retry');

const dataManagement = new Hono();
dataManagement.use('*', authRequired);
dataManagement.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'OWNER') {
    return c.json({
      error: 'Only the pharmacy Owner can remove business data. General Managers receive storage alerts but cannot erase records.',
      code: 'OWNER_DATA_MANAGEMENT_REQUIRED',
    }, 403);
  }
  return next();
});

const MODES = {
  PERIOD: {
    label: 'Delete selected period',
    phrase: 'DELETE SELECTED PERIOD',
    needsDates: true,
    description: 'Hard-deletes activity dated within the selected inclusive period. It keeps current setup, people, branches, products, suppliers, customers and stock batches.',
  },
  ALL_BUSINESS_DATA: {
    label: 'Clear all business data',
    phrase: 'CLEAR ALL BUSINESS DATA',
    description: 'Hard-deletes trading, stock, accounting, supplier/customer and sync records while keeping branches and every existing account credential.',
  },
  FULL_SETUP_RESET: {
    label: 'Full business and team reset',
    phrase: 'RESET BUSINESS AND TEAM',
    description: 'Hard-deletes all business records and also removes Manager and Staff credentials, branch devices and branches. Owner and PharmaRidge Support accounts, plan/settings, tax schedules, the NAFDAC reference catalog and this minimal cleanup log remain.',
  },
};

// Only names from this closed list are interpolated into SQL. Dates and actor
// ids remain bound parameters. This avoids treating a table name supplied by a
// browser as executable SQL while still keeping the cleanup sequence readable.
const BUSINESS_COUNT_TABLES = [
  'sales', 'sale_items', 'sale_payments', 'prescriptions', 'controlled_substance_register',
  'debtor_ledger', 'change_owed', 'creditor_ledger', 'branch_safe_ledger', 'expenses',
  'till_sessions', 'wht_entries', 'gl_journal_entries', 'gl_journal_lines',
  'purchase_orders', 'purchase_order_items', 'purchase_order_receipts',
  'stock_batches', 'stock_adjustments', 'stock_transfers', 'stocktake_sessions', 'stocktake_lines',
  'product_price_overrides', 'products', 'suppliers', 'customers',
  'branch_sync_status', 'sync_change_log', 'sync_conflicts', 'idempotency_keys',
  'login_attempts', 'user_assignment_history', 'pending_user_transfers',
];

function countTotal(counts) {
  return Object.values(counts || {}).reduce((total, value) => total + Number(value || 0), 0);
}

function validIsoDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${label} must be a calendar date in YYYY-MM-DD format.`;
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    return `${label} must be a real calendar date in YYYY-MM-DD format.`;
  }
  return null;
}

function parseScope(mode, input) {
  const spec = MODES[mode];
  if (!spec) return { error: `mode must be one of: ${Object.keys(MODES).join(', ')}` };
  if (!spec.needsDates) return { mode, startDate: null, endDate: null };
  const startDate = input.start_date;
  const endDate = input.end_date;
  const badStart = validIsoDate(startDate, 'start_date');
  const badEnd = validIsoDate(endDate, 'end_date');
  if (badStart || badEnd) return { error: badStart || badEnd };
  if (startDate > endDate) return { error: 'start_date must be on or before end_date.' };
  return { mode, startDate, endDate };
}

function ownerOperationGuard(c) {
  // This has a named helper primarily so every endpoint gets the same plain
  // explanation. An Owner can make a destructive decision; a support token
  // cannot make it on their behalf.
  const user = c.get('user');
  return user && user.role === 'OWNER';
}

function scopedDate(column, startDate, endDate) {
  return { where: `date(${column}) >= date(?) AND date(${column}) <= date(?)`, binds: [startDate, endDate] };
}

function deletion(table, where, binds) {
  return { table, where, binds: binds || [] };
}

// This ordering is child-first, then parent. Foreign-key enforcement is on in
// D1, so keeping the sequence here (rather than turning checks off) means an
// accidental future relationship turns the cleanup into a safe rollback rather
// than a half-cleared database.
function periodDeletions(startDate, endDate) {
  const sale = scopedDate('created_at', startDate, endDate);
  const till = scopedDate('opened_at', startDate, endDate);
  const stocktake = scopedDate('started_at', startDate, endDate);
  const attendance = scopedDate('clock_in_at', startDate, endDate);
  const transfer = scopedDate('initiated_at', startDate, endDate);
  const gl = scopedDate('entry_date', startDate, endDate);
  const simple = (table, column) => {
    const d = scopedDate(column, startDate, endDate);
    return deletion(table, d.where, d.binds);
  };
  const saleIds = `SELECT id FROM sales WHERE ${sale.where}`;
  const stocktakeIds = `SELECT id FROM stocktake_sessions WHERE ${stocktake.where}`;
  const glIds = `SELECT id FROM gl_journal_entries WHERE ${gl.where}`;

  return [
    // A controlled register entry can be linked to a sale or created by a
    // dispensing workflow, so both routes into the period must be removed
    // before its prescription/sale parents.
    deletion('controlled_substance_register', `sale_id IN (${saleIds}) OR ${scopedDate('created_at', startDate, endDate).where}`, [...sale.binds, startDate, endDate]),
    deletion('prescriptions', `sale_id IN (${saleIds}) OR ${scopedDate('created_at', startDate, endDate).where}`, [...sale.binds, startDate, endDate]),
    deletion('sale_payments', `sale_id IN (${saleIds})`, sale.binds),
    deletion('sale_items', `sale_id IN (${saleIds})`, sale.binds),
    deletion('change_owed', `sale_id IN (${saleIds}) OR settled_sale_id IN (${saleIds}) OR ${scopedDate('created_at', startDate, endDate).where}`, [...sale.binds, ...sale.binds, startDate, endDate]),
    simple('debtor_ledger', 'created_at'),
    deletion('sales', sale.where, sale.binds),

    simple('wht_entries', 'entry_date'),
    simple('creditor_ledger', 'created_at'),
    simple('branch_safe_ledger', 'created_at'),
    simple('expenses', 'expense_date'),
    deletion('gl_journal_lines', `journal_entry_id IN (${glIds})`, gl.binds),
    deletion('gl_journal_entries', gl.where, gl.binds),

    // A stocktake adjustment may be recorded after the count was opened. If
    // the selected count is removed, remove that dependent adjustment too even
    // when its own timestamp falls just outside the selected window.
    deletion('stock_adjustments', `stocktake_id IN (${stocktakeIds}) OR ${scopedDate('created_at', startDate, endDate).where}`, [...stocktake.binds, startDate, endDate]),
    deletion('stocktake_lines', `stocktake_id IN (${stocktakeIds})`, stocktake.binds),
    deletion('stocktake_sessions', stocktake.where, stocktake.binds),
    simple('stock_transfers', 'initiated_at'),
    simple('purchase_order_receipts', 'received_at'),
    deletion('till_sessions', `${till.where} AND id NOT IN (SELECT till_session_id FROM sales WHERE till_session_id IS NOT NULL)`, till.binds),
    deletion('staff_attendance', attendance.where, attendance.binds),

    // Operational/diagnostic rows do not carry financial history; making a
    // date-range delete include them is what actually frees space from old
    // device sync trails and brute-force login logs.
    simple('sync_change_log', 'synced_at'),
    simple('sync_conflicts', 'detected_at'),
    simple('idempotency_keys', 'created_at'),
    simple('login_attempts', 'attempted_at'),
    simple('user_assignment_history', 'changed_at'),
    simple('pending_user_transfers', 'requested_at'),
  ];
}

function allBusinessDeletions() {
  return [
    deletion('branch_sync_status', '1 = 1'),
    deletion('sync_change_log', '1 = 1'),
    deletion('sync_conflicts', '1 = 1'),
    deletion('idempotency_keys', '1 = 1'),
    deletion('login_attempts', '1 = 1'),

    deletion('controlled_substance_register', '1 = 1'),
    deletion('prescriptions', '1 = 1'),
    deletion('sale_payments', '1 = 1'),
    deletion('sale_items', '1 = 1'),
    deletion('change_owed', '1 = 1'),
    deletion('debtor_ledger', '1 = 1'),
    deletion('sales', '1 = 1'),

    deletion('wht_entries', '1 = 1'),
    deletion('creditor_ledger', '1 = 1'),
    deletion('branch_safe_ledger', '1 = 1'),
    deletion('expenses', '1 = 1'),
    deletion('till_sessions', '1 = 1'),
    deletion('staff_attendance', '1 = 1'),
    deletion('gl_journal_lines', '1 = 1'),
    deletion('gl_journal_entries', '1 = 1'),

    deletion('stock_transfers', '1 = 1'),
    deletion('stock_adjustments', '1 = 1'),
    deletion('stocktake_lines', '1 = 1'),
    deletion('stocktake_sessions', '1 = 1'),
    deletion('stock_batches', '1 = 1'),
    deletion('purchase_order_receipts', '1 = 1'),
    deletion('purchase_order_items', '1 = 1'),
    deletion('purchase_orders', '1 = 1'),
    deletion('product_price_overrides', '1 = 1'),
    deletion('customers', '1 = 1'),
    deletion('suppliers', '1 = 1'),
    deletion('products', '1 = 1'),

    deletion('pending_user_transfers', '1 = 1'),
    deletion('user_assignment_history', '1 = 1'),
  ];
}

function fullSetupDeletions() {
  return [
    ...allBusinessDeletions(),
    deletion('branch_devices', '1 = 1'),
    // Sessions must be removed before their account. Owner and Support
    // sessions are intentionally preserved: the Owner who performed the
    // reset must not be locked out by their own successful request.
    deletion('user_sessions', "user_id IN (SELECT id FROM users WHERE role IN ('MANAGER','STAFF'))"),
    deletion('users', "role IN ('MANAGER','STAFF')"),
    deletion('branches', '1 = 1'),
  ];
}

function sqlForDelete(op) {
  return `DELETE FROM ${op.table} WHERE ${op.where}`;
}

async function tableCounts(db, ops) {
  if (!ops.length) return {};
  const columns = ops.map((op) => `(SELECT COUNT(*) FROM ${op.table} WHERE ${op.where}) AS ${op.table}`).join(', ');
  const binds = ops.flatMap((op) => op.binds || []);
  const row = await db.prepare(`SELECT ${columns}`).bind(...binds).first();
  const counts = {};
  for (const op of ops) counts[op.table] = Number((row && row[op.table]) || 0);
  return counts;
}

async function allTableCounts(db, includeFullExtras) {
  const tableExpressions = BUSINESS_COUNT_TABLES.map((table) => ({ table, where: '1 = 1' }));
  if (includeFullExtras) {
    tableExpressions.push(
      { table: 'branch_devices', where: '1 = 1' },
      // A full setup reset deliberately preserves Owners and the vendor Admin
      // seat. Count only the accounts that are actually removed so the preview
      // cannot over-promise its effect.
      { table: 'users', where: "role IN ('MANAGER','STAFF')" },
      { table: 'branches', where: '1 = 1' },
    );
  }
  const columns = tableExpressions
    .map((entry) => `(SELECT COUNT(*) FROM ${entry.table} WHERE ${entry.where}) AS ${entry.table}`)
    .join(', ');
  const row = await db.prepare(`SELECT ${columns}`).first();
  const counts = {};
  for (const entry of tableExpressions) counts[entry.table] = Number((row && row[entry.table]) || 0);
  return counts;
}

async function blockersFor(db, scope) {
  const all = scope.mode !== 'PERIOD';
  const range = (column) => all ? { where: '1 = 1', binds: [] } : scopedDate(column, scope.startDate, scope.endDate);
  const till = range('opened_at');
  const stocktake = range('started_at');
  const attendance = range('clock_in_at');
  const transfer = range('initiated_at');
  const pendingUser = range('requested_at');

  const q = [
    [`SELECT COUNT(*) AS n FROM till_sessions WHERE status = 'OPEN' AND is_deleted = 0 AND ${till.where}`, till.binds, 'Open till session'],
    [`SELECT COUNT(*) AS n FROM stocktake_sessions WHERE status = 'OPEN' AND is_deleted = 0 AND ${stocktake.where}`, stocktake.binds, 'Open stocktake'],
    [`SELECT COUNT(*) AS n FROM staff_attendance WHERE clock_out_at IS NULL AND is_deleted = 0 AND ${attendance.where}`, attendance.binds, 'Open attendance shift'],
    [`SELECT COUNT(*) AS n FROM stock_transfers WHERE status IN ('PENDING','IN_TRANSIT') AND is_deleted = 0 AND ${transfer.where}`, transfer.binds, 'Unresolved stock transfer'],
    [`SELECT COUNT(*) AS n FROM pending_user_transfers WHERE status = 'AWAITING_CONFIRMATION' AND is_deleted = 0 AND ${pendingUser.where}`, pendingUser.binds, 'Pending staff transfer'],
    // A device has told the server it still holds records that have not been
    // pushed. Clearing central data underneath that queue would turn a reset
    // into a later surprise replay (or a lost sale if replay is fenced), so
    // require its known backlog to be resolved first. A device that has never
    // reported a heartbeat cannot be detected here; the UI still names that
    // limitation and the reset timestamp fences any old replay it sends.
    ["SELECT COUNT(*) AS n FROM branch_sync_status WHERE pending_push_count > 0", [], 'Reported unsynced offline queue'],
  ];
  const results = await Promise.all(q.map(async ([sql, binds, label]) => {
    const row = await db.prepare(sql).bind(...binds).first();
    return { label, count: Number((row && row.n) || 0) };
  }));
  return results.filter((row) => row.count > 0);
}

async function makePreview(db, scope) {
  const ops = scope.mode === 'PERIOD'
    ? periodDeletions(scope.startDate, scope.endDate)
    : (scope.mode === 'FULL_SETUP_RESET' ? fullSetupDeletions() : allBusinessDeletions());
  const counts = scope.mode === 'PERIOD'
    ? await tableCounts(db, ops)
    : await allTableCounts(db, scope.mode === 'FULL_SETUP_RESET');
  const blockers = await blockersFor(db, scope);
  const storage = await getStorageHealth(db);
  return {
    mode: scope.mode,
    mode_label: MODES[scope.mode].label,
    start_date: scope.startDate,
    end_date: scope.endDate,
    description: MODES[scope.mode].description,
    records: counts,
    record_total: countTotal(counts),
    blockers,
    can_run: blockers.length === 0,
    storage_before: storage,
    confirmation_phrase: MODES[scope.mode].phrase,
    retention_notice: 'Deleting a record is permanent from this application. Export and verify every report or backup you must retain before continuing. Resolve every reported offline queue first; after any cleanup, an old queued replay is quarantined for review instead of being allowed to recreate records. Check your accountant, tax adviser and applicable pharmacy/controlled-drug retention obligations before deleting financial, VAT/WHT, prescription or controlled-drug records.',
    storage_notice: 'This removes live rows and reduces PharmaRidge’s active-data estimate. Cloudflare manages physical database allocation; do not rely on deletion alone as a guarantee of immediate billed-storage reduction. If capacity is critical, plan an upgrade with support as well.',
  };
}

async function recentLog(db) {
  const { results } = await db.prepare(`
    SELECT id, mode, initiated_by_username, start_date, end_date, deleted_summary_json, created_at
    FROM data_cleanup_log
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  return (results || []).map((row) => {
    let summary = {};
    try { summary = JSON.parse(row.deleted_summary_json || '{}'); } catch (e) { summary = {}; }
    return {
      id: row.id,
      mode: row.mode,
      initiated_by_username: row.initiated_by_username,
      start_date: row.start_date,
      end_date: row.end_date,
      record_total: Number(summary.record_total || 0),
      created_at: row.created_at,
    };
  });
}

dataManagement.get('/status', async (c) => {
  if (!ownerOperationGuard(c)) return c.json({ error: 'Only the pharmacy Owner can view data-management controls.' }, 403);
  const db = c.env.DB;
  return c.json({
    storage: await getStorageHealth(db),
    recent_cleanups: await recentLog(db),
    modes: Object.entries(MODES).map(([code, spec]) => ({ code, label: spec.label, description: spec.description, needs_dates: !!spec.needsDates, confirmation_phrase: spec.phrase })),
  });
});

dataManagement.get('/preview', async (c) => {
  if (!ownerOperationGuard(c)) return c.json({ error: 'Only the pharmacy Owner can preview data removal.' }, 403);
  const scope = parseScope(c.req.query('mode'), {
    start_date: c.req.query('start_date'),
    end_date: c.req.query('end_date'),
  });
  if (scope.error) return c.json({ error: scope.error }, 400);
  return c.json(await makePreview(c.env.DB, scope));
});

dataManagement.post('/purge', async (c) => {
  if (!ownerOperationGuard(c)) return c.json({ error: 'Only the pharmacy Owner can remove data.' }, 403);
  const body = await readJsonBody(c);
  {
    const bad = rejectUnknownFields(body, ['mode', 'start_date', 'end_date', 'confirmation', 'export_confirmed', 'retention_acknowledged'], { label: 'data removal request' });
    if (bad) return c.json(bad, 400);
  }
  const scope = parseScope(body.mode, body);
  if (scope.error) return c.json({ error: scope.error }, 400);
  const spec = MODES[scope.mode];
  if (body.confirmation !== spec.phrase) {
    return c.json({ error: `Type exactly “${spec.phrase}” to authorise this irreversible action.` }, 400);
  }
  if (body.export_confirmed !== true || body.retention_acknowledged !== true) {
    return c.json({ error: 'Confirm that required exports/backups were checked and that you understand the retention warning before continuing.' }, 400);
  }

  const db = c.env.DB;
  // Recalculate at execution time. A preview is intentionally only advice:
  // someone can record a sale after previewing but before submitting.
  const preview = await makePreview(db, scope);
  if (preview.blockers.length) {
    return c.json({
      error: `Resolve these active operations before clearing data: ${preview.blockers.map((b) => `${b.count} ${b.label}`).join(', ')}.`,
      code: 'ACTIVE_OPERATIONS_BLOCK_RESET',
      blockers: preview.blockers,
    }, 409);
  }

  const user = c.get('user');
  const ops = scope.mode === 'PERIOD'
    ? periodDeletions(scope.startDate, scope.endDate)
    : (scope.mode === 'FULL_SETUP_RESET' ? fullSetupDeletions() : allBusinessDeletions());
  const summary = {
    record_total: preview.record_total,
    records: preview.records,
    storage_before: preview.storage_before && {
      estimated_bytes: preview.storage_before.bytes,
      megabytes: preview.storage_before.megabytes,
      percent_used: preview.storage_before.percent_used,
    },
  };

  const statements = [];
  // Every cleanup, including a selected-period cleanup, must refuse stale
  // offline replay. Otherwise an old sale from the very period just removed
  // could reconnect tomorrow and recreate itself. The broad fence is
  // intentionally conservative: a queued item created before ANY cleanup is
  // sent for human review instead of guessing whether it belongs to the range.
  //
  // On FULL_SETUP_RESET this UPDATE MUST be first: client_settings.updated_by
  // may still point at a Manager account which the same atomic batch is about
  // to delete. Re-pointing it at the acting Owner before that delete preserves
  // the foreign-key invariant without weakening foreign-key enforcement.
  statements.push(db.prepare("UPDATE client_settings SET data_reset_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = 1").bind(user.id));
  statements.push(...ops.map((op) => db.prepare(sqlForDelete(op)).bind(...op.binds)));
  statements.push(db.prepare(`
    INSERT INTO data_cleanup_log (mode, initiated_by, initiated_by_username, start_date, end_date, deleted_summary_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(scope.mode, user.id, user.username, scope.startDate, scope.endDate, JSON.stringify(summary)));

  await withD1Retry(() => db.batch(statements), `owner data management ${scope.mode}`);
  const storageAfter = await getStorageHealth(db);
  return c.json({
    ok: true,
    mode: scope.mode,
    mode_label: spec.label,
    removed: summary,
    storage_after: storageAfter,
    message: scope.mode === 'FULL_SETUP_RESET'
      ? 'Business data, Manager and Staff credentials, devices and branches were removed. Your Owner account remains signed in so you can set up the new business.'
      : scope.mode === 'ALL_BUSINESS_DATA'
        ? 'Business data was removed. Existing Owner, Manager and Staff credentials and branch setup remain.'
        : 'The selected historical period was removed. Current setup and master records remain.',
  });
});

module.exports = dataManagement;
