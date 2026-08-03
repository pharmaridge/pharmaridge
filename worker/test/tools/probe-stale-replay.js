// STALE-REPLAY PROBE — the long-tail offline scenario nobody tests.
//
// The offline queue never expires an item. Idempotency keys are pruned after
// 14 days. Those two facts have to be reconciled, because a Nigerian pharmacy
// really does produce devices that are offline for a long time: a branch
// phone left in a drawer over a holiday, a spare tablet used during a network
// outage and then forgotten, a device that only reconnects when someone
// carries it to the shop with working data.
//
// The questions:
//   1. If a sale is queued and replayed AFTER its idempotency key was pruned,
//      is double-submit protection still meaningful, or can the same sale be
//      recorded twice?
//   2. Does a very old queued sale still post to the right accounting period,
//      or does it silently land in today's books?
//   3. Does the UI tell anyone that an item has been stuck for weeks?
//
// (1) is the money question. Cloudflare + D1 give exactly-once only while the
// key row survives.
const { execSync } = require('child_process');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function d1(sql) {
  sql = String(sql).replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute pharmaridge-db --local --json --command ${JSON.stringify(sql)}`,
    { cwd: __dirname + '/../..', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('[')));
}
const rows = (sql) => d1(sql)[0].results;
const num = (sql) => Number(rows(sql)[0].n);

let TOKEN = null;
async function api(method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (opts.replay) headers['X-Offline-Replay'] = '1';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, body: json };
}

(async () => {
  const login = await api('POST', '/api/auth/login', { username: 'manager', pin: '1234' });
  if (login.status !== 200) { console.error('login failed', login); process.exit(2); }
  TOKEN = login.body.token;
  const branch = (await api('GET', '/api/branches')).body.find((b) => b.is_active);
  const stock = (await api('GET', `/api/stock?branch_id=${branch.id}`)).body;
  const batch = (Array.isArray(stock) ? stock : stock.results).find((s) => Number(s.quantity_remaining) > 5);
  await api('POST', '/api/till/open', { branch_id: branch.id, opening_float: 1000 });

  const unit = Number(batch.selling_price_per_unit);
  const saleBody = {
    branch_id: branch.id,
    items: [{ product_id: batch.product_id, quantity: 1 }],
    payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
  };

  console.log('\n=== A. NORMAL REPLAY IS EXACTLY-ONCE (control) ===');
  const KEY = `stale-probe-${Date.now()}`;
  const before = num(`SELECT COUNT(*) n FROM sales WHERE is_deleted = 0`);
  const first = await api('POST', '/api/sales', saleBody, { idem: KEY, replay: true });
  const second = await api('POST', '/api/sales', saleBody, { idem: KEY, replay: true });
  const afterTwo = num(`SELECT COUNT(*) n FROM sales WHERE is_deleted = 0`);
  check('the first submission is accepted', first.status === 201, `status=${first.status} ${JSON.stringify(first.body).slice(0, 90)}`);
  check('an immediate duplicate replay does NOT create a second sale',
    afterTwo - before === 1, `sales created = ${afterTwo - before}`);
  check('...and the duplicate returns the ORIGINAL response, not an error',
    second.status === 201 || second.status === 200, `status=${second.status}`);

  console.log('\n=== B. WHAT HAPPENS ONCE THE KEY HAS BEEN PRUNED (BUG 68) ===');
  // Simulate a device offline longer than the 14-day idempotency retention:
  // age the key past the window, run the real cron, then replay.
  const keyRow = num(`SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key = '${KEY}'`);
  check('the idempotency key was recorded', keyRow === 1, `rows=${keyRow}`);

  d1(`UPDATE idempotency_keys SET created_at = datetime('now','-20 days') WHERE idempotency_key = '${KEY}'`);
  await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  await new Promise((r) => setTimeout(r, 1200));
  const survived = num(`SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key = '${KEY}'`);
  check('a 20-day-old key is pruned by the cron (retention is 14 days)', survived === 0, `rows=${survived}`);

  const beforeStale = num(`SELECT COUNT(*) n FROM sales WHERE is_deleted = 0`);
  const stale = await api('POST', '/api/sales', saleBody, { idem: KEY, replay: true });
  const afterStale = num(`SELECT COUNT(*) n FROM sales WHERE is_deleted = 0`);
  const duplicated = afterStale - beforeStale;
  console.log(`     server-side replay after pruning -> status ${stale.status}, sales created: ${duplicated}`);
  // The SERVER cannot defend against this: once the key row is gone the
  // request is genuinely indistinguishable from a new one. Recording that
  // honestly rather than pretending otherwise.
  check('(known) the SERVER alone cannot detect a replay past key retention',
    duplicated === 1,
    'documented limitation — the defence has to live on the client, which is the only '
    + 'side that knows how long the item has been queued');

  // THE ACTUAL FIX (Bug 68): the client refuses to replay past a safe window.
  const offSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', '..', 'public', 'js', 'offline.js'), 'utf8');
  const winMatch = offSrc.match(/IDEMPOTENCY_SAFE_DAYS\s*=\s*(\d+)/);
  const safeDays = winMatch ? Number(winMatch[1]) : null;
  check('the client refuses to replay an item beyond a safe window (Bug 68)',
    safeDays !== null && /isBeyondSafeReplayWindow/.test(offSrc), `window=${safeDays}`);
  check('...and that window is SHORTER than the server\'s 14-day key retention',
    safeDays !== null && safeDays < 14,
    'a replay must be refused while the key is still guaranteed present, never in the '
    + 'grey zone around the pruning boundary');
  check('...and an over-age item is quarantined for a human, not dropped',
    /moveToFailed\([\s\S]{0,200}waiting to sync for more than/.test(offSrc),
    'losing a sale to review is recoverable; duplicating one corrupts books and stock together');
  check('...with a message that says why and what to do',
    /Check whether it already exists/.test(offSrc));

  console.log('\n=== C. IS THE OPERATOR WARNED ABOUT A LONG-STUCK ITEM? ===');
  const offlineSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', '..', 'public', 'js', 'offline.js'), 'utf8');
  check('queued items record WHEN they were queued', /queuedAt/.test(offlineSrc));
  const syncView = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', '..', 'public', 'js', 'views', 'sync.js'), 'utf8');
  check('the Sync screen surfaces the age of a stuck item',
    /queuedAt/.test(syncView),
    'a sale stuck for weeks looks identical to one queued a minute ago');

  console.log('\n' + '='.repeat(62));
  console.log(`STALE-REPLAY PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
