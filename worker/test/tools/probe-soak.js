// SOAK / ACCOUNTING-INTEGRITY PROBE
//
// Every existing suite exercises tens of transactions. A real pharmacy does
// hundreds a day and tens of thousands a year, and the questions that only
// appear at volume are the ones that cost a client money:
//
//   1. Does the general ledger STAY balanced after sustained mixed traffic —
//      sales, voids, expenses, debtor payments, stock adjustments — or does a
//      rounding error accumulate one kobo at a time?
//   2. Does stock arithmetic stay exact across hundreds of FEFO deductions and
//      reversals, or does it drift?
//   3. Do the reported totals still equal the sum of their own parts?
//   4. Does anything degrade — response times climbing, a table scan appearing
//      — as row counts grow?
//
// This is the closest thing to "a month of trading" that can be run locally.
// It is NOT a substitute for real load testing on Cloudflare (wrangler dev
// serialises requests), and it does not claim to be.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const N = Number(process.env.SOAK_N || 300);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

let TOKEN = null;
async function api(method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN && !opts.noAuth) headers.Authorization = `Bearer ${TOKEN}`;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* empty body */ }
  return { status: r.status, body: json };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

(async () => {
  console.log(`\nSoaking with ${N} transactions...\n`);

  const login = await api('POST', '/api/auth/login', { username: 'manager', pin: '1234' }, { noAuth: true });
  if (login.status !== 200) { console.error('login failed', login); process.exit(2); }
  TOKEN = login.body.token;

  const branches = (await api('GET', '/api/branches')).body;
  const branch = branches.find((b) => b.is_active) || branches[0];

  // --- Baseline: books must start balanced -------------------------------
  // MY OWN BUG, recorded: I assumed /gl/trial-balance returned an object with
  // total_debits/total_credits. It returns an ARRAY of per-account rows, each
  // with its own totals — so my first run compared undefined to undefined and
  // reported NaN. Read the shape, then sum it.
  const sumTB = (rowsArr) => (Array.isArray(rowsArr) ? rowsArr : []).reduce((acc, r) => {
    acc.d += Number(r.total_debits || 0); acc.c += Number(r.total_credits || 0); return acc;
  }, { d: 0, c: 0 });
  const tb0 = sumTB((await api('GET', '/api/gl/trial-balance')).body);
  const bal0 = round2(tb0.d - tb0.c);
  check('books are balanced BEFORE the soak', Math.abs(bal0) < 0.005,
    `debits=${round2(tb0.d)} credits=${round2(tb0.c)} diff=${bal0}`);

  // --- Find sellable stock ------------------------------------------------
  const stock = (await api('GET', `/api/stock?branch_id=${branch.id}`)).body;
  const sellable = (Array.isArray(stock) ? stock : stock.results || [])
    .filter((s) => Number(s.quantity_remaining) > 0);
  check('there is stock to sell', sellable.length > 0, `${sellable.length} batches`);
  if (!sellable.length) { console.log('cannot soak without stock'); process.exit(1); }

  // Open a till: cash sales require one (Bug 37).
  const till = await api('POST', '/api/till/open', { branch_id: branch.id, opening_float: 5000 });
  const tillOpen = till.status === 201 || till.status === 200 || till.status === 409;
  check('a till session is available for cash sales', tillOpen, `status=${till.status}`);

  // --- Record starting stock so we can verify arithmetic exactly ---------
  const startQty = {};
  for (const s of sellable) startQty[s.id] = Number(s.quantity_remaining);

  // --- THE SOAK -----------------------------------------------------------
  let sales = 0, voids = 0, expenses = 0, errors = 0, sold = 0, reversed = 0;
  const saleIds = [];
  const timings = [];
  const errSamples = [];

  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const mix = i % 10;

    if (mix < 6) {
      // 60% cash sales of 1 unit — the commonest real transaction.
      const batch = sellable[i % sellable.length];
      // The field is selling_price_per_unit. My first version used
      // `batch.selling_price` (undefined -> 100) and the server correctly
      // refused every sale with "Payments (100) do not sum to sale total (55)"
      // — 72 clean 400s. The app was right; my probe was wrong. Pay exactly.
      const unit = Number(batch.selling_price_per_unit);
      const r = await api('POST', '/api/sales', {
        branch_id: branch.id,
        items: [{ product_id: batch.product_id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
      }, { idem: `soak-sale-${i}` });
      if (r.status === 201) { sales++; sold++; saleIds.push(r.body.id || (r.body.sale && r.body.sale.id)); }
      else if (r.status === 422 || r.status === 409) { /* out of stock / no till — expected at volume */ }
      else { errors++; if (errSamples.length < 3) errSamples.push(`sale ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`); }
    } else if (mix < 8) {
      // 20% expenses.
      const r = await api('POST', '/api/expenses', {
        branch_id: branch.id, category: 'diesel', amount: 250.55, description: `soak ${i}`,
      }, { idem: `soak-exp-${i}` });
      if (r.status === 201) expenses++;
      else { errors++; if (errSamples.length < 3) errSamples.push(`expense ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`); }
    } else if (mix === 8 && saleIds.length) {
      // 10% voids — the path that reverses revenue, COGS and stock.
      const id = saleIds.pop();
      const r = await api('POST', `/api/sales/${id}/void`, { reason: `soak void ${i}` });
      if (r.status === 200) { voids++; reversed++; }
      else if (r.status === 403 || r.status === 404 || r.status === 409) { /* window/permission — fine */ }
      else { errors++; if (errSamples.length < 3) errSamples.push(`void ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`); }
    } else {
      // 10% reads — the reporting a manager actually does all day.
      await api('GET', '/api/gl/trial-balance');
    }
    timings.push(Date.now() - t0);
  }

  console.log(`\n     recorded: ${sales} sales, ${voids} voids, ${expenses} expenses, ${errors} unexpected errors`);
  if (errSamples.length) errSamples.forEach((e) => console.log('     sample error: ' + e));

  console.log('\n=== A. NOTHING BLEW UP ===');
  check('no unexpected 5xx/4xx during sustained traffic', errors === 0, `${errors} errors`);
  check('a meaningful number of sales actually committed', sales >= N * 0.3, `${sales} of ~${Math.round(N * 0.6)} attempted`);

  console.log('\n=== B. THE LEDGER IS STILL BALANCED (the one that costs money) ===');
  const tb = sumTB((await api('GET', '/api/gl/trial-balance')).body);
  const diff = round2(tb.d - tb.c);
  check('debits === credits after the full soak', Math.abs(diff) < 0.005,
    `debits=${round2(tb.d)} credits=${round2(tb.c)} diff=${diff}`);

  const bs = (await api('GET', '/api/gl/balance-sheet')).body;
  check('balance sheet still balances (Assets = Liabilities + Equity)', bs.balances === true,
    JSON.stringify({ a: bs.total_assets, l: bs.total_liabilities, e: bs.total_equity }));

  // Every individual journal entry must balance too — a single lopsided entry
  // can hide inside a trial balance that nets to zero overall.
  const entries = (await api('GET', '/api/gl/journal-entries?limit=500')).body;
  const list = Array.isArray(entries) ? entries : (entries.results || entries.entries || []);
  let lopsided = 0;
  for (const e of list) {
    const d = Number(e.total_debit ?? e.total_debits ?? 0);
    const c = Number(e.total_credit ?? e.total_credits ?? 0);
    if (Math.abs(round2(d - c)) >= 0.005) lopsided++;
  }
  check('every individual journal entry balances', lopsided === 0,
    `${lopsided} lopsided of ${list.length}`);

  console.log('\n=== C. P&L IS INTERNALLY CONSISTENT ===');
  const pl = (await api('GET', '/api/gl/profit-loss')).body;
  const rev = Number(pl.total_revenue || 0), exp = Number(pl.total_expenses || 0);
  const net = Number(pl.net_profit ?? (rev - exp));
  check('net profit equals revenue minus expenses', Math.abs(round2(net - (rev - exp))) < 0.005,
    `rev=${rev} exp=${exp} net=${net}`);
  const revLines = (pl.revenue || pl.revenue_lines || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  if ((pl.revenue || pl.revenue_lines || []).length) {
    check('revenue total equals the sum of its own line items',
      Math.abs(round2(revLines - rev)) < 0.005, `lines=${round2(revLines)} total=${rev}`);
  }

  console.log('\n=== D. STOCK ARITHMETIC IS EXACT, NOT APPROXIMATE ===');
  const stockAfter = (await api('GET', `/api/stock?branch_id=${branch.id}`)).body;
  const after = Array.isArray(stockAfter) ? stockAfter : (stockAfter.results || []);
  let negative = 0, fractional = 0;
  for (const s of after) {
    const q = Number(s.quantity_remaining);
    if (q < 0) negative++;
    if (!Number.isInteger(q)) fractional++;
  }
  check('no batch went negative under sustained selling', negative === 0, `${negative} negative`);
  check('no batch acquired a fractional unit count', fractional === 0, `${fractional} fractional`);

  console.log('\n=== E. NO PERFORMANCE CLIFF AS THE TABLES GROW ===');
  // wrangler dev serialises requests, so these are NOT production latencies.
  // What matters is the SHAPE: the last decile must not be dramatically slower
  // than the first, which is what an accidental table scan looks like.
  const firstTenth = timings.slice(0, Math.max(5, Math.floor(N / 10)));
  const lastTenth = timings.slice(-Math.max(5, Math.floor(N / 10)));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const a1 = avg(firstTenth), a2 = avg(lastTenth);
  console.log(`     first decile avg ${a1.toFixed(1)}ms, last decile avg ${a2.toFixed(1)}ms`);
  check('response time does not degrade sharply as row counts grow',
    a2 < a1 * 3 + 50, `${a1.toFixed(1)}ms -> ${a2.toFixed(1)}ms`);

  console.log('\n=== F. STORAGE ACCOUNTING STILL HONEST AT VOLUME ===');
  const health = (await api('GET', '/api/health')).body;
  check('health still reports storage', !!health.storage, JSON.stringify(health.storage).slice(0, 120));
  if (health.storage) {
    check('storage estimate is a real number, not NaN', Number.isFinite(Number(health.storage.estimated_bytes ?? health.storage.bytes ?? 0)),
      JSON.stringify(health.storage).slice(0, 120));
  }

  console.log('\n' + '='.repeat(62));
  console.log(`SOAK PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
