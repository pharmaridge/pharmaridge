// Sales engine for the Cloudflare D1 deployment.
//
// ARCHITECTURAL NOTE — how this differs from the Node/better-sqlite3
// deployment's salesService.js, and why:
//
// The original design wraps a sale in a single interactive SQLite
// transaction (db.transaction(...)), which gives it true read-your- writes
// isolation for the whole read-pick-write sequence.
//
// D1 offers NO interactive transactions — only db.batch([...]), which
// atomically commits-or-rolls-back a pre-built array of already-bound
// statements, with no way to branch on an intermediate result inside the
// batch. So the shape of this function is necessarily different: 1. READ
// current stock_batches for the requested products (a plain query, NOT
// inside any lock — another request could be doing the same read
// concurrently). 2. COMPUTE, in JS, which batches to draw from (FEFO
// order) and the resulting prices/totals, exactly like the Node version.
// 3. BUILD one array of INSERT/UPDATE statements covering the whole sale
// (sale row, sale_items, payments, stock decrements, ledger entries,
// controlled-drug register, prescriptions) and submit it as ONE db.batch
// call.
//
// The race window between steps 1 and 3 (another concurrent sale could
// have consumed the same stock in between) is closed not by locking — D1
// has none available to application code — but by the `CHECK
// (quantity_remaining >= 0)` constraint added on stock_batches (see
// migrations/0001). If two concurrent sales both read "10 left" and both
// try to sell the last few units, D1 processes each batch's writes
// atomically and independently; whichever batch commits second will have
// its UPDATE...SET quantity_remaining = quantity_remaining - N push the
// column below zero, and the ENTIRE batch (not just that one statement) is
// rejected and rolled back by SQLite itself. This was verified directly
// against a real local D1 instance under 15 concurrent requests against 10
// units of stock: exactly 10 succeeded, 5 failed cleanly with a CHECK
// constraint error, and the final stock was exactly 0 — never negative.
// When that happens here, we surface it to the caller as a normal,
// expected 409/422 "stock changed, please retry" rather than a 500 — it is
// not a bug, it is the concurrency control working as designed.
const { uuid } = require('../lib/crypto');
const { isTransientD1Error } = require('../lib/d1Retry');
const { withD1Retry } = require('../lib/d1Retry');
const { round2, baseUnitsFor, unitPriceFor, validateMoneyAmount, validateQuantity, normaliseMoney } = require('../lib/business');
const glService = require('./glService');
const { getClientSettings } = require('../lib/planLimits');
const whtLib = require('../lib/wht');
const changeOwedService = require('./changeOwedService');


const VALID_UNIT_TYPES = ['BASE_UNIT', 'PACK', 'CARTON'];
const VALID_PAYMENT_METHODS = ['CASH', 'POS_CARD', 'TRANSFER', 'CREDIT'];

// SECURITY/FINANCIAL-INTEGRITY: see the identical fix + full exploit
// writeup in the original design. None of a sale's numeric inputs were
// validated as positive before this function used them, most seriously
// allowing a negative payment amount to arbitrarily inflate or deflate
// tillService.js's computeExpectedCash while still passing the
// pre-existing "payments sum to total" check.
function validateSaleInputs({ items, discount, payments }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one item is required'), { status: 400 });
  }
  for (const item of items) {
    if (!item.product_id) throw Object.assign(new Error('Each item requires a product_id'), { status: 400 });
    if (item.unit_type != null && !VALID_UNIT_TYPES.includes(item.unit_type)) {
      throw Object.assign(new Error(`unit_type must be one of: ${VALID_UNIT_TYPES.join(', ')}`), { status: 400 });
    }
    // BUG 82 — a base unit is an indivisible physical object. `isFinite`
    // accepted 1.5, so "1.5 tablets" could be sold and 1.5 units deducted from
    // a batch. Transfers and adjustments already enforced isInteger; sales and
    // procurement were the outliers. Selling half a tablet is not a rounding
    // question, it is an impossible transaction.
    const sqErr = validateQuantity(item.quantity, `quantity for product ${item.product_id}`);
    if (sqErr) throw Object.assign(new Error(sqErr), { status: 400, code: 'QUANTITY_NOT_WHOLE' });
    if (item.override_unit_price != null && (!Number.isFinite(item.override_unit_price) || item.override_unit_price < 0)) {
      throw Object.assign(new Error(`override_unit_price for product ${item.product_id} must be a non-negative number`), { status: 400 });
    }
    // BUG 106 — see the write-up on whtSuffered in createSale(). Bug 100
    // snapped the PAYMENTS to whole kobo and the class was treated as closed,
    // but a payment is not the only money a caller can send. An overridden
    // unit price is multiplied by the quantity and lands in the same ledger,
    // so a sub-kobo override reaches the balance check by a different route.
    if (item.override_unit_price != null) item.override_unit_price = normaliseMoney(item.override_unit_price);
  }
  if (discount != null && (!Number.isFinite(discount) || discount < 0)) {
    throw Object.assign(new Error('discount must be a non-negative number'), { status: 400 });
  }
  if (!Array.isArray(payments) || payments.length === 0) {
    throw Object.assign(new Error('At least one payment is required'), { status: 400 });
  }
  for (const p of payments) {
    if (!VALID_PAYMENT_METHODS.includes(p.method)) {
      throw Object.assign(new Error(`payment method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`), { status: 400 });
    }
    // BUG 41: `> 0` alone let a sub-kobo payment reach the GL, which rounds
    // to 2dp and then threw "journal line ... has neither a debit nor a
    // credit" — internal ledger wording shown straight to the cashier.
    {
      const moneyErr = validateMoneyAmount(p.amount, 'Each payment amount');
      if (moneyErr) throw Object.assign(new Error(moneyErr), { status: 400, code: 'INVALID_MONEY_AMOUNT' });
      // BUG 100 — SUB-KOBO MONEY REACHED THE LEDGER.
      //
      // Bug 52 snapped expense amounts to the kobo at the boundary precisely so
      // a stored figure and its own GL entry could never disagree. Sale
      // payments were never given the same treatment, so a caller sending
      // 110.705 (an ordinary `price * 0.95` in someone's integration) produced
      // debits of 110.71 against credits of 110.705 — a ONE KOBO imbalance —
      // and the sale failed with the ledger's own internal wording:
      //   "GL posting error: entry for SALE/... does not balance"
      // shown verbatim to whoever was at the counter.
      //
      // Snapped here, at the edge, rather than patched in the poster: the
      // arithmetic downstream is correct, it was simply being fed a figure
      // Naira cannot express.
      p.amount = normaliseMoney(p.amount);
      if (p.cash_tendered != null) p.cash_tendered = normaliseMoney(p.cash_tendered);
      if (p.change_owed != null) p.change_owed = normaliseMoney(p.change_owed);
    }
    if (p.cash_tendered != null && (!Number.isFinite(p.cash_tendered) || p.cash_tendered < 0)) {
      throw Object.assign(new Error('cash_tendered must be a non-negative number'), { status: 400 });
    }
    // BUG 39 (live-reproduced). cash_tendered was checked for being a
    // non-negative number but never against the amount it is paying, so
    // {amount: 25, cash_tendered: 10} was accepted with HTTP 201 and
    // stored change_given = -15. Negative change is physically impossible:
    // it means the drawer handed money BACK to itself. The receipt hides
    // it (`change_given > 0`), so nobody sees it, and the row sits in
    // sale_payments as a permanently wrong record of what happened at the
    // counter — the kind of quiet inconsistency that surfaces months later
    // in a dispute with no way to reconstruct the truth.
    //
    // A customer handing over LESS than the line they are paying is a
    // short payment, not a sale: either the cashier mis-keyed the tender,
    // or the payment should have been split across methods. Refuse it and
    // say which, rather than silently recording a negative.
    if (p.method === 'CASH' && p.cash_tendered != null && round2(p.cash_tendered) < round2(p.amount)) {
      // Worded for the person at the counter, not the API. This string is
      // printed verbatim by the POS toast (pos.js catch -> UI.toast), so a
      // raw column name like `cash_tendered` would be noise to a cashier.
      throw Object.assign(
        new Error(`Cash received (N${round2(p.cash_tendered)}) is less than the cash part of this sale (N${round2(p.amount)}). Enter the full amount the customer handed over, or put the balance on another payment method.`),
        { status: 400, code: 'CASH_TENDERED_SHORT' },
      );
    }
  }
}

// Picks FEFO (first-expire-first-out) batches for a product from an
// ALREADY-LOADED, in-memory pool of that product's stock_batches rows —
// see loadStockPools below for why this is no longer a per-item D1 read.
// `pool` is mutated in place (each pick's `quantity_remaining` is
// decremented immediately) so that a SECOND cart line for the SAME product
// correctly sees the first line's in-flight allocation and picks from
// what's genuinely left, rather than both lines reading the same stale
// pre-sale snapshot and over-allocating the same units — this fixes a real
// bug (found and fixed during a production audit) where a legitimate sale
// needing 12 units total, split across two cart lines of 6 units each
// against 15 truly-available units spread over two batches, was
// incorrectly rejected as "insufficient stock": each line's separate D1
// read saw the same un-decremented 5+10 split, so both lines tried to draw
// from the same 5-unit batch and only one could actually be satisfied.
// Verified live against a real Worker + local D1 instance before and after
// this fix. Picks FEFO (first-expire-first-out) batches for a product from
// an ALREADY-LOADED, in-memory pool of that product's stock_batches rows —
// see loadStockPools below for why this is no longer a per-item D1 read.
// `pool` is mutated in place (each pick's `quantity_remaining` is
// decremented immediately) so that a SECOND cart line for the SAME product
// correctly sees the first line's in-flight allocation and picks from
// what's genuinely left, rather than both lines reading the same stale
// pre-sale snapshot and over-allocating the same units — this fixes a real
// bug (found and fixed during a production audit) where a legitimate sale
// needing 12 units total, split across two cart lines of 6 units each
// against 15 truly-available units spread over two batches, was
// incorrectly rejected as "insufficient stock": each line's separate D1
// read saw the same un-decremented 5+10 split, so both lines tried to draw
// from the same 5-unit batch and only one could actually be satisfied.
// Verified live against a real Worker + local D1 instance before and after
// this fix.
//
// `hasExpiredStock` (found and fixed during a production audit, same bug +
// fix as the original design's pickFefoBatches — see that function's
// detailed comment in the original implementation for the full write-up
// and live-reproduced numbers): the pool passed in here is now
// pre-filtered by loadStockPools to exclude any batch whose expiry_date
// has already passed, so an expired batch can never be picked for a sale —
// it previously WAS picked, and picked FIRST, since FEFO's `expiry_date
// ASC` ordering naturally sorts an expired batch ahead of every
// still-valid one. `hasExpiredStock` (computed by loadStockPools from a
// separate bulk query) lets this function tell a cashier the more useful,
// ACTIONABLE truth when a shortfall is specifically because the only
// remaining stock is expired (write it off first) rather than the generic
// "insufficient stock" message (which would incorrectly suggest waiting
// for a restock when stock may be sitting right there on the shelf, simply
// too old to sell).
function pickFefoFromPool(pool, neededBaseUnits, hasExpiredStock = false) {
  const picks = [];
  let remaining = neededBaseUnits;
  for (const b of pool) {
    if (remaining <= 0) break;
    if (b.quantity_remaining <= 0) continue;
    const take = Math.min(b.quantity_remaining, remaining);
    picks.push({ batch: b, take });
    b.quantity_remaining -= take; // mutate the shared in-memory pool — see comment above
    remaining -= take;
  }
  if (remaining > 0) {
    if (hasExpiredStock) {
      const err = new Error(`Insufficient NON-EXPIRED stock for this product (short by ${remaining} base unit(s)) — some stock exists but has expired and cannot legally be sold; write it off via Stock > Adjustments first.`);
      err.code = 'EXPIRED_STOCK_ONLY';
      err.status = 422;
      throw err;
    }
    const err = new Error(`Insufficient stock for this product: short by ${remaining} base unit(s)`);
    err.code = 'INSUFFICIENT_STOCK';
    throw err;
  }
  return picks;
}

// CLOUDFLARE FREE-TIER SUBREQUEST SAFETY NET (found and fixed during a
// production audit): every D1 query/db.batch call inside one Worker
// invocation counts against the Workers Free plan's hard 50-subrequest-
// per-invocation ceiling. Before this fix, createSale issued ONE D1 read
// per cart line for the product lookup and ANOTHER for its FEFO batch
// lookup (2 subrequests × N items), on top of ~5 fixed subrequests for
// auth/idempotency/subscription-gate middleware and 1 for the final
// db.batch commit — so a real sale with as few as ~23 distinct line items
// would silently fail in production with a "Script exceeded resource
// limits" error, even though it worked fine locally against `wrangler dev`
// (which does not enforce this specific production quota) and works fine
// on the original design (no equivalent per-request ceiling there). Fixed
// by loading every distinct product + its full stock_batches pool in
// exactly ONE bulk query each (see loadStockPools below), reducing the
// per-cart-line D1 cost from 2 reads to effectively 0 (all picking happens
// in-memory against the preloaded pools) — total subrequest cost for a
// sale is now a small constant (≈8) regardless of cart size.
// MAX_SALE_ITEMS below is a defense-in-depth cap on top of this fix, not a
// replacement for it — it protects the two other things that DO still
// scale with cart size: CPU time spent in the FEFO-picking/pricing loop
// (must stay under the Free plan's 10ms/request ceiling) and the final
// `db.batch`'s own statement count (each line contributes 2 statements:
// one sale_items INSERT, one stock_batches UPDATE).
//
// LOWERED 40 -> 20 (this pass, at the client's explicit request "just in
// case of other downtimes"): halving the cap buys a substantial extra
// safety margin against BOTH of the still-scaling costs above, for any
// future regression, platform-limit change (Cloudflare could tighten the
// CPU-time or Free-plan terms further), or slower device (e.g. a low-end
// Android tablet running the PWA, where the FEFO- picking/pricing loop's
// wall-clock time is not the same as the server-side CPU-time budget it
// must stay under, but a larger cart still means more JSON to parse and
// more work to do either way) — at essentially zero real-world cost, since
// 20 distinct line items in a single pharmacy transaction is already an
// unusually large basket (most Nigerian pharmacy/PPMV transactions are 1-6
// items) and the error message directs the cashier to simply split into
// two sales.
const MAX_SALE_ITEMS = 20;

// REGULATORY-COMPLIANCE-CRITICAL (found and fixed during a production
// audit — identical bug and fix to the original design's pickFefoBatches,
// see the write-up below for the full write-up including live-reproduced
// numbers): this bulk query previously had NO filter excluding
// already-expired batches, and FEFO sorting by `expiry_date ASC` means an
// expired batch — having the EARLIEST expiry date of all — was picked
// FIRST for every sale, not last or never. Fixed by splitting each
// product's batches into a `pools` Map (non-expired only — this is what
// pickFefoFromPool actually allocates from) and a separate
// `expiredProductIds` Set (tracks which products have SOME expired batch
// with quantity_remaining > 0, purely so a shortfall can be reported as
// the more actionable "write it off first" message instead of a generic
// "insufficient stock" one) — both derived from the SAME single bulk
// query, so this fix costs zero additional D1 subrequests. An expired
// batch is never added to `pools`, so it is now categorically impossible
// for pickFefoFromPool to allocate from one, regardless of what the
// shortfall-message logic reports.
async function loadStockPools(db, branchId, productIds) {
  if (productIds.length === 0) return { pools: new Map(), expiredProductIds: new Set() };
  // A single query for ALL requested products' batches (expired ones
  // included, filtered out below in JS), ordered so that slicing
  // per-product below still yields correct FEFO order within each
  // product's own group.
  const placeholders = productIds.map(() => '?').join(',');
  const { results: allBatches } = await db.prepare(`
    SELECT * FROM stock_batches
    WHERE branch_id = ? AND product_id IN (${placeholders}) AND is_deleted = 0 AND quantity_remaining > 0
    ORDER BY product_id, CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, received_at ASC
  `).bind(branchId, ...productIds).all();

  const pools = new Map();
  const expiredProductIds = new Set();
  for (const pid of productIds) pools.set(pid, []);
  // Compare against the WAT (West Africa Time, UTC+1) calendar date,
  // matching this system's existing WAT-based day-boundary convention
  // (see migration 009) — a batch expiring exactly "today" is treated
  // as already unsellable, the conservative/safe interpretation.
  const todayWat = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const batch of allBatches) {
    if (batch.expiry_date != null && batch.expiry_date.slice(0, 10) < todayWat) {
      expiredProductIds.add(batch.product_id);
      continue; // never enters the sellable pool
    }
    pools.get(batch.product_id).push(batch);
  }
  return { pools, expiredProductIds };
}

// items: [{ product_id, unit_type, quantity, override_unit_price?,
//           prescription?, controlled_kyc? }]
// payments: [{ method, amount, cash_tendered?, reference? }]
async function createSale(db, { branchId, servedBy, servedByRole = null, customerId, items, discount = 0, payments = [], tillSessionId = null, whtSuffered = 0, whtRateCode = null, whtCounterpartyTin = null, creditOverrideReason = null, changeOwedFor = null }) {
  // BUG 83: set when a manager authorises exceeding a credit limit; written
  // to sales.credit_override_reason below so the authorisation is permanent.
  let creditOverrideApplied = null;
  // BUG 106 — EVERY money figure a caller can send must be snapped to whole
  // kobo at this one boundary, not just the payments.
  //
  // Bug 100 fixed exactly this for `payments[].amount` and the class was
  // written up as closed. It was not: a sale also accepts a DISCOUNT, an
  // OVERRIDDEN UNIT PRICE and WHT SUFFERED, none of which were snapped. A
  // caller computing `price * 0.05` for withholding tax sends 19.845, the
  // ledger legs round differently, and the sale dies with the GL's own
  // internal wording shown to whoever is standing at the counter:
  //   "GL posting error: entry for SALE/... does not balance
  //    (debits=396.90999999999997 ...)"
  // Live-reproduced on a contract sale to a hospital buyer, which is exactly
  // the customer type WHT-suffered exists for.
  //
  // `discount` and `whtSuffered` are reassigned before validation so every
  // downstream calculation — the total, the payment reconciliation and both
  // GL legs — works from the same snapped figures.
  discount = normaliseMoney(discount || 0);
  whtSuffered = normaliseMoney(whtSuffered || 0);
  validateSaleInputs({ items, discount, payments });
  if (items.length > MAX_SALE_ITEMS) {
    throw Object.assign(
      new Error(`A single sale may contain at most ${MAX_SALE_ITEMS} line items (this one has ${items.length}). Split it into multiple sales.`),
      { status: 413, code: 'TOO_MANY_ITEMS' }
    );
  }
  const saleId = uuid();
  const statements = [];
  let subtotal = 0;
  let costOfGoodsSold = 0;

  const prescriptionRows = [];
  const controlledEntries = [];
  // BUG 95: a human-readable snapshot of what was bought, captured AT SALE
  // TIME so a change claim still describes itself years later even if the
  // product is renamed, reprice or deleted.
  const itemSummaries = [];

  // Bulk-preload: one query for every distinct product in the cart, one
  // query for every distinct product's full stock_batches pool — see the
  // subrequest-count rationale above. Products missing from this map (a
  // bad/nonexistent product_id) are caught below exactly as before, just
  // from a Map lookup instead of a fresh per-item read.
  //
  // FUNCTIONAL/DATA-INTEGRITY: see the write-up below — a discontinued
  // (soft-deleted) product must remain sellable for as long as physical
  // stock of it exists; only NEW purchase orders for it are blocked (see the
  // companion fix in worker/src/routes/purchaseOrders.js). This query is
  // deliberately NOT filtered by is_deleted for that reason.
  const distinctProductIds = [...new Set(items.map((it) => it.product_id))];
  const placeholders = distinctProductIds.map(() => '?').join(',');
  const productMap = new Map();
  if (distinctProductIds.length > 0) {
    const { results: productRows } = await db.prepare(
      `SELECT * FROM products WHERE id IN (${placeholders})`
    ).bind(...distinctProductIds).all();
    for (const p of productRows) productMap.set(p.id, p);
  }
  const { pools: stockPools, expiredProductIds } = await loadStockPools(db, branchId, distinctProductIds);

  // DATA-INTEGRITY: see the full explanation below — a nonexistent
  // customer_id previously reached all the way into the final db.batch
  // before failing with a raw "FOREIGN KEY constraint failed" (D1's
  // equivalent surfaces as a generic batch error rather than SQLite's own
  // SQLITE_CONSTRAINT_FOREIGNKEY code, making it even less diagnosable than
  // on the original design). Validated here, as a single extra subrequest
  // ONLY when a customer_id is actually provided (the common OTC-cash-sale
  // case pays zero cost for this check at all), before any statement is
  // built.
  if (customerId) {
    const customerExists = await db.prepare('SELECT 1 FROM customers WHERE id = ? AND is_deleted = 0').bind(customerId).first();
    if (!customerExists) {
      throw Object.assign(new Error(`Unknown customer ${customerId}`), { status: 400 });
    }
  }

  // COMPLIANCE GAP CLOSED (mirrors the identical fix + full write-up in the
  // original implementation, original design): the Admin Portal's
  // "Controlled Drug Register" plan toggle
  // (client_settings.controlled_register_enabled) was fully wired up for
  // display/persistence on this backend too, but turning it OFF never
  // actually stopped a controlled substance from being sold — confirmed live
  // against a real D1 instance. Checked here, using the already-preloaded
  // productMap (zero extra subrequests), before any statement is built — a
  // disabled client gets a clean 403 FEATURE_DISABLED up front rather than a
  // batch that has to be thrown away. Only checked when the cart actually
  // contains a controlled product, exactly like the original design.
  const hasControlledItem = [...productMap.values()].some((p) => p.is_controlled);
  if (hasControlledItem) {
    const settings = await getClientSettings(db);
    if (!settings.controlled_register_enabled) {
      throw Object.assign(
        new Error('The Controlled Drug Register module is not enabled on your current plan, so controlled substances cannot be dispensed. Please contact your PharmaRidge account administrator to enable it.'),
        { status: 403, code: 'FEATURE_DISABLED' }
      );
    }
  }

  // REGULATORY-COMPLIANCE GAP CLOSED (mirrors the identical fix + full
  // write-up in the original implementation, original design): a
  // PPMV-licensed branch is legally prohibited from dispensing POM
  // (prescription-only) medications under PCN regulations.
  const hasPomItem = [...productMap.values()].some((p) => p.dispensing_type === 'POM');
  if (hasPomItem) {
    const branch = await db.prepare('SELECT license_type FROM branches WHERE id = ?').bind(branchId).first();
    if (branch && branch.license_type === 'PPMV') {
      throw Object.assign(
        new Error('This branch is licensed as a Patent Medicine Vendor (PPMV), which is not permitted to dispense prescription-only (POM) medication under PCN regulations. Only a full PHARMACY license may sell this product.'),
        { status: 403, code: 'PPMV_CANNOT_DISPENSE_POM' }
      );
    }
  }

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) throw Object.assign(new Error(`Unknown product ${item.product_id}`), { status: 400 });

    const unitType = item.unit_type || 'BASE_UNIT';

    // BUG 113 — resolve the pack size from the BATCH THAT WILL BE SOLD, not
    // from the product's default. Pricing already read the batch, so taking
    // the quantity from the product meant a customer could be charged for a
    // 24-bottle pack and handed 10.
    //
    // The FEFO batch is peeked at here rather than after picking, because the
    // quantity in base units is the INPUT to picking — a chicken-and-egg that
    // is resolved by reading the pool's head, which is exactly the batch FEFO
    // will draw from first. Where a line spans two batches with different
    // nesting the first batch governs the whole line; that is a deliberate,
    // documented simplification (mixing pack sizes inside one line is not
    // something a counter can hand over anyway) and it is still infinitely
    // better than silently using a figure from neither batch.
    const pool = stockPools.get(item.product_id) || [];
    const leadBatch = pool.length ? pool[0].batch || pool[0] : null;
    const neededBase = baseUnitsFor(product, unitType, item.quantity, leadBatch);

    if (product.dispensing_type === 'POM' && !String(item.prescription?.prescriber_name || '').trim()) {
      // COMPLIANCE: see the full explanation below.
      throw Object.assign(new Error(`Product "${product.name}" is prescription-only (POM); prescription details (at minimum prescriber_name) are required.`), { code: 'PRESCRIPTION_REQUIRED' });
    }
    // COMPLIANCE: see the full explanation below — an empty `controlled_kyc:
    // {}` object is truthy and previously passed this check with no actual
    // buyer identity captured.
    if (product.is_controlled) {
      const kyc = item.controlled_kyc;
      if (!kyc || !String(kyc.buyer_name || '').trim() || !String(kyc.buyer_phone || '').trim()) {
        throw Object.assign(new Error(`Product "${product.name}" is a controlled substance; buyer_name and buyer_phone are required (buyer_id_type/buyer_id_number optional).`), { code: 'CONTROLLED_KYC_REQUIRED' });
      }
    }

    const picks = pickFefoFromPool(stockPools.get(item.product_id), neededBase, expiredProductIds.has(item.product_id));
    const baseUnitsPerUnitType = neededBase / item.quantity;

    for (const pick of picks) {
      const takeInUnitType = pick.take / baseUnitsPerUnitType;
      const unitPrice = item.override_unit_price != null ? item.override_unit_price : unitPriceFor(pick.batch, unitType);
      if (unitPrice == null) {
        throw Object.assign(new Error(`No ${unitType} price configured for "${product.name}"; sell as BASE_UNIT or set pack/carton price.`), { status: 400 });
      }
      const lineTotal = round2(unitPrice * takeInUnitType);
      subtotal += lineTotal;
      costOfGoodsSold += pick.take * pick.batch.cost_price_per_unit;

      const saleItemId = uuid();
      itemSummaries.push(`${takeInUnitType} x ${product.name} @ N${unitPrice}`);
      statements.push(db.prepare(`
        INSERT INTO sale_items (id, sale_id, stock_batch_id, product_id, unit_type, quantity, quantity_base_units, unit_price, line_total)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(saleItemId, saleId, pick.batch.id, item.product_id, unitType, takeInUnitType, pick.take, unitPrice, lineTotal));

      // UNGUARDED decrement — this is deliberate, not an oversight. It
      // may look safer to add "AND quantity_remaining >= ?" here, but
      // that is actually a CORRECTNESS BUG: a D1 batch statement that
      // matches ZERO rows is NOT an error (verified directly against a
      // real local D1 instance: batch() returns success:true,
      // meta.changes:0 for a no-op UPDATE) — it does not fail the
      // batch, it does not roll anything back, and the rest of this
      // sale (the sale row, payment, sale_items) would still commit
      // while this one batch's worth of stock silently never
      // decremented. That is a WORSE bug than overselling: phantom
      // inventory that the till/reports would never explain. The
      // actual, working safety net is letting the raw arithmetic run
      // and relying on CHECK (quantity_remaining >= 0) on the column
      // (see migrations/0001) to make SQLite itself throw a real error
      // — which DOES abort and roll back the entire batch atomically —
      // the moment a concurrent sale has already consumed the stock we
      // thought we had. This exact behavior (guarded vs unguarded) was
      // verified with real concurrency tests against local D1 during
      // development: the guarded version let 15/15 concurrent sales
      // against 10 units of stock all "succeed" while silently
      // under-decrementing stock; the unguarded version correctly let
      // exactly 10 succeed and rejected the other 5 with a clean,
      // catchable CHECK constraint error.
      statements.push(db.prepare(`
        UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(pick.take, pick.batch.id));

      if (item.prescription) prescriptionRows.push({ saleItemId, ...item.prescription });
      if (product.is_controlled) {
        controlledEntries.push({ productId: product.id, quantityDispensed: pick.take, saleItemId, kyc: item.controlled_kyc });
      }
    }
  }

  const total = round2(subtotal - discount);
  if (total < 0) throw Object.assign(new Error('Discount exceeds subtotal'), { status: 400 });

  // VAT (Value Added Tax) tracking — mirrors the identical fix + full design
  // rationale in the original design. VAT-INCLUSIVE model: `total` is never
  // increased by this; vatAmount is EXTRACTED from the existing total.
  const clientSettingsForVat = await getClientSettings(db);
  const vatAmount = clientSettingsForVat.vat_enabled && total > 0
    ? round2((total * clientSettingsForVat.vat_rate_percent) / (100 + clientSettingsForVat.vat_rate_percent))
    : 0;

  // WITHHOLDING TAX SUFFERED ON THIS SALE (the RECEIVABLE direction).
  //
  // A corporate customer — hospital, NGO, government buyer on contract —
  // is itself a tax agent: it withholds a slice of the invoice and pays
  // the pharmacy less cash. The pharmacy still EARNED the gross invoice
  // value, and the withheld slice is a reclaimable income-tax credit.
  //
  // This must be counted as settling part of the total. Without it, a
  // ₦1,000,000 invoice paid as ₦980,000 cash + ₦20,000 withheld would be
  // rejected here as a ₦20,000 underpayment, and the cashier's only way
  // out would be to fake a discount — destroying both the revenue figure
  // and the reclaimable credit.
  const whtAmount = round2(whtSuffered || 0);
  if (whtAmount < 0) {
    throw Object.assign(new Error('Withholding tax suffered cannot be negative'), { status: 400, code: 'WHT_INVALID_GROSS' });
  }
  if (whtAmount > total) {
    throw Object.assign(new Error(`Withholding tax (${whtAmount}) cannot exceed the sale total (${total})`), { status: 400, code: 'WHT_EXCEEDS_GROSS' });
  }

  const totalPaidNonCredit = payments.filter((p) => p.method !== 'CREDIT').reduce((s, p) => s + p.amount, 0);
  const creditPortion = payments.filter((p) => p.method === 'CREDIT').reduce((s, p) => s + p.amount, 0);
  const isCreditSale = creditPortion > 0 ? 1 : 0;
  const paidSum = round2(totalPaidNonCredit + creditPortion + whtAmount);
  if (Math.abs(paidSum - total) > 0.01) {
    throw Object.assign(new Error(`Payments (${paidSum}) do not sum to sale total (${total})`), { status: 400 });
  }

  // BUG 106 — THE ONE-KOBO TOLERANCE ABOVE WAS NOT HONOURED BY THE LEDGER.
  //
  // The check immediately above deliberately accepts a settlement that is up
  // to one kobo off the total: a caller splitting an invoice into a 95% cash
  // leg and a 5% withholding-tax leg rounds each part separately, and two
  // independently-rounded parts can sum to a kobo more or less than the whole.
  // That is unavoidable arithmetic, not a mistake by the caller, which is
  // exactly why the tolerance exists.
  //
  // But the GL was then handed those same unreconciled figures. It credits
  // SALES_REVENUE with the TOTAL while debiting CASH and WHT_RECEIVABLE with
  // the caller's two rounded legs, so the entry did not balance and the sale
  // died with the ledger's internal wording shown to the counter:
  //   "GL posting error: entry for SALE/... does not balance
  //    (debits=137.71, credits=137.7)"
  // Live-reproduced at price 10.30, 10.50, 10.90, 11.10 ... — roughly every
  // other price ending in an odd number of kobo. A contract sale to a hospital
  // buyer would have failed at the counter about half the time.
  //
  // Accepting a tolerance and then refusing to post it is the actual defect.
  // The residue is absorbed into the WHT leg, because WHT is the figure that
  // was derived by percentage and is therefore the one carrying the rounding;
  // cash is what physically changed hands and must never be adjusted to make
  // books balance. Revenue and the cash leg both stay exactly as recorded.
  //
  // NOTE ON THE COMPARISON ITSELF: the tolerance test is done in whole KOBO,
  // as integers. Written as `Math.abs(residue - whtAmount) <= 0.01` it fails
  // for the very cases it exists to catch — |0.51 - 0.52| evaluates to
  // 0.010000000000000009 in binary floating point, which is NOT <= 0.01, so
  // the correction silently did not apply and the sale still died. Comparing
  // integers removes the problem instead of tuning an epsilon around it.
  let whtPosted = whtAmount;
  if (whtAmount > 0) {
    const residue = round2(total - round2(totalPaidNonCredit + creditPortion));
    const kobo = (n) => Math.round(n * 100);
    if (residue >= 0 && Math.abs(kobo(residue) - kobo(whtAmount)) <= 1) whtPosted = residue;
  }
  if (creditPortion > 0 && !customerId) {
    throw Object.assign(new Error('Credit sales require a customer_id'), { status: 400 });
  }

  // BUG 83 — CREDIT HAD NO CEILING OF ANY KIND.
  //
  // Nothing anywhere compared a CREDIT payment against anything: no
  // credit_limit existed in the schema, the backend or the UI, and this
  // function happily recorded an unbounded debt. Live-reproduced: a plain
  // CASHIER extended 7,500 naira to one walk-in across six sales, with no
  // approval, no warning and no ceiling. Uncollectable debt is one of the most
  // common ways a profitable Nigerian pharmacy runs out of cash.
  //
  // The rule: a credit sale may not push the customer's OUTSTANDING BALANCE
  // past their credit_limit. The check is on the resulting balance, not on the
  // single sale, because ten small sales are the same exposure as one large
  // one — and the "lots of little ones" shape is exactly how the limit would
  // otherwise be walked past.
  //
  // Scoped per branch, matching how debtor_ledger and the repayment guard
  // (BUG 81) already compute what is owed.
  //
  // The OVERRIDE (client decision) exists because a real pharmacy sometimes
  // must extend credit past a limit — a trusted regular, a corporate account
  // mid-renewal — and a system that makes that impossible gets worked around
  // by recording a fake cash sale, which is far worse. So it is permitted,
  // but only for a MANAGER and above, only with a stated reason, and it is
  // recorded on the sale itself. A cashier can never override.
  if (creditPortion > 0) {
    const customer = await db.prepare(
      'SELECT id, name, credit_limit FROM customers WHERE id = ? AND is_deleted = 0',
    ).bind(customerId).first();
    if (!customer) {
      throw Object.assign(new Error('Customer not found'), { status: 404 });
    }
    const owedRow = await db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END), 0) AS owed
        FROM debtor_ledger
       WHERE customer_id = ? AND branch_id = ? AND is_deleted = 0
    `).bind(customerId, branchId).first();
    const alreadyOwed = round2(Number((owedRow && owedRow.owed) || 0));
    const limit = round2(Number(customer.credit_limit || 0));
    const wouldOwe = round2(alreadyOwed + creditPortion);

    if (wouldOwe > limit) {
      const reason = typeof creditOverrideReason === 'string' ? creditOverrideReason.trim() : '';
      const mayOverride = ['MANAGER', 'OWNER', 'ADMIN'].includes(servedByRole);
      if (!reason) {
        throw Object.assign(
          new Error(
            limit <= 0
              ? `${customer.name} has no credit limit set, so this sale must be paid for now. A manager can grant them a credit limit on the Customers screen.`
              : `This would take ${customer.name} to ${wouldOwe.toFixed(2)} against a credit limit of ${limit.toFixed(2)} (they already owe ${alreadyOwed.toFixed(2)}). Collect payment, or ask a manager to authorise going over the limit.`,
          ),
          { status: 400, code: 'CREDIT_LIMIT_EXCEEDED', credit_limit: limit, already_owed: alreadyOwed, would_owe: wouldOwe },
        );
      }
      if (!mayOverride) {
        throw Object.assign(
          new Error(`Only a manager or the owner can authorise credit beyond ${customer.name}'s limit.`),
          { status: 403, code: 'CREDIT_OVERRIDE_FORBIDDEN' },
        );
      }
      if (reason.length < 4) {
        throw Object.assign(
          new Error('Give a reason for going over this customer\'s credit limit — it is the only record of why the debt was allowed to grow.'),
          { status: 400, code: 'CREDIT_OVERRIDE_REASON_REQUIRED' },
        );
      }
      creditOverrideApplied = reason;
    }
  }

  // Sale header — inserted first in the batch array; D1 processes a
  // batch's statements in order within the single atomic unit, so
  // later statements referencing sale_id via FK are safe even though
  // nothing has actually committed until the whole batch succeeds.
  statements.unshift(db.prepare(`
    INSERT INTO sales (id, branch_id, served_by, customer_id, subtotal, discount, total, vat_amount, is_credit_sale, status, credit_override_reason, till_session_id)
    VALUES (?,?,?,?,?,?,?,?,?,'COMPLETED',?,?)
  `).bind(saleId, branchId, servedBy, customerId || null, round2(subtotal), round2(discount), total, vatAmount, isCreditSale, creditOverrideApplied, tillSessionId));

  // BUG 95 — `change_given` USED TO RECORD MONEY THAT WAS NEVER HANDED OVER.
  //
  // The old line was `change_given = cash_tendered - amount`, unconditionally.
  // That is only true when the drawer actually HAD the change. The single most
  // common counter event in a Nigerian pharmacy is that it does not: goods come
  // to N400, the customer gives N500, and there is no N100 note. The books then
  // claimed the customer had been paid N100 they never received, and the drawer
  // expected N400 while physically holding N500 — a phantom overage on every
  // occurrence, posting to CASH_OVER_SHORT at till close and making a genuine
  // overage indistinguishable from routine no-change events.
  //
  // The caller now says what actually happened, per payment line:
  //     change_owed: 100   -> N100 stayed in the drawer and is owed
  // Anything not owed is treated as handed over, exactly as before, so an
  // ordinary sale with change available is completely unaffected.
  let totalChangeOwed = 0;
  for (const p of payments) {
    const rawChange = p.method === 'CASH' && p.cash_tendered != null ? round2(p.cash_tendered - p.amount) : 0;
    const owed = p.method === 'CASH' ? round2(Math.max(0, Number(p.change_owed) || 0)) : 0;
    if (owed > rawChange + 0.0001) {
      throw Object.assign(
        new Error(`You cannot owe more change (N${owed}) than this payment leaves over (N${rawChange}). `
          + 'Check the cash received and the amount owed.'),
        { status: 400, code: 'CHANGE_OWED_EXCEEDS_CHANGE' }
      );
    }
    totalChangeOwed = round2(totalChangeOwed + owed);
    const changeGiven = round2(rawChange - owed);
    statements.push(db.prepare(`
      INSERT INTO sale_payments (id, sale_id, method, amount, cash_tendered, change_given, reference)
      VALUES (?,?,?,?,?,?,?)
    `).bind(uuid(), saleId, p.method, round2(p.amount), p.cash_tendered != null ? round2(p.cash_tendered) : null, changeGiven, p.reference || null));
  }

  // The claim itself, plus its GL posting, both appended to THIS batch so a
  // claim can never exist without its sale and vice versa.
  let changeClaim = null;
  if (totalChangeOwed > 0) {
    const summary = itemSummaries && itemSummaries.length
      ? itemSummaries.join(', ')
      : null;
    const built = await changeOwedService.buildShortfallStatements(db, {
      branchId, saleId, amount: totalChangeOwed,
      customerId: customerId || null,
      customerName: changeOwedFor && changeOwedFor.name,
      customerPhone: changeOwedFor && changeOwedFor.phone,
      saleSummary: summary,
      recordedBy: servedBy,
    });
    statements.push(...built.statements);
    // DR Cash (the money really is in the drawer) / CR Change Owed Payable
    // (and it really is the customer's). Same batch, so the liability cannot
    // exist without its ledger entry.
    // postChangeOwed returns `{ entryId, statements }` (or null when already
    // posted) — NOT a bare array. An earlier draft spread the object itself,
    // which appended nothing: the claim and the receipt both looked correct
    // while CHANGE_OWED_PAYABLE never moved and the drawer stayed N100 short.
    // Caught only because the probe asserts the LEDGER and the DRAWER, not the
    // 201 from the sale.
    const glChange = await glService.postChangeOwed(db, {
      branchId, claimId: built.claimId, recordedBy: servedBy, amount: built.amount,
    });
    if (glChange && glChange.statements) statements.push(...glChange.statements);
    changeClaim = { claim_code: built.claimCode, amount: built.amount, claim_id: built.claimId };
  }

  if (creditPortion > 0) {
    statements.push(db.prepare(`
      INSERT INTO debtor_ledger (id, branch_id, customer_id, sale_id, entry_type, amount, recorded_by, notes)
      VALUES (?,?,?,?,'DEBIT',?,?,'Credit sale balance')
    `).bind(uuid(), branchId, customerId, saleId, round2(creditPortion), servedBy));
  }

  // GENERAL LEDGER: builds the balanced double-entry statements for
  // this sale (Sales Revenue credited, Sales Discounts debited if any,
  // Cash/Bank/Accounts Receivable debited per payment method, Cost of
  // Goods Sold recognized against Inventory Asset) — see
  // worker/src/services/glService.js's postSale(). These statements
  // are appended to THIS SAME batch (not executed separately), so the
  // GL posting is atomic with the rest of the sale — either the whole
  // batch commits or none of it does.
  const glResult = await glService.postSale(db, {
    branchId, saleId, servedBy,
    subtotal: round2(subtotal), discount: round2(discount),
    payments: payments.map((p) => ({ method: p.method, amount: round2(p.amount) })),
    costOfGoodsSold: round2(costOfGoodsSold),
    vatAmount,
    // Bug 106: the LEDGER gets the reconciled figure so the entry balances.
    // The WHT REGISTER below keeps `whtAmount` — the amount the customer
    // actually withheld and will issue a credit note for. They differ by at
    // most one kobo and each is right for its own purpose.
    whtAmount: whtPosted,
  });
  if (glResult) statements.push(...glResult.statements);

  // The WHT register row backing the credit note the customer must issue,
  // and the figure the pharmacy later offsets against its own income tax.
  // Appended to the SAME batch as the sale and its journal entry, so a
  // reclaimable credit can never exist without the sale that earned it.
  if (whtAmount > 0) {
    statements.push(whtLib.buildEntryStatement(db, {
      id: uuid(),
      branchId,
      direction: 'RECEIVABLE',
      sourceType: 'SALE',
      sourceId: saleId,
      deduction: {
        rateCode: whtRateCode || 'CUSTOM',
        ratePercent: total > 0 ? round2((whtAmount / total) * 100) : 0,
        gross: total,
        wht: whtAmount,
        net: round2(total - whtAmount),
      },
      customerId: customerId || null,
      counterpartyTin: whtCounterpartyTin || null,
      recordedBy: servedBy,
      notes: 'WHT deducted by customer on contract supply',
    }));
  }

  const prescriptionIdBySaleItem = {};
  for (const pr of prescriptionRows) {
    const prescriptionId = uuid();
    prescriptionIdBySaleItem[pr.saleItemId] = prescriptionId;
    statements.push(db.prepare(`
      INSERT INTO prescriptions (id, sale_id, sale_item_id, prescriber_name, prescriber_pcn_or_mdcn_no, patient_name, patient_phone, dosage_notes, recorded_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(prescriptionId, saleId, pr.saleItemId, pr.prescriber_name || null, pr.prescriber_pcn_or_mdcn_no || null, pr.patient_name || null, pr.patient_phone || null, pr.dosage_notes || null, servedBy));
  }

  // Controlled substance register: the hash chain's prev_hash must be
  // computed from the LAST entry currently on record for this branch.
  // Because D1 batches can't read intermediate state mid-batch, if a
  // sale contains more than one controlled-drug line, we chain them
  // against each other in JS before submitting, exactly mirroring what
  // sequential inserts would have produced.
  //
  // RACE CONDITION FIX (found and fixed during a production audit,
  // reproduced live against a real Worker + D1 instance): reading the
  // branch's "last entry_hash" and then submitting a new row chained
  // from it is NOT atomic across two concurrent controlled-substance
  // sales at the same branch — both could read the same last hash and
  // both successfully commit, forking the tamper-evident chain (6 of 8
  // rows sharing one prev_hash in the live repro; the app's own
  // /verify endpoint correctly flagged the resulting chain as
  // `valid: false` even though nothing was actually tampered with).
  // Migration 010 added a `UNIQUE(branch_id, prev_hash)` index (with a
  // 'GENESIS' sentinel replacing NULL for a branch's very first entry —
  // see CHAIN_GENESIS_MARKER below and that migration's comment for why
  // NULL alone doesn't work) that makes a fork impossible to commit at
  // the storage layer; this function now catches exactly that
  // constraint violation and automatically retries with a freshly
  // re-read `last` hash, so a transient, genuinely expected race under
  // real concurrent dispensing is invisible to the cashier instead of
  // failing the whole sale or (worse) silently forking the chain.
  const CHAIN_GENESIS_MARKER = 'GENESIS';
  const MAX_CHAIN_RETRIES = 8;

  async function buildControlledRegisterStatements() {
    const last = await db.prepare(`
      SELECT entry_hash FROM controlled_substance_register WHERE branch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).bind(branchId).first();
    let prevHashForHashing = last ? last.entry_hash : null;
    let prevHashForStorage = last ? last.entry_hash : CHAIN_GENESIS_MARKER;
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const stmts = [];

    for (const c of controlledEntries) {
      const id = uuid();
      const prescriptionId = prescriptionIdBySaleItem[c.saleItemId] || null;
      const canonical = JSON.stringify({
        id, branchId, saleId, saleItemId: c.saleItemId, productId: c.productId, quantityDispensed: c.quantityDispensed,
        buyerName: c.kyc.buyer_name, buyerPhone: c.kyc.buyer_phone, buyerIdType: c.kyc.buyer_id_type || null,
        buyerIdNumber: c.kyc.buyer_id_number || null, prescriptionId, dispensedBy: servedBy, createdAt: nowIso, prevHash: prevHashForHashing,
      });
      const entryHash = await sha256Hex(canonical);
      stmts.push(db.prepare(`
        INSERT INTO controlled_substance_register
          (id, branch_id, sale_id, sale_item_id, product_id, quantity_dispensed, buyer_name, buyer_phone, buyer_id_type, buyer_id_number, prescription_id, dispensed_by, prev_hash, entry_hash, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(id, branchId, saleId, c.saleItemId, c.productId, c.quantityDispensed, c.kyc.buyer_name, c.kyc.buyer_phone, c.kyc.buyer_id_type || null, c.kyc.buyer_id_number || null, prescriptionId, servedBy, prevHashForStorage, entryHash, nowIso));
      prevHashForHashing = entryHash;
      prevHashForStorage = entryHash;
    }
    return stmts;
  }

  const isChainForkViolation = (e) => controlledEntries.length > 0
    && String(e.message).includes('controlled_substance_register.branch_id, controlled_substance_register.prev_hash');
  // BUG 40: this previously matched ANY CHECK constraint failure and
  // reported every one of them as INSUFFICIENT_STOCK ("Stock changed while
  // processing this sale"). That was true when quantity_remaining >= 0 was
  // the only CHECK a sale batch could trip, but it is a latent
  // misdiagnosis trap: the moment another CHECK is added to any table this
  // batch writes, a completely unrelated fault starts telling the cashier
  // to retry a sale that will never succeed. Observed exactly that way
  // while adding the change_given >= 0 constraint for BUG 39 — a short
  // cash tender surfaced as a 422 "Stock changed... Please retry."
  //
  // This is the same class as BUG 23 (every adjustment CHECK failure
  // misreported as low stock). Match the stock constraint SPECIFICALLY;
  // anything else must surface as itself rather than wear stock's label.
  const isStockCheckViolation = (e) => {
    const m = String(e && e.message);
    const isCheck = m.includes('CHECK constraint') || m.includes('SQLITE_CONSTRAINT_CHECK');
    return isCheck && m.includes('quantity_remaining');
  };

  for (let attempt = 1; attempt <= MAX_CHAIN_RETRIES; attempt++) {
    const controlledStatements = controlledEntries.length > 0 ? await buildControlledRegisterStatements() : [];
    try {
      await withD1Retry(() => db.batch([...statements, ...controlledStatements]), 'sale + controlled register');
      break; // success — fall through to getSaleReceipt below
    } catch (e) {
      if (isStockCheckViolation(e) && !isChainForkViolation(e)) {
        // A CHECK constraint failure here means stock genuinely changed between
        // our read and our write (a concurrent sale won the race) — this is
        // expected under contention, not a bug. Surface it as the same
        // INSUFFICIENT_STOCK the original design would report.
        throw Object.assign(new Error('Stock changed while processing this sale (likely a concurrent sale). Please retry.'), { code: 'INSUFFICIENT_STOCK', status: 422 });
      }
      if (isChainForkViolation(e) && attempt < MAX_CHAIN_RETRIES) {
        // Small random jitter before re-reading — under a genuine
        // "thundering herd" of simultaneous controlled sales at one
        // branch, retrying instantly in lockstep makes every retry just
        // as likely to collide again; a brief random stagger (a few
        // milliseconds, cheap relative to the Workers Free plan's 10ms
        // CPU-time budget since await-ing a timer does not consume CPU
        // time — only active computation does) spreads retries out and
        // sharply raises the odds that whichever request retries first
        // wins cleanly before the next one even re-reads.
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15) + 5));
        continue; // re-read the last hash and rebuild the controlled-register statements fresh
      }
      if (isChainForkViolation(e)) {
        // Exhausted retries under truly extreme contention at one
        // branch — surface a clean, actionable error rather than the
        // raw constraint message, and let the client's normal retry
        // logic (or a cashier simply pressing "Complete Sale" again)
        // handle it, exactly like INSUFFICIENT_STOCK already does.
        throw Object.assign(new Error('Another controlled-substance sale is being recorded for this branch at the same instant. Please retry.'), { code: 'CHAIN_CONTENTION', status: 409 });
      }
      // TRANSIENT D1 INFRASTRUCTURE FAULT (not contention, not a
      // constraint): Cloudflare documents these as routine and says to
      // retry — see lib/d1Retry.js. This loop existed only for
      // hash-chain contention, so a blip fell straight through to
      // `throw e`, became a bare 500, and (before the companion fix in
      // public/js/offline.js) got the sale quarantined. Retrying is safe
      // for exactly the same reason the chain retry is: db.batch() is
      // atomic, so a failed batch committed nothing, and the whole route
      // sits behind an Idempotency-Key that a 5xx releases.
      if (isTransientD1Error(e) && attempt < MAX_CHAIN_RETRIES) {
        console.warn(`[sales] transient D1 fault on sale commit (attempt ${attempt}/${MAX_CHAIN_RETRIES}): ${e.message}`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw e;
    }
  }

  return getSaleReceipt(db, saleId);
}

async function getSaleReceipt(db, saleId) {
  // PRINTABLE-RECEIPT ENRICHMENT (added during the pre-launch audit):
  // a receipt that leaves the building on paper must be self-describing. The
  // sales row alone carries only foreign keys, so the branch's trading
  // identity (name/address/phone/PCN licence), the serving cashier and the
  // customer are joined in here rather than being looked up separately by the
  // frontend — three extra round trips per receipt would also have counted
  // against the Workers free plan's subrequest budget on every single sale.
  const sale = await db.prepare(`
    SELECT s.*,
           b.name    AS branch_name,
           b.address AS branch_address,
           b.phone   AS branch_phone,
           b.pcn_license_no,
           b.superintendent_pharmacist,
           u.full_name AS served_by_name,
           v.full_name AS voided_by_name,
           c.name      AS customer_name,
           c.phone     AS customer_phone
    FROM sales s
    LEFT JOIN branches  b ON b.id = s.branch_id
    LEFT JOIN users     u ON u.id = s.served_by
    LEFT JOIN users     v ON v.id = s.voided_by
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ?
  `).bind(saleId).first();
  if (!sale) return null;
  const { results: items } = await db.prepare(`
    SELECT si.*, p.name AS product_name, p.base_unit, sb.batch_no, sb.expiry_date
    FROM sale_items si JOIN products p ON p.id = si.product_id JOIN stock_batches sb ON sb.id = si.stock_batch_id
    WHERE si.sale_id = ? AND si.is_deleted = 0
  `).bind(saleId).all();
  const { results: payments } = await db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all();
  const { results: prescriptions } = await db.prepare('SELECT * FROM prescriptions WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all();
  // Controlled-substance register entries belong on the customer's copy: a
  // PCN inspector expects the dispensing record and the buyer's identity to be
  // reproducible from the receipt itself.
  const { results: controlledEntries } = await db.prepare(`
    SELECT csr.*, p.name AS product_name
    FROM controlled_substance_register csr
    LEFT JOIN products p ON p.id = csr.product_id
    WHERE csr.sale_id = ?
  `).bind(saleId).all();
  // BUG 95, and the client's explicit instruction that the claim "should
  // appear in the initial purchase receipt too". Attached to the RECEIPT
  // rather than returned only from createSale, so a reprint weeks later still
  // carries the code — a customer who lost the slip is exactly the person who
  // will ask for the receipt again.
  const changeClaims = await changeOwedService.claimsForSale(db, saleId);
  return {
    ...sale, items, payments, prescriptions, controlled_entries: controlledEntries,
    change_owed: changeClaims.length ? changeClaims : undefined,
  };
}

async function voidSale(db, saleId, voidedBy, reason) {
  const sale = await db.prepare('SELECT * FROM sales WHERE id = ?').bind(saleId).first();
  if (!sale) throw Object.assign(new Error('Sale not found'), { status: 404 });
  if (sale.status !== 'COMPLETED') throw Object.assign(new Error(`Cannot void a sale with status ${sale.status}`), { status: 400 });

  // PHASE 1: atomically claim the void with a guarded UPDATE, alone, in
  // its own batch. This is deliberately isolated from the stock/ledger
  // reversal below — if we bundled them into one batch, two concurrent
  // void attempts could both have their stock-reversal statements
  // execute (those have no natural guard), even though only one of them
  // could ever win the sales-row guard, silently double-crediting stock
  // back. Splitting into two phases means the second phase (the actual
  // reversal) only ever runs for whichever single request wins phase 1.
// BUG 65 — a CAS claim batch left unwrapped turns a routine D1 blip into a
// FALSE conflict. Cloudflare documents faults like "Network connection lost."
// as expected noise; unwrapped, the claim throws and the caller reports a 409
// "someone else did this at the same time" when nobody did. Retrying is safe
// precisely BECAUSE it is a compare-and-swap: if the first attempt actually
// committed, the re-run matches no rows and yields changes=0, which the
// existing guard below already handles as the loser. Only Cloudflare's
// documented transient list is retried; a real conflict is untouched.
  const claimResult = await withD1Retry(() => db.batch([
    db.prepare(`UPDATE sales SET status = 'VOIDED', voided_by = ?, void_reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'COMPLETED'`)
      .bind(voidedBy, reason || null, saleId),
  ]), 'void claim');
  const claimed = claimResult[0]?.meta?.changes === 1;
  if (!claimed) {
    throw Object.assign(new Error('This sale was voided by another request at the same time.'), { status: 409 });
  }

  // PHASE 2: we now exclusively own reversing this sale's effects.
  const { results: items } = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all();
  const statements = items.map((it) =>
    db.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(it.quantity_base_units, it.stock_batch_id)
  );
  // FINANCIAL-INTEGRITY (real bug found and fixed during a production audit,
  // mirrored from the identical Node-deployment fix — see voidSale for the
  // full write-up and live-reproduced numbers): reverse the debtor ledger by
  // the ACTUAL credit portion originally recorded for THIS sale (summed
  // fresh from that sale's own DEBIT row(s) in debtor_ledger), never
  // `sale.total` — a mixed cash+credit sale's `total` includes the cash
  // portion the customer already paid up front, which must never be credited
  // back to their running balance on void.
  if (sale.is_credit_sale) {
    const originalDebit = await db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM debtor_ledger
      WHERE sale_id = ? AND entry_type = 'DEBIT' AND is_deleted = 0
    `).bind(saleId).first();
    if (originalDebit.total > 0) {
      statements.push(db.prepare(`
        INSERT INTO debtor_ledger (id, branch_id, customer_id, sale_id, entry_type, amount, recorded_by, notes)
        VALUES (?,?,?,?,'PAYMENT',?,?,'Reversal due to sale void')
      `).bind(uuid(), sale.branch_id, sale.customer_id, saleId, originalDebit.total, voidedBy));
    }
  }

  // BUG 102 — VOIDING A SALE LEFT ITS CHANGE CLAIM STANDING.
  //
  // A sale that could not give change creates a claim: the money stays in the
  // drawer and the shop formally owes a named customer (Bug 95). Voiding the
  // sale reversed the stock, the debtor ledger and the GL — but never touched
  // the claim. Live-reproduced: after the void the claim was still
  // OUTSTANDING and CHANGE_OWED_PAYABLE still carried the liability, so the
  // pharmacy owed N100 for a sale that no longer exists, and the customer
  // could walk in and collect it on top of the refund they already had.
  //
  // Cancelled rather than deleted, and only while still OUTSTANDING: a claim
  // the customer already collected must NOT be rewritten — that money really
  // did leave the drawer, and erasing the record would make the till short
  // with nothing to explain it. This is the same reasoning as reversing the
  // debtor ledger with a new PAYMENT row instead of deleting the DEBIT.
  const openClaims = await db.prepare(`
    SELECT id, amount FROM change_owed
    WHERE sale_id = ? AND status = 'OUTSTANDING' AND is_deleted = 0
  `).bind(saleId).all();
  for (const claim of (openClaims.results || [])) {
    statements.push(db.prepare(`
      UPDATE change_owed
         SET status = 'WRITTEN_OFF', settlement_method = 'WRITTEN_OFF',
             settled_at = datetime('now'), settled_by = ?,
             settled_notes = 'Cancelled automatically because the sale was voided',
             updated_at = datetime('now')
       WHERE id = ? AND status = 'OUTSTANDING'
    `).bind(voidedBy, claim.id));
    // And release the liability. Posted as a settlement, not a write-off to
    // income: nothing was earned here — the money is going back to the
    // customer with the rest of the refund.
    const glClaim = await glService.postChangeSettlement(db, {
      branchId: sale.branch_id, claimId: claim.id, settledBy: voidedBy,
      amount: claim.amount, appliedToSale: false,
    });
    if (glClaim && glClaim.statements) statements.push(...glClaim.statements);
  }

  // GENERAL LEDGER: reverse the original sale's posted journal entry
  // (exact debit/credit swap, not a fresh recomputation) — see
  // worker/src/services/glService.js's postSaleVoid(). Appended to
  // THIS SAME phase-2 batch so it commits atomically with the stock/
  // ledger reversal above. No-op if the original sale was never
  // posted to the GL (e.g. it predates this feature).
  const glVoidResult = await glService.postSaleVoid(db, { branchId: sale.branch_id, saleId, voidedBy });
  if (glVoidResult) statements.push(...glVoidResult.statements);

  // WITHHOLDING TAX REGISTER (bug found and live-reproduced during an
  // audit): postSaleVoid above reverses every GL line generically, so
  // WHT_RECEIVABLE correctly went back to zero — but the `wht_entries`
  // row survived untouched. That row is not decoration: it is what backs
  // the WHT credit note and the amount the pharmacy claims against its
  // own income tax. Measured on live D1: after voiding an 80,000 contract
  // sale the GL said the 1,600 credit was gone while the register still
  // asserted it existed.
  //
  // The consequence is a pharmacy claiming a tax credit for an invoice
  // that no longer exists — a real exposure with the revenue authority,
  // and one that no screen would ever surface because each source of
  // truth looks internally consistent on its own.
  //
  // Soft-deleted rather than hard-deleted, matching how this codebase
  // reverses everything else financial (voidSale inserts a compensating
  // debtor_ledger row instead of deleting the original): the audit trail
  // of "a credit was raised and then withdrawn" must survive.
  statements.push(db.prepare(`
    UPDATE wht_entries
       SET is_deleted = 1,
           notes = COALESCE(notes || ' | ', '') || 'Withdrawn: sale voided',
           updated_at = datetime('now')
     WHERE source_type = 'SALE' AND source_id = ? AND is_deleted = 0
  `).bind(saleId));

  if (statements.length > 0) {
    await withD1Retry(() => db.batch(statements), 'sale');
  }

  return getSaleReceipt(db, saleId);
}

module.exports = { createSale, voidSale, getSaleReceipt, pickFefoFromPool, loadStockPools };

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
