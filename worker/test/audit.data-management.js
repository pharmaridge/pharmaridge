// OWNER DATA MANAGEMENT — API/relationship/role regression probe.
//
// Runs the actual Hono route against a temporary SQLite representation of the
// D1 schema. It deliberately does NOT touch a production database. The probe
// checks the pieces most likely to regress in a destructive feature: Owner-only
// authority, active-operation blocking, selected-period scope, full reset
// relationship order, credential removal and the surviving audit trail.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const fs = require('fs');
const Database = require('better-sqlite3');
const dataManagement = require('../src/routes/dataManagement');
const { signToken } = require('../src/lib/crypto');

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

function d1Adapter(sqlite) {
  function prepared(sql, binds) {
    const args = binds || [];
    return {
      bind(...next) { return prepared(sql, next); },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() {
        const r = sqlite.prepare(sql).run(...args);
        return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
      },
      _run() { return sqlite.prepare(sql).run(...args); },
    };
  }
  return {
    prepare(sql) { return prepared(sql, []); },
    async batch(statements) {
      const execute = sqlite.transaction((items) => items.map((s) => s._run()));
      return execute(statements);
    },
  };
}

async function asUser(path, method, token, body) {
  const response = await dataManagement.request(`http://local${path}`, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV);
  let json = null;
  try { json = await response.json(); } catch (_) { /* ignored */ }
  return { status: response.status, body: json };
}

const sqlite = new Database(':memory:');
for (const migration of ['0001_initial_schema.sql']) {
  sqlite.exec(fs.readFileSync(`${__dirname}/../migrations/${migration}`, 'utf8'));
}
const DB = d1Adapter(sqlite);
const SECRET = 'data-management-audit-secret-with-enough-length';
const ENV = { DB, JWT_SECRET: SECRET, ENVIRONMENT: 'test' };

(async () => {
  // Minimal but fully-related operating data. Dates deliberately straddle the
  // period test so we can prove that selected-period deletion does not wipe a
  // current sale.
  sqlite.prepare("INSERT INTO branches (id,name) VALUES ('b1','Main Branch')").run();
  sqlite.prepare("INSERT INTO users (id,full_name,username,pin_hash,role) VALUES ('owner1','Owner One','owner','x','OWNER'), ('gm1','General Manager','manager','x','MANAGER')").run();
  sqlite.prepare("INSERT INTO users (id,branch_id,full_name,username,pin_hash,role) VALUES ('staff1','b1','Staff One','staff','x','STAFF')").run();
  sqlite.prepare("INSERT INTO user_sessions (user_id,session_id) VALUES ('owner1','owner-session'),('gm1','gm-session')").run();
  sqlite.prepare("INSERT INTO suppliers (id,name) VALUES ('sup1','Supplier')").run();
  sqlite.prepare("INSERT INTO products (id,name) VALUES ('prod1','Current Stock Product'),('prod-empty','Exhausted Product')").run();
  sqlite.prepare("INSERT INTO purchase_orders (id,branch_id,supplier_id,ordered_by) VALUES ('po1','b1','sup1','owner1')").run();
  sqlite.prepare("INSERT INTO customers (id,branch_id,name) VALUES ('cust1','b1','Customer')").run();
  sqlite.prepare("INSERT INTO stock_batches (id,branch_id,product_id,quantity_received,quantity_remaining,cost_price_per_unit,selling_price_per_unit,supplier_id,purchase_order_id) VALUES ('batch1','b1','prod1',10,8,10,15,'sup1','po1'),('batch-empty','b1','prod-empty',2,0,10,15,'sup1','po1')").run();
  sqlite.prepare("INSERT INTO product_price_overrides (id,branch_id,product_id,default_selling_price) VALUES ('price-current','b1','prod1',16),('price-empty','b1','prod-empty',16)").run();
  sqlite.prepare("INSERT INTO till_sessions (id,branch_id,opened_by,opening_cash,opened_at,status) VALUES ('t-old','b1','owner1',0,'2025-01-10 08:00:00','CLOSED'),('t-new','b1','owner1',0,'2025-02-10 08:00:00','CLOSED')").run();
  sqlite.prepare("INSERT INTO sales (id,branch_id,served_by,customer_id,subtotal,discount,total,is_credit_sale,status,till_session_id,created_at,updated_at) VALUES ('sale-old','b1','owner1','cust1',15,0,15,0,'COMPLETED','t-old','2025-01-10 09:00:00','2025-01-10 09:00:00'),('sale-new','b1','owner1','cust1',15,0,15,0,'COMPLETED','t-new','2025-02-10 09:00:00','2025-02-10 09:00:00')").run();
  sqlite.prepare("INSERT INTO sale_items (id,sale_id,stock_batch_id,product_id,quantity,quantity_base_units,unit_price,line_total) VALUES ('si-old','sale-old','batch1','prod1',1,1,15,15),('si-new','sale-new','batch1','prod1',1,1,15,15)").run();
  sqlite.prepare("INSERT INTO sale_payments (id,sale_id,method,amount,created_at) VALUES ('sp-old','sale-old','CASH',15,'2025-01-10 09:00:00'),('sp-new','sale-new','CASH',15,'2025-02-10 09:00:00')").run();
  sqlite.prepare("INSERT INTO expenses (id,branch_id,category,description,amount,recorded_by,expense_date,created_at) VALUES ('expense-old','b1','Utilities','Old bill',10,'owner1','2025-01-11','2025-01-11 10:00:00')").run();
  // Independent accounting rows make the continuity contract testable: the
  // accounting-preserving cleanup must retain these while deleting every live
  // sale/product/customer/supplier record around them.
  sqlite.prepare("INSERT INTO gl_accounts (id,code,name,account_type,is_system) VALUES ('audit-cash','AUDIT_CASH','Audit Cash','ASSET',0),('audit-revenue','AUDIT_REVENUE','Audit Revenue','REVENUE',0)").run();
  sqlite.prepare("INSERT INTO gl_journal_entries (id,branch_id,entry_date,source_type,source_id,description,posted_by,status) VALUES ('je-keep','b1','2025-02-10','SALE','sale-new','Cumulative sale figure','owner1','POSTED')").run();
  sqlite.prepare("INSERT INTO gl_journal_lines (id,journal_entry_id,account_id,debit,credit) VALUES ('jl-keep-dr','je-keep','audit-cash',15,0),('jl-keep-cr','je-keep','audit-revenue',0,15)").run();
  sqlite.prepare("INSERT INTO branch_safe_ledger (id,branch_id,entry_type,amount,reason,recorded_by) VALUES ('safe-keep','b1','DEPOSIT',50,'Opening reserve','owner1')").run();

  const ownerToken = await signToken({ id: 'owner1', sid: 'owner-session' }, SECRET);
  const gmToken = await signToken({ id: 'gm1', sid: 'gm-session' }, SECRET);

  console.log('\n=== Owner data-management controls ===');
  let r = await asUser('/status', 'GET', gmToken);
  check('General Manager cannot open destructive data controls', r.status === 403, `status=${r.status}`);

  r = await asUser('/preview?mode=PERIOD&start_date=2025-01-01&end_date=2025-01-31', 'GET', ownerToken);
  check('Owner can preview a selected period', r.status === 200 && r.body.mode === 'PERIOD', `status=${r.status}`);
  check('period preview sees only old sale activity', Number(r.body.records.sales) === 1, JSON.stringify(r.body.records));

  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'PERIOD', start_date: '2025-01-01', end_date: '2025-01-31',
    confirmation: 'wrong words', export_confirmed: true, retention_acknowledged: true,
  });
  check('typed confirmation is enforced server-side', r.status === 400, `status=${r.status}`);

  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'PERIOD', start_date: '2025-01-01', end_date: '2025-01-31',
    confirmation: 'DELETE SELECTED PERIOD', export_confirmed: true, retention_acknowledged: true,
  });
  check('Owner can delete the reviewed period', r.status === 200 && r.body.ok, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('old sale and dependent rows are deleted', sqlite.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='sale-old'").get().n === 0
    && sqlite.prepare("SELECT COUNT(*) AS n FROM sale_items WHERE id='si-old'").get().n === 0, 'old sale/line remains');
  check('newer sale outside the period remains', sqlite.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='sale-new'").get().n === 1, 'new sale missing');
  check('period cleanup leaves Manager and Staff credentials intact', sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('MANAGER','STAFF')").get().n === 2, 'accounts missing');

  r = await asUser('/preview?mode=CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK', 'GET', ownerToken);
  check('accounting-and-stock continuity preview is available to the Owner', r.status === 200
    && r.body.mode === 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK'
    && r.body.retained && r.body.retained.stock_batches === 1 && r.body.retained.stock_base_units === 8
    && !Object.prototype.hasOwnProperty.call(r.body.records || {}, 'gl_journal_entries'), `status=${r.status} ${JSON.stringify(r.body)}`);

  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK', confirmation: 'CLEAR OPERATIONS KEEP ACCOUNTING AND STOCK', export_confirmed: true, retention_acknowledged: true,
  });
  check('accounting-and-stock cleanup clears operations but keeps team and branch setup', r.status === 200
    && sqlite.prepare("SELECT COUNT(*) AS n FROM sales").get().n === 0
    && sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('MANAGER','STAFF')").get().n === 2
    && sqlite.prepare('SELECT COUNT(*) AS n FROM branches').get().n === 1, `status=${r.status}`);
  check('accounting-and-stock cleanup preserves only on-hand stock, its product and price', sqlite.prepare("SELECT COUNT(*) AS n FROM stock_batches WHERE id='batch1' AND quantity_remaining=8 AND supplier_id IS NULL AND purchase_order_id IS NULL").get().n === 1
    && sqlite.prepare("SELECT COUNT(*) AS n FROM products WHERE id='prod1'").get().n === 1
    && sqlite.prepare("SELECT COUNT(*) AS n FROM product_price_overrides WHERE id='price-current'").get().n === 1
    && sqlite.prepare("SELECT COUNT(*) AS n FROM stock_batches WHERE id='batch-empty'").get().n === 0
    && sqlite.prepare("SELECT COUNT(*) AS n FROM products WHERE id='prod-empty'").get().n === 0
    && sqlite.prepare("SELECT COUNT(*) AS n FROM product_price_overrides WHERE id='price-empty'").get().n === 0, 'current-stock continuity did not match the protected set');
  check('accounting-and-stock cleanup preserves cumulative GL and branch-safe figures', sqlite.prepare("SELECT COUNT(*) AS n FROM gl_journal_entries WHERE id='je-keep'").get().n === 1
    && sqlite.prepare("SELECT COUNT(*) AS n FROM gl_journal_lines WHERE journal_entry_id='je-keep'").get().n === 2
    && sqlite.prepare("SELECT COUNT(*) AS n FROM branch_safe_ledger WHERE id='safe-keep'").get().n === 1, 'accounting continuity row was removed');

  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING', confirmation: 'CLEAR OPERATIONS KEEP ACCOUNTING', export_confirmed: true, retention_acknowledged: true,
  });
  check('accounting-only continuity option still removes the retained stock master data', r.status === 200
    && sqlite.prepare('SELECT COUNT(*) AS n FROM stock_batches').get().n === 0
    && sqlite.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0
    && sqlite.prepare("SELECT COUNT(*) AS n FROM gl_journal_entries WHERE id='je-keep'").get().n === 1, `status=${r.status}`);

  // A device-reported offline backlog is also a blocker: the Owner must sync
  // known records before wiping the central database underneath them.
  sqlite.prepare("INSERT INTO branch_sync_status (branch_id,pending_push_count) VALUES ('b1',2)").run();
  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'FULL_SETUP_RESET', confirmation: 'RESET BUSINESS AND TEAM', export_confirmed: true, retention_acknowledged: true,
  });
  check('reported unsynced offline queue blocks a full reset', r.status === 409 && r.body.code === 'ACTIVE_OPERATIONS_BLOCK_RESET', `status=${r.status}`);
  sqlite.prepare("UPDATE branch_sync_status SET pending_push_count=0 WHERE branch_id='b1'").run();

  // Full-reset safety: unresolved work must block deletion rather than remove a
  // till/shift/transfer under a cashier's feet.
  sqlite.prepare("INSERT INTO till_sessions (id,branch_id,opened_by,opening_cash,status) VALUES ('t-open','b1','owner1',0,'OPEN')").run();
  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'FULL_SETUP_RESET', confirmation: 'RESET BUSINESS AND TEAM', export_confirmed: true, retention_acknowledged: true,
  });
  check('open till blocks a full reset', r.status === 409 && r.body.code === 'ACTIVE_OPERATIONS_BLOCK_RESET', `status=${r.status}`);
  sqlite.prepare("UPDATE till_sessions SET status='CLOSED' WHERE id='t-open'").run();

  r = await asUser('/purge', 'POST', ownerToken, {
    mode: 'FULL_SETUP_RESET', confirmation: 'RESET BUSINESS AND TEAM', export_confirmed: true, retention_acknowledged: true,
  });
  check('full business-and-team reset succeeds after operations close', r.status === 200 && r.body.ok, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('full reset removes business masters and branches', sqlite.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0
    && sqlite.prepare('SELECT COUNT(*) AS n FROM branches').get().n === 0, 'product or branch remains');
  check('full reset removes Manager and Staff credentials', sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('MANAGER','STAFF')").get().n === 0, 'team account remains');
  check('full reset preserves the Owner account and current session', sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id='owner1' AND role='OWNER'").get().n === 1
    && sqlite.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id='owner1'").get().n === 1, 'owner access removed');
  check('cleanup audit log survives the reset', sqlite.prepare('SELECT COUNT(*) AS n FROM data_cleanup_log').get().n >= 2, 'cleanup log missing');
  check('all-data reset records a stale-queue fence timestamp', !!sqlite.prepare('SELECT data_reset_at FROM client_settings WHERE id=1').get().data_reset_at, 'data_reset_at missing');

  console.log(`\nDATA MANAGEMENT AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
