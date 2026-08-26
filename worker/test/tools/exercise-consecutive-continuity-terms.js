// CONSECUTIVE DATA-MANAGEMENT CONTINUITY PROBE
//
// Local-only, API-first verification. Each selected policy runs three 90-day
// terms in the same D1 world; after every term the real Owner cleanup endpoint
// is called and the app's own reporting/stock APIs are re-read. It proves that
// the next term can operate on the protected accounting and, when selected,
// protected current stock. A final all-business cleanup remains deliberately
// destructive and is tested too.
const { execFileSync } = require('child_process');
const path = require('path');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const ROOT = path.resolve(__dirname, '..', '..');
const selected = process.env.CONTINUITY_MODE || 'ACCOUNTING';
const MODE = selected === 'STOCK' ? 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK' : 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING';
const PHRASE = selected === 'STOCK' ? 'CLEAR OPERATIONS KEEP ACCOUNTING AND STOCK' : 'CLEAR OPERATIONS KEEP ACCOUNTING';
let pass = 0; let fail = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
const rounded = (v) => Math.round(Number(v || 0) * 100) / 100;
const stable = (v) => JSON.stringify(v || []);
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
function must(label, yes, detail = '') { check(label, yes, detail); if (!yes) throw new Error(`${label}${detail ? ` — ${detail}` : ''}`); }

async function request(method, route, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let lastError;
  // Local workerd can briefly restart its request bridge after the simulator's
  // local timestamp batch. Retrying an idempotent read/login here avoids
  // mistaking that runner transition for a data-continuity defect.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      return { status: response.status, body: data };
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}
async function ownerToken() {
  const r = await request('POST', '/api/auth/login', null, { username: 'owner', pin: '1234' });
  if (r.status !== 200 || !r.body || !r.body.token) throw new Error(`Owner login failed: ${r.status}`);
  return r.body.token;
}

async function accountingSnapshot(token) {
  const trial = await request('GET', '/api/gl/trial-balance', token);
  must('Trial Balance API is readable for continuity comparison', trial.status === 200, JSON.stringify(trial.body));
  const rows = list(trial.body).map((r) => ({
    account_code: r.account_code || r.code,
    total_debits: rounded(r.total_debits), total_credits: rounded(r.total_credits), balance: rounded(r.balance),
  })).sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
  const debits = rounded(rows.reduce((sum, r) => sum + Number(r.total_debits || 0), 0));
  const credits = rounded(rows.reduce((sum, r) => sum + Number(r.total_credits || 0), 0));
  const journal = await request('GET', '/api/gl/journal-entries', token);
  const branches = await request('GET', '/api/branches', token);
  const safe = [];
  for (const branch of list(branches.body)) {
    const movement = await request('GET', `/api/safe/${encodeURIComponent(branch.id)}/movements`, token);
    if (movement.status === 200) safe.push({ branch_id: branch.id, safe_balance: rounded(movement.body.safe_balance), movement_count: list(movement.body.movements).length });
  }
  safe.sort((a, b) => a.branch_id.localeCompare(b.branch_id));
  return { rows, debits, credits, journal_rows: list(journal.body).length, safe };
}
async function stockSnapshot(token) {
  const stock = await request('GET', '/api/stock?limit=2000', token);
  must('Stock API is readable for continuity comparison', stock.status === 200, JSON.stringify(stock.body));
  const batches = list(stock.body).filter((b) => Number(b.quantity_remaining || 0) > 0 && !b.is_deleted).map((b) => ({
    id: b.id, branch_id: b.branch_id, product_id: b.product_id, quantity_remaining: Number(b.quantity_remaining),
    expiry_date: b.expiry_date || null, cost_price_per_unit: rounded(b.cost_price_per_unit),
    selling_price_per_unit: rounded(b.selling_price_per_unit), pack_price: b.pack_price == null ? null : rounded(b.pack_price),
    carton_price: b.carton_price == null ? null : rounded(b.carton_price),
    supplier_id: b.supplier_id || null, purchase_order_id: b.purchase_order_id || null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const products = [];
  const prices = [];
  for (const productId of [...new Set(batches.map((b) => b.product_id))].sort()) {
    const detail = await request('GET', `/api/products/${encodeURIComponent(productId)}`, token);
    must(`Product ${productId} remains readable before cleanup`, detail.status === 200, JSON.stringify(detail.body));
    const p = detail.body;
    products.push({ id: p.id, name: p.name, base_unit: p.base_unit, units_per_pack: p.units_per_pack, packs_per_carton: p.packs_per_carton, reorder_level: p.reorder_level });
    for (const po of list(p.price_overrides)) prices.push({
      product_id: po.product_id, branch_id: po.branch_id, default_selling_price: rounded(po.default_selling_price),
      pack_price: po.pack_price == null ? null : rounded(po.pack_price), carton_price: po.carton_price == null ? null : rounded(po.carton_price),
    });
  }
  products.sort((a, b) => a.id.localeCompare(b.id));
  prices.sort((a, b) => `${a.product_id}:${a.branch_id}`.localeCompare(`${b.product_id}:${b.branch_id}`));
  return { batches, products, prices };
}
function detachedBatches(rows) { return rows.map((b) => Object.assign({}, b, { supplier_id: null, purchase_order_id: null })); }

async function createRealPriceOverride(token) {
  const stock = await stockSnapshot(token);
  const batch = stock.batches[0];
  if (!batch) throw new Error('No current stock exists for the price-continuity assertion.');
  const response = await request('PUT', `/api/products/${encodeURIComponent(batch.product_id)}/price-override/${encodeURIComponent(batch.branch_id)}`, token, {
    default_selling_price: rounded(Number(batch.selling_price_per_unit) + 1),
    pack_price: batch.pack_price == null ? null : rounded(Number(batch.pack_price) + 1),
    carton_price: batch.carton_price == null ? null : rounded(Number(batch.carton_price) + 1),
  });
  if (response.status !== 200 && response.status !== 201) throw new Error(`Could not create real price override: ${response.status} ${JSON.stringify(response.body)}`);
}
function runThreeMonthTerm(term) {
  console.log(`\n=== ${selected} continuity — term ${term}/3: create and audit 90 days ===`);
  execFileSync(process.execPath, ['test/tools/simulate-three-months.js'], { cwd: ROOT, env: Object.assign({}, process.env, { WORKER_BASE: BASE }), stdio: 'inherit' });
  execFileSync(process.execPath, ['test/audit.three-month-simulation.js'], { cwd: ROOT, env: Object.assign({}, process.env, { WORKER_BASE: BASE }), stdio: 'inherit' });
}

async function cleanupTerm(term) {
  const token = await ownerToken();
  if (selected === 'STOCK') await createRealPriceOverride(token);
  const beforeAccounting = await accountingSnapshot(token);
  const beforeStock = await stockSnapshot(token);
  must(`term ${term}: cumulative accounting is non-empty`, beforeAccounting.journal_rows > 0);
  must(`term ${term}: Trial Balance is exact before cleanup`, beforeAccounting.debits === beforeAccounting.credits, JSON.stringify(beforeAccounting));
  if (selected === 'STOCK') {
    must(`term ${term}: current stock exists before protected-stock cleanup`, beforeStock.batches.length > 0 && beforeStock.products.length > 0, JSON.stringify(beforeStock));
    must(`term ${term}: a real branch price override exists before protected-stock cleanup`, beforeStock.prices.length > 0, JSON.stringify(beforeStock.prices));
  }
  const preview = await request('GET', `/api/data-management/preview?mode=${encodeURIComponent(MODE)}`, token);
  must(`term ${term}: Owner can preview ${selected.toLowerCase()} continuity`, preview.status === 200 && preview.body.mode === MODE, JSON.stringify(preview.body));
  must(`term ${term}: no open operation blocks cleanup`, preview.body.can_run === true, JSON.stringify(preview.body.blockers));
  if (selected === 'STOCK') {
    must(`term ${term}: preview reports the exact protected stock count`, preview.body.retained
      && Number(preview.body.retained.stock_batches) === beforeStock.batches.length
      && Number(preview.body.retained.stock_base_units) === beforeStock.batches.reduce((sum, b) => sum + b.quantity_remaining, 0), JSON.stringify(preview.body.retained));
  }
  const purge = await request('POST', '/api/data-management/purge', token, { mode: MODE, confirmation: PHRASE, export_confirmed: true, retention_acknowledged: true });
  must(`term ${term}: ${selected.toLowerCase()} cleanup succeeds through the real Owner API`, purge.status === 200 && purge.body.ok, JSON.stringify(purge.body));

  const tokenAfter = await ownerToken();
  const afterAccounting = await accountingSnapshot(tokenAfter);
  check(`term ${term}: cumulative Trial Balance rows remain identical`, stable(afterAccounting.rows) === stable(beforeAccounting.rows), JSON.stringify({ before: beforeAccounting.rows, after: afterAccounting.rows }));
  check(`term ${term}: cumulative Trial Balance stays exact`, afterAccounting.debits === afterAccounting.credits && afterAccounting.debits === beforeAccounting.debits, JSON.stringify({ beforeAccounting, afterAccounting }));
  check(`term ${term}: branch-safe balances/history remain identical`, stable(afterAccounting.safe) === stable(beforeAccounting.safe), JSON.stringify({ before: beforeAccounting.safe, after: afterAccounting.safe }));

  const afterStock = await stockSnapshot(tokenAfter);
  if (selected === 'STOCK') {
    check(`term ${term}: every protected current batch keeps quantity and prices`, stable(afterStock.batches) === stable(detachedBatches(beforeStock.batches)), JSON.stringify({ before: beforeStock.batches, after: afterStock.batches }));
    check(`term ${term}: protected products remain`, stable(afterStock.products) === stable(beforeStock.products), JSON.stringify({ before: beforeStock.products, after: afterStock.products }));
    check(`term ${term}: protected branch price overrides remain`, stable(afterStock.prices) === stable(beforeStock.prices), JSON.stringify({ before: beforeStock.prices, after: afterStock.prices }));
  } else {
    check(`term ${term}: accounting-only cleanup removes stock and products`, afterStock.batches.length === 0 && afterStock.products.length === 0 && afterStock.prices.length === 0, JSON.stringify(afterStock));
  }
}

async function finalDelete() {
  const token = await ownerToken();
  const result = await request('POST', '/api/data-management/purge', token, { mode: 'ALL_BUSINESS_DATA', confirmation: 'CLEAR ALL BUSINESS DATA', export_confirmed: true, retention_acknowledged: true });
  must(`${selected}: final all-business delete succeeds after three terms`, result.status === 200 && result.body.ok, JSON.stringify(result.body));
  const after = await ownerToken();
  const stock = await stockSnapshot(after);
  const sales = await request('GET', '/api/sales?limit=200', after);
  const trial = await accountingSnapshot(after);
  const branches = await request('GET', '/api/branches', after);
  const users = await request('GET', '/api/users', after);
  check(`${selected}: final delete removes operations, stock and accounting figures`, list(sales.body).length === 0 && stock.batches.length === 0 && stock.products.length === 0 && stock.prices.length === 0 && trial.debits === 0 && trial.credits === 0 && trial.journal_rows === 0, JSON.stringify({ stock, sales: list(sales.body).length, trial }));
  check(`${selected}: final delete leaves branch/team setup for re-onboarding`, list(branches.body).length > 0 && list(users.body).some((u) => ['OWNER', 'MANAGER', 'STAFF'].includes(u.role)), JSON.stringify({ branches: list(branches.body).length, users: list(users.body).length }));
}

(async () => {
  console.log(`\n===== CONSECUTIVE ${selected} CONTINUITY AUDIT =====`);
  for (let term = 1; term <= 3; term++) { runThreeMonthTerm(term); await cleanupTerm(term); }
  await finalDelete();
  console.log(`\nCONSECUTIVE ${selected} CONTINUITY AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
