// THREE-MONTH OPERATING SIMULATION
//
// Builds 90 dated days of real API-created activity on a local D1 database.
// The events are created through the same routes a pharmacy uses; only their
// timestamps are backdated in one local-D1 SQL batch afterwards so reports can
// exercise a real 90-day history without waiting three months.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const ROOT = path.resolve(__dirname, '..', '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const sqlQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const day = (offset) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
const at = (isoDay, hour = '12:00:00') => `${isoDay} ${hour}`;

async function request(method, route, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, body: data };
}
const list = (v) => Array.isArray(v) ? v : ((v && v.results) || []);
async function login(username) {
  const r = await request('POST', '/api/auth/login', { body: { username, pin: '1234' } });
  if (r.status !== 200) throw new Error(`cannot log in as ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

function applyBackdates(statements) {
  const file = '/tmp/pharmaridge-three-month-backdates.sql';
  fs.writeFileSync(file, statements.join('\n') + '\n');
  execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'pharmaridge-db', '--local', '--file', file], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

(async () => {
  console.log('=== THREE-MONTH SIMULATION ===');
  const owner = await login('owner');
  const manager = await login('manager');
  const staffLagos = await login('lagos.staff');
  const staffMinna = await login('minna.staff');

  const branches = list((await request('GET', '/api/branches', { token: owner })).body).filter((b) => b.is_active);
  if (branches.length < 2) throw new Error('simulation needs two active branches');
  const [lagos, minna] = branches;
  const products = list((await request('GET', '/api/products', { token: owner })).body);
  const allowedProducts = new Map(products.filter((p) => !p.is_controlled && p.dispensing_type !== 'POM').map((p) => [p.id, p]));

  // VAT is enabled for the simulated period so VAT extraction is represented
  // in both sales rows and the GL/WHT reports.
  const vat = await request('PUT', '/api/settings/vat', { token: owner, body: { vat_enabled: true, vat_rate_percent: 7.5 } });
  if (vat.status !== 200) throw new Error(`could not enable VAT: ${vat.status}`);

  // Customers used for recurring credit activity.
  const customers = [];
  for (const [branch, name] of [[lagos, 'Three Month Lagos Clinic'], [minna, 'Three Month Minna Clinic']]) {
    const made = await request('POST', '/api/customers', { token: owner, body: {
      branch_id: branch.id, name, phone: `0803${branch.id.slice(0, 7)}` } });
    if (made.status !== 201) throw new Error(`customer create failed: ${made.status}`);
    await request('PUT', `/api/customers/${made.body.id}`, { token: owner, body: { credit_limit: 250000 } });
    customers.push(made.body);
  }

  // Supplier credit receipts make the three-month creditor/payment path real.
  let supplier = list((await request('GET', '/api/suppliers', { token: owner })).body)[0];
  if (!supplier) {
    const made = await request('POST', '/api/suppliers', { token: owner, body: {
      name: 'Three Month Wholesale Depot', phone: '08035550000', address: 'Simulation depot' } });
    supplier = made.body;
  }

  // A dedicated high-volume OTC product removes FEFO ambiguity from the daily
  // simulation. It is received into both branches before day 1, ensuring every
  // one of the 90 simulated tills has real sellable stock.
  const simProductRes = await request('POST', '/api/products', { token: owner, body: {
    name: 'Simulation Paracetamol 500mg', generic_name: 'Paracetamol', category: 'Analgesic',
    dispensing_type: 'OTC', base_unit: 'tablet', units_per_pack: 10, reorder_level: 100 } });
  if (simProductRes.status !== 201) throw new Error(`simulation product create failed: ${simProductRes.status}`);
  const simulationProduct = simProductRes.body;
  for (const [branch, offset] of [[lagos, 90], [minna, 89]]) {
    const po = await request('POST', '/api/purchase-orders', { token: owner, body: {
      branch_id: branch.id, supplier_id: supplier.id,
      items: [{ product_id: simulationProduct.id, quantity_ordered: 1000, expected_unit_cost: 100 }] } });
    if (po.status !== 201) throw new Error(`simulation stock PO failed: ${po.status}`);
    const receipt = await request('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner, body: {
      on_credit: true,
      batches: [{ product_id: simulationProduct.id, quantity_received: 1000, cost_price_per_unit: 100,
        selling_price_per_unit: 150, batch_no: `SIM-OPEN-${branch.id.slice(0, 6)}`, expiry_date: '2031-12-31' }] } });
    if (receipt.status !== 200) throw new Error(`simulation stock receipt failed: ${receipt.status}`);
  }

  const dated = [];
  const recordDate = (table, idColumn, id, dateValue, extra = '') => {
    dated.push(`UPDATE ${table} SET ${extra}${extra ? ', ' : ''}created_at = ${sqlQuote(at(dateValue))} WHERE ${idColumn} = ${sqlQuote(id)};`);
  };

  // Receipt stock on credit at the start of each month, then pay portions from
  // the safe so supplier, stock and cash ledgers have correlated history.
  for (const monthOffset of [89, 59, 29]) {
    const branch = monthOffset === 59 ? minna : lagos;
    const stockRows = list((await request('GET', `/api/stock?branch_id=${branch.id}`, { token: owner })).body)
      .filter((s) => allowedProducts.has(s.product_id));
    const picked = stockRows[monthOffset === 59 ? 0 : 1] || stockRows[0];
    if (!picked) continue;
    const po = await request('POST', '/api/purchase-orders', { token: owner, body: {
      branch_id: branch.id, supplier_id: supplier.id,
      items: [{ product_id: picked.product_id, quantity_ordered: 100, expected_unit_cost: 110 }] } });
    if (po.status !== 201) throw new Error(`PO create failed: ${po.status}`);
    const receive = await request('POST', `/api/purchase-orders/${po.body.id}/receive`, { token: owner, body: {
      on_credit: true,
      batches: [{ product_id: picked.product_id, quantity_received: 100, cost_price_per_unit: 110,
        selling_price_per_unit: 170, batch_no: `SIM-${monthOffset}-${Date.now()}`, expiry_date: '2031-12-31' }] } });
    if (receive.status !== 200) throw new Error(`PO receive failed: ${receive.status}`);
    dated.push(`UPDATE purchase_orders SET ordered_at = ${sqlQuote(at(day(monthOffset), '09:00:00'))} WHERE id = ${sqlQuote(po.body.id)};`);
    dated.push(`UPDATE purchase_order_receipts SET received_at = ${sqlQuote(at(day(monthOffset), '10:00:00'))} WHERE purchase_order_id = ${sqlQuote(po.body.id)};`);
  }

  // Cash reserve for supplier payments and safe/till movement history.
  for (const [branch, offset] of [[lagos, 88], [minna, 58], [lagos, 28]]) {
    const deposit = await request('POST', '/api/safe/movements', { token: owner, body: {
      branch_id: branch.id, entry_type: 'DEPOSIT', amount: 50000, reason: `Three-month reserve ${day(offset)}` } });
    if (deposit.status === 201) dated.push(`UPDATE branch_safe_ledger SET created_at = ${sqlQuote(at(day(offset), '08:00:00'))} WHERE id = ${sqlQuote(deposit.body.id)};`);
  }

  let salesCreated = 0;
  let changeClaims = 0;
  let creditSales = 0;
  // One actual till session + sale per day, alternating branches and staff.
  for (let offset = 89; offset >= 0; offset--) {
    const branch = offset % 2 ? lagos : minna;
    const staff = offset % 2 ? staffLagos : staffMinna;
    const customer = customers[offset % customers.length];
    const stockRows = list((await request('GET', `/api/stock?branch_id=${branch.id}`, { token: owner })).body)
      .filter((s) => s.product_id === simulationProduct.id && s.quantity_remaining > 5 && s.selling_price_per_unit > 0);
    if (!stockRows.length) continue;
    const productId = simulationProduct.id;
    const fefo = stockRows.sort((a, b) => String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999')))[0];
    const qty = 1 + (offset % 3);
    const amount = Math.round(fefo.selling_price_per_unit * qty * 100) / 100;

    // A seed or prior simulated day can leave one branch drawer open. Close it
    // through the Owner recovery path before opening this day’s named staff
    // session; otherwise a 409 would skip the sale and fake a quiet month.
    const alreadyOpen = list((await request('GET', `/api/till?branch_id=${branch.id}`, { token: owner })).body)
      .find((t) => t.status === 'OPEN');
    if (alreadyOpen) {
      const expected = await request('GET', `/api/till/${alreadyOpen.id}/expected`, { token: owner });
      await request('POST', `/api/till/${alreadyOpen.id}/close`, { token: owner, body: {
        counted_closing_cash: expected.body.expected_closing_cash,
        force_reason: 'Three-month simulation: close prior drawer before next simulated day' } });
    }
    const till = await request('POST', '/api/till/open', { token: staff, body: { branch_id: branch.id, opening_cash: 5000 } });
    if (till.status !== 201) continue;
    const dateValue = day(offset);
    const isCredit = offset % 11 === 0;
    const isChangeOwed = !isCredit && offset % 17 === 0;
    const saleBody = {
      branch_id: branch.id,
      items: [{ product_id: productId, quantity: qty, unit_type: 'BASE_UNIT' }],
      payments: isCredit
        ? [{ method: 'CREDIT', amount }]
        : [{ method: 'CASH', amount, cash_tendered: isChangeOwed ? amount + 100 : amount, change_owed: isChangeOwed ? 100 : undefined }],
    };
    if (isCredit) { saleBody.customer_id = customer.id; creditSales++; }
    if (isChangeOwed) { saleBody.change_owed_for = { name: `Simulation Change ${offset}`, phone: `0804${String(offset).padStart(7, '0')}` }; }
    const sale = await request('POST', '/api/sales', { token: staff, body: saleBody });
    if (sale.status !== 201) {
      if (offset >= 85) console.log(`sale ${offset} refused: ${sale.status} ${JSON.stringify(sale.body).slice(0, 160)}`);
      continue;
    }
    salesCreated++;
    if (isChangeOwed) changeClaims++;
    dated.push(`UPDATE sales SET created_at = ${sqlQuote(at(dateValue, '13:00:00'))}, updated_at = ${sqlQuote(at(dateValue, '13:00:00'))} WHERE id = ${sqlQuote(sale.body.id)};`);
    dated.push(`UPDATE sale_payments SET created_at = ${sqlQuote(at(dateValue, '13:00:00'))} WHERE sale_id = ${sqlQuote(sale.body.id)};`);
    dated.push(`UPDATE debtor_ledger SET created_at = ${sqlQuote(at(dateValue, '13:00:00'))} WHERE sale_id = ${sqlQuote(sale.body.id)};`);
    dated.push(`UPDATE change_owed SET created_at = ${sqlQuote(at(dateValue, '13:00:00'))}, updated_at = ${sqlQuote(at(dateValue, '13:00:00'))} WHERE sale_id = ${sqlQuote(sale.body.id)};`);
    dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(dateValue, '13:00:00'))} WHERE source_type = 'SALE' AND source_id = ${sqlQuote(sale.body.id)};`);

    const expected = await request('GET', `/api/till/${till.body.id}/expected`, { token: staff });
    await request('POST', `/api/till/${till.body.id}/close`, { token: staff, body: { counted_closing_cash: expected.body.expected_closing_cash } });
    dated.push(`UPDATE till_sessions SET opened_at = ${sqlQuote(at(dateValue, '08:00:00'))}, closed_at = ${sqlQuote(at(dateValue, '18:00:00'))}, updated_at = ${sqlQuote(at(dateValue, '18:00:00'))} WHERE id = ${sqlQuote(till.body.id)};`);
  }

  // Monthly WHT-bearing costs and safe-funded supplier repayments.
  for (const offset of [75, 45, 15]) {
    for (const branch of [lagos, minna]) {
      const expense = await request('POST', '/api/expenses', { token: owner, body: {
        branch_id: branch.id, category: 'PROFESSIONAL_FEES', amount: 5000,
        description: `Three-month professional fee ${day(offset)}`,
        paid_by_method: 'TRANSFER', wht_rate_code: 'PROFESSIONAL_FEES', wht_counterparty_name: 'Simulation consultant' } });
      if (expense.status === 201) {
        dated.push(`UPDATE expenses SET expense_date = ${sqlQuote(day(offset))}, created_at = ${sqlQuote(at(day(offset), '15:00:00'))}, updated_at = ${sqlQuote(at(day(offset), '15:00:00'))} WHERE id = ${sqlQuote(expense.body.id)};`);
        dated.push(`UPDATE wht_entries SET entry_date = ${sqlQuote(day(offset))} WHERE source_type = 'EXPENSE' AND source_id = ${sqlQuote(expense.body.id)};`);
        dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(day(offset), '15:00:00'))} WHERE source_type = 'EXPENSE' AND source_id = ${sqlQuote(expense.body.id)};`);
      }
    }
  }

  // A handful of repayment/attendance records across the period.
  for (let offset = 80; offset >= 8; offset -= 18) {
    const branch = offset % 2 ? lagos : minna;
    const customer = customers[offset % customers.length];
    const balance = await request('GET', `/api/customers/${customer.id}/balance`, { token: owner });
    const owed = Number(balance.body && balance.body.balance_owed || 0);
    if (owed > 100) {
      const paid = await request('POST', `/api/customers/${customer.id}/payments`, { token: owner, body: { branch_id: branch.id, amount: 100 } });
      if (paid.status === 201) {
        dated.push(`UPDATE debtor_ledger SET created_at = ${sqlQuote(at(day(offset), '16:00:00'))} WHERE id = ${sqlQuote(paid.body.id)};`);
        dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(day(offset), '16:00:00'))} WHERE source_type = 'CUSTOMER_PAYMENT' AND source_id = ${sqlQuote(paid.body.id)};`);
      }
    }
    const attendance = await request('POST', '/api/attendance/clock-in', { token: offset % 2 ? staffLagos : staffMinna, body: { branch_id: branch.id, location: null } });
    if (attendance.status === 201) {
      const out = await request('POST', `/api/attendance/${attendance.body.id}/clock-out`, { token: offset % 2 ? staffLagos : staffMinna, body: { location: null } });
      if (out.status === 200) dated.push(`UPDATE staff_attendance SET clock_in_at = ${sqlQuote(at(day(offset), '08:00:00'))}, clock_out_at = ${sqlQuote(at(day(offset), '17:00:00'))}, updated_at = ${sqlQuote(at(day(offset), '17:00:00'))} WHERE id = ${sqlQuote(attendance.body.id)};`);
    }
  }

  // One completed inter-branch transfer validates the stock/cost clearing path
  // over the simulated period.
  const transferable = list((await request('GET', `/api/stock?branch_id=${lagos.id}`, { token: owner })).body)
    .find((row) => row.quantity_remaining > 10 && allowedProducts.has(row.product_id));
  if (transferable) {
    const transfer = await request('POST', '/api/transfers', { token: owner, body: {
      to_branch_id: minna.id, stock_batch_id: transferable.id, quantity: 5 } });
    if (transfer.status === 201) {
      await request('POST', `/api/transfers/${transfer.body.id}/receive`, { token: owner, body: {} });
      dated.push(`UPDATE stock_transfers SET initiated_at = ${sqlQuote(at(day(20), '11:00:00'))}, received_at = ${sqlQuote(at(day(19), '11:00:00'))}, updated_at = ${sqlQuote(at(day(19), '11:00:00'))} WHERE id = ${sqlQuote(transfer.body.id)};`);
      dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(day(20), '11:00:00'))} WHERE source_type = 'STOCK_TRANSFER_OUT' AND source_id = ${sqlQuote(transfer.body.id)};`);
      dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(day(19), '11:00:00'))} WHERE source_type = 'STOCK_TRANSFER_IN' AND source_id = ${sqlQuote(transfer.body.id)};`);
    }
  }

  // Settle part of a genuine supplier balance from the safe, retaining an
  // outstanding remainder for creditor ageing.
  const creditor = list((await request('GET', '/api/creditors/balances', { token: owner })).body)
    .find((row) => Number(row.balance_owed) > 500);
  if (creditor) {
    const amount = Math.round(Number(creditor.balance_owed) / 2 * 100) / 100;
    const payment = await request('POST', `/api/creditors/${creditor.supplier_id}/payments`, { token: owner, body: {
      branch_id: creditor.branch_id, amount, paid_by_method: 'SAFE', notes: 'Three-month supplier settlement' } });
    if (payment.status === 201) {
      dated.push(`UPDATE creditor_ledger SET created_at = ${sqlQuote(at(day(12), '14:00:00'))} WHERE id = ${sqlQuote(payment.body.id)};`);
      dated.push(`UPDATE gl_journal_entries SET entry_date = ${sqlQuote(at(day(12), '14:00:00'))} WHERE source_type = 'SUPPLIER_PAYMENT' AND source_id = ${sqlQuote(payment.body.id)};`);
    }
  }

  applyBackdates(dated);
  const metadata = {
    simulated_days: 90,
    sales_created: salesCreated,
    credit_sales: creditSales,
    change_claims: changeClaims,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync('/tmp/pharmaridge-three-month-simulation.json', JSON.stringify(metadata, null, 2));
  console.log(`Simulation complete: ${salesCreated} dated sales, ${creditSales} credit sales, ${changeClaims} change claims across 90 days.`);
})();
