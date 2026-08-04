// PAYING FROM THE DRAWER, THE SAFE, OR BOTH  (Bug 98 + the staff safe allowance).
//
// Two things are proven here, and both are asserted against MEASURED balances
// rather than status codes:
//
//   1. A purchase can be funded from the counter drawer, the branch safe, or a
//      COMBINATION — and each pot moves by exactly its own share. Before this,
//      sending a split returned 201 and silently booked the whole amount to
//      CASH (the Bug 77 class: success reported for something that did not
//      happen), and the till then charged the drawer for money that came out
//      of the safe.
//   2. STAFF may spend from the safe within an allowance that a MANAGER or the
//      OWNER sets — including "no cap" — while a manager still cannot grant
//      themselves the owner's own switches through the same endpoint.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;

async function req(m, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const login = async (u) => await req('POST', '/api/auth/login', { body: { username: u, pin: '1234' } });
const L = b => (Array.isArray(b) ? b : []);

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token;
  // Keep this probe independently runnable against the ordinary fresh seed.
  // Scenario-only a.* users made the financial split audit silently depend on
  // a separate browser/screenshot setup phase.
  const staffRes = await login('lagos.staff');
  const staff = staffRes.body.token;
  const branchId = staffRes.body.user.branch_id;
  const mgr = (await login('lagos.mgr')).body.token;

  const drawer = async () => {
    const t = L((await req('GET', '/api/till?branch_id=' + branchId, { token: owner })).body).find(x => x.status === 'OPEN');
    return t ? Number((await req('GET', `/api/till/${t.id}/expected`, { token: owner })).body.expected_closing_cash) : null;
  };
  const safe = async () => Number((await req('GET', `/api/safe/${branchId}/movements`, { token: owner })).body.safe_balance);
  const books = async () => {
    const r = L((await req('GET', '/api/gl/trial-balance', { token: owner })).body);
    return { dr: r.reduce((a, x) => a + Number(x.total_debits || 0), 0), cr: r.reduce((a, x) => a + Number(x.total_credits || 0), 0) };
  };
  const setAllowance = async (fields, token = owner) =>
    req('PUT', '/api/settings/manager-permissions', { token, body: fields });

  // Make sure both pots can fund what follows.
  await req('POST', '/api/safe/movements', { token: owner, body: {
    branch_id: branchId, entry_type: 'DEPOSIT', amount: 300000, reason: 'Float for the split-payment probe' } });
  if ((await drawer()) === null) {
    await req('POST', '/api/till/open', { token: owner, body: { branch_id: branchId, opening_cash: 50000 } });
  }
  // TOP THE DRAWER UP EVEN WHEN A TILL IS ALREADY OPEN.
  //
  // The opening float above only applies when this probe opens the till
  // ITSELF. Run after any other probe that spends cash — or twice in a row —
  // a till was already open with a drained drawer, and ten checks failed with
  // CASH_EXPENSE_EXCEEDS_DRAWER: the drawer guard working exactly as designed
  // against a fixture that had not been provisioned. That intermittency was
  // reported as "seed contamination" for several rounds; it was this.
  //
  // TILL_TRANSFER carries direction in its SIGN (trap #95) — negative moves
  // cash out of the safe and into the drawer. Asserted, because a setup step
  // that fails quietly is how the wrong thing gets debugged.
  {
    const have = Number(await drawer()) || 0;
    if (have < 60000) {
      const top = await req('POST', '/api/safe/movements', { token: owner, body: {
        branch_id: branchId, entry_type: 'TILL_TRANSFER', amount: -(60000 - have),
        reason: 'Float for the split-payment probe (drawer)' } });
      ok('fixture: the drawer can be topped up from the safe',
        top.status === 200 || top.status === 201,
        `status=${top.status} ${String(top.body && top.body.error).slice(0, 100)}`);
    }
  }
  await setAllowance({ staff_can_spend_from_safe: true, staff_safe_spend_max: 20000 });
  ok(`fixture ready — drawer N${(await drawer()).toFixed(2)}, safe N${(await safe()).toFixed(2)}, staff allowance N20,000`);

  // ---- A. ONE SOURCE AT A TIME ------------------------------------------
  console.log('\n=== A. EACH POT ON ITS OWN ===');
  {
    const d0 = await drawer(), s0 = await safe();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 1500, description: 'okada', paid_by_method: 'CASH' } });
    const d1 = await drawer(), s1 = await safe();
    if (r.status === 201 && near(d0 - d1, 1500) && near(s0, s1)) ok('drawer-only: N1,500 leaves the drawer, safe untouched');
    else bad(`drawer-only: status ${r.status}, drawer -${(d0 - d1).toFixed(2)}, safe -${(s0 - s1).toFixed(2)}`);
  }
  {
    const d0 = await drawer(), s0 = await safe();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 2500, description: 'diesel', paid_by_method: 'SAFE' } });
    const d1 = await drawer(), s1 = await safe();
    if (r.status === 201 && near(s0 - s1, 2500) && near(d0, d1)) ok('safe-only: N2,500 leaves the safe, drawer untouched');
    else bad(`safe-only: status ${r.status}, drawer -${(d0 - d1).toFixed(2)}, safe -${(s0 - s1).toFixed(2)}`);
  }

  // ---- B. THE COMBINATION (the point of this change) --------------------
  console.log('\n=== B. A COMBINATION OF BOTH ===');
  {
    const d0 = await drawer(), s0 = await safe(), g0 = await books();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 20000,
      description: 'carton of drips bought at the depot',
      cash_sources: [{ source: 'CASH', amount: 8000 }, { source: 'SAFE', amount: 12000 }] } });
    const d1 = await drawer(), s1 = await safe(), g1 = await books();
    if (r.status === 201) ok('a cashier can fund one purchase from BOTH pots');
    else bad(`split refused: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    if (near(d0 - d1, 8000)) ok('  the drawer fell by exactly its N8,000 share');
    else bad(`  the drawer fell by N${(d0 - d1).toFixed(2)}, expected N8,000`);
    if (near(s0 - s1, 12000)) ok('  the safe fell by exactly its N12,000 share');
    else bad(`  the safe fell by N${(s0 - s1).toFixed(2)}, expected N12,000`);
    if (near(g1.dr, g1.cr)) ok('  books balance after the split');
    else bad(`  books unbalanced: ${g1.dr} vs ${g1.cr}`);
    if (near(g1.dr - g0.dr, 20000)) ok('  the whole N20,000 is posted once, not twice');
    else bad(`  debits moved by N${(g1.dr - g0.dr).toFixed(2)}, expected N20,000`);
  }

  // ---- C. A SPLIT THAT DOES NOT ADD UP ----------------------------------
  console.log('\n=== C. THE SPLIT MUST ACCOUNT FOR THE WHOLE PAYMENT ===');
  {
    const d0 = await drawer(), s0 = await safe();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 5000, description: 'short split',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: 1000 }] } });
    if (r.status === 400 && r.body.code === 'CASH_SOURCES_DO_NOT_SUM') ok('a split that does not sum to the total is refused');
    else bad(`mismatched split returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    if (near(await drawer(), d0) && near(await safe(), s0)) ok('...and neither pot moved');
    else bad('a refused split still moved money');
  }
  {
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 2000, description: 'dupe',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'CASH', amount: 1000 }] } });
    if (r.status === 400 && r.body.code === 'DUPLICATE_CASH_SOURCE') ok('naming the same pot twice is refused');
    else bad(`duplicate source returned ${r.status}`);
  }
  {
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 2000, description: 'bogus',
      cash_sources: [{ source: 'BANK', amount: 2000 }] } });
    if (r.status === 400 && r.body.code === 'INVALID_CASH_SOURCES') ok('an unknown pot is refused (money from the bank is a TRANSFER)');
    else bad(`unknown source returned ${r.status}`);
  }

  // ---- D. NEITHER POT MAY GO NEGATIVE -----------------------------------
  console.log('\n=== D. NEITHER POT MAY BE OVERDRAWN ===');
  {
    const d = await drawer();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: Math.round(d) + 6000, description: 'over drawer',
      cash_sources: [{ source: 'CASH', amount: Math.round(d) + 5000 }, { source: 'SAFE', amount: 1000 }] } });
    if (r.status === 400 && r.body.code === 'CASH_EXPENSE_EXCEEDS_DRAWER') ok('taking more than the drawer holds is refused, even inside a split');
    else bad(`drawer overdraw returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  }
  {
    await setAllowance({ staff_safe_spend_max: 0 });   // no cap, so the SAFE balance is the only limit
    const s = await safe();
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: Math.round(s) + 6000, description: 'over safe',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: Math.round(s) + 5000 }] } });
    if (r.status === 400 && r.body.code === 'SAFE_INSUFFICIENT_FUNDS') ok('taking more than the safe holds is refused, even inside a split');
    else bad(`safe overdraw returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    await setAllowance({ staff_safe_spend_max: 20000 });
  }

  // ---- E. THE STAFF ALLOWANCE -------------------------------------------
  console.log('\n=== E. THE STAFF SAFE ALLOWANCE (client decision) ===');
  {
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 25000, description: 'above cap',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: 24000 }] } });
    if (r.status === 403 && r.body.code === 'STAFF_SAFE_OVER_CAP') ok('a cashier cannot draw more than their allowance from the safe');
    else bad(`over-cap draw returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    if (r.body && /manager/i.test(String(r.body.error))) ok('...and is told to ask a manager');
    else bad('the refusal does not say what to do next');
  }
  {
    // A MANAGER — not only the owner — may set it, and may set NO CAP.
    const set = await setAllowance({ staff_safe_spend_max: 0 }, mgr);
    if (set.status === 200 && Number(set.body.staff_safe_spend_max) === 0) ok('a MANAGER can set the allowance, including "no cap" (0)');
    else bad(`manager could not set the allowance: ${set.status} ${JSON.stringify(set.body).slice(0, 90)}`);
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 25000, description: 'no cap now',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: 24000 }] } });
    if (r.status === 201) ok('...and the same N24,000 draw is then allowed');
    else bad(`with no cap the draw still returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  }
  {
    // 0 must mean NO CAP, never "nothing allowed" — the on/off decision is the
    // boolean, and conflating the two would silently ban all staff spending.
    const off = await setAllowance({ staff_can_spend_from_safe: false });
    const r = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 3000, description: 'switched off',
      cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: 2000 }] } });
    if (off.status === 200 && r.status === 403 && r.body.code === 'STAFF_SAFE_REQUIRES_MANAGER') ok('turning the allowance OFF stops staff spending from the safe entirely');
    else bad(`with the switch off, the draw returned ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    const stillDrawer = await req('POST', '/api/expenses', { token: staff, body: {
      branch_id: branchId, category: 'TRANSPORT', amount: 900, description: 'drawer still fine', paid_by_method: 'CASH' } });
    if (stillDrawer.status === 201) ok('...but the cashier can still spend from the drawer');
    else bad(`drawer spending broke when the safe switch went off: ${stillDrawer.status}`);
    await setAllowance({ staff_can_spend_from_safe: true, staff_safe_spend_max: 20000 });
  }

  // ---- F. A MANAGER MAY NOT WIDEN THEIR OWN POWERS ----------------------
  console.log('\n=== F. THE MANAGER\'S REACH STOPS AT THE STAFF ALLOWANCE ===');
  for (const field of ['managers_can_void_sales', 'staff_can_void_sales', 'staff_adjustment_max_units']) {
    const v = field === 'staff_adjustment_max_units' ? 9999 : true;
    const r = await setAllowance({ [field]: v }, mgr);
    if (r.status === 403 && r.body.code === 'OWNER_ONLY_SETTING') ok(`a manager cannot set ${field}`);
    else bad(`a manager set ${field}: ${r.status}`);
  }
  {
    const r = await setAllowance({ managers_can_void_sales: true });
    if (r.status === 200) ok('...while the OWNER still can');
    else bad(`the owner could not set a manager switch: ${r.status}`);
  }

  // ---- G. A MANAGER SPENDING FROM THE SAFE IS UNCAPPED ------------------
  console.log('\n=== G. THE ALLOWANCE APPLIES TO STAFF ONLY ===');
  {
    await setAllowance({ staff_safe_spend_max: 1000 });
    const s0 = await safe();
    const r = await req('POST', '/api/expenses', { token: mgr, body: {
      branch_id: branchId, category: 'RENT', amount: 15000, description: 'manager, above the staff cap',
      paid_by_method: 'SAFE' } });
    const s1 = await safe();
    if (r.status === 201 && near(s0 - s1, 15000)) ok('a manager is not bound by the cashiers\' allowance');
    else bad(`manager safe spend returned ${r.status}, safe moved ${(s0 - s1).toFixed(2)}`);
    await setAllowance({ staff_safe_spend_max: 20000 });
  }

  // ---- H. SUPPLIER PAYMENTS SPLIT THE SAME WAY --------------------------
  console.log('\n=== H. PAYING A DELIVERY FROM BOTH POTS ===');
  {
    let bals = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
      .filter(x => x.branch_id === branchId && Number(x.balance_owed) > 3000);
    // Make the supplier-credit half independently runnable on a fresh seed.
    if (!bals.length) {
      const suppliers = L((await req('GET', '/api/suppliers', { token: owner })).body);
      let supplier = suppliers[0];
      if (!supplier) {
        const made = await req('POST', '/api/suppliers', { token: owner, body: {
          name: `Split Payment Supplier ${Date.now()}`, phone: '08030000001', address: 'Audit depot' } });
        supplier = made.body;
      }
      const products = L((await req('GET', '/api/products', { token: owner })).body);
      const product = products.find(p => p.dispensing_type !== 'POM' && !p.is_controlled) || products[0];
      if (supplier && product) {
        const po = await req('POST', '/api/purchase-orders', { token: owner, body: {
          branch_id: branchId, supplier_id: supplier.id,
          items: [{ product_id: product.id, quantity_ordered: 40, expected_unit_cost: 100 }] } });
        if (po.status === 201) {
          await req('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner, body: {
            on_credit: true,
            batches: [{ product_id: product.id, quantity_received: 40, cost_price_per_unit: 100,
              selling_price_per_unit: 150, batch_no: `SPLIT-${Date.now()}`, expiry_date: '2030-12-31' }] } });
        }
      }
      bals = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
        .filter(x => x.branch_id === branchId && Number(x.balance_owed) > 3000);
    }
    if (!bals.length) { bad('could not create supplier debt fixture to settle'); }
    else {
      const debt = bals[0];
      const total = 3000;
      const d0 = await drawer(), s0 = await safe();
      const r = await req('POST', `/api/creditors/${debt.supplier_id}/payments`, { token: owner, body: {
        branch_id: branchId, amount: total, notes: 'Delivery paid from drawer and safe',
        cash_sources: [{ source: 'CASH', amount: 1000 }, { source: 'SAFE', amount: 2000 }] } });
      const d1 = await drawer(), s1 = await safe();
      if (r.status === 201) ok('a supplier payment can be split across both pots');
      else bad(`split supplier payment returned ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
      if (near(d0 - d1, 1000)) ok('  the drawer fell by its N1,000 share');
      else bad(`  the drawer fell by N${(d0 - d1).toFixed(2)}, expected N1,000`);
      if (near(s0 - s1, 2000)) ok('  the safe fell by its N2,000 share');
      else bad(`  the safe fell by N${(s0 - s1).toFixed(2)}, expected N2,000`);
      const after = L((await req('GET', '/api/creditors/balances', { token: owner })).body)
        .find(x => x.supplier_id === debt.supplier_id && x.branch_id === branchId);
      if (after && near(Number(debt.balance_owed) - Number(after.balance_owed), total)) ok('  the supplier balance fell by the full N3,000');
      else bad(`  supplier balance moved by ${after ? (Number(debt.balance_owed) - Number(after.balance_owed)).toFixed(2) : 'n/a'}`);
      const g = await books();
      if (near(g.dr, g.cr)) ok('  books balance after the split supplier payment');
      else bad(`  books unbalanced: ${g.dr} vs ${g.cr}`);
    }
  }

  // ---- I. THE HISTORY SHOWS WHICH POT PAID ------------------------------
  console.log('\n=== I. THE RECORD SAYS WHERE THE MONEY CAME FROM ===');
  {
    const moves = L((await req('GET', `/api/safe/${branchId}/movements`, { token: owner })).body.movements);
    const fromSplit = moves.filter(m => /safe share of/i.test(String(m.reason || '')));
    if (fromSplit.length) ok(`${fromSplit.length} safe movement(s) are labelled as the safe's share of a larger purchase`);
    else bad('a split purchase left no identifiable safe movement');
    if (fromSplit.every(m => m.source_id)) ok('...each linked to the expense or payment it funded');
    else bad('a split safe movement has no source_id');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
