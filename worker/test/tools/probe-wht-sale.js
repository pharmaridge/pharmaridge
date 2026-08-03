// probe-whtsale — BUG 106: a tolerance the ledger refused to honour.
//
// A sale may be settled partly in cash and partly by withholding tax the
// CUSTOMER deducted (a hospital, NGO or government buyer on contract). The
// caller splits the invoice by percentage, so each leg is rounded on its own
// and the two can sum to one kobo more or less than the total. createSale
// deliberately tolerates that. The GENERAL LEDGER did not: it credited revenue
// with the total while debiting the caller's two unreconciled legs, so the
// entry failed to balance and the sale was rejected with the ledger's internal
// wording shown to whoever was at the counter.
//
// Reproduced arithmetically first, which is what turned "one flaky probe
// failure" into a specific, predictable list of prices: 10.30, 10.50, 10.90,
// 11.10, 11.30, 11.50 ... roughly every other price ending in odd kobo. This
// probe drives those exact prices through the real endpoint.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', pin: '1234' }),
  })).json();
  const H = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
  const get = async (p) => JSON.parse(await (await fetch(BASE + p, { headers: H })).text());
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };

  console.log('\n=== THE ARITHMETIC THAT CAUSES IT IS REAL ===');
  {
    // Prove the split can drift BEFORE blaming the server, so a future reader
    // knows this is inherent to percentage splitting and not a server bug.
    const drifting = [];
    for (let c = 1000; c <= 2000; c++) {
      const price = c / 100;
      const legs = round2(round2(price * 0.95) + round2(Math.round(price * 0.05 * 100) / 100));
      if (Math.abs(legs - round2(price)) > 0.0001) drifting.push(price);
    }
    check('a 95/5 split genuinely drifts by a kobo at some prices',
      drifting.length > 0, `${drifting.length} of 1001 prices tested`);
    // 35 of 1001 prices — roughly 1 contract sale in 29. My first version of
    // this check demanded >100 and failed: I had guessed at the rate instead
    // of measuring it. The number that matters is that it is NOT zero and is
    // frequent enough to reach a real client, not that it clears an
    // arbitrary threshold I picked.
    check('...and it is frequent enough to reach a real client',
      drifting.length >= 20, `${drifting.length} of 1001 prices drift`);
  }

  console.log('\n=== EVERY DRIFTING PRICE STILL COMPLETES THE SALE ===');
  {
    const products = await get('/api/products');
    const plist = products.results || products;
    const sellable = new Map(plist.filter((p) => !p.is_controlled && p.dispensing_type !== 'POM')
      .map((p) => [p.id, p]));
    const stock = await get('/api/stock');
    const rows = (stock.results || stock).filter((r) => r.quantity_remaining > 30 && sellable.has(r.product_id));
    check('a sellable batch is available to test against', rows.length > 0);
    if (!rows.length) { console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`); process.exit(1); }
    const b = rows[0];
    await post('/api/till/open', { branch_id: b.branch_id, opening_float: 5000 });

    // Override the unit price so the test drives the EXACT figures proven to
    // break, rather than hoping the seeded prices happen to be among them.
    const prices = [10.30, 10.50, 10.90, 11.10, 11.30, 11.50];
    let ok = 0; const failures = [];
    for (const price of prices) {
      const cash = round2(price * 0.95);
      const wht = Math.round(price * 0.05 * 100) / 100;
      const r = await post('/api/sales', {
        branch_id: b.branch_id,
        items: [{ product_id: b.product_id, unit_type: 'BASE_UNIT', quantity: 1, override_unit_price: price }],
        payments: [{ method: 'CASH', amount: cash }],
        wht_suffered: wht, wht_rate_code: 'PROFESSIONAL_FEES',
      });
      if (r.status === 201) ok++; else failures.push(`${price}->${r.status} ${r.text.slice(0, 70)}`);
    }
    check('every drifting price is accepted', ok === prices.length, failures.join(' | '));
    check('...and none failed with a raw GL error shown to the counter',
      !failures.some((f) => /does not balance/.test(f)), failures.slice(0, 1).join(''));
  }

  console.log('\n=== AND THE BOOKS ARE STILL EXACTLY RIGHT ===');
  {
    const tb = await get('/api/gl/trial-balance');
    const sum = tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('the trial balance still balances to the kobo', Math.abs(sum) < 0.005, `sum(dr-cr)=${sum}`);
    const wr = tb.find((r) => r.account_code === 'WHT_RECEIVABLE');
    check('WHT_RECEIVABLE carries a real balance', !!wr && wr.total_debits > 0,
      wr ? String(wr.total_debits) : 'account absent');

    // The register is the customer's credit note; it keeps the amount actually
    // withheld, which may differ from the posted leg by at most one kobo.
    const reg = await get('/api/wht/entries?direction=RECEIVABLE');
    const list = reg.results || reg;
    check('a RECEIVABLE register row was written for the contract sales',
      Array.isArray(list) && list.length > 0, `n=${Array.isArray(list) ? list.length : 'n/a'}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
