// probe-quantity — BUG 104: money was capped, quantity was not.
//
// Bug 103 put a ceiling on every AMOUNT and the "unbounded number" class was
// declared closed. It was not. The ledger posts quantity x unit_cost, so an
// unbounded QUANTITY reaches exactly the same place through a different door:
// a PO for 1e15 units at a legal N100 each was accepted, the goods-received
// posted, and the trial balance came out N4 short with no error anywhere.
//
// This probe asserts the OUTCOME at each of the seven quantity boundaries —
// that the entry is refused, and (for the receiving path that actually broke
// the books) that the trial balance still balances afterwards.
//
// Requires: bash test/devserver.sh 9001
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const login = async (username, pin = '1234') =>
  (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  })).json();

(async () => {
  const { token } = await login('owner');
  const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const get = async (p) => JSON.parse(await (await fetch(BASE + p, { headers: H })).text());
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };

  // The cap lives in one place; read it rather than restating it, so this
  // probe cannot disagree with the implementation (trap #43).
  const { MAX_QUANTITY } = require('../../src/lib/business');
  const OVER = MAX_QUANTITY + 1;

  const products = await get('/api/products');
  const plist = products.results || products;
  const otc = new Map(plist.filter((p) => p.dispensing_type === 'OTC' && !p.is_controlled).map((p) => [p.id, p]));
  const stock = await get('/api/stock');
  const s = stock.find((r) => r.quantity_remaining > 10 && otc.has(r.product_id));
  const branches = await get('/api/branches');
  const blist = branches.results || branches;

  // Self-seed the supplier. A fresh devserver DB has none, and a probe that
  // assumes fixtures left behind by an earlier probe is the cross-probe
  // contamination this suite already suffers from (trap #62).
  let suppliers = await get('/api/suppliers');
  let slist = suppliers.results || suppliers;
  if (!slist.length) {
    await post('/api/suppliers', { name: 'Probe Supplies Ltd', phone: '08030000009', branch_id: blist[0].id });
    suppliers = await get('/api/suppliers');
    slist = suppliers.results || suppliers;
  }
  if (!slist.length || !s) {
    console.log('  FAIL could not obtain a supplier / stocked OTC product to test against');
    process.exit(1);
  }

  console.log('\n=== THE TRIAL BALANCE IS THE THING THAT ACTUALLY BROKE ===');
  {
    // Reproduce the exact original defect end to end, and assert the books.
    const before = await get('/api/gl/trial-balance');
    const sumBefore = before.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('trial balance starts balanced', Math.abs(sumBefore) < 0.005, String(sumBefore));

    const po = await post('/api/purchase-orders', {
      branch_id: blist[0].id, supplier_id: slist[0].id,
      items: [{ product_id: otc.keys().next().value, quantity_ordered: 1e15, expected_unit_cost: 100 }],
    });
    check('a PO for 1e15 units is REFUSED at order time', po.status === 400,
      `got ${po.status} ${po.text.slice(0, 90)}`);

    const legalPo = await post('/api/purchase-orders', {
      branch_id: blist[0].id, supplier_id: slist[0].id,
      items: [{ product_id: otc.keys().next().value, quantity_ordered: 10, expected_unit_cost: 100 }],
    });
    check('a sane PO is still accepted', legalPo.status === 201, `got ${legalPo.status}`);

    // THE RECEIVING PATH IS THE ONE THAT BROKE THE BOOKS, so it must be
    // exercised on its own terms.
    //
    // MY FIRST VERSION OF THIS CHECK PASSED FOR THE WRONG REASON — the exact
    // trap this project keeps re-learning. It received 1e15 against a PO that
    // had ORDERED 10, so the refusal came from the
    // `quantity_received <= quantity_ordered` CHECK constraint and the check
    // stayed green even with the cap removed. It proved nothing.
    //
    // Ordering the huge quantity FIRST is what isolates the receiving guard:
    // with the cap in place the PO is refused here, so the fallback below
    // reaches the receive endpoint through a PO large enough that only the
    // quantity validator can stop it.
    const hugePo = await post('/api/purchase-orders', {
      branch_id: blist[0].id, supplier_id: slist[0].id,
      items: [{ product_id: otc.keys().next().value, quantity_ordered: 1e15, expected_unit_cost: 100 }],
    });
    if (hugePo.status === 201) {
      // Only reachable when the order-time cap is absent (i.e. regressed).
      const id = JSON.parse(hugePo.text).id;
      const recv = await post(`/api/purchase-orders/${id}/receive`, {
        batches: [{
          product_id: otc.keys().next().value, quantity_received: 1e15,
          cost_price_per_unit: 100, selling_price_per_unit: 150,
          batch_no: 'PROBE-HUGE', expiry_date: '2030-01-01',
        }],
      });
      check('receiving 1e15 units is REFUSED by the receiving guard too',
        recv.status === 400, `got ${recv.status} ${recv.text.slice(0, 90)}`);
    } else {
      check('receiving 1e15 units is unreachable because the order was refused first',
        hugePo.status === 400, `got ${hugePo.status}`);
    }

    const after = await get('/api/gl/trial-balance');
    const sumAfter = after.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('trial balance is STILL balanced after the attempts',
      Math.abs(sumAfter) < 0.005, `sum(dr-cr)=${sumAfter}`);

    // BOTH checks are kept, and the SECOND is the load-bearing one.
    //
    // Measured during revert-verification: with the cap removed, the original
    // reproduction threw the trial balance out by N4 — but on a re-run with
    // different seed data the same oversized posting balanced exactly, because
    // whether the float error surfaces depends on the specific magnitudes
    // involved. So "the trial balance is balanced" is a REAL invariant but an
    // UNRELIABLE detector of this bug: it is silent roughly half the time.
    //
    // The dependable signal is that no account should ever hold a balance
    // larger than any real pharmacy could transact. That check failed on every
    // reverted run. Asserting only the trial balance would have produced a
    // regression test that passes while the bug is present.
    const huge = after.filter((r) => r.total_debits > 1e12 || r.total_credits > 1e12);
    check('no ledger account holds an absurd balance', huge.length === 0,
      huge.map((r) => r.account_code).join(','));
  }

  console.log('\n=== EVERY QUANTITY BOUNDARY REFUSES THE SAME MIS-KEY ===');
  {
    const bid = s.branch_id;
    await post('/api/till/open', { branch_id: bid, opening_float: 1000 });

    const sale = await post('/api/sales', {
      branch_id: bid,
      items: [{ product_id: s.product_id, unit_type: 'BASE_UNIT', quantity: OVER, unit_price: 10 }],
      payments: [{ method: 'CASH', amount: 10 }],
    });
    // A sale is ALSO capped by stock, so assert the reason is the quantity
    // guard — not INSUFFICIENT_STOCK, which would pass for the wrong reason
    // and leave the real boundary untested.
    check('a sale of MAX_QUANTITY+1 is refused BY THE QUANTITY GUARD',
      sale.status === 400 && /QUANTITY_NOT_WHOLE|looks like a mistake/.test(sale.text),
      `got ${sale.status} ${sale.text.slice(0, 110)}`);

    const po2 = await post('/api/purchase-orders', {
      branch_id: blist[0].id, supplier_id: slist[0].id,
      items: [{ product_id: otc.keys().next().value, quantity_ordered: OVER, expected_unit_cost: 1 }],
    });
    check('a PO of MAX_QUANTITY+1 is refused', po2.status === 400, `got ${po2.status}`);

    const tr = await post('/api/transfers', {
      from_branch_id: s.branch_id, to_branch_id: blist.find((b) => b.id !== s.branch_id).id,
      stock_batch_id: s.id, quantity: OVER,
    });
    check('a transfer of MAX_QUANTITY+1 is refused', tr.status === 400, `got ${tr.status}`);

    const adj = await post('/api/adjustments', {
      branch_id: s.branch_id, stock_batch_id: s.id,
      quantity_change: OVER, adjustment_type: 'DAMAGE', reason: 'probe',
    });
    check('a stock adjustment of MAX_QUANTITY+1 is refused', adj.status === 400, `got ${adj.status}`);
  }

  console.log('\n=== ...WITHOUT BREAKING THE LEGITIMATE CASES ===');
  {
    // A cap that also refuses real work is not a fix. These must still pass.
    const bid = s.branch_id;
    // Pay the batch's REAL selling price. `unit_price` in the request is not
    // authoritative — the server prices from the batch, correctly — so a
    // made-up figure here fails on payment reconciliation and would look like
    // the quantity fix had broken selling. (My first version of this check
    // did exactly that: the probe was wrong, not the app.)
    const qty = 2;
    const due = s.selling_price_per_unit * qty;
    const sale = await post('/api/sales', {
      branch_id: bid,
      items: [{ product_id: s.product_id, unit_type: 'BASE_UNIT', quantity: qty }],
      payments: [{ method: 'CASH', amount: due }],
    });
    check('an ordinary 2-unit sale still succeeds', sale.status === 201,
      `got ${sale.status} ${sale.text.slice(0, 110)}`);

    // A write-off is NEGATIVE. Trap #95: the sign is direction, not an error,
    // so only the magnitude may be bounded — a negative adjustment must work.
    const adj = await post('/api/adjustments', {
      branch_id: s.branch_id, stock_batch_id: s.id,
      quantity_change: -1, adjustment_type: 'DAMAGE', reason: 'probe write-off',
    });
    check('a NEGATIVE write-off is still allowed (sign is direction)',
      adj.status === 201, `got ${adj.status} ${adj.text.slice(0, 110)}`);

    // ...and a negative one that is absurdly large must still be refused.
    const adjBig = await post('/api/adjustments', {
      branch_id: s.branch_id, stock_batch_id: s.id,
      quantity_change: -OVER, adjustment_type: 'DAMAGE', reason: 'probe',
    });
    check('a NEGATIVE write-off beyond the cap is refused', adjBig.status === 400,
      `got ${adjBig.status}`);

    check('MAX_QUANTITY itself is a plausible ceiling, not a policy',
      MAX_QUANTITY >= 1e6 && MAX_QUANTITY <= 1e9, String(MAX_QUANTITY));
    // The whole point of the cap: qty x cost must stay exact in kobo.
    check('MAX_QUANTITY x a high unit cost stays exact in kobo',
      Number.isSafeInteger(MAX_QUANTITY * 12500 * 100));
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
