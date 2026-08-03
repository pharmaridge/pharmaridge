// probe-receiving — BUG 112: a delivery could only be received in pieces, and
// a unit_type sent with it was silently ignored.
//
// Live-reproduced before the fix: `{quantity_received: 10, unit_type:'CARTON'}`
// on a 10 packs x 10 capsules product recorded **10 capsules instead of 1,000**
// and returned 200. A sale could already be rung up by the carton, so the two
// halves of the same product disagreed about what a carton is.
//
// The model now matches how suppliers actually deliver and invoice: pick the
// unit, state the nesting, give ONE total price, and choose how the counter
// will sell it.
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
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const listOf = (x) => (x && x.results) ? x.results : x;

  const plist = listOf(await get('/api/products'));
  const prod = plist[0];
  const blist = listOf(await get('/api/branches'));
  const bid = blist[0].id;
  let slist = listOf(await get('/api/suppliers'));
  if (!slist.length) {
    await post('/api/suppliers', { name: 'Receiving Probe Supplies', phone: '08030000007', branch_id: bid });
    slist = listOf(await get('/api/suppliers'));
  }
  const mkPo = async (qty) => {
    const r = await post('/api/purchase-orders', {
      branch_id: bid, supplier_id: slist[0].id,
      items: [{ product_id: prod.id, quantity_ordered: qty, expected_unit_cost: 40 }],
    });
    return r.status === 201 ? JSON.parse(r.text).id : null;
  };

  // ---------------------------------------------------------------------
  console.log('\n=== A CARTON DELIVERY LANDS AS THE RIGHT NUMBER OF PIECES ===');
  // ---------------------------------------------------------------------
  {
    const id = await mkPo(1000);
    check('a purchase order can be raised', !!id);
    const r = await post(`/api/purchase-orders/${id}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: 'PRB-CTN', expiry_date: '2030-01-01',
        receive_unit: 'CARTON', receive_quantity: 10, packs_per_carton: 10, units_per_pack: 10,
        total_cost: 480000, selling_pattern: 'PIECE', selling_price_per_unit: 800,
      }],
    });
    check('10 cartons can be received', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);

    const b = listOf(await get('/api/stock')).find((x) => x.batch_no === 'PRB-CTN');
    check('the batch exists', !!b);
    if (b) {
      // THE BUG, ASSERTED DIRECTLY: 10 cartons of 10x10 is 1,000 pieces.
      check('10 cartons x 10 packs x 10 pieces = 1,000 pieces on the shelf',
        b.quantity_remaining === 1000, `got ${b.quantity_remaining}`);
      check('the unit it arrived in is recorded', b.received_unit === 'CARTON', String(b.received_unit));
      check('...and how many of them', b.received_unit_count === 10, String(b.received_unit_count));
      check('the nesting AS DELIVERED is kept on the batch',
        b.packs_per_carton_at_receipt === 10 && b.units_per_pack_at_receipt === 10,
        `${b.packs_per_carton_at_receipt}x${b.units_per_pack_at_receipt}`);
      check('the selling pattern is recorded', b.selling_pattern === 'PIECE', String(b.selling_pattern));

      // ONE total price, split three ways.
      check('cost per piece is derived from the invoice total',
        Math.abs(b.cost_price_per_unit - 480) < 0.0001, String(b.cost_price_per_unit));
      check('...and the pack cost with it', Math.abs(b.pack_price - 4800) < 0.0001, String(b.pack_price));
      check('...and the carton cost', Math.abs(b.carton_price - 48000) < 0.0001, String(b.carton_price));
      check('the invoiced total is kept for audit', Math.abs(b.total_cost - 480000) < 0.0001, String(b.total_cost));
      // The property that actually protects the books.
      check('piece cost x quantity reconciles back to the invoice EXACTLY',
        Math.abs(b.cost_price_per_unit * b.quantity_remaining - 480000) < 0.005,
        String(b.cost_price_per_unit * b.quantity_remaining));
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== A PRICE THAT DOES NOT DIVIDE EVENLY LOSES NO MONEY ===');
  // ---------------------------------------------------------------------
  {
    // 480,000 over 7,000 pieces is 68.5714... If that were rounded to kobo and
    // multiplied back it would value the stock at 479,999.80 — N0.20 short on
    // every such delivery, forever. Full precision is kept for valuation.
    const id = await mkPo(7000);
    const r = await post(`/api/purchase-orders/${id}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: 'PRB-ODD', expiry_date: '2030-01-01',
        receive_unit: 'CARTON', receive_quantity: 10, packs_per_carton: 7, units_per_pack: 100,
        total_cost: 480000, selling_pattern: 'PACK', selling_price_per_unit: 90,
      }],
    });
    check('an awkward division is still accepted', r.status === 200, `${r.status}`);
    const b = listOf(await get('/api/stock')).find((x) => x.batch_no === 'PRB-ODD');
    check('7,000 pieces landed', b && b.quantity_remaining === 7000, b ? String(b.quantity_remaining) : 'missing');
    if (b) {
      check('the stock value still reconciles to the invoice to the kobo',
        Math.abs(b.cost_price_per_unit * b.quantity_remaining - 480000) < 0.005,
        String(b.cost_price_per_unit * b.quantity_remaining));
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== PACKS AND LOOSE PIECES WORK TOO ===');
  // ---------------------------------------------------------------------
  {
    const id = await mkPo(240);
    const r = await post(`/api/purchase-orders/${id}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: 'PRB-PACK', expiry_date: '2030-01-01',
        receive_unit: 'PACK', receive_quantity: 20, units_per_pack: 12,
        total_cost: 24000, selling_pattern: 'PACK', selling_price_per_unit: 120,
      }],
    });
    check('a pack delivery is accepted', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
    const b = listOf(await get('/api/stock')).find((x) => x.batch_no === 'PRB-PACK');
    check('20 packs x 12 = 240 pieces', b && b.quantity_remaining === 240, b ? String(b.quantity_remaining) : 'missing');
    check('a pack delivery has no carton cost invented',
      b && (b.carton_price === null || b.carton_price === undefined), b ? String(b.carton_price) : '');

    const id2 = await mkPo(37);
    const r2 = await post(`/api/purchase-orders/${id2}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: 'PRB-LOOSE', expiry_date: '2030-01-01',
        receive_unit: 'PIECE', receive_quantity: 37,
        total_cost: 3700, selling_pattern: 'PIECE', selling_price_per_unit: 150,
      }],
    });
    check('loose pieces are accepted with no nesting questions', r2.status === 200, `${r2.status} ${r2.text.slice(0, 100)}`);
    const b2 = listOf(await get('/api/stock')).find((x) => x.batch_no === 'PRB-LOOSE');
    check('37 pieces landed as 37', b2 && b2.quantity_remaining === 37, b2 ? String(b2.quantity_remaining) : 'missing');
  }

  // ---------------------------------------------------------------------
  console.log('\n=== ONE DELIVERY, TWO BATCHES OF THE SAME PRODUCT ===');
  // ---------------------------------------------------------------------
  {
    // The client's own scenario: 6 cartons expiring 2027 and 4 expiring 2028
    // arrive together. They must remain SEPARATE batches so FEFO can sell the
    // nearer expiry first — merging them would destroy the whole point.
    const id = await mkPo(1000);
    const r = await post(`/api/purchase-orders/${id}/receive`, {
      batches: [
        { product_id: prod.id, batch_no: 'PRB-S1', expiry_date: '2027-03-31',
          receive_unit: 'CARTON', receive_quantity: 6, packs_per_carton: 10, units_per_pack: 10,
          total_cost: 288000, selling_pattern: 'PIECE', selling_price_per_unit: 800 },
        { product_id: prod.id, batch_no: 'PRB-S2', expiry_date: '2028-09-30',
          receive_unit: 'CARTON', receive_quantity: 4, packs_per_carton: 10, units_per_pack: 10,
          total_cost: 200000, selling_pattern: 'PIECE', selling_price_per_unit: 800 },
      ],
    });
    check('two batch lines for one product are accepted', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    const rows = listOf(await get('/api/stock'));
    const s1 = rows.find((x) => x.batch_no === 'PRB-S1');
    const s2 = rows.find((x) => x.batch_no === 'PRB-S2');
    check('both batches exist separately', !!s1 && !!s2);
    check('...with their own quantities', s1 && s2 && s1.quantity_remaining === 600 && s2.quantity_remaining === 400,
      s1 && s2 ? `${s1.quantity_remaining}/${s2.quantity_remaining}` : '');
    check('...their own expiry dates, so FEFO can still order them',
      s1 && s2 && s1.expiry_date !== s2.expiry_date);
    check('...and their own unit costs from their own invoice lines',
      s1 && s2 && Math.abs(s1.cost_price_per_unit - 480) < 0.001 && Math.abs(s2.cost_price_per_unit - 500) < 0.001,
      s1 && s2 ? `${s1.cost_price_per_unit}/${s2.cost_price_per_unit}` : '');
  }

  // ---------------------------------------------------------------------
  console.log('\n=== THE FORM CANNOT BE FILLED IN A WAY THAT LIES ===');
  // ---------------------------------------------------------------------
  {
    const bad = async (batch, label, expectCode) => {
      const id = await mkPo(50);
      const r = await post(`/api/purchase-orders/${id}/receive`, {
        batches: [{ product_id: prod.id, batch_no: 'PRB-BAD', expiry_date: '2030-01-01',
          selling_price_per_unit: 10, ...batch }],
      });
      let code = '';
      try { code = JSON.parse(r.text).code || ''; } catch (e) {}
      check(label, r.status === 400 && (!expectCode || code === expectCode), `${r.status} ${code || r.text.slice(0, 70)}`);
    };
    await bad({ receive_unit: 'CARTON', receive_quantity: 5, units_per_pack: 10, total_cost: 100 },
      'a carton delivery must say how many packs are in a carton', 'PACKS_PER_CARTON_REQUIRED');
    await bad({ receive_unit: 'PACK', receive_quantity: 5, total_cost: 100 },
      'a pack delivery must say how many pieces are in a pack', 'UNITS_PER_PACK_REQUIRED');
    await bad({ receive_unit: 'BOX', receive_quantity: 5, total_cost: 100 },
      'an unknown unit is refused', 'RECEIVE_UNIT_INVALID');
    await bad({ receive_unit: 'CARTON', receive_quantity: 0, packs_per_carton: 10, units_per_pack: 10, total_cost: 100 },
      'zero cartons is refused', 'RECEIVE_QUANTITY_INVALID');
    await bad({ receive_unit: 'CARTON', receive_quantity: 2.5, packs_per_carton: 10, units_per_pack: 10, total_cost: 100 },
      'half a carton is refused', 'RECEIVE_QUANTITY_INVALID');
    await bad({ receive_unit: 'PIECE', receive_quantity: 5, total_cost: 100, selling_pattern: 'CARTON' },
      'you cannot sell by the carton what arrived as loose pieces', 'SELLING_PATTERN_UNREACHABLE');
    await bad({ receive_unit: 'CARTON', receive_quantity: 5, packs_per_carton: 99999999, units_per_pack: 10, total_cost: 100 },
      'an implausible carton size is refused as a typo', 'PACKS_PER_CARTON_IMPLAUSIBLE');
    await bad({ receive_unit: 'CARTON', receive_quantity: 5, packs_per_carton: 10, units_per_pack: 10, total_cost: -5 },
      'a negative invoice total is refused', 'TOTAL_COST_INVALID');
  }

  // ---------------------------------------------------------------------
  console.log('\n=== THE BOOKS STILL BALANCE AFTER ALL OF THAT ===');
  // ---------------------------------------------------------------------
  {
    const tb = await get('/api/gl/trial-balance');
    const sum = tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('the trial balance balances', Math.abs(sum) < 0.005, `sum(dr-cr)=${sum}`);
    const inv = tb.find((r) => r.account_code === 'INVENTORY_ASSET');
    check('inventory carries a real value', !!inv && inv.total_debits > 0, inv ? String(inv.total_debits) : 'none');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
