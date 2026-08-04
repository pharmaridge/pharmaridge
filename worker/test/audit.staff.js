// STAFF (CASHIER) — FULL-CIRCLE AUDIT.
//
// The cashier is the role that touches MONEY all day, on the cheapest device,
// with the least training, under the most time pressure. Two things must both
// be true and they pull against each other:
//
//   1. THE JOB MUST WORK. Sell, take payment, print, correct an honest mistake,
//      clock in, count stock. A cashier blocked from their own job costs the
//      pharmacy a customer at the counter.
//   2. THE TWO COMMONEST WAYS MONEY GOES MISSING MUST BE FENCED. Voiding a sale
//      after pocketing the cash, and writing off stock as "damaged" after
//      taking the goods. The product's answer is not to ban them — honest
//      mistakes need fixing — but to keep them SMALL: own sale, short window,
//      till still open, tiny unit cap. Anything bigger needs a manager.
//
// Plus the boundary questions: a cashier must see only their own branch, must
// not read the pharmacy's money position, and must not be able to widen any of
// the limits above.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function note(m) { notes.push(m); console.log('  ..   ' + m); }

async function login(username, pin) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  return { status: r.status, ...b };
}
async function api(method, path, { token, body, headers } = {}) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
}
const listOf = (x) => (Array.isArray(x) ? x : (x && x.results) || []);

(async () => {
  const S = await login('lagos.staff', '1234');    // Lagos cashier
  const S2 = await login('minna.staff', '1234');   // a DIFFERENT branch's cashier
  const GM = await login('manager', '1234');
  const O = await login('owner', '1234');
  const tS = S.token, tS2 = S2.token, tGM = GM.token, tO = O.token;

  const branches = listOf((await api('GET', '/api/branches', { token: tGM })).body);
  const mine = branches.find((b) => b.id === S.user.branch_id);
  const other = branches.find((b) => b.id !== S.user.branch_id && b.is_active);

  // A non-controlled product with stock — a POM line is legally refused at the
  // counter without prescriber details, which is a safety control, not a bug.
  const prods = listOf((await api('GET', '/api/products', { token: tGM })).body);
  const safeIds = new Set(prods.filter((p) => !p.is_controlled).map((p) => p.id));
  const stock = listOf((await api('GET', `/api/stock?branch_id=${mine.id}`, { token: tGM })).body);
  const batch = stock.find((s) => Number(s.quantity_remaining) > 20 && safeIds.has(s.product_id));
  check('the fixture has a sellable, non-controlled batch', !!batch, `${stock.length} batches`);
  const unit = batch ? Number(batch.selling_price_per_unit) : 0;

  console.log('\n=== A. THE CASHIER IS WHO THEY SAY THEY ARE ===');
  check('the cashier signs in', S.status === 200 && !!tS, `status=${S.status}`);
  check('the role reads "Staff", not a raw enum', S.user.role_label === 'Staff', String(S.user.role_label));
  check('a cashier is ALWAYS pinned to one branch', !!S.user.branch_id, String(S.user.branch_id));
  check('the two fixture cashiers are at different branches',
    S.user.branch_id !== S2.user.branch_id, `${S.user.branch_id} vs ${S2.user.branch_id}`);

  console.log('\n=== B. THE JOB WORKS: A CASHIER CAN ACTUALLY SERVE A CUSTOMER ===');
  const till = await api('POST', '/api/till/open', { token: tS, body: { branch_id: mine.id, opening_float: 5000 } });
  check('a cashier can open their till', till.status === 201 || till.status === 409, `status=${till.status}`);

  const sale = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  check('a cashier can record a cash sale', sale.status === 201,
    `status=${sale.status} ${JSON.stringify(sale.body).slice(0, 100)}`);
  const saleId = sale.body && (sale.body.id || (sale.body.sale && sale.body.sale.id));

  check('...and the sale is attributed to them by name',
    !!(sale.body && (sale.body.served_by === S.user.id || (sale.body.sale && sale.body.sale.served_by === S.user.id))),
    JSON.stringify(sale.body).slice(0, 110));

  const receipt = saleId ? await api('GET', `/api/sales/${saleId}`, { token: tS }) : { status: 0 };
  check('...and can reprint the receipt for the customer', receipt.status === 200, `status=${receipt.status}`);

  const staffReads = [
    ['/api/dashboard/summary', 'their own branch dashboard'],
    ['/api/sales', 'their branch sales history'],
    ['/api/stock', 'stock on hand'],
    ['/api/products', 'the product catalogue'],
    ['/api/customers', 'customers (for credit sales)'],
    ['/api/till/current', 'their open till'],
    ['/api/attendance/me/current', 'their own shift'],
    ['/api/stocktakes', 'stocktakes'],
  ];
  for (const [p, label] of staffReads) {
    const r = await api('GET', p, { token: tS });
    check(`a cashier can read ${label}`, r.status === 200, `${p} -> ${r.status}`);
  }

  const clockIn = await api('POST', '/api/attendance/clock-in', {
    token: tS, body: { branch_id: mine.id, device_id: 'probe-staff-device' },
  });
  check('a cashier can clock in', clockIn.status === 201 || clockIn.status === 409, `status=${clockIn.status}`);

  console.log('\n=== C. THE MONEY POSITION IS NOT A CASHIER\'S BUSINESS ===');
  // A live audit once showed a STAFF token reading a 50,000 supplier debt, the
  // FIRS position and a 100,000 rent payment. Those are manager-and-above.
  const forbidden = [
    ['/api/expenses', 'expenses'],
    ['/api/gl/trial-balance', 'the general ledger'],
    ['/api/gl/profit-loss?start_date=2000-01-01&end_date=2999-12-31', 'profit & loss'],
    ['/api/gl/balance-sheet', 'the balance sheet'],
    ['/api/wht/entries', 'the tax position'],
    ['/api/dashboard/branches-breakdown', 'other branches\' money'],
    ['/api/dashboard/plan', 'the subscription plan'],
    ['/api/admin/settings', 'the vendor Admin Portal'],
  ];
  for (const [p, label] of forbidden) {
    const r = await api('GET', p, { token: tS });
    check(`a cashier CANNOT read ${label}`, r.status === 403, `${p} -> ${r.status}`);
  }
  // Org-wide sync health names every branch, so it is manager-and-above. A
  // cashier still sees their OWN device queue on the Sync screen.
  const syncOverview = await api('GET', '/api/sync/overview', { token: tS });
  check('a cashier CANNOT read every branch\'s sync health', syncOverview.status === 403,
    `status=${syncOverview.status}`);

  // Ensure there IS a supplier to test against. The first run skipped the Bug 72
  // projection entirely because the seed has none — a probe that silently skips
  // the very fix it exists to guard is worse than no probe.
  if (listOf((await api('GET', '/api/suppliers', { token: tGM })).body).length === 0) {
    await api('POST', '/api/suppliers', {
      token: tGM,
      body: { name: `Probe Wholesaler ${Date.now()}`, phone: '08099887766', address: '12 Broad St, Lagos' },
    });
  }

  // BUG 72. Suppliers is NOT a blanket refusal: a cashier legitimately needs
  // supplier NAMES for the Purchase Orders dropdown, and blanket-403 took that
  // whole screen down (its Promise.all rejected). What must not leak is the
  // contact detail — the buyer's direct line and the delivery address.
  const supList = listOf((await api('GET', '/api/suppliers', { token: tS })).body);
  const mgrList = listOf((await api('GET', '/api/suppliers', { token: tGM })).body);
  check('a cashier CAN still read supplier names (the PO dropdown needs them)',
    supList.length === mgrList.length, `staff=${supList.length} manager=${mgrList.length}`);
  if (supList.length) {
    const keys = Object.keys(supList[0]).sort();
    check('...but ONLY id and name — no phone, address or audit columns',
      keys.join(',') === 'id,name', keys.join(','));
    check('...while a manager still sees the full record',
      Object.keys(mgrList[0]).some((k) => k === 'phone' || k === 'address'),
      Object.keys(mgrList[0]).join(','));
  } else { note('no suppliers in this dataset — projection not exercised'); }

  // The three screens the PO page loads together must ALL succeed, or the
  // cashier's Purchase Orders screen half-loads and then fails.
  const poTrio = await Promise.all([
    api('GET', '/api/purchase-orders', { token: tS }),
    api('GET', '/api/suppliers', { token: tS }),
    api('GET', '/api/products', { token: tS }),
  ]);
  check('the Purchase Orders screen\'s three parallel loads all succeed for a cashier',
    poTrio.every((r) => r.status === 200), poTrio.map((r) => r.status).join(','));

  console.log('\n=== D. A CASHIER IS SEALED INTO THEIR OWN BRANCH ===');
  const foreignSale = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: other.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  check('a cashier cannot record a sale into ANOTHER branch',
    foreignSale.status >= 400
    || (foreignSale.body && foreignSale.body.branch_id === mine.id)
    || (foreignSale.body && foreignSale.body.sale && foreignSale.body.sale.branch_id === mine.id),
    `status=${foreignSale.status} branch=${JSON.stringify(foreignSale.body).slice(0, 80)}`);

  const foreignStock = listOf((await api('GET', `/api/stock?branch_id=${other.id}`, { token: tS })).body);
  const leaked = foreignStock.filter((s) => s.branch_id && s.branch_id !== mine.id);
  check('...and cannot read another branch\'s stock', leaked.length === 0, `${leaked.length} foreign rows`);

  const foreignSales = listOf((await api('GET', `/api/sales?branch_id=${other.id}`, { token: tS })).body);
  const leakedSales = foreignSales.filter((s) => s.branch_id && s.branch_id !== mine.id);
  check('...nor another branch\'s sales', leakedSales.length === 0, `${leakedSales.length} foreign rows`);

  console.log('\n=== E. A CASHIER CANNOT ACT ON A COLLEAGUE ===');
  // Have the MANAGER serve a sale at this branch, so there is genuinely a
  // colleague-served row to attempt. Same reasoning as above: skipping this
  // check leaves STAFF_VOID_NOT_OWN_SALE unproven.
  await api('POST', '/api/till/open', { token: tGM, body: { branch_id: mine.id, opening_float: 1000 } });
  await api('POST', '/api/sales', {
    token: tGM,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  const colleagueSales = listOf((await api('GET', '/api/sales', { token: tGM })).body)
    .filter((s) => s.branch_id === mine.id && s.served_by && s.served_by !== S.user.id && s.status === 'COMPLETED');
  if (colleagueSales.length) {
    const voidTheirs = await api('POST', `/api/sales/${colleagueSales[0].id}/void`, {
      token: tS, body: { reason: 'probe: voiding a colleague\'s sale' },
    });
    check('a cashier cannot void a COLLEAGUE\'s sale', voidTheirs.status === 403,
      `status=${voidTheirs.status} ${JSON.stringify(voidTheirs.body).slice(0, 90)}`);
    check('...with the right reason code',
      voidTheirs.body && voidTheirs.body.code === 'STAFF_VOID_NOT_OWN_SALE',
      JSON.stringify(voidTheirs.body).slice(0, 100));
  } else { note('no colleague-served sale at this branch — not exercised'); }

  const otherStaffRow = listOf((await api('GET', '/api/users', { token: tGM })).body)
    .find((u) => u.role === 'STAFF' && u.id !== S.user.id);
  if (otherStaffRow) {
    const takeover = await api('PUT', `/api/users/${otherStaffRow.id}`, { token: tS, body: { pin: '9999' } });
    check('a cashier cannot reset anyone\'s PIN', takeover.status === 403, `status=${takeover.status}`);
  }
  const hire = await api('POST', '/api/users', {
    token: tS, body: { full_name: 'Ghost', username: `ghost-${Date.now()}`, pin: '4321', role: 'STAFF', branch_id: mine.id },
  });
  check('a cashier cannot create user accounts', hire.status === 403, `status=${hire.status}`);
  const selfPromote = await api('PUT', `/api/users/${S.user.id}`, { token: tS, body: { role: 'MANAGER' } });
  check('a cashier cannot promote themselves', selfPromote.status >= 400,
    `status=${selfPromote.status} ${JSON.stringify(selfPromote.body).slice(0, 80)}`);

  console.log('\n=== F. A CASHIER CANNOT WIDEN THEIR OWN LIMITS ===');
  // If they could, every other guard in this section is decoration.
  const widen = await api('PUT', '/api/settings/manager-permissions', {
    token: tS, body: { staff_can_void_sales: true, staff_void_window_minutes: 1440, staff_adjustment_max_units: 9999 },
  });
  check('a cashier cannot change the staff-permission policy', widen.status === 403, `status=${widen.status}`);
  const vat = await api('PUT', '/api/settings/vat', { token: tS, body: { vat_enabled: true, vat_rate_percent: 0 } });
  check('...nor the pharmacy\'s tax position', vat.status === 403, `status=${vat.status}`);
  const price = await api('PUT', `/api/products/${batch.product_id}/price-override/${mine.id}`, {
    token: tS, body: { default_selling_price: 1 },
  });
  check('...nor what customers are charged', price.status === 403, `status=${price.status}`);

  console.log('\n=== G. THE VOID ALLOWANCE IS REAL, AND REALLY BOUNDED ===');
  const perms0 = (await api('GET', '/api/settings/manager-permissions', { token: tO })).body;

  // G1. Own sale, fresh, till open -> ALLOWED. The honest-mistake case.
  const ownSale = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  if (ownSale.status === 201) {
    const id = ownSale.body.id || (ownSale.body.sale && ownSale.body.sale.id);
    const undo = await api('POST', `/api/sales/${id}/void`, { token: tS, body: { reason: 'mis-keyed quantity' } });
    check('a cashier CAN undo their own fresh mistake', undo.status === 200,
      `status=${undo.status} ${JSON.stringify(undo.body).slice(0, 90)}`);
  } else { note(`could not create a sale to void: ${ownSale.status}`); }

  // G2. Owner switches the allowance OFF -> refused.
  await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { staff_can_void_sales: false } });
  const s2 = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  if (s2.status === 201) {
    const id2 = s2.body.id || (s2.body.sale && s2.body.sale.id);
    const blocked = await api('POST', `/api/sales/${id2}/void`, { token: tS, body: { reason: 'should be refused' } });
    check('switching the allowance OFF refuses a cashier void', blocked.status === 403, `status=${blocked.status}`);
    check('...with a code the UI can branch on',
      blocked.body && blocked.body.code === 'STAFF_VOID_REQUIRES_MANAGER', JSON.stringify(blocked.body).slice(0, 100));
    // ...and a MANAGER can still do it, so the shop is not stuck.
    const byMgr = await api('POST', `/api/sales/${id2}/void`, { token: tGM, body: { reason: 'manager handled it' } });
    check('...while a manager can still void it (the shop is never stuck)', byMgr.status === 200,
      `status=${byMgr.status}`);
  } else { note(`could not create a sale for the OFF test: ${s2.status}`); }
  await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { staff_can_void_sales: true } });

  // G3. The WINDOW. Set it to zero minutes... which means "no limit", so use 1
  //     minute and age the sale in the database rather than waiting.
  const s3 = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  if (s3.status === 201) {
    const id3 = s3.body.id || (s3.body.sale && s3.body.sale.id);
    await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { staff_void_window_minutes: 1 } });
    // Age the sale by 30 minutes at the DATABASE, which is where the check
    // measures from — a device clock cannot widen it.
    const { execSync } = require('child_process');
    const path = require('path');
    const sql = `UPDATE sales SET created_at = datetime(created_at, '-30 minutes') WHERE id = '${id3}'`;
    // This file lives in worker/test. ../.. is the repository root (which has
    // no Wrangler config); run from the Worker root so the local D1 binding is
    // resolved from worker/wrangler.jsonc.
    execSync(`npx --no-install wrangler d1 execute pharmaridge-db --local --command ${JSON.stringify(sql)}`,
      { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const late = await api('POST', `/api/sales/${id3}/void`, { token: tS, body: { reason: 'too late' } });
    check('a sale older than the window is refused', late.status === 403, `status=${late.status}`);
    check('...with the window code', late.body && late.body.code === 'STAFF_VOID_WINDOW_EXPIRED',
      JSON.stringify(late.body).slice(0, 110));
    check('...and the message says how old it actually is (not just "no")',
      /minutes ago/.test(String(late.body && late.body.error)), String(late.body && late.body.error).slice(0, 120));
    await api('POST', `/api/sales/${id3}/void`, { token: tGM, body: { reason: 'manager cleanup' } });
  } else { note(`could not create a sale for the window test: ${s3.status}`); }
  await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { staff_void_window_minutes: Number(perms0.staff_void_window_minutes) },
  });

  // G4. TILL CLOSED. Once cash is counted, reversing a sale behind that figure
  //     is exactly what the allowance must not permit.
  const s4 = await api('POST', '/api/sales', {
    token: tS,
    body: {
      branch_id: mine.id,
      items: [{ product_id: batch.product_id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unit, cash_tendered: unit }],
    },
  });
  if (s4.status === 201) {
    const id4 = s4.body.id || (s4.body.sale && s4.body.sale.id);
    const cur = await api('GET', '/api/till/current', { token: tS });
    const tillId = cur.body && (cur.body.id || (cur.body.session && cur.body.session.id));
    if (tillId) {
      const closed = await api('POST', `/api/till/${tillId}/close`, {
        token: tS, body: { counted_closing_cash: 5000 },
      });
      if (closed.status === 200) {
        const afterClose = await api('POST', `/api/sales/${id4}/void`, { token: tS, body: { reason: 'after close' } });
        check('a cashier cannot void behind a CLOSED, counted till', afterClose.status === 403,
          `status=${afterClose.status}`);
        check('...with the till-closed code',
          afterClose.body && afterClose.body.code === 'STAFF_VOID_TILL_CLOSED',
          JSON.stringify(afterClose.body).slice(0, 110));
      } else { note(`till close returned ${closed.status} — till-closed void not exercised`); }
    } else { note('no open till id available for the till-closed test'); }
  } else { note(`could not create a sale for the till test: ${s4.status}`); }

  console.log('\n=== H. THE WRITE-OFF ALLOWANCE IS REAL, AND REALLY CAPPED ===');
  const cap = Number(perms0.staff_adjustment_max_units);
  const smallAdj = await api('POST', '/api/adjustments', {
    token: tS,
    body: { branch_id: mine.id, stock_batch_id: batch.id, adjustment_type: 'DAMAGE', quantity_change: -1, reason: 'dropped a bottle' },
  });
  check(`a cashier CAN write off a small amount (cap is ${cap})`, smallAdj.status === 201,
    `status=${smallAdj.status} ${JSON.stringify(smallAdj.body).slice(0, 90)}`);

  const bigAdj = await api('POST', '/api/adjustments', {
    token: tS,
    body: { branch_id: mine.id, stock_batch_id: batch.id, adjustment_type: 'DAMAGE', quantity_change: -(cap + 50), reason: 'probe over cap' },
  });
  check('...but not a large one', bigAdj.status === 403, `status=${bigAdj.status}`);
  check('...with the cap code and the actual numbers in the message',
    bigAdj.body && bigAdj.body.code === 'STAFF_ADJUST_OVER_CAP' && /at most/.test(String(bigAdj.body.error)),
    JSON.stringify(bigAdj.body).slice(0, 130));

  // The cap must apply to POSITIVE adjustments too — inventing stock out of
  // nowhere is the mirror image of writing it off.
  const bigPositive = await api('POST', '/api/adjustments', {
    token: tS,
    body: { branch_id: mine.id, stock_batch_id: batch.id, adjustment_type: 'MANUAL_CORRECTION', quantity_change: cap + 50, reason: 'probe invent stock' },
  });
  check('...and the cap applies to INVENTING stock as well as writing it off',
    bigPositive.status === 403, `status=${bigPositive.status} ${JSON.stringify(bigPositive.body).slice(0, 90)}`);

  await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { staff_can_adjust_stock: false } });
  const adjOff = await api('POST', '/api/adjustments', {
    token: tS,
    body: { branch_id: mine.id, stock_batch_id: batch.id, adjustment_type: 'DAMAGE', quantity_change: -1, reason: 'should be refused' },
  });
  check('switching the write-off allowance OFF refuses a cashier adjustment',
    adjOff.status === 403, `status=${adjOff.status}`);
  check('...with a code the UI can branch on',
    adjOff.body && adjOff.body.code === 'STAFF_ADJUST_REQUIRES_MANAGER', JSON.stringify(adjOff.body).slice(0, 100));
  await api('PUT', '/api/settings/manager-permissions', {
    token: tO, body: { staff_can_adjust_stock: !!perms0.staff_can_adjust_stock },
  });

  console.log('\n=== I. THE BOOKS SURVIVED EVERYTHING A CASHIER DID ===');
  const tb = listOf((await api('GET', '/api/gl/trial-balance', { token: tGM })).body);
  const sum = tb.reduce((a, r) => { a.d += Number(r.total_debits || 0); a.c += Number(r.total_credits || 0); return a; }, { d: 0, c: 0 });
  check('debits still equal credits', Math.abs(Math.round((sum.d - sum.c) * 100) / 100) < 0.005,
    `debits=${sum.d.toFixed(2)} credits=${sum.c.toFixed(2)}`);
  const negative = listOf((await api('GET', `/api/stock?branch_id=${mine.id}`, { token: tGM })).body)
    .filter((s) => Number(s.quantity_remaining) < 0);
  check('no stock batch went negative', negative.length === 0, `${negative.length} negative batches`);

  // Restore the owner's original policy in full.
  await api('PUT', '/api/settings/manager-permissions', {
    token: tO,
    body: {
      staff_can_void_sales: !!perms0.staff_can_void_sales,
      staff_can_adjust_stock: !!perms0.staff_can_adjust_stock,
      staff_void_window_minutes: Number(perms0.staff_void_window_minutes),
      staff_adjustment_max_units: Number(perms0.staff_adjustment_max_units),
    },
  });

  console.log('\n' + '='.repeat(62));
  console.log(`STAFF PROBE: ${pass} passed, ${fail} failed`);
  if (notes.length) { console.log('\nOBSERVATIONS:'); notes.forEach((n) => console.log('  - ' + n)); }
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
