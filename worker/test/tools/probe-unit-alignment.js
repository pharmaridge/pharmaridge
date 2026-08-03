// probe-unitalign — BUG 113: "a pack" meant a different number of pieces to
// the PRICE than it did to the SHELF.
//
// Bug 112 began recording the nesting AS DELIVERED on each batch, because
// suppliers genuinely differ — the same syrup arrives 10-to-a-pack from one
// and 24 from another. Pricing already read the BATCH (unitPriceFor), but the
// QUANTITY was still computed from the PRODUCT's default, so the two halves of
// one sale answered to different authorities.
//
// Live-reproduced: a batch delivered as packs of 24 on a product defaulting to
// 10. Selling "1 pack" charged the batch's N4,800 and removed 10 bottles. The
// customer paid for 24 and carried away 10; the stock file agreed with neither
// the invoice nor the shelf, and nothing errored.
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
  const L = (x) => (x && x.results) ? x.results : x;
  const bid = L(await get('/api/branches'))[0].id;
  let sup = L(await get('/api/suppliers'));
  if (!sup.length) {
    await post('/api/suppliers', { name: 'Unit Align Supplies', phone: '08030000011', branch_id: bid });
    sup = L(await get('/api/suppliers'));
  }

  // A brand-new product per case, so FEFO has exactly one batch to choose and
  // the result cannot be attributed to some other stock on the shelf. (A
  // shared product made an earlier run inconclusive: FEFO drew from a
  // different batch entirely and the test proved nothing.)
  async function scenario({ label, productPack, productCarton, unit, count, upp, ppc, total, sellUnit }) {
    const pr = await post('/api/products', {
      name: `UnitAlign ${label} ${Date.now()}`, category: 'OTC', base_unit: 'bottle',
      units_per_pack: productPack, packs_per_carton: productCarton, branch_id: bid,
    });
    const prod = JSON.parse(pr.text);
    const po = JSON.parse((await post('/api/purchase-orders', {
      branch_id: bid, supplier_id: sup[0].id,
      items: [{ product_id: prod.id, quantity_ordered: 5000, expected_unit_cost: 10 }],
    })).text);
    const batchNo = `UA-${label}-${Date.now()}`;
    const rec = await post(`/api/purchase-orders/${po.id}/receive`, {
      batches: [{
        product_id: prod.id, batch_no: batchNo, expiry_date: '2029-12-31',
        receive_unit: unit, receive_quantity: count,
        units_per_pack: upp, packs_per_carton: ppc,
        total_cost: total, selling_pattern: sellUnit, selling_price_per_unit: 100,
      }],
    });
    if (rec.status !== 200) return { error: `receive ${rec.status} ${rec.text.slice(0, 90)}` };
    const batch = L(await get('/api/stock')).find((x) => x.batch_no === batchNo);
    await post('/api/till/open', { branch_id: bid, opening_float: 5000 });

    // Ask the server what one of `sellUnit` costs by letting it refuse an
    // underpayment — the refusal names the true total.
    const probe = await post('/api/sales', {
      branch_id: bid, items: [{ product_id: prod.id, unit_type: sellUnit === 'PIECE' ? 'BASE_UNIT' : sellUnit, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1 }],
    });
    const m = /sale total \(([\d.]+)\)/.exec(probe.text);
    if (!m) return { error: `could not read the price: ${probe.status} ${probe.text.slice(0, 90)}` };
    const due = Number(m[1]);
    const before = batch.quantity_remaining;
    const sale = await post('/api/sales', {
      branch_id: bid, items: [{ product_id: prod.id, unit_type: sellUnit === 'PIECE' ? 'BASE_UNIT' : sellUnit, quantity: 1 }],
      payments: [{ method: 'CASH', amount: due }],
    });
    const after = L(await get('/api/stock')).find((x) => x.batch_no === batchNo);
    return {
      prod, batch, due, saleStatus: sale.status,
      drawn: before - (after ? after.quantity_remaining : 0),
    };
  }

  console.log('\n=== A PACK MEANS THE SAME THING TO THE PRICE AND TO THE SHELF ===');
  {
    // The exact reproduction: product says 10, delivery says 24.
    const s = await scenario({ label: 'pack', productPack: 10, productCarton: 10,
      unit: 'PACK', count: 25, upp: 24, ppc: undefined, total: 120000, sellUnit: 'PACK' });
    check('the scenario could be built', !s.error, s.error || '');
    if (!s.error) {
      check('the batch records the pack size AS DELIVERED',
        s.batch.units_per_pack_at_receipt === 24, String(s.batch.units_per_pack_at_receipt));
      check('...which deliberately differs from the product default',
        s.prod.units_per_pack === 10, String(s.prod.units_per_pack));
      check('the sale completes', s.saleStatus === 201, String(s.saleStatus));
      // THE BUG: price came from the batch, quantity from the product.
      check('selling ONE PACK removes the number of pieces the batch really holds',
        s.drawn === 24, `removed ${s.drawn}, batch holds ${s.batch.units_per_pack_at_receipt} per pack`);
      check('...and the price charged is that same pack\'s price',
        Math.abs(s.due - s.batch.pack_price) < 0.005, `charged ${s.due}, batch pack_price ${s.batch.pack_price}`);
      // The property that actually protects the customer and the books.
      check('what the customer PAID FOR and what they RECEIVED agree',
        Math.abs(s.due - s.drawn * s.batch.cost_price_per_unit * (s.due / (s.batch.units_per_pack_at_receipt * s.batch.cost_price_per_unit))) < 0.01
        || s.drawn === s.batch.units_per_pack_at_receipt,
        `paid for ${s.batch.units_per_pack_at_receipt}, received ${s.drawn}`);
    }
  }

  console.log('\n=== THE SAME HOLDS FOR A CARTON ===');
  {
    const s = await scenario({ label: 'carton', productPack: 10, productCarton: 10,
      unit: 'CARTON', count: 5, upp: 12, ppc: 8, total: 96000, sellUnit: 'CARTON' });
    check('the carton scenario could be built', !s.error, s.error || '');
    if (!s.error) {
      check('the batch records the carton nesting as delivered',
        s.batch.packs_per_carton_at_receipt === 8 && s.batch.units_per_pack_at_receipt === 12,
        `${s.batch.packs_per_carton_at_receipt}x${s.batch.units_per_pack_at_receipt}`);
      check('selling ONE CARTON removes 8 x 12 = 96 pieces', s.drawn === 96,
        `removed ${s.drawn}`);
      check('...and is priced from that carton', Math.abs(s.due - s.batch.carton_price) < 0.005,
        `charged ${s.due}, batch carton_price ${s.batch.carton_price}`);
    }
  }

  console.log('\n=== OLD STOCK WITHOUT RECORDED NESTING STILL WORKS ===');
  {
    // Batches created before Bug 112 have NULL nesting. They really WERE
    // received at the product default, so falling back to it is correct — and
    // must keep working, or the fix breaks every existing pharmacy's shelf.
    const rows = L(await get('/api/stock'))
      .filter((r) => !r.units_per_pack_at_receipt && r.quantity_remaining > 30 && r.pack_price > 0);
    check('legacy batches with no recorded nesting exist to test against', rows.length > 0,
      `n=${rows.length}`);
    if (rows.length) {
      const r = rows[0];
      const prods = L(await get('/api/products'));
      const prod = prods.find((p) => p.id === r.product_id);
      await post('/api/till/open', { branch_id: r.branch_id, opening_float: 5000 });
      const probe = await post('/api/sales', {
        branch_id: r.branch_id, items: [{ product_id: r.product_id, unit_type: 'PACK', quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1 }],
      });
      const m = /sale total \(([\d.]+)\)/.exec(probe.text);
      check('a legacy batch can still be priced by the pack', !!m, probe.text.slice(0, 90));
      if (m) {
        const before = r.quantity_remaining;
        const sale = await post('/api/sales', {
          branch_id: r.branch_id, items: [{ product_id: r.product_id, unit_type: 'PACK', quantity: 1 }],
          payments: [{ method: 'CASH', amount: Number(m[1]) }],
        });
        check('...and sold', sale.status === 201, `${sale.status} ${sale.text.slice(0, 80)}`);
        const after = L(await get('/api/stock')).find((x) => x.id === r.id);
        const drawn = before - (after ? after.quantity_remaining : 0);
        check('...falling back to the product default, as it should',
          drawn === (prod.units_per_pack || 1), `removed ${drawn}, product default ${prod.units_per_pack}`);
      }
    }
  }

  console.log('\n=== THE BOOKS SURVIVE ALL OF IT ===');
  {
    const tb = await get('/api/gl/trial-balance');
    const sum = tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('the trial balance still balances', Math.abs(sum) < 0.005, `sum(dr-cr)=${sum}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
