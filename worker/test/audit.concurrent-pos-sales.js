// CONCURRENT COUNTER SALES — three separate staff accounts sell from the same
// branch and the same stock batch at once. Verifies atomic stock, cash, sales
// attribution and double-entry reconciliation through live Worker endpoints.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function api(method, path, { token, body, headers } = {}) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: r.status, body: json };
}
async function login(username) {
  const r = await api('POST', '/api/auth/login', { body: { username, pin: '1234' } });
  if (r.status !== 200) throw new Error(`login ${username} failed (${r.status})`);
  return r.body;
}
function trialTotals(rows) {
  return list(rows).reduce((out, row) => ({ debit: out.debit + Number(row.total_debits || 0), credit: out.credit + Number(row.total_credits || 0) }), { debit: 0, credit: 0 });
}

(async () => {
  console.log('=== THREE-STAFF / SAME-STOCK CONCURRENT POS AUDIT ===');
  const owner = await login('owner');
  const branches = list((await api('GET', '/api/branches', { token: owner.token })).body);
  const branch = branches.find((b) => /lagos/i.test(b.name)) || branches.find((b) => b.is_active);
  if (!branch) throw new Error('No active branch available');

  // Use three independently authenticated staff identities at the same shop.
  const staffSessions = [await login('lagos.staff')];
  for (let i = 2; i <= 3; i++) {
    const username = `concurrent.${i}.${suffix()}`;
    const made = await api('POST', '/api/users', { token: owner.token, body: {
      full_name: `Concurrent Counter Staff ${i}`, username, pin: '1234', role: 'STAFF', branch_id: branch.id,
    } });
    check(`staff ${i} account is created for the same branch`, made.status === 201, `status=${made.status} ${JSON.stringify(made.body)}`);
    if (made.status === 201) staffSessions.push(await login(username));
  }
  check('three distinct staff sessions are ready', staffSessions.length === 3 && new Set(staffSessions.map((s) => s.user.id)).size === 3, String(staffSessions.length));

  const openTills = list((await api('GET', `/api/till?branch_id=${encodeURIComponent(branch.id)}`, { token: owner.token })).body).filter((t) => t.status === 'OPEN');
  const till = openTills[0] || (await api('POST', '/api/till/open', { token: staffSessions[0].token, body: { branch_id: branch.id, opening_cash: 1000 } })).body;
  check('one shared branch till is open before simultaneous sales', !!(till && till.id), JSON.stringify(till));

  const supplierRows = list((await api('GET', '/api/suppliers', { token: owner.token })).body);
  let supplier = supplierRows[0];
  if (!supplier) supplier = (await api('POST', '/api/suppliers', { token: owner.token, body: { name: `Concurrent Supplier ${suffix()}`, phone: '08031110000', address: 'Test depot' } })).body;
  const product = await api('POST', '/api/products', { token: owner.token, body: {
    name: `Concurrent Stock ${suffix()}`, category: 'OTC', dispensing_type: 'OTC', base_unit: 'tablet', units_per_pack: 1, reorder_level: 0,
  } });
  check('dedicated concurrent-sale product is created', product.status === 201, `status=${product.status}`);
  if (product.status !== 201) throw new Error('product setup failed');
  const po = await api('POST', '/api/purchase-orders', { token: owner.token, body: {
    branch_id: branch.id, supplier_id: supplier.id, items: [{ product_id: product.body.id, quantity_ordered: 11, expected_unit_cost: 10 }],
  } });
  check('dedicated 11-unit purchase order is created', po.status === 201, `status=${po.status}`);
  const receive = await api('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner.token, body: { batches: [{
    product_id: product.body.id, quantity_received: 11, cost_price_per_unit: 10, selling_price_per_unit: 20,
    batch_no: `CONCURRENT-${suffix()}`, expiry_date: '2031-12-31',
  }] } });
  check('dedicated 11-unit batch is received', receive.status === 200 || receive.status === 201, `status=${receive.status} ${JSON.stringify(receive.body)}`);

  const beforeBatch = list((await api('GET', `/api/stock?branch_id=${encodeURIComponent(branch.id)}`, { token: owner.token })).body).find((b) => b.product_id === product.body.id);
  const expectedBefore = await api('GET', `/api/till/${till.id}/expected`, { token: owner.token });
  check('same-stock fixture starts with exactly 11 units', beforeBatch && Number(beforeBatch.quantity_remaining) === 11, JSON.stringify(beforeBatch));
  const sell = (session, quantity, key) => api('POST', '/api/sales', {
    token: session.token,
    headers: { 'Idempotency-Key': key },
    body: { branch_id: branch.id, items: [{ product_id: product.body.id, quantity, unit_type: 'BASE_UNIT' }], payments: [{ method: 'CASH', amount: quantity * 20, cash_tendered: quantity * 20 }] },
  });

  console.log('\n--- Enough stock: 3 staff × 2 units concurrently ---');
  const firstWave = await Promise.all(staffSessions.map((session, index) => sell(session, 2, `concurrent-full-${index}-${suffix()}`)));
  check('all three simultaneous sales succeed when stock covers demand', firstWave.every((r) => r.status === 201), firstWave.map((r) => r.status).join(','));
  const firstIds = firstWave.map((r) => r.body && r.body.sale && r.body.sale.id || r.body && r.body.id).filter(Boolean);
  const afterFirst = list((await api('GET', `/api/stock?branch_id=${encodeURIComponent(branch.id)}`, { token: owner.token })).body).find((b) => b.id === beforeBatch.id);
  check('shared batch falls by exactly six units after three simultaneous sales', afterFirst && Number(afterFirst.quantity_remaining) === 5, `final=${afterFirst && afterFirst.quantity_remaining}`);

  console.log('\n--- Short stock: 3 staff × 2 units concurrently against 5 remaining ---');
  const secondWave = await Promise.all(staffSessions.map((session, index) => sell(session, 2, `concurrent-short-${index}-${suffix()}`)));
  const successfulSecond = secondWave.filter((r) => r.status === 201);
  const refusedSecond = secondWave.filter((r) => r.status >= 400);
  check('only two of three requests commit when five units remain', successfulSecond.length === 2 && refusedSecond.length === 1, secondWave.map((r) => `${r.status}:${r.body && r.body.code}`).join(' | '));
  check('the losing concurrent sale returns an actionable stock response, not a server error', refusedSecond.length === 1 && refusedSecond[0].status < 500 && /stock|retry|insufficient/i.test(String(refusedSecond[0].body && refusedSecond[0].body.error)), JSON.stringify(refusedSecond[0] && refusedSecond[0].body));
  const afterSecond = list((await api('GET', `/api/stock?branch_id=${encodeURIComponent(branch.id)}`, { token: owner.token })).body).find((b) => b.id === beforeBatch.id);
  check('stock never becomes negative and exactly one unit remains', afterSecond && Number(afterSecond.quantity_remaining) === 1, `final=${afterSecond && afterSecond.quantity_remaining}`);

  const allSaleIds = firstIds.concat(successfulSecond.map((r) => r.body && (r.body.sale && r.body.sale.id || r.body.id)).filter(Boolean));
  const sales = list((await api('GET', `/api/sales?branch_id=${encodeURIComponent(branch.id)}&limit=1000`, { token: owner.token })).body).filter((s) => allSaleIds.includes(s.id));
  check('every committed concurrent request appears exactly once in sales history', sales.length === 5 && new Set(sales.map((s) => s.id)).size === 5, `sales=${sales.length} ids=${allSaleIds.length}`);
  check('all three staff are represented in the five committed sales', new Set(sales.map((s) => s.served_by)).size === 3, JSON.stringify(sales.map((s) => s.served_by)));

  const expectedAfter = await api('GET', `/api/till/${till.id}/expected`, { token: owner.token });
  const committedCash = sales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  check('shared till increases by exactly the five committed cash sales', expectedBefore.status === 200 && expectedAfter.status === 200
    && Math.abs((Number(expectedAfter.body.expected_closing_cash) - Number(expectedBefore.body.expected_closing_cash)) - committedCash) < 0.005,
  JSON.stringify({ before: expectedBefore.body, after: expectedAfter.body, committedCash }));
  const trial = await api('GET', '/api/gl/trial-balance', { token: owner.token });
  const totals = trialTotals(trial.body);
  check('books remain exactly balanced after concurrent sales and one rejected race', trial.status === 200 && Math.abs(totals.debit - totals.credit) < 0.005, JSON.stringify(totals));

  console.log(`\nCONCURRENT POS AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => { console.error('CRASH', err); process.exit(2); });
