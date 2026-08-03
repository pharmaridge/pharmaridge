const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, managerOnly, resolveScopedBranchId, assertBranchAccess, assertBranchActive, resolveMutationBranchId } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const wht = require('../lib/wht');
const { validateBatchEntry, normaliseBatchEntry } = require('../lib/stockEntry');
const { chunkIds, assertArrayWithinCap } = require('../lib/d1Limits');
const { assertManagerPermission } = require('../lib/planLimits');
const { readJsonBody } = require('../lib/http');
const { validateQuantity } = require('../lib/business');
const { resolveReceiveLine, splitTotalCost, describeReceipt } = require('../lib/receiving');

// HARD ARRAY-SIZE CAPS (added during a production audit alongside the
// N+1 subrequest fixes below). Even with bulk-chunked reads, an
// unbounded array still costs unbounded CPU and JSON parsing, and every
// row becomes a statement inside one db.batch(). These caps keep a
// single request comfortably inside the Workers Free plan's ceilings
// while sitting far above any realistic Nigerian pharmacy delivery —
// the largest real wholesaler invoices seen in this domain run to a few
// dozen lines, not hundreds.
const MAX_PO_ITEMS = 200;
const MAX_RECEIVE_BATCHES = 200;




const purchaseOrders = new Hono();
purchaseOrders.use('*', authRequired);

purchaseOrders.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  let sql = `
    SELECT po.*, s.name AS supplier_name, b.name AS branch_name
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id JOIN branches b ON b.id = po.branch_id
    WHERE po.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND po.branch_id = ?'; params.push(branchId); }
  sql += ' ORDER BY po.ordered_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

purchaseOrders.get('/:id', async (c) => {
  const id = c.req.param('id');
  // A purchase order is a DOCUMENT that gets printed and sent to a supplier,
  // so it must carry the trading identities, not bare foreign keys — otherwise
  // the printed copy has blank Supplier and Branch fields. Joined here rather
  // than fetched separately by the frontend, which would cost extra
  // subrequests per view against the Workers free-plan budget.
  const po = await c.env.DB.prepare(`
    SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, s.address AS supplier_address,
           b.name AS branch_name, u.full_name AS ordered_by_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN branches  b ON b.id = po.branch_id
    LEFT JOIN users     u ON u.id = po.ordered_by
    WHERE po.id = ? AND po.is_deleted = 0
  `).bind(id).first();
  if (!po) return c.json({ error: 'Purchase order not found' }, 404);
  try {
    assertBranchAccess(c, po.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  const { results: items } = await c.env.DB.prepare(`
    SELECT poi.*, p.name AS product_name FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ? AND poi.is_deleted = 0
  `).bind(id).all();
  // Receiving history — one row per actual delivery event — see the
  // identical field + rationale in the original design's partial-receiving
  // write-up.
  const { results: receipts } = await c.env.DB.prepare(`
    SELECT por.*, u.full_name AS received_by_name FROM purchase_order_receipts por
    LEFT JOIN users u ON u.id = por.received_by
    WHERE por.purchase_order_id = ? AND por.is_deleted = 0
    ORDER BY por.received_at ASC
  `).bind(id).all();
  return c.json({ ...po, items, receipts });
});

purchaseOrders.post('/', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  try {
    await assertBranchActive(c.env.DB, branchId, 'create a purchase order');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }
  if (!body.items || !body.items.length) return c.json({ error: 'At least one item is required' }, 400);

  // HARD ARRAY-SIZE CAP (added during a production audit — see the
  // subrequest write-up below). Refused with 413 + a machine-readable
  // code and an explicit `max`, matching the PUSH_BATCH_TOO_LARGE
  // contract in services/syncService.js so every oversized-collection
  // refusal in this API looks identical to a client.
  {
    const capErr = assertArrayWithinCap(body.items, {
      max: MAX_PO_ITEMS,
      code: 'PO_ITEMS_TOO_MANY',
      label: 'purchase-order line items',
      guidance: `Raise this as ${Math.ceil(body.items.length / MAX_PO_ITEMS)} separate purchase orders of ${MAX_PO_ITEMS} lines or fewer.`,
    });
    if (capErr) return c.json({ error: capErr.message, code: capErr.code, max: capErr.max, received: capErr.received }, 413);
  }

  // SECURITY/DATA-INTEGRITY: see the full explanation below.
  for (const it of body.items) {
    if (!it.product_id) return c.json({ error: 'Each item requires a product_id' }, 400);
    // BUG 82 — FRACTIONAL UNITS OF A PHYSICAL OBJECT.
    //
    // `isFinite` accepts 1.5, so a purchase order for "1.5 tablets" was
    // recorded verbatim, and receiving 2.5 units created a stock row holding
    // 2.5 tablets. Live-reproduced end to end: the batch appeared on the shelf
    // with quantity_remaining = 2.5.
    //
    // A base unit here is an indivisible physical object — a tablet, a bottle,
    // a sachet. Half of one cannot be ordered, delivered, counted at a
    // stocktake, or sold. The codebase already knew this: transfers
    // (routes/transfers.js) and stock adjustments (routes/adjustments.js) both
    // enforce Number.isInteger. The procurement and sales paths were the
    // outliers, which is exactly how the inconsistency was found.
    //
    // Fractional PACKS are a different question and remain impossible for the
    // same reason: quantity is always expressed in whole units of the chosen
    // unit_type, and the conversion to base units multiplies by whole numbers.
    // BUG 104: the ceiling comes from the SHARED validator, so this route
    // cannot drift from the other six quantity boundaries.
    const qErr = validateQuantity(it.quantity_ordered, `quantity_ordered for product ${it.product_id}`);
    if (qErr) return c.json({ error: qErr, code: 'QUANTITY_NOT_WHOLE' }, 400);
    if (it.expected_unit_cost != null && (!Number.isFinite(it.expected_unit_cost) || it.expected_unit_cost < 0)) {
      return c.json({ error: `expected_unit_cost for product ${it.product_id} must be a non-negative number` }, 400);
    }
  }

  // FREE-TIER SUBREQUEST BUG FOUND AND FIXED DURING A PRODUCTION AUDIT
  // (live-reproduced by executing this route with Cloudflare's
  // documented ceilings enforced): the product validation below used to
  // run INSIDE the per-item loop — one `SELECT ... FROM products` per
  // line item, plus a SECOND `SELECT ... FROM branches` per item for
  // POM products. Measured subrequest counts for a single request:
  //   60 OTC items ................ 64 subrequests  (Free ceiling: 50)
  //   30 all-POM items ............ 64 subrequests
  // Exceeding the ceiling does not degrade gracefully — the Workers
  // runtime kills the whole invocation with "Script exceeded resource
  // limits", so the buyer sees an opaque failure and the PO is silently
  // never created. `wrangler dev --local` does NOT enforce this quota,
  // which is precisely why it survived local testing.
  //
  // Fixed by (a) bulk-loading every referenced product in chunked
  // `IN (...)` queries — ceil(N/90) reads instead of N — (b) hoisting
  // the branch licence lookup out of the loop so it runs at most ONCE,
  // and (c) the hard MAX_PO_ITEMS cap above. A 200-line PO now costs 3
  // reads instead of 400.
  const requestedProductIds = [...new Set(body.items.map((it) => it.product_id))];
  const productById = new Map();
  for (const chunk of chunkIds(requestedProductIds)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await c.env.DB.prepare(
      `SELECT id, is_deleted, dispensing_type FROM products WHERE id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const p of results) productById.set(p.id, p);
  }

  let branchLicenseType = null;
  const hasPom = requestedProductIds.some((pid) => {
    const p = productById.get(pid);
    return p && p.dispensing_type === 'POM';
  });
  if (hasPom) {
    const branch = await c.env.DB.prepare('SELECT license_type FROM branches WHERE id = ?').bind(branchId).first();
    branchLicenseType = branch ? branch.license_type : null;
  }

  for (const it of body.items) {
    // FUNCTIONAL GAP CLOSED: see the write-up below — a discontinued
    // (soft-deleted) product may no longer be ordered, closing the
    // "receivable" half of the Products screen's own delete-confirmation
    // promise.
    const product = productById.get(it.product_id);
    if (!product) return c.json({ error: `Unknown product ${it.product_id}` }, 400);
    if (product.is_deleted) return c.json({ error: `Product ${it.product_id} has been discontinued and can no longer be ordered.` }, 400);
    // REGULATORY-COMPLIANCE — mirrors the identical fix + full write- up in
    // the original design.
    if (product.dispensing_type === 'POM' && branchLicenseType === 'PPMV') {
      return c.json({
        error: `Product ${it.product_id} is a prescription-only (POM) medication — this branch is licensed as a Patent Medicine Vendor (PPMV) and is not permitted to order or stock it under PCN regulations.`,
        code: 'PPMV_CANNOT_DISPENSE_POM',
      }, 403);
    }
  }

  const id = uuid();
  const statements = [
    c.env.DB.prepare(`INSERT INTO purchase_orders (id, branch_id, supplier_id, ordered_by, notes) VALUES (?,?,?,?,?)`)
      .bind(id, branchId, body.supplier_id || null, user.id, body.notes || null),
    ...body.items.map((it) =>
      c.env.DB.prepare(`INSERT INTO purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, expected_unit_cost) VALUES (?,?,?,?,?)`)
        .bind(uuid(), id, it.product_id, it.quantity_ordered, it.expected_unit_cost || null)
    ),
  ];
  await withD1Retry(() => c.env.DB.batch(statements), 'purchase order');
  return c.json(await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first(), 201);
});

// PARTIAL RECEIVING SUPPORT (feature added during a production audit pass
// — closes a real "designed but unreachable schema value" gap:
// purchase_orders.status has always included \'PARTIALLY_RECEIVED\' in its
// CHECK constraint, but this route was strictly all-or-nothing — see the
// write-up below for the full write- up). This route may now be called
// MULTIPLE times against the same PO as long as at least one line still
// has quantity remaining to receive — each call is its own "Goods Received
// Note" (a purchase_order_receipts row), with its own batches, its own
// cost total, and its own independent GL posting (keyed by the RECEIPT\'s
// id, not the PO\'s id).
//
// D1-SPECIFIC CONCURRENCY STRATEGY (no interactive transactions): the
// over-receive pre-check below is a fast, friendly rejection based on a
// read taken just before building the batch — it is NOT the authoritative
// safety net (see the identical caveat for the sales engine\'s unguarded
// stock decrement in worker/src/services/salesService.js). The actual
// database-enforced guarantee is (1) the CHECK (quantity_received <=
// quantity_ordered) constraint on purchase_order_items, which atomically
// fails this WHOLE batch if two concurrent receives ever raced to
// over-commit the same remaining quantity, and (2) computing the PO\'s
// final status via a correlated subquery evaluated by the LAST statement
// in this same batch (not from the earlier, possibly-stale pre-read) —
// since D1 batch statements execute sequentially within one atomic unit,
// this subquery correctly sees every quantity_received increment this same
// batch just applied.
// BUG 54 — CANCEL A PURCHASE ORDER.
//
// `purchase_orders.status` has always included 'CANCELLED' in its CHECK
// constraint, and the receive route below already refuses a cancelled PO
// ("it may have already been fully received or cancelled"). But NO route
// could ever set that value and no screen offered it: the status was
// designed, guarded against, and unreachable — the same
// "designed-but-unreachable schema value" class already found and closed
// on stocktake_sessions.
//
// The real-world gap: a supplier goes out of stock, or the pharmacy
// changes its mind, and the order sits PENDING forever. It keeps appearing
// on the outstanding-orders screen as goods that are still expected, which
// quietly overstates incoming stock in every reorder decision.
//
// Rules, deliberately narrow:
//   * Only a PENDING order may be cancelled. Once ANY goods have been
//     received the order is a record of a real delivery, and cancelling it
//     would orphan the stock and the supplier debt already booked.
//   * A reason is required, matching the BUG 51 standard for every other
//     manager override.
//   * managerOnly: cancelling an order is a commercial decision.
//   * No GL impact whatsoever — a PENDING order has posted nothing, which
//     is exactly why only PENDING is cancellable.
purchaseOrders.post('/:id/cancel', managerOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const po = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!po) return c.json({ error: 'Purchase order not found' }, 404);
  try {
    assertBranchAccess(c, po.branch_id);
    // BUG 84 — CLOSING A BRANCH STRANDED ITS OWN PENDING PURCHASE ORDERS.
    //
    // This route used to call assertBranchActive(). That is correct for every
    // action that CREATES new work at a branch — a sale, a clock-in, opening a
    // till, starting a stocktake, raising a PO — and every one of those guards
    // stays exactly as it is.
    //
    // Cancelling is the opposite: it is WIND-DOWN work, and closing a branch is
    // precisely when it needs doing. Live-reproduced: a branch was closed with
    // a PENDING purchase order outstanding, and the order could then never be
    // cancelled by anyone — not the owner, not the vendor ADMIN seat (both
    // 403). The only escape was to REOPEN the branch, cancel, and close it
    // again, and nothing in the product ever said so. Meanwhile the order kept
    // appearing as goods still expected.
    //
    // Every sibling wind-down action already got this right and was never
    // gated: closing a till, cancelling a stocktake, and force-clocking-out a
    // shift all work fine at a closed branch (verified). This route was the
    // sole outlier — which is exactly how the gap was found.
    //
    // Cancelling is safe at a closed branch: only a PENDING order may be
    // cancelled (enforced below), a PENDING order has posted nothing to the
    // GL, moved no stock and created no supplier debt, so there is no money
    // for a closed branch's books to absorb.
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }

  const body = await readJsonBody(c);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 4) {
    return c.json({
      error: 'Give a reason for cancelling this order — it is the only record of why goods that were ordered never arrived.',
      code: 'CANCEL_REASON_REQUIRED',
    }, 400);
  }

  if (po.status !== 'PENDING') {
    return c.json({
      error: po.status === 'CANCELLED'
        ? 'This purchase order has already been cancelled.'
        : `This order cannot be cancelled — its status is ${po.status}. Goods have already been received against it, so cancelling would orphan the stock and the supplier debt already recorded.`,
      code: 'PO_NOT_CANCELLABLE',
    }, 409);
  }

  // Guarded UPDATE: the WHERE clause re-asserts PENDING so two concurrent
  // cancels (or a cancel racing a receive) cannot both take effect. Same
  // compare-and-swap discipline as every other state transition here.
  const claim = await c.env.DB.prepare(`
    UPDATE purchase_orders
       SET status = 'CANCELLED',
           notes = TRIM(COALESCE(notes || ' | ', '') || 'Cancelled: ' || ?),
           updated_at = datetime('now')
     WHERE id = ? AND status = 'PENDING' AND is_deleted = 0
  `).bind(reason, id).run();
  if (!claim.meta || claim.meta.changes !== 1) {
    return c.json({
      error: 'This order changed while you were cancelling it — it may have just been received. Refresh and check before trying again.',
      code: 'PO_NOT_CANCELLABLE',
    }, 409);
  }

  return c.json(await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first());
});

purchaseOrders.post('/:id/receive', idempotent, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const po = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!po) return c.json({ error: 'Purchase order not found' }, 404);
  try {
    assertBranchAccess(c, po.branch_id);
    await assertBranchActive(c.env.DB, po.branch_id, 'receive a purchase order');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }
  if (!['PENDING', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    return c.json({ error: `This purchase order cannot be received — its status is ${po.status} (it may have already been fully received or cancelled).`, code: 'PO_NOT_RECEIVABLE' }, 409);
  }

  const body = await readJsonBody(c);

  if (!body.batches || !body.batches.length) {
    return c.json({ error: 'At least one batch is required' }, 400);
  }

  // HARD ARRAY-SIZE CAP — same contract as PO_ITEMS_TOO_MANY above.
  // Receiving is naturally splittable: this route already supports
  // PARTIAL receipts against the same PO, so refusing an oversized
  // payload costs the user nothing but a second "Receive" click.
  {
    const capErr = assertArrayWithinCap(body.batches, {
      max: MAX_RECEIVE_BATCHES,
      code: 'RECEIVE_BATCHES_TOO_MANY',
      label: 'stock batches',
      guidance: `Receive this delivery in ${Math.ceil(body.batches.length / MAX_RECEIVE_BATCHES)} passes of ${MAX_RECEIVE_BATCHES} batches or fewer — this purchase order supports partial receiving, so the remaining lines stay open.`,
    });
    if (capErr) return c.json({ error: capErr.message, code: capErr.code, max: capErr.max, received: capErr.received }, 413);
  }

  // SECURITY/DATA-INTEGRITY: see the full explanation below — a negative or
  // zero quantity/cost/price here corrupts stock-value reporting and, when
  // on_credit is set, the supplier creditor ledger total.
  for (const b of body.batches) {
    if (!b.product_id) {
      return c.json({ error: 'Each batch requires a product_id' }, 400);
    }
    // BUG 82 — see the write-up on quantity_ordered above. Receiving is the
    // step that actually put 2.5 tablets on the shelf, so it is guarded in its
    // own right rather than relying on the order having been sane.
    // BUG 112 — RECEIVE IN THE UNIT THE DELIVERY ARRIVED IN.
    //
    // Previously this accepted base units ONLY, and silently ignored a
    // `unit_type` field if one was sent: `{quantity_received:10,
    // unit_type:'CARTON'}` on a 10x10 product recorded 10 capsules instead of
    // 1,000 and returned 200. A sale could already be rung up by the carton,
    // so the two halves of the same product disagreed about what a carton is.
    //
    // A line may now be expressed EITHER way:
    //   receive_unit + receive_quantity (+ nesting)  -> converted here
    //   quantity_received                            -> already base units
    // Both are supported because an integration or an older client may still
    // post base units, and breaking them to add a feature would be its own
    // defect. The converted figure overwrites quantity_received, so every
    // downstream reader — stock, GL, creditor ledger — is unchanged.
    if (b.receive_unit) {
      const r = resolveReceiveLine(b, { label: `Product ${b.product_id}` });
      if (!r.ok) return c.json({ error: r.error, code: r.code }, 400);
      b.quantity_received = r.totalPieces;
      b.__resolved = r;

      // TOTAL PRICE FIRST. The supplier invoices a total; the per-piece cost
      // is arithmetic nobody should be doing at a delivery door.
      if (b.total_cost != null) {
        const split = splitTotalCost(b.total_cost, r);
        if (!split.ok) return c.json({ error: split.error, code: split.code }, 400);
        b.cost_price_per_unit = split.costPerPiece;
        b.__costSplit = split;
      }
    }

    const rqErr = validateQuantity(b.quantity_received, `quantity_received for product ${b.product_id}`);
    if (rqErr) return c.json({ error: rqErr, code: 'QUANTITY_NOT_WHOLE' }, 400);
    if (!Number.isFinite(b.cost_price_per_unit) || b.cost_price_per_unit < 0) {
      return c.json({ error: `cost_price_per_unit for product ${b.product_id} must be a non-negative number` }, 400);
    }
    if (!Number.isFinite(b.selling_price_per_unit) || b.selling_price_per_unit < 0) {
      return c.json({ error: `selling_price_per_unit for product ${b.product_id} must be a non-negative number` }, 400);
    }
    if (b.pack_price != null && (!Number.isFinite(b.pack_price) || b.pack_price < 0)) {
      return c.json({ error: `pack_price for product ${b.product_id} must be a non-negative number` }, 400);
    }
    if (b.carton_price != null && (!Number.isFinite(b.carton_price) || b.carton_price < 0)) {
      return c.json({ error: `carton_price for product ${b.product_id} must be a non-negative number` }, 400);
    }
    // DISPENSING-SAFETY (gap found during the pre-launch audit): expiry_date
    // and batch_no were previously accepted as `|| null`, admitting stock that
    // FEFO sorts last, the expired-sale guard cannot block, and the expiry
    // report never shows. See lib/stockEntry.js for the full write-up.
    const entryError = validateBatchEntry(b, `product ${b.product_id}`);
    if (entryError) return c.json({ error: entryError, code: 'BATCH_ENTRY_INVALID' }, 400);
  }

  // OWNER-CONTROLLED MANAGER PERMISSION — PRICE-SETTING BYPASS CLOSED.
  //
  // BUG FOUND AND LIVE-REPRODUCED during an OWNER/MANAGER alignment audit.
  // `managers_can_edit_prices` was enforced on
  // PUT /products/:id/price-override/:branchId — and nowhere else. But
  // receiving a delivery WRITES selling_price_per_unit straight onto the
  // new stock_batches row, and that batch price is the price of record the
  // POS actually charges.
  //
  // Reproduced: with the permission revoked, a MANAGER was refused a ₦35
  // price override (403), then received a delivery at
  // selling_price_per_unit = 999 and it landed in stock. Once the existing
  // ₦25 batch depletes, FEFO reaches that batch and every customer is
  // charged ₦999. The owner's restriction was a front door with the back
  // door open.
  //
  // WHY THIS IS NOT SIMPLY "BLOCK THE RECEIVE": selling_price_per_unit is
  // MANDATORY on every batch (validated above — a batch with no price is
  // rejected outright). So refusing any priced receive would refuse EVERY
  // receive, and a restricted manager could never book in a delivery at
  // all. Stopping a pharmacy from receiving stock because of a PRICING
  // policy is not what the owner asked for, and it would be discovered on
  // a delivery day with a driver waiting.
  //
  // Instead: a restricted manager may receive, but may NOT set a price
  // that differs from what the owner has already established for that
  // product at that branch. The branch price override is the owner's
  // decision; falling back to the product's most recent batch price keeps
  // a first-ever delivery workable. Only a genuine price CHANGE is
  // refused.
  {
    const permErr = await assertManagerPermission(c.env.DB, user, 'managers_can_edit_prices');
    if (permErr) {
      // Owner-set branch prices take precedence, then the product's
      // current batch price. Loaded in ONE query per source to stay well
      // inside the Free plan's subrequest budget.
      const productIds = [...new Set(body.batches.map((b) => b.product_id))];
      const allowed = new Map();
      for (const chunk of chunkIds(productIds, 1)) {
        const ph = chunk.map(() => '?').join(',');
        const { results: overrides } = await c.env.DB.prepare(`
          SELECT product_id, default_selling_price FROM product_price_overrides
           WHERE branch_id = ? AND product_id IN (${ph}) AND is_deleted = 0
        `).bind(po.branch_id, ...chunk).all();
        for (const r of overrides) allowed.set(r.product_id, r.default_selling_price);
        const { results: batches } = await c.env.DB.prepare(`
          SELECT product_id, MAX(selling_price_per_unit) AS p FROM stock_batches
           WHERE branch_id = ? AND product_id IN (${ph}) AND is_deleted = 0
           GROUP BY product_id
        `).bind(po.branch_id, ...chunk).all();
        for (const r of batches) if (!allowed.has(r.product_id)) allowed.set(r.product_id, r.p);
      }
      const changed = body.batches.filter((b) => {
        const ref = allowed.get(b.product_id);
        if (ref == null) return false; // no established price yet — first delivery
        return Math.abs(Number(b.selling_price_per_unit) - Number(ref)) > 0.005
          || b.pack_price != null || b.carton_price != null;
      });
      if (changed.length) {
        return c.json({
          error: 'The Owner has restricted this action: managers are not permitted to change product prices, '
            + 'and receiving a delivery sets the selling price customers are charged for that batch. '
            + 'Receive at the existing price, or ask the Owner to set the new price first.',
          code: permErr.code,
          products: changed.map((b) => ({
            product_id: b.product_id,
            submitted: b.selling_price_per_unit,
            existing: allowed.get(b.product_id),
          })),
        }, permErr.status);
      }
    }
  }

  // Over-receiving pre-check (friendly 400, not the authoritative
  // guard — see the file-header comment above).
  const requestedByProduct = new Map();
  for (const b of body.batches) {
    requestedByProduct.set(b.product_id, (requestedByProduct.get(b.product_id) || 0) + b.quantity_received);
  }
  // FREE-TIER SUBREQUEST BUG FOUND AND FIXED DURING A PRODUCTION AUDIT
  // (same class as the create route above, live-reproduced the same
  // way): this loop issued one `SELECT ... FROM purchase_order_items`
  // per DISTINCT product being received. Measured: receiving 50
  // distinct products in one delivery cost 55 subrequests, over the
  // Workers Free plan's 50 ceiling — the invocation is killed outright,
  // so the stock is never booked in even though the goods physically
  // arrived. Fixed by loading every relevant item row in chunked bulk
  // queries (ceil(N/89) reads instead of N) and grouping in memory.
  const itemRowsByProduct = new Map();
  const distinctProductIds = [...requestedByProduct.keys()];
  for (const chunk of chunkIds(distinctProductIds, 1)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results: rows } = await c.env.DB.prepare(`
      SELECT * FROM purchase_order_items
      WHERE purchase_order_id = ? AND product_id IN (${placeholders}) AND is_deleted = 0
      ORDER BY id
    `).bind(po.id, ...chunk).all();
    for (const row of rows) {
      if (!itemRowsByProduct.has(row.product_id)) itemRowsByProduct.set(row.product_id, []);
      itemRowsByProduct.get(row.product_id).push(row);
    }
  }
  for (const [productId, requested] of requestedByProduct) {
    const rows = itemRowsByProduct.get(productId);
    if (!rows || !rows.length) {
      return c.json({ error: `Product ${productId} is not on this purchase order` }, 400);
    }
    const remaining = rows.reduce((sum, r) => sum + (r.quantity_ordered - r.quantity_received), 0);
    if (requested > remaining) {
      return c.json({ error: `Cannot receive ${requested} of product ${productId} — only ${remaining} remain unreceived on this purchase order` }, 400);
    }
  }

  let totalCost = 0;
  const statements = [];
  for (const b of body.batches) {
    const batchId = uuid();
    statements.push(c.env.DB.prepare(`
      INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, pack_price, carton_price, supplier_id, purchase_order_id, received_by,
                                 received_unit, received_unit_count, units_per_pack_at_receipt, packs_per_carton_at_receipt, selling_pattern, total_cost)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(batchId, po.branch_id, b.product_id, normaliseBatchEntry(b).batch_no, normaliseBatchEntry(b).expiry_date, b.quantity_received, b.quantity_received,
             b.cost_price_per_unit, b.selling_price_per_unit,
             // Bug 112: where a total price was given, DERIVE the pack and
             // carton prices from it rather than leaving them blank — the
             // whole point of asking for the total is that the operator
             // should not have to compute these by hand. An explicitly
             // supplied price still wins.
             b.pack_price != null ? b.pack_price : (b.__costSplit ? b.__costSplit.costPerPack : null),
             b.carton_price != null ? b.carton_price : (b.__costSplit ? b.__costSplit.costPerCarton : null),
             po.supplier_id, po.id, user.id,
             b.__resolved ? b.__resolved.unit : null,
             b.__resolved ? b.__resolved.count : null,
             b.__resolved ? b.__resolved.unitsPerPack : null,
             b.__resolved ? b.__resolved.packsPerCarton : null,
             b.__resolved ? b.__resolved.sellingPattern : null,
             b.total_cost != null ? b.total_cost : null));
    totalCost += b.quantity_received * b.cost_price_per_unit;
  }

  // Consume the received delta against each product's item row(s),
  // oldest first — the CHECK (quantity_received <= quantity_ordered)
  // constraint is the database-enforced guard behind this write.
  for (const [productId, requested] of requestedByProduct) {
    let remainingToApply = requested;
    for (const row of itemRowsByProduct.get(productId)) {
      if (remainingToApply <= 0) break;
      const availableOnThisRow = row.quantity_ordered - row.quantity_received;
      if (availableOnThisRow <= 0) continue;
      const applyToThisRow = Math.min(availableOnThisRow, remainingToApply);
      statements.push(c.env.DB.prepare(`UPDATE purchase_order_items SET quantity_received = quantity_received + ?, updated_at = datetime('now') WHERE id = ?`).bind(applyToThisRow, row.id));
      remainingToApply -= applyToThisRow;
    }
  }

  const receiptId = uuid();
  statements.push(c.env.DB.prepare(`
    INSERT INTO purchase_order_receipts (id, purchase_order_id, received_by, on_credit, total_cost)
    VALUES (?,?,?,?,?)
  `).bind(receiptId, po.id, user.id, body.on_credit && po.supplier_id ? 1 : 0, totalCost));

  if (body.on_credit && po.supplier_id) {
    statements.push(c.env.DB.prepare(`
      INSERT INTO creditor_ledger (id, branch_id, supplier_id, purchase_order_id, entry_type, amount, recorded_by, notes) VALUES (?,?,?,?,'DEBIT',?,?,'Stock received on credit')
    `).bind(uuid(), po.branch_id, po.supplier_id, po.id, totalCost, user.id));
  }

  // GENERAL LEDGER: Inventory Asset debited at cost, Accounts Payable
  // credited if received on supplier credit, else Cash credited — see
  // worker/src/services/glService.js's postPoReceive(). Keyed by THIS
  // RECEIPT's own id (not the parent PO's id) so a second partial
  // delivery on the same PO posts its own independent GL entry.
  const onCredit = !!(body.on_credit && po.supplier_id);

  // WITHHOLDING TAX ON A CASH PURCHASE OF STOCK. Supply of goods by anyone
  // other than the manufacturer/producer attracts 2% under the 2024
  // Regulations, and a pharmacy buying from a distributor is in scope.
  //
  // Only on a CASH receipt. On a CREDIT receipt nothing has been paid yet
  // and WHT is deducted AT PAYMENT — taking it here as well would
  // double-count it when the supplier payment is later recorded. Refused
  // explicitly rather than silently ignored, so a caller that asks for
  // something incoherent is told why.
  let deduction = null;
  if (totalCost > 0) {
    if (onCredit && (body.wht_rate_code || body.wht_rate_percent != null)) {
      return c.json({
        error: 'Withholding tax cannot be deducted on a CREDIT receipt — nothing has been paid yet. Deduct it when you record the payment to the supplier, or this delivery would be taxed twice.',
        code: 'WHT_NOT_ON_CREDIT_RECEIPT',
      }, 400);
    }
    try {
      deduction = await wht.resolveDeduction(c.env.DB, {
        grossAmount: totalCost,
        rateCode: body.wht_rate_code,
        ratePercentOverride: body.wht_rate_percent,
        direction: 'PAYABLE',
      });
    } catch (e) {
      return c.json({ error: e.message, code: e.code }, e.status || 400);
    }
  }

  if (deduction) {
    const supplierRow = po.supplier_id
      ? await c.env.DB.prepare('SELECT name FROM suppliers WHERE id = ?').bind(po.supplier_id).first()
      : null;
    statements.push(wht.buildEntryStatement(c.env.DB, {
      id: uuid(), branchId: po.branch_id, direction: 'PAYABLE', sourceType: 'PO_RECEIVE', sourceId: receiptId,
      deduction,
      supplierId: po.supplier_id || null,
      counterpartyName: supplierRow ? supplierRow.name : null,
      counterpartyTin: body.wht_counterparty_tin || null,
      recordedBy: user.id,
      notes: 'WHT on supply of goods received',
    }));
  }

  // GENERAL LEDGER: Inventory Asset debited at the GROSS cost (the stock is
  // worth what it cost regardless of how payment was split), Accounts
  // Payable credited if on supplier credit, else Cash credited by the NET
  // with WHT Payable credited the remainder.
  if (totalCost > 0) {
    const glResult = await glService.postPoReceive(c.env.DB, {
      branchId: po.branch_id, poId: receiptId, receivedBy: user.id, totalCost,
      onCredit,
      whtAmount: deduction ? deduction.wht : 0,
    });
    if (glResult) statements.push(...glResult.statements);
  }

  // The PO is fully RECEIVED only once EVERY line's quantity_received
  // has reached its quantity_ordered — evaluated via a correlated
  // subquery against the database state AS OF the last statement in
  // this same batch (i.e. AFTER every increment above has already
  // applied), not from any earlier, possibly-stale read. This is the
  // exact transition this route could never previously reach.
  statements.push(c.env.DB.prepare(`
    UPDATE purchase_orders
    SET status = CASE
          WHEN (SELECT COUNT(*) FROM purchase_order_items WHERE purchase_order_id = ? AND is_deleted = 0 AND quantity_received < quantity_ordered) = 0
          THEN 'RECEIVED' ELSE 'PARTIALLY_RECEIVED'
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(po.id, po.id));

  try {
    await withD1Retry(() => c.env.DB.batch(statements), 'purchase order');
  } catch (e) {
    if (String(e.message).includes('CHECK constraint')) {
      return c.json({ error: 'This purchase order was received by another request at the same time and can no longer accept this delivery as specified — please refresh and try again.' }, 409);
    }
    throw e;
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(po.id).first());
});

module.exports = purchaseOrders;
