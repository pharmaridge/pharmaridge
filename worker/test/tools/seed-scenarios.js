// Builds THREE realistic pharmacy datasets for screenshot comparison:
//   A. a TWO-BRANCH owner with 8 staff and heavy transaction history
//   B. a SINGLE-BRANCH owner with 2 staff and light history
//   C. a FIVE-BRANCH estate with 20 staff and dense multi-branch traffic
// All live in the same deployment (PharmaRidge is single-tenant-per-client,
// so "several pharmacies" is modelled as branch groups under one owner with
// separately-scoped branch managers).
//
// Scenario C deliberately crosses the seeded plan allowance (20 branches /
// 30 staff). The seed therefore performs the SAME action a real vendor would:
// PUT /api/admin/settings as the ADMIN to raise the cap. If that call is
// removed the hires start failing with PLAN_LIMIT_EXCEEDED, which is the
// billing model working, not a fault.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const J = { 'content-type': 'application/json' };
async function req(m, p, { token, body, idem } = {}) {
  const h = { ...J };
  if (token) h.authorization = 'Bearer ' + token;
  if (idem) h['Idempotency-Key'] = idem;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; const t = await r.text();
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const login = async (u, p = '1234') => (await req('POST', '/api/auth/login', { body: { username: u, pin: p } })).body?.token;
const L = b => (Array.isArray(b) ? b : []);
const uniq = () => Math.random().toString(36).slice(2, 7);
const m2 = n => Math.round(n * 100) / 100;
const plus = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

(async () => {
  const owner = await login('owner');
  if (!owner) { console.log('cannot log in — run: bash test/devserver.sh 9001'); process.exit(3); }
  const admin = await login('admin');

  // ---- Plan headroom -------------------------------------------------------
  // 2 (seed) + 1 (B) + 5 (C) = 8 branches; 5 (seed) + 8 + 2 + 20 = 35 staff.
  // The seeded allowance is 20/30, so the staff cap WOULD bite. Raise it the
  // way the vendor actually would, and prove the raise landed.
  const raise = await req('PUT', '/api/admin/settings', { token: admin, body: { max_branches: 25, max_staff: 60 } });
  console.log(`Plan raised by ADMIN: ${raise.status} -> ${raise.body?.max_branches} branches / ${raise.body?.max_staff} staff`);

  const branches = L((await req('GET', '/api/branches', { token: owner })).body);
  const lagos = branches.find(b => /lagos/i.test(b.name));
  const minna = branches.find(b => /minna/i.test(b.name));
  console.log('Branch A1 (Lagos):', lagos.name);
  console.log('Branch A2 (Minna):', minna.name);

  async function openBranch(name, address, phone, licenseType, licenseNo, lat, lng) {
    const r = await req('POST', '/api/branches', { token: owner, body: {
      name, address, phone, license_type: licenseType, pcn_license_no: licenseNo,
      latitude: lat, longitude: lng, geofence_radius_meters: 120,
      pcn_license_expiry_date: plus(300 + Math.floor(Math.random() * 300)),
    } });
    if (r.status !== 201) { console.log('  branch failed', name, r.status, String(r.body?.error).slice(0, 90)); return null; }
    return r.body;
  }

  // ---- Scenario B branch: a single-branch pharmacy -------------------------
  const bBranch = await openBranch('Sunrise Chemist - Enugu', '7 Ogui Road, Enugu', '08033445566',
    'PPMV', 'PPMV/EN/00891', 6.4402, 7.4993);
  console.log('Branch B  (Enugu):', bBranch.name);

  // ---- Scenario C branches: a five-shop estate -----------------------------
  console.log('\n--- Scenario C: 5 branches, 20 staff ---');
  const cSpecs = [
    ['Rivertown Pharmacy - Ikeja', '14 Allen Avenue, Ikeja, Lagos', '08120001001', 'PHARMACY', 'PCN/LA/03311', 6.6018, 3.3515],
    ['Rivertown Pharmacy - Abuja', '3 Gimbiya Street, Area 11, Abuja', '08120001002', 'PHARMACY', 'PCN/FC/03312', 9.0579, 7.4951],
    ['Rivertown Chemist - Kano', '22 Zoo Road, Kano', '08120001003', 'PPMV', 'PPMV/KN/03313', 12.0022, 8.5920],
    ['Rivertown Pharmacy - Port Harcourt', '9 Aba Road, Port Harcourt', '08120001004', 'PHARMACY', 'PCN/RV/03314', 4.8156, 7.0498],
    ['Rivertown Chemist - Ibadan', '5 Ring Road, Ibadan', '08120001005', 'PPMV', 'PPMV/OY/03315', 7.3775, 3.9470],
  ];
  const cBranches = [];
  for (const s of cSpecs) { const b = await openBranch(...s); if (b) cBranches.push(b); }
  console.log(`  opened ${cBranches.length} of 5 branches`);

  const products = L((await req('GET', '/api/products', { token: owner })).body);
  const otc = products.filter(p => p.dispensing_type !== 'POM' && !p.is_controlled);
  let suppliers = L((await req('GET', '/api/suppliers', { token: owner })).body);
  const supplierNames = ['Emzor Distributors', 'Fidson Wholesale', 'May & Baker Depot', 'Juhel Nigeria', 'Swiss Pharma Depot'];
  for (const n of supplierNames) {
    if (!suppliers.some(s => s.name === n)) {
      await req('POST', '/api/suppliers', { token: owner, body: { name: n, phone: '0803' + uniq(), address: 'Lagos' } });
    }
  }
  suppliers = L((await req('GET', '/api/suppliers', { token: owner })).body);

  // ---- Staff -------------------------------------------------------------
  const made = [];
  async function hire(role, branchId, fullName, username, jobTitle) {
    const r = await req('POST', '/api/users', { token: owner, body: {
      branch_id: branchId, full_name: fullName, username, pin: '1234', role, job_title: jobTitle } });
    if (r.status === 201) { made.push({ ...r.body, username }); return { ...r.body, username, token: await login(username) }; }
    console.log('  hire failed', username, r.status, String(r.body && r.body.error).slice(0, 80));
    return null;
  }

  console.log('\n--- Scenario A: 2 branches, 8 staff ---');
  const aStaff = [];
  const aPeople = [
    ['MANAGER', lagos.id, 'Chidinma Eze', 'a.mgr.lagos', 'Branch Manager'],
    ['MANAGER', minna.id, 'Yusuf Bello', 'a.mgr.minna', 'Branch Manager'],
    ['STAFF', lagos.id, 'Ngozi Okafor', 'a.cash1', 'Senior Cashier'],
    ['STAFF', lagos.id, 'Emeka Nwosu', 'a.cash2', 'Sales Attendant'],
    ['STAFF', lagos.id, 'Fatima Sani', 'a.cash3', 'Sales Attendant'],
    ['STAFF', minna.id, 'Ibrahim Musa', 'a.cash4', 'Sales Attendant'],
    ['STAFF', minna.id, 'Blessing Adeyemi', 'a.cash5', 'Storekeeper'],
    ['STAFF', minna.id, 'Tunde Bakare', 'a.cash6', 'Sales Attendant'],
  ];
  for (const [role, bid, name, un, title] of aPeople) {
    const u = await hire(role, bid, name, un, title);
    if (u) aStaff.push(u);
  }
  console.log(`  hired ${aStaff.length} of 8`);

  console.log('\n--- Scenario B: 1 branch, 2 staff ---');
  const bStaff = [];
  for (const [role, name, un, title] of [
    ['MANAGER', 'Chinwe Obi', 'b.mgr', 'Branch Manager'],
    ['STAFF', 'Samuel Eze', 'b.cash1', 'Sales Attendant'],
  ]) {
    const u = await hire(role, bBranch.id, name, un, title);
    if (u) bStaff.push(u);
  }
  console.log(`  hired ${bStaff.length} of 2`);

  // Scenario C staffing: 5 branch managers (one pinned per shop) + 14 floor
  // staff spread unevenly + 1 org-wide General Manager (no branch_id), which
  // is the shape a five-shop estate actually has.
  const cFirst = ['Amaka', 'Suleiman', 'Kelechi', 'Halima', 'Obinna', 'Zainab', 'Chuka', 'Rukayat',
    'Ifeanyi', 'Maryam', 'Segun', 'Nkechi', 'Bashir', 'Temitope', 'Uche', 'Aminu', 'Folake', 'Danladi', 'Ezinne'];
  const cLast = ['Okonjo', 'Abubakar', 'Nwachukwu', 'Lawal', 'Chukwu', 'Yakubu', 'Madu', 'Ogunleye',
    'Eze', 'Ibrahim', 'Adeyanju', 'Onuoha', 'Garba', 'Balogun', 'Anyanwu', 'Sadiq', 'Fashola', 'Waziri', 'Chidi'];
  const cStaff = [];
  {
    // one General Manager, org-wide (no branch pin) — the estate's overseer
    const gm = await hire('MANAGER', null, 'Adaobi Chukwuma', 'c.gm', 'General Manager');
    if (gm) cStaff.push(gm);
    let n = 0;
    for (let i = 0; i < cBranches.length; i++) {
      const b = cBranches[i];
      const mgr = await hire('MANAGER', b.id, `${cFirst[n]} ${cLast[n]}`, `c.mgr${i + 1}`, 'Branch Manager');
      n++;
      if (mgr) cStaff.push(mgr);
      // uneven floor headcount: 4,3,3,2,2 = 14
      const headcount = [4, 3, 3, 2, 2][i];
      for (let k = 0; k < headcount; k++) {
        const title = k === 0 ? 'Senior Cashier' : k === 1 ? 'Sales Attendant' : k === 2 ? 'Storekeeper' : 'Sales Attendant';
        const u = await hire('STAFF', b.id, `${cFirst[n % cFirst.length]} ${cLast[n % cLast.length]}`, `c.b${i + 1}s${k + 1}`, title);
        n++;
        if (u) cStaff.push(u);
      }
    }
  }
  console.log(`  hired ${cStaff.length} of 20 (1 General Manager + 5 Branch Managers + 14 floor staff)`);

  // ---- Stock into every branch -------------------------------------------
  async function stockUp(branchId, count, label) {
    let n = 0;
    for (let i = 0; i < count; i++) {
      const prod = otc[i % otc.length];
      const sup = pick(suppliers);
      const cost = 40 + Math.floor(Math.random() * 260);
      const po = await req('POST', '/api/purchase-orders', { token: owner, body: {
        branch_id: branchId, supplier_id: sup.id,
        items: [{ product_id: prod.id, quantity_ordered: 200, expected_unit_cost: cost }] } });
      if (po.status !== 201) continue;
      const onCredit = i % 3 === 0;
      const rec = await req('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner, body: {
        on_credit: onCredit,
        batches: [{ product_id: prod.id, quantity_received: 200, cost_price_per_unit: cost,
          selling_price_per_unit: m2(cost * 1.7), pack_price: m2(cost * 1.7 * 9.2),
          batch_no: 'B' + uniq().toUpperCase(),
          expiry_date: plus([20, 75, 200, 500, 700][i % 5]) }] } });
      if (rec.status === 200 || rec.status === 201) n++;
    }
    console.log(`  ${label}: received ${n} deliveries`);
  }
  await stockUp(lagos.id, 10, 'Lagos');
  await stockUp(minna.id, 8, 'Minna');
  await stockUp(bBranch.id, 5, 'Enugu');
  for (let i = 0; i < cBranches.length; i++) {
    await stockUp(cBranches[i].id, [9, 8, 6, 6, 5][i], cBranches[i].name.split(' - ')[1]);
  }

  // ---- Customers with credit ---------------------------------------------
  async function makeCustomers(branchId, names, limit) {
    const out = [];
    for (const n of names) {
      const c = await req('POST', '/api/customers', { token: owner, body: {
        branch_id: branchId, name: n, phone: '0806' + uniq(), address: 'Local' } });
      if (c.status === 201) {
        await req('PUT', `/api/customers/${c.body.id}`, { token: owner, body: { credit_limit: limit } });
        out.push(c.body);
      }
    }
    return out;
  }
  const aCustL = await makeCustomers(lagos.id, ['Grace Medical Centre', 'Ikeja Clinic Ltd', 'Mrs Adaeze Umeh', 'Dr Kola Ajayi'], 150000);
  const aCustM = await makeCustomers(minna.id, ['Niger State Clinic', 'Alhaji Sule Garba'], 80000);
  const bCust = await makeCustomers(bBranch.id, ['Enugu Health Post', 'Mr Obinna Nnaji'], 40000);
  console.log(`  customers: Lagos ${aCustL.length}, Minna ${aCustM.length}, Enugu ${bCust.length}`);

  const cCustNames = [
    ['Allen Avenue Clinic', 'Mrs Bimpe Salau', 'Ikeja GRA Health Centre'],
    ['Area 11 Staff Clinic', 'Dr Musa Danjuma', 'Wuse Diagnostics Ltd'],
    ['Zoo Road Maternity', 'Alhaji Bello Kano'],
    ['Aba Road Medical', 'Mr Tamuno West', 'Rivers Staff Clinic'],
    ['Ring Road Surgery', 'Mrs Yetunde Ojo'],
  ];
  const cCust = [];
  for (let i = 0; i < cBranches.length; i++) {
    // Different limits per shop so the aging/credit screens are not uniform:
    // one branch is deliberately CASH-ONLY (limit 0) which is the safe default.
    const limit = [200000, 120000, 0, 90000, 60000][i];
    cCust.push(await makeCustomers(cBranches[i].id, cCustNames[i], limit));
  }
  console.log(`  Scenario C customers: ${cCust.map(x => x.length).join(', ')} (Kano deliberately cash-only, limit 0)`);

  // ---- Trading ------------------------------------------------------------
  async function trade(branchId, cashiers, customers, saleCount, label) {
    if (!cashiers.length) return;
    // Only OTC batches: POM and controlled products correctly REFUSE a sale
    // without prescription/KYC details (422), which is the app being right —
    // the seed must not fight a safety control.
    const otcIds = new Set(otc.map(p => p.id));
    const stock = L((await req('GET', '/api/stock?branch_id=' + branchId, { token: owner })).body)
      .filter(s => s.quantity_remaining > 30 && s.selling_price_per_unit > 0 && otcIds.has(s.product_id));
    if (!stock.length) { console.log(`  ${label}: no stock to sell`); return; }
    // one open till per branch
    const tills = L((await req('GET', '/api/till?branch_id=' + branchId, { token: owner })).body).filter(t => t.status === 'OPEN');
    for (const t of tills) {
      const e = (await req('GET', `/api/till/${t.id}/expected`, { token: owner })).body;
      await req('POST', `/api/till/${t.id}/close`, { token: owner, body: { counted_closing_cash: e.expected_closing_cash, force_reason: 'seed reset' } });
    }
    const teller = cashiers[0];
    await req('POST', '/api/till/open', { token: teller.token, body: { branch_id: branchId, opening_cash: 25000 } });
    // The batch list goes STALE as quantities fall — a fixed snapshot made most
    // sales fail on insufficient stock, which looked like a product fault but
    // was the seed selling from figures it captured minutes earlier.
    let live = stock.slice();
    let ok = 0, credit = 0, voided = 0, failed = 0;
    for (let i = 0; i < saleCount; i++) {
      if (i % 8 === 0) {
        live = L((await req('GET', '/api/stock?branch_id=' + branchId, { token: owner })).body)
          .filter(s => s.quantity_remaining > 30 && s.selling_price_per_unit > 0 && otcIds.has(s.product_id));
      }
      if (!live.length) break;
      const who = pick(cashiers);
      const b = pick(live);
      const qty = 1 + Math.floor(Math.random() * 4);
      // FEFO decides which batch actually fills the line — the NEAREST-expiry
      // batch of that product, which may not be the one I sampled and may carry
      // a different price. Pricing off my sampled batch produced "Payments do
      // not sum to sale total": the app being right, my arithmetic wrong.
      // There is no quote endpoint (checked), so mirror FEFO here: take the
      // earliest-expiry live batch for this product.
      const sameProduct = live.filter(x => x.product_id === b.product_id)
        .sort((x, y) => String(x.expiry_date || '9999').localeCompare(String(y.expiry_date || '9999')));
      const fefo = sameProduct[0] || b;
      if (fefo.quantity_remaining < qty) continue;
      const total = m2(qty * fefo.selling_price_per_unit);
      const useCredit = customers.length && i % 7 === 0;
      const body = { branch_id: branchId,
        items: [{ product_id: b.product_id, quantity: qty, unit_type: 'BASE_UNIT' }],
        payments: useCredit ? [{ method: 'CREDIT', amount: total }]
          : i % 5 === 0 ? [{ method: 'CASH', amount: m2(total / 2) }, { method: 'POS_CARD', amount: m2(total - m2(total / 2)) }]
          : [{ method: 'CASH', amount: total, cash_tendered: m2(total + 500) }] };
      if (useCredit) body.customer_id = pick(customers).id;
      const r = await req('POST', '/api/sales', { token: who.token, body });
      if (r.status !== 201) { failed++; if (failed <= 2) console.log(`    (sale refused ${r.status}: ${String(r.body && r.body.error).slice(0, 70)})`); }
      if (r.status === 201) {
        ok++; if (useCredit) credit++;
        if (i % 11 === 0) {
          const v = await req('POST', `/api/sales/${r.body.id}/void`, { token: owner, body: { reason: 'Customer changed their mind at the counter' } });
          if (v.status === 200) voided++;
        }
      }
    }
    console.log(`  ${label}: ${ok} sales (${credit} on credit, ${voided} voided, ${failed} refused)`);
  }
  const aLagosCashiers = aStaff.filter(u => u.branch_id === lagos.id);
  const aMinnaCashiers = aStaff.filter(u => u.branch_id === minna.id);
  await trade(lagos.id, aLagosCashiers, aCustL, 42, 'Lagos');
  await trade(minna.id, aMinnaCashiers, aCustM, 28, 'Minna');
  await trade(bBranch.id, bStaff, bCust, 9, 'Enugu');
  for (let i = 0; i < cBranches.length; i++) {
    const shop = cBranches[i];
    const crew = cStaff.filter(u => u.branch_id === shop.id);
    await trade(shop.id, crew, cCust[i], [36, 30, 24, 20, 16][i], shop.name.split(' - ')[1]);
  }

  // ---- Expenses, WHT, repayments, attendance, adjustments -----------------
  const cats = ['RENT', 'ELECTRICITY', 'TRANSPORT', 'PROFESSIONAL_FEES', 'STAFF_WELFARE'];
  const expensePlan = [[lagos.id, 9, 'Lagos'], [minna.id, 6, 'Minna'], [bBranch.id, 3, 'Enugu']]
    .concat(cBranches.map((b, i) => [b.id, [7, 6, 5, 4, 4][i], b.name.split(' - ')[1]]));
  for (const [bid, n, label] of expensePlan) {
    let e = 0;
    for (let i = 0; i < n; i++) {
      const cat = cats[i % cats.length];
      // BUG 96. Rent and salaries are large and are paid from the safe or the
      // bank, not out of the counter drawer — recording them as CASH is what
      // drove a seeded till to an impossible -N31,732 expected balance and
      // made it unclosable. The seed now spends like a real shop: big
      // obligations by TRANSFER, small running costs in cash.
      const big = cat === 'RENT' || cat === 'PROFESSIONAL_FEES';
      const body = { branch_id: bid, category: cat,
        amount: big ? m2(20000 + Math.random() * 40000) : m2(500 + Math.random() * 4000),
        description: cat.toLowerCase().replace('_', ' ') + ' for the month',
        paid_by_method: big ? 'TRANSFER' : (i % 3 === 0 ? 'TRANSFER' : 'CASH') };
      if (cat === 'PROFESSIONAL_FEES' || cat === 'RENT') { body.wht_rate_code = cat === 'RENT' ? 'RENT' : 'PROFESSIONAL_FEES'; body.wht_counterparty_name = 'Service provider'; }
      const r = await req('POST', '/api/expenses', { token: owner, body });
      if (r.status === 201) e++;
    }
    console.log(`  ${label}: ${e} expenses recorded`);
  }
  for (const list of [aCustL, aCustM, bCust, ...cCust]) {
    for (const c of list) {
      const bal = (await req('GET', `/api/customers/${c.id}/balance`, { token: owner })).body;
      const owed = Number(bal && bal.balance_owed || 0);
      if (owed > 0) await req('POST', `/api/customers/${c.id}/payments`, { token: owner, body: { branch_id: c.branch_id, amount: m2(owed / 2) } });
    }
  }
  for (const u of [...aStaff, ...bStaff, ...cStaff]) {
    if (!u.branch_id) continue; // org-wide GM has no branch to clock into
    await req('POST', '/api/attendance/clock-in', { token: u.token, body: { branch_id: u.branch_id,
      location: Math.random() > 0.35 ? { lat: 6.6018, lng: 3.3515, accuracy: 12 } : null } });
  }
  const adjPlan = [[lagos.id, 'Lagos'], [minna.id, 'Minna']].concat(cBranches.slice(0, 3).map(b => [b.id, b.name]));
  for (const [bid, label] of adjPlan) {
    const st = L((await req('GET', '/api/stock?branch_id=' + bid, { token: owner })).body).filter(s => s.quantity_remaining > 20);
    for (let i = 0; i < Math.min(3, st.length); i++) {
      await req('POST', '/api/adjustments', { token: owner, body: { branch_id: bid, stock_batch_id: st[i].id,
        quantity_change: -(1 + Math.floor(Math.random() * 6)), adjustment_type: pick(['DAMAGE', 'EXPIRED', 'STOCKTAKE_VARIANCE']),
        reason: 'Routine shrinkage recorded during the shift' } });
    }
  }
  // branch transfers: one completed and one in flight for A, plus a small
  // inter-branch web across the five-shop estate (that is the whole point of
  // running five shops — stock moves between them).
  async function moveStock(fromId, toId, howMany, receive) {
    const src = L((await req('GET', '/api/stock?branch_id=' + fromId, { token: owner })).body).filter(s => s.quantity_remaining > 40);
    let n = 0;
    for (let i = 0; i < Math.min(howMany, src.length); i++) {
      const t = await req('POST', '/api/transfers', { token: owner, body: { to_branch_id: toId, stock_batch_id: src[i].id, quantity: 15 } });
      if (t.status !== 201) continue;
      n++;
      if (receive) await req('POST', `/api/transfers/${t.body.id}/receive`, { token: owner, body: {} });
    }
    return n;
  }
  await moveStock(lagos.id, minna.id, 1, true);
  await moveStock(lagos.id, minna.id, 1, false);
  if (cBranches.length === 5) {
    let done = 0, flight = 0;
    done += await moveStock(cBranches[0].id, cBranches[1].id, 2, true);
    done += await moveStock(cBranches[1].id, cBranches[2].id, 1, true);
    flight += await moveStock(cBranches[0].id, cBranches[3].id, 1, false);
    flight += await moveStock(cBranches[2].id, cBranches[4].id, 1, false);
    flight += await moveStock(cBranches[3].id, cBranches[0].id, 1, false);
    console.log(`  Scenario C transfers: ${done} completed, ${flight} in flight`);
  }
  // ---- Branch safe: every shop keeps a reserve, and some of it has been
  // spent on the big obligations a drawer could never cover. Without this the
  // manual's screenshots would show an empty safe, which is not what a
  // trading pharmacy looks like.
  const allShops = [lagos, minna, bBranch, ...cBranches];
  for (const shop of allShops) {
    const float = 60000 + Math.floor(Math.random() * 140000);
    await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: shop.id, entry_type: 'DEPOSIT', amount: float,
      reason: 'Monthly cash reserve placed in the branch safe' } });
    // A large obligation paid from the reserve — the case the safe exists for.
    await req('POST', '/api/expenses', { token: owner, body: {
      branch_id: shop.id, category: 'RENT', amount: m2(20000 + Math.random() * 25000),
      description: 'Quarterly rent, paid from the branch safe', paid_by_method: 'SAFE' } });
    // End-of-day sweep from the counter into the safe.
    await req('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: shop.id, entry_type: 'TILL_TRANSFER', amount: 5000,
      reason: 'End-of-day sweep from the counter drawer' } });
  }

  // ---- Change owed: the "no N100 note" case, so the counter list and the
  // dashboard tile are populated in the manual.
  for (const [shop, cashiers, people] of [
    [lagos, aLagosCashiers, [['Mrs Adaeze Umeh', '08031234567'], ['Mr Tunde Alabi', '08065554433']]],
    [minna, aMinnaCashiers, [['Alhaji Sule Garba', '08023339911']]],
    [cBranches[0], cStaff.filter(u => u.branch_id === cBranches[0].id), [['Mrs Bimpe Salau', '08099887766']]],
  ]) {
    if (!cashiers || !cashiers.length) continue;
    const st = L((await req('GET', '/api/stock?branch_id=' + shop.id, { token: owner })).body)
      .filter(x => x.quantity_remaining > 5 && x.selling_price_per_unit > 0);
    if (!st.length) continue;
    for (let i = 0; i < people.length; i++) {
      const line = st[i % st.length];
      await req('POST', '/api/sales', { token: cashiers[0].token, body: {
        branch_id: shop.id,
        items: [{ product_id: line.product_id, quantity: 1, unit_type: 'BASE_UNIT' }],
        payments: [{ method: 'CASH', amount: line.selling_price_per_unit,
          cash_tendered: m2(line.selling_price_per_unit + 100), change_owed: 100 }],
        change_owed_for: { name: people[i][0], phone: people[i][1] } } });
    }
  }

  const hb = [[lagos.id, 'A-LAGOS-TILL'], [minna.id, 'A-MINNA-TILL'], [bBranch.id, 'B-ENUGU-TILL']]
    .concat(cBranches.map((b, i) => [b.id, 'C-TILL-' + (i + 1)]));
  for (const [bid, dev] of hb) {
    await req('POST', '/api/sync/heartbeat', { token: owner, body: { branch_id: bid, device_id: dev, app_version: '1.0.0', pending_push_count: Math.floor(Math.random() * 5) } });
  }
  const tb = L((await req('GET', '/api/gl/trial-balance', { token: owner })).body);
  const dr = tb.reduce((a, x) => a + Number(x.total_debits || 0), 0);
  const cr = tb.reduce((a, x) => a + Number(x.total_credits || 0), 0);
  console.log(`\nBooks: debits ${dr.toFixed(2)} credits ${cr.toFixed(2)} balanced=${Math.abs(dr - cr) < 0.005}`);
  const plan = (await req('GET', '/api/dashboard/plan', { token: owner })).body;
  console.log(`Plan: branches ${plan.branches.used}/${plan.branches.max} · staff ${plan.staff.used}/${plan.staff.max}`);
  require('fs').writeFileSync('/tmp/scenarios.json', JSON.stringify({
    A: { lagos: lagos.id, minna: minna.id, staff: aStaff.map(u => u.username) },
    B: { enugu: bBranch.id, staff: bStaff.map(u => u.username) },
    C: { branches: cBranches.map(b => ({ id: b.id, name: b.name })), staff: cStaff.map(u => u.username) },
  }, null, 2));
  console.log('\nScenario map written to /tmp/scenarios.json');
})();
