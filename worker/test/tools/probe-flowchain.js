// probe-flowchain — BUG 115, and the inter-related flows a batch travels
// through once it exists.
//
// THE CLASS THIS PROBE OWNS: a fact that is correct where it is CREATED and
// lost where it is COPIED. Bug 112 put the pack size on the batch; Bug 113
// made the sale honour it. Bug 115 was the same defect one hop downstream —
// a TRANSFER created a new batch row at the destination, carried the pack
// PRICE forward and dropped the pack SIZE, so the receiving branch sold 10
// bottles for the price of 24.
//
// Every earlier probe tested one feature against itself. This one follows a
// single delivery all the way through the business:
//
//   receive (carton nesting)
//     -> transfer to another branch
//        -> sell a pack there
//     -> write off some
//     -> stocktake with a variance
//     -> sell and void
//
// and asserts the books balance at every step.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const lg = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', pin: '1234' }),
  })).json();
  const H = { 'content-type': 'application/json', authorization: `Bearer ${lg.token}` };
  const get = async (p) => JSON.parse(await (await fetch(BASE + p, { headers: H })).text());
  const call = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  };
  const post = (p, b) => call('POST', p, b);
  const L = (x) => (x && x.results) ? x.results : x;
  const balanced = async () => {
    const tb = await get('/api/gl/trial-balance');
    return Math.abs(tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0));
  };

  const branches = L(await get('/api/branches')).filter((b) => b.is_active);
  const src = branches[0];
  const dst = branches.find((b) => b.id !== src.id);
  let sup = L(await get('/api/suppliers'));
  if (!sup.length) {
    await post('/api/suppliers', { name: 'Flow Chain Supplies', phone: '08030000012', branch_id: src.id });
    sup = L(await get('/api/suppliers'));
  }

  // A purpose-built product so FEFO has exactly one batch to choose and no
  // result can be attributed to some other stock on the shelf.
  const prod = JSON.parse((await post('/api/products', {
    name: `FlowChain ${Date.now()}`, category: 'OTC', base_unit: 'bottle',
    units_per_pack: 10, packs_per_carton: 10, branch_id: src.id,
  })).text);
  const PACK_AS_DELIVERED = 24;

  console.log('\n=== A DELIVERY ARRIVES WITH ITS OWN PACK SIZE ===');
  let batch;
  {
    const po = JSON.parse((await post('/api/purchase-orders', {
      branch_id: src.id, supplier_id: sup[0].id,
      items: [{ product_id: prod.id, quantity_ordered: 600, expected_unit_cost: 10 }],
    })).text);
    const rec = await post(`/api/purchase-orders/${po.id}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: `FC-${Date.now()}`, expiry_date: '2029-12-31',
        receive_unit: 'PACK', receive_quantity: 25, units_per_pack: PACK_AS_DELIVERED,
        total_cost: 120000, selling_pattern: 'PACK', selling_price_per_unit: 300,
      }],
    });
    check('the delivery is received', rec.status === 200, `${rec.status} ${rec.text.slice(0, 90)}`);
    batch = L(await get('/api/stock')).find((x) => x.product_id === prod.id && x.branch_id === src.id);
    check('600 bottles landed', batch && batch.quantity_remaining === 600, batch ? String(batch.quantity_remaining) : 'none');
    check('the pack size AS DELIVERED is on the batch, not the product default',
      batch.units_per_pack_at_receipt === PACK_AS_DELIVERED && prod.units_per_pack === 10,
      `batch ${batch.units_per_pack_at_receipt}, product ${prod.units_per_pack}`);
  }

  console.log('\n=== BUG 115: A TRANSFER CARRIES THE PACK SIZE, NOT JUST THE PRICE ===');
  let destBatch;
  {
    const tr = await post('/api/transfers', { to_branch_id: dst.id, stock_batch_id: batch.id, quantity: 240 });
    check('the transfer is raised', tr.status === 201, `${tr.status} ${tr.text.slice(0, 90)}`);
    const tid = JSON.parse(tr.text).id;
    const rec = await post(`/api/transfers/${tid}/receive`);
    check('the destination receives it', rec.status === 200, `${rec.status} ${rec.text.slice(0, 90)}`);
    destBatch = L(await get('/api/stock')).find((x) => x.id === JSON.parse(rec.text).new_batch_id);
    check('the new batch exists at the destination', !!destBatch);

    // THE BUG, ASSERTED DIRECTLY.
    check('the pack size crossed the branch boundary with the stock',
      destBatch.units_per_pack_at_receipt === PACK_AS_DELIVERED,
      `destination has ${destBatch.units_per_pack_at_receipt}, source had ${PACK_AS_DELIVERED}`);
    check('...and so did the selling pattern',
      destBatch.selling_pattern === batch.selling_pattern,
      `${destBatch.selling_pattern} vs ${batch.selling_pattern}`);
    check('...and the pack price, as it always did',
      Math.abs(destBatch.pack_price - batch.pack_price) < 0.005);
    // The delivery COUNT must NOT be copied: the source received 25 packs,
    // this branch received part of that. Claiming 25 would make the
    // goods-received record lie.
    check('the original delivery count is NOT claimed by the destination',
      destBatch.received_unit_count == null, String(destBatch.received_unit_count));

    // What the customer actually gets is the only proof that matters.
    await post('/api/till/open', { branch_id: dst.id, opening_float: 5000 });
    const probe = await post('/api/sales', {
      branch_id: dst.id, items: [{ product_id: prod.id, unit_type: 'PACK', quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1 }],
    });
    const m = /sale total \(([\d.]+)\)/.exec(probe.text);
    check('a pack can be priced at the destination', !!m, probe.text.slice(0, 100));
    if (m) {
      const due = Number(m[1]);
      const before = destBatch.quantity_remaining;
      const sale = await post('/api/sales', {
        branch_id: dst.id, items: [{ product_id: prod.id, unit_type: 'PACK', quantity: 1 }],
        payments: [{ method: 'CASH', amount: due }],
      });
      check('the pack sells at the destination', sale.status === 201, `${sale.status} ${sale.text.slice(0, 90)}`);
      const after = L(await get('/api/stock')).find((x) => x.id === destBatch.id);
      const drawn = before - (after ? after.quantity_remaining : 0);
      check('what the customer PAID FOR and RECEIVED agree after a transfer',
        drawn === PACK_AS_DELIVERED,
        `charged for a pack of ${PACK_AS_DELIVERED}, handed over ${drawn}`);
    }
  }

  console.log('\n=== THE REST OF THE CHAIN STILL HOLDS ===');
  {
    check('the books balance after receive + transfer + sale', (await balanced()) < 0.005);

    // Write-off, valued at the batch's own derived cost.
    const cur = L(await get('/api/stock')).find((x) => x.id === batch.id);
    const adj = await post('/api/adjustments', {
      branch_id: src.id, stock_batch_id: batch.id, quantity_change: -7,
      adjustment_type: 'DAMAGE', reason: 'flow chain probe: breakage',
    });
    check('stock can be written off', adj.status === 201, `${adj.status} ${adj.text.slice(0, 90)}`);
    const afterAdj = L(await get('/api/stock')).find((x) => x.id === batch.id);
    check('...by exactly the quantity written off',
      afterAdj.quantity_remaining === cur.quantity_remaining - 7,
      `${afterAdj.quantity_remaining} vs ${cur.quantity_remaining - 7}`);
    check('the books balance after a write-off', (await balanced()) < 0.005);

    // Stocktake with a real variance.
    const st = await post('/api/stocktakes', { branch_id: src.id });
    check('a stocktake can be opened', st.status === 201, `${st.status} ${st.text.slice(0, 90)}`);
    if (st.status === 201) {
      const sid = JSON.parse(st.text).id;
      const full = await get(`/api/stocktakes/${sid}`);
      const line = (full.lines || []).find((l) => l.stock_batch_id === batch.id);
      check('the batch appears on the count sheet', !!line);
      if (line) {
        const cnt = await call('PUT', `/api/stocktakes/lines/${line.id}/count`, { counted_quantity: line.system_quantity - 3 });
        check('a short count is accepted', cnt.status === 200, `${cnt.status} ${cnt.text.slice(0, 80)}`);
        const cl = await post(`/api/stocktakes/${sid}/close`, { reason: 'flow chain probe' });
        check('the stocktake closes', cl.status === 200, `${cl.status} ${cl.text.slice(0, 90)}`);
        check('the books balance after a stocktake variance', (await balanced()) < 0.005);
      }
    }

    // Sale then void — the reversal must restore the SAME batch.
    await post('/api/till/open', { branch_id: src.id, opening_float: 5000 });
    const beforeSale = L(await get('/api/stock')).find((x) => x.id === batch.id).quantity_remaining;
    const sale = await post('/api/sales', {
      branch_id: src.id, items: [{ product_id: prod.id, unit_type: 'BASE_UNIT', quantity: 5 }],
      payments: [{ method: 'CASH', amount: 300 * 5 }],
    });
    check('a piece sale still works on a pack-delivered batch', sale.status === 201, `${sale.status} ${sale.text.slice(0, 90)}`);
    if (sale.status === 201) {
      const v = await post(`/api/sales/${JSON.parse(sale.text).id}/void`, { reason: 'flow chain probe void' });
      check('the sale can be voided', v.status === 200, `${v.status}`);
      const back = L(await get('/api/stock')).find((x) => x.id === batch.id);
      check('voiding returns the stock to the SAME batch it came from',
        back.quantity_remaining === beforeSale, `${back.quantity_remaining} vs ${beforeSale}`);
      check('the books balance after a void', (await balanced()) < 0.005);
    }
  }

  console.log('\n=== STOCK VALUE STILL RECONCILES TO WHAT WAS PAID ===');
  {
    // The per-piece cost is deliberately unrounded (Bug 112). The valuation
    // view multiplies it back, so any rounding introduced downstream would
    // show up here as a drift from the invoice.
    const b = L(await get('/api/stock')).find((x) => x.id === batch.id);
    const perPiece = b.cost_price_per_unit;
    check('the batch cost is full precision, not rounded to kobo',
      Math.abs(perPiece * 600 - 120000) < 0.005,
      `${perPiece} x 600 = ${perPiece * 600}, invoice 120000`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
