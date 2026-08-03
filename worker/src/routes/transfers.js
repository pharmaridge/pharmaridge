const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { idempotent } = require('../lib/idempotency');
const { authRequired, assertBranchAccess, assertBranchActive, resolveScopedBranchId, pinnedBranchIdOf } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const { readJsonBody } = require('../lib/http');
const { validateQuantity } = require('../lib/business');




const transfers = new Hono();
transfers.use('*', authRequired);

transfers.get('/', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  let sql = `
    SELECT st.*, p.name AS product_name, fb.name AS from_branch_name, tb.name AS to_branch_name
    FROM stock_transfers st JOIN stock_batches sb ON sb.id = st.stock_batch_id JOIN products p ON p.id = sb.product_id
    JOIN branches fb ON fb.id = st.from_branch_id JOIN branches tb ON tb.id = st.to_branch_id
    WHERE st.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND (st.from_branch_id = ? OR st.to_branch_id = ?)'; params.push(branchId, branchId); }
  sql += ' ORDER BY st.initiated_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

transfers.post('/', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const { to_branch_id, stock_batch_id, quantity } = body;
  if (!to_branch_id || !stock_batch_id || !quantity) return c.json({ error: 'to_branch_id, stock_batch_id, quantity are required' }, 400);
  // SECURITY/DATA-INTEGRITY: see the full explanation below — `!quantity`
  // alone does not reject a negative number, which would fabricate stock via
  // the raw arithmetic in the `/receive` step below.
  const tqErr = validateQuantity(quantity, 'quantity');
  if (tqErr) return c.json({ error: tqErr }, 400);

  const batch = await c.env.DB.prepare('SELECT * FROM stock_batches WHERE id = ? AND is_deleted = 0').bind(stock_batch_id).first();
  if (!batch) return c.json({ error: 'Stock batch not found' }, 404);
  // CROSS-BRANCH STOCK PULL FOUND AND FIXED (live-reproduced): this
  // checked `role === 'STAFF'` only, so a MANAGER pinned to Minna
  // initiated a transfer OUT of a Lagos batch and received it into
  // Minna, moving 50 units (5,000 -> 4,950) from a branch they cannot
  // even list. Any branch-pinned user — STAFF or MANAGER — may only
  // move stock out of their own branch.
  {
    const pinned = pinnedBranchIdOf(user);
    if (pinned && batch.branch_id !== pinned) {
      return c.json({ error: 'You can only transfer stock out of your own branch.', code: 'BRANCH_SCOPE_VIOLATION' }, 403);
    }
  }
  if (batch.branch_id === to_branch_id) return c.json({ error: 'from and to branch must differ' }, 400);
  if (quantity > batch.quantity_remaining) return c.json({ error: 'Insufficient stock in source batch' }, 400);

  // BRANCH-DEACTIVATION ENFORCEMENT: see the identical fix + full rationale
  // in the original design — only the DESTINATION branch is checked, not the
  // source, since a branch being wound down still needs to be able to move
  // its existing stock OUT to another active branch.
  try {
    await assertBranchActive(c.env.DB, to_branch_id, 'receive a stock transfer');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }

  // REGULATORY-COMPLIANCE — mirrors the identical fix + full write-up in the
  // original design: fail fast at initiation time (the receive-time check is
  // the authoritative enforcement and remains in place regardless).
  const transferProductForInit = await c.env.DB.prepare('SELECT dispensing_type FROM products WHERE id = ?').bind(batch.product_id).first();
  if (transferProductForInit && transferProductForInit.dispensing_type === 'POM') {
    const destBranchForInit = await c.env.DB.prepare('SELECT license_type FROM branches WHERE id = ?').bind(to_branch_id).first();
    if (destBranchForInit && destBranchForInit.license_type === 'PPMV') {
      return c.json({
        error: 'This is a prescription-only (POM) product — the destination branch is licensed as a Patent Medicine Vendor (PPMV) and is not permitted to receive or stock it under PCN regulations.',
        code: 'PPMV_CANNOT_DISPENSE_POM',
      }, 403);
    }
  }

  const id = uuid();
  await c.env.DB.prepare(`INSERT INTO stock_transfers (id, from_branch_id, to_branch_id, stock_batch_id, quantity, status, initiated_by) VALUES (?,?,?,?,?,'PENDING',?)`)
    .bind(id, batch.branch_id, to_branch_id, stock_batch_id, quantity, user.id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ?').bind(id).first(), 201);
});

// Marking a transfer in-transit is a sending-branch action; previously
// this had NO branch check at all — see the rationale
// below (mirrored here, including the real cross-branch authorization
// bug this closes).
transfers.post('/:id/mark-in-transit', async (c) => {
  const id = c.req.param('id');
  const transfer = await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!transfer) return c.json({ error: 'Transfer not found' }, 404);
  try {
    assertBranchAccess(c, transfer.from_branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  await c.env.DB.prepare(`UPDATE stock_transfers SET status = 'IN_TRANSIT', updated_at = datetime('now') WHERE id = ? AND status = 'PENDING'`).bind(id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ?').bind(id).first());
});

transfers.post('/:id/receive', idempotent, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const transfer = await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!transfer) return c.json({ error: 'Transfer not found' }, 404);
  if (!['PENDING', 'IN_TRANSIT'].includes(transfer.status)) return c.json({ error: `Cannot receive a transfer in status ${transfer.status}` }, 400);
  // Same fix as transfer creation: a pinned MANAGER, not just STAFF, may
  // only receive goods into their OWN branch. Receiving is the step that
  // actually moves the stock and posts the GL entries.
  {
    const pinned = pinnedBranchIdOf(user);
    if (pinned && transfer.to_branch_id !== pinned) {
      return c.json({ error: 'You can only receive transfers into your own branch.', code: 'BRANCH_SCOPE_VIOLATION' }, 403);
    }
  }
  // BRANCH-DEACTIVATION ENFORCEMENT: see the identical fix + full rationale
  // in the original design — covers the edge case where the destination
  // branch was deactivated AFTER this transfer was already initiated.
  try {
    await assertBranchActive(c.env.DB, transfer.to_branch_id, 'receive a stock transfer');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }

  const sourceBatch = await c.env.DB.prepare('SELECT * FROM stock_batches WHERE id = ?').bind(transfer.stock_batch_id).first();

  // BUG 107 — AN OFFLINE SALE MUST NOT FREEZE A TRANSFER.
  //
  // This used to be `if (transfer.quantity > sourceBatch.quantity_remaining)
  // return 400 'Source batch no longer has enough stock'`, and that is exactly
  // the break the client described. Live-reproduced: a manager transfers all
  // 156 units of a batch; a cashier at the SOURCE branch, working offline,
  // sells 3 from it; the queued sale replays after the transfer was raised.
  // The destination could then never receive — the transfer sat at PENDING
  // permanently and 153 units were unsellable at BOTH branches. The cashier
  // did nothing wrong; they were offline, which this product treats as normal.
  //
  // The transfer now SELF-CORRECTS to what is really on the shelf: it moves
  // the available quantity, records the shortfall against the transfer, and
  // completes. `quantity` keeps the manager's original intent so the
  // difference stays auditable — the client's instruction was to "subtract
  // the number sold and correct the total transferred", not to hide it.
  //
  // The shortfall is FLAGGED, not silent (the client's own choice when asked):
  // an offline sale is the ordinary explanation, but a miscount or a theft
  // produces exactly the same arithmetic, and a manager must be able to see
  // the difference and ask why.
  const available = sourceBatch ? sourceBatch.quantity_remaining : 0;
  const moving = Math.min(transfer.quantity, available);
  const shortfall = transfer.quantity - moving;

  // Nothing at all left is a different situation from "some of it went". There
  // is no stock to move, so completing would create an empty batch row at the
  // destination and post a zero-value GL entry. Cancel it instead and say why.
  if (moving <= 0) {
    await c.env.DB.prepare(`
      UPDATE stock_transfers
         SET status = 'CANCELLED', quantity_received = 0, shortfall_quantity = ?,
             shortfall_reason = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('PENDING','IN_TRANSIT')
    `).bind(transfer.quantity,
            'The whole batch was sold or written off at the sending branch before this transfer arrived. Nothing was left to move.',
            id).run();
    return c.json({
      error: 'Every unit of this batch was sold or written off at the sending branch before the transfer could be received, so there is nothing to move. The transfer has been cancelled automatically and no stock was lost — the sales that consumed it are on the record.',
      code: 'TRANSFER_SOURCE_EXHAUSTED',
    }, 409);
  }

  // REGULATORY-COMPLIANCE — mirrors the identical fix + full write-up in the
  // original design: a PPMV branch is legally prohibited from stocking POM
  // medication, so it must not be able to receive it via inter-branch
  // transfer either.
  const transferProduct = await c.env.DB.prepare('SELECT dispensing_type FROM products WHERE id = ?').bind(sourceBatch.product_id).first();
  if (transferProduct && transferProduct.dispensing_type === 'POM') {
    const destBranch = await c.env.DB.prepare('SELECT license_type FROM branches WHERE id = ?').bind(transfer.to_branch_id).first();
    if (destBranch && destBranch.license_type === 'PPMV') {
      return c.json({
        error: 'This transfer carries a prescription-only (POM) product — the destination branch is licensed as a Patent Medicine Vendor (PPMV) and is not permitted to receive or stock it under PCN regulations.',
        code: 'PPMV_CANNOT_DISPENSE_POM',
      }, 403);
    }
  }

  // PHASE 1: claim the transfer via the (initially NULL) received_by
  // column, guarded on meta.changes — NOT via an intermediate `status`
  // value, since stock_transfers.status has a fixed CHECK enum
  // (PENDING/IN_TRANSIT/RECEIVED/CANCELLED) we must not violate, and we
  // can't set status='RECEIVED' with new_batch_id yet because that
  // batch row doesn't exist until phase 2 (its own foreign key would
  // fail). This is the same "only one concurrent request can win"
  // guarantee as voidSale/closeTill's phase-1 claims, just expressed via
  // a different column since the target enum value isn't available yet.
  // BUG 65 — retry-wrapped. A compare-and-swap claim is safe to re-run: if the
  // first attempt committed, the re-run matches no rows and the existing
  // changes!==1 guard below correctly treats it as the loser. Unwrapped, a
  // routine D1 blip surfaced as a FALSE "someone else did this" conflict.
  const claim = await withD1Retry(() => c.env.DB.batch([
    c.env.DB.prepare(`UPDATE stock_transfers SET received_by = ? WHERE id = ? AND status IN ('PENDING','IN_TRANSIT') AND received_by IS NULL`)
      .bind(user.id, id),
  ]), 'transfer receive claim');
  if (claim[0]?.meta?.changes !== 1) {
    return c.json({ error: 'This transfer was already received by another request.' }, 409);
  }

  // PHASE 2: we now exclusively own completing this transfer. All three
  // statements commit atomically — the new batch row is inserted BEFORE
  // stock_transfers.new_batch_id is set to reference it later in the
  // same batch, so the foreign key is always satisfiable.
  const newBatchId = crypto.randomUUID().replace(/-/g, '');
  try {
    const statements = [
      c.env.DB.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(moving, sourceBatch.id),
      c.env.DB.prepare(`
        INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, pack_price, carton_price, supplier_id, received_by,
                                   received_unit, received_unit_count, units_per_pack_at_receipt, packs_per_carton_at_receipt, selling_pattern, total_cost)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(newBatchId, transfer.to_branch_id, sourceBatch.product_id, sourceBatch.batch_no, sourceBatch.expiry_date, moving, moving,
              sourceBatch.cost_price_per_unit, sourceBatch.selling_price_per_unit, sourceBatch.pack_price, sourceBatch.carton_price, sourceBatch.supplier_id, user.id,
              // BUG 115 — A TRANSFER MUST CARRY THE PACK SIZE, NOT JUST THE PRICE.
              //
              // This copied the batch's prices but not its NESTING, so the new
              // row at the destination had NULL units_per_pack_at_receipt and
              // silently fell back to the product default. Live-reproduced: a
              // batch delivered as packs of 24 was transferred, and selling one
              // pack at the destination charged the carried-over N4,800 and
              // handed over 10 bottles. Bug 113 exactly, one hop downstream —
              // the price crossed the branch boundary and the meaning of "a
              // pack" did not.
              //
              // received_unit_count is deliberately NOT copied: the source
              // received 25 packs, this branch received part of that, and
              // claiming otherwise would make the goods-received note lie.
              // The NESTING is a property of the goods; the COUNT is a
              // property of the delivery.
              sourceBatch.received_unit,
              null,
              sourceBatch.units_per_pack_at_receipt,
              sourceBatch.packs_per_carton_at_receipt,
              sourceBatch.selling_pattern,
              null),
      c.env.DB.prepare(`
        UPDATE stock_transfers
           SET status = 'RECEIVED', received_at = datetime('now'), new_batch_id = ?,
               quantity_received = ?, shortfall_quantity = ?, shortfall_reason = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `).bind(newBatchId, moving, shortfall,
              shortfall > 0
                ? `${shortfall} unit(s) of the ${transfer.quantity} sent were already gone from the sending branch when this arrived — normally an offline sale that synced after the transfer was raised. ${moving} unit(s) were moved and the transfer was corrected automatically.`
                : null,
              id),
    ];

    // GENERAL LEDGER (real gap found and fixed during this audit pass — see
    // the write-up below's Node-deployment counterpart for the full write-up):
    // this is the single atomic moment BOTH branches' financial position
    // changes, so two independent, branch-scoped journal entries are posted
    // against a shared clearing account, appended to this SAME batch for
    // atomicity — see glService.postStockTransferOut/postStockTransferIn.
    // Bug 107: value what actually MOVED. Posting the intended quantity would
    // debit the destination for stock it never received and leave the
    // inter-branch clearing account permanently out by the shortfall.
    const transferValue = glService.round2(moving * sourceBatch.cost_price_per_unit);
    if (transferValue > 0) {
      const outResult = await glService.postStockTransferOut(c.env.DB, { branchId: sourceBatch.branch_id, transferId: transfer.id, initiatedBy: transfer.initiated_by, value: transferValue });
      if (outResult) statements.push(...outResult.statements);
      const inResult = await glService.postStockTransferIn(c.env.DB, { branchId: transfer.to_branch_id, transferId: transfer.id, receivedBy: user.id, value: transferValue });
      if (inResult) statements.push(...inResult.statements);
    }

    await withD1Retry(() => c.env.DB.batch(statements), 'stock transfer');
  } catch (e) {
    // Release our claim so the transfer remains receivable (e.g. the
    // source batch's stock genuinely changed since our check above and
    // the CHECK (quantity_remaining >= 0) constraint rejected the
    // decrement) rather than getting permanently stuck half-claimed.
    await c.env.DB.prepare(`UPDATE stock_transfers SET received_by = NULL WHERE id = ?`).bind(id).run();
    if (String(e.message).includes('CHECK constraint')) return c.json({ error: 'Source batch no longer has enough stock' }, 400);
    throw e;
  }

  return c.json(await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ?').bind(id).first());
});

// Cancelling a transfer previously had NO branch check at all either — see
// the write-up below. STAFF may cancel only if their own branch is a party
// to the transfer (sender or receiver); MANAGER/OWNER/ADMIN retain
// unrestricted access.
transfers.post('/:id/cancel', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const transfer = await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!transfer) return c.json({ error: 'Transfer not found' }, 404);
  // Same fix again: a pinned MANAGER may only cancel a transfer their own
  // branch is a party to (either end). Cancelling someone else's in-flight
  // transfer is a denial-of-service against that branch's replenishment.
  {
    const pinned = pinnedBranchIdOf(user);
    if (pinned && transfer.from_branch_id !== pinned && transfer.to_branch_id !== pinned) {
      return c.json({ error: 'You can only cancel a transfer involving your own branch.', code: 'BRANCH_SCOPE_VIOLATION' }, 403);
    }
  }
  await c.env.DB.prepare(`UPDATE stock_transfers SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ? AND status IN ('PENDING','IN_TRANSIT')`).bind(id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM stock_transfers WHERE id = ?').bind(id).first());
});

module.exports = transfers;
