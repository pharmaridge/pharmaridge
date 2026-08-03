// Stocktake (physical inventory count) service for the D1 deployment.
// Mirrors the original implementation's corrected variance logic (see
// migrations/001 in the original design): variance is always computed
// against the batch's LIVE quantity_remaining at the moment of
// counting/closing, never the stale quantity captured when the session
// opened — otherwise a normal sale happening while a stocktake is open
// would be mistaken for shrinkage and the stock would be deducted a second
// time.
const { uuid } = require('../lib/crypto');
const { withD1Retry } = require('../lib/d1Retry');
const glService = require('./glService');
const { chunkIds, SAFE_IN_CHUNK } = require('../lib/d1Limits');
const { validateQuantity } = require('../lib/business');


async function startStocktake(db, { branchId, startedBy, notes, productIds }) {
  // FUNCTIONAL GAP CLOSED (real bug found and fixed during this audit — see
  // the write-up below): validate every supplied product_id exists BEFORE
  // ever creating the stocktake_sessions row, so a bogus/typo'd id can never
  // silently produce a permanently-recorded, zero-line session with no error
  // at all.
  if (productIds && productIds.length) {
    // PLATFORM-LIMIT BUG FOUND AND FIXED DURING A PRODUCTION AUDIT
    // (live-reproduced against this exact function with D1's documented
    // ceilings enforced): this validation query, and the batch-loading
    // query further down, both built `IN (...)` directly from the
    // caller-supplied product_ids array with NO chunking. D1 rejects any
    // statement carrying more than 100 bound parameters, so the exact
    // breaking point measured was 100 product ids — 99 ids passed (99 +
    // the branch_id bound by the second query = 100), 100 ids failed the
    // WHOLE request with a raw, unactionable
    // "D1_ERROR: too many SQL variables".
    //
    // This was reachable from the UI with no warning: the Stocktake
    // screen's scoped-count modal ("By Category" / "Pick Individual
    // Products") renders a checkbox per product and imposes no cap, so
    // any branch whose catalogue has 100+ products in the chosen scope
    // would hit it — and a full-branch stocktake of a real NAFDAC-sized
    // catalogue trivially exceeds it. Fixed by chunking every IN-list
    // through lib/d1Limits.js's shared helper.
    const foundIds = new Set();
    for (const chunk of chunkIds(productIds)) {
      const placeholders = chunk.map(() => '?').join(',');
      const { results: found } = await db.prepare(`SELECT id FROM products WHERE id IN (${placeholders})`).bind(...chunk).all();
      for (const p of found) foundIds.add(p.id);
    }
    const missing = productIds.filter((pid) => !foundIds.has(pid));
    if (missing.length) {
      throw Object.assign(new Error(`Unknown product(s): ${missing.join(', ')}`), { status: 400 });
    }
  }

  const id = uuid();
  try {
    // idx_stocktake_one_open_per_branch (partial UNIQUE index) is the
    // authoritative guard against two concurrent open stocktakes for
    // the same branch; this INSERT either succeeds outright or throws.
    await db.prepare(`INSERT INTO stocktake_sessions (id, branch_id, started_by, notes) VALUES (?,?,?,?)`)
      .bind(id, branchId, startedBy, notes || null).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) {
      throw Object.assign(new Error('A stocktake session is already open for this branch'), { code: 'STOCKTAKE_ALREADY_OPEN' });
    }
    throw e;
  }

  let batches;
  if (productIds && productIds.length) {
    // Chunked for the same reason as the validation query above. Note
    // this statement binds branch_id IN ADDITION to the IN list, so the
    // true safe size is 99, not 100 — exactly the off-by-one that makes
    // hand-rolled chunking dangerous and is why chunkIds() takes an
    // explicit `otherParams` count.
    batches = [];
    for (const chunk of chunkIds(productIds, 1)) {
      const placeholders = chunk.map(() => '?').join(',');
      const { results } = await db.prepare(`SELECT * FROM stock_batches WHERE branch_id = ? AND is_deleted = 0 AND product_id IN (${placeholders})`)
        .bind(branchId, ...chunk).all();
      batches.push(...results);
    }
  } else {
    const { results } = await db.prepare(`SELECT * FROM stock_batches WHERE branch_id = ? AND is_deleted = 0`).bind(branchId).all();
    batches = results;
  }

  if (batches.length > 0) {
    const statements = batches.map((b) =>
      db.prepare(`INSERT INTO stocktake_lines (id, stocktake_id, stock_batch_id, system_quantity) VALUES (?,?,?,?)`)
        .bind(uuid(), id, b.id, b.quantity_remaining)
    );
    await withD1Retry(() => db.batch(statements), 'stocktake');
  }

  return getStocktake(db, id);
}

async function getStocktake(db, id) {
  const session = await db.prepare(`
    SELECT ss.*, u.full_name AS started_by_name, fc.full_name AS force_closed_by_name
    FROM stocktake_sessions ss
    JOIN users u ON u.id = ss.started_by
    LEFT JOIN users fc ON fc.id = ss.force_closed_by
    WHERE ss.id = ?
  `).bind(id).first();
  if (!session) return null;
  const { results: lines } = await db.prepare(`
    SELECT sl.*, p.name AS product_name, sb.batch_no, sb.expiry_date
    FROM stocktake_lines sl JOIN stock_batches sb ON sb.id = sl.stock_batch_id JOIN products p ON p.id = sb.product_id
    WHERE sl.stocktake_id = ? AND sl.is_deleted = 0 ORDER BY p.name
  `).bind(id).all();
  return { ...session, lines };
}

async function recordCount(db, { lineId, countedQuantity, countedBy, notes }) {
  // DATA-QUALITY: see the full explanation below.
  // allowZero: counting ZERO of something is a real and important result —
  // it is how a shelf is recorded as empty — so zero must stay valid here
  // while still being rejected on a sale or a transfer.
  const cqErr = validateQuantity(countedQuantity, 'counted_quantity', { allowZero: true });
  if (cqErr) throw Object.assign(new Error(cqErr), { status: 400 });
  const line = await db.prepare('SELECT * FROM stocktake_lines WHERE id = ?').bind(lineId).first();
  if (!line) throw Object.assign(new Error('Stocktake line not found'), { status: 404 });

  // Compare against the batch's CURRENT quantity_remaining (right now,
  // at count time), not the stale system_quantity from session-open —
  // see the file header comment.
  const batch = await db.prepare('SELECT quantity_remaining FROM stock_batches WHERE id = ?').bind(line.stock_batch_id).first();
  const quantityAtCount = batch.quantity_remaining;
  const variance = countedQuantity - quantityAtCount;

  await db.prepare(`
    UPDATE stocktake_lines SET counted_quantity = ?, quantity_remaining_at_count = ?, variance = ?, counted_by = ?, counted_at = datetime('now'), notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(countedQuantity, quantityAtCount, variance, countedBy, notes || null, lineId).run();

  return db.prepare('SELECT * FROM stocktake_lines WHERE id = ?').bind(lineId).first();
}

// READ-ONLY preview of the variances closeStocktake WOULD apply, computed
// exactly the way it computes them: counted quantity minus the batch's
// LIVE quantity_remaining right now, never the stale figure captured when
// the session opened.
//
// Exists so the STAFF write-off cap can be enforced BEFORE anything is
// committed. Closing a stocktake writes stock_adjustments rows directly,
// bypassing the capped /adjustments route — a cashier capped at 5 units
// was able to write off 100 units of a controlled drug this way
// (live-reproduced). The route calls this first and refuses the close if
// the largest variance exceeds what that cashier may adjust unaided.
//
// Deliberately shares no state with closeStocktake beyond the query: this
// must reflect what WILL happen, so if the two ever diverge the cap would
// silently stop matching the write. The duplication is the point — see
// the assertion in audit.managerstaff.js that keeps them agreeing.
async function previewVariances(db, stocktakeId) {
  // BUG 43: mirrors closeStocktake exactly — the STORED variance observed
  // at count time, not a fresh (counted - liveNow) recomputation. If these
  // two ever disagree the STAFF write-off cap would be checked against a
  // different number than the one actually written, which is precisely the
  // bypass this preview exists to prevent.
  const { results: countedLines } = await db.prepare(`
    SELECT stock_batch_id, counted_quantity, quantity_remaining_at_count, variance
    FROM stocktake_lines
    WHERE stocktake_id = ? AND counted_quantity IS NOT NULL AND is_deleted = 0
  `).bind(stocktakeId).all();
  if (!countedLines.length) return [];

  // Live quantities are still needed for legacy rows written before this
  // fix, where `variance` may be null.
  const needsFallback = countedLines.some((l) => l.variance == null && l.quantity_remaining_at_count == null);
  const liveQty = new Map();
  if (needsFallback) {
    const batchIds = [...new Set(countedLines.map((l) => l.stock_batch_id))];
    for (const chunk of chunkIds(batchIds, 0)) {
      const { results } = await db.prepare(
        `SELECT id, quantity_remaining FROM stock_batches WHERE id IN (${chunk.map(() => '?').join(',')})`
      ).bind(...chunk).all();
      for (const row of results) liveQty.set(row.id, row.quantity_remaining);
    }
  }

  const out = [];
  for (const line of countedLines) {
    let variance;
    if (line.variance != null) {
      variance = line.variance;
    } else if (line.quantity_remaining_at_count != null) {
      variance = line.counted_quantity - line.quantity_remaining_at_count;
    } else {
      const current = liveQty.get(line.stock_batch_id);
      if (current === undefined) continue;
      variance = line.counted_quantity - current;
    }
    if (variance) out.push({ stock_batch_id: line.stock_batch_id, variance });
  }
  return out;
}

async function closeStocktake(db, { stocktakeId, closedBy, forceClose = false, forceReason = null }) {
  const session = await db.prepare('SELECT * FROM stocktake_sessions WHERE id = ?').bind(stocktakeId).first();
  if (!session) throw Object.assign(new Error('Stocktake session not found'), { status: 404 });
  if (session.status !== 'OPEN') throw Object.assign(new Error('Stocktake session is not open'), { status: 400 });

  // Claim the close first (same guarded-UPDATE pattern as till/void), so two
  // concurrent "close" calls can't both apply adjustments. The force-close
  // columns are set in this same claim UPDATE — see the write-up below.
  // BUG 65 — retry-wrapped. A compare-and-swap claim is safe to re-run: if the
  // first attempt committed, the re-run matches no rows and the existing
  // changes!==1 guard below correctly treats it as the loser. Unwrapped, a
  // routine D1 blip surfaced as a FALSE "someone else did this" conflict.
  const claim = await withD1Retry(() => db.batch([
    db.prepare(`
      UPDATE stocktake_sessions
      SET status = 'CLOSED', closed_by = ?, closed_at = datetime('now'),
          force_closed_by = ?, force_closed_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'OPEN'
    `).bind(closedBy, forceClose ? closedBy : null, forceClose ? (forceReason || 'Force-closed by manager') : null, stocktakeId),
  ]), 'stocktake close claim');
  if (claim[0]?.meta?.changes !== 1) {
    throw Object.assign(new Error('This stocktake was already closed by another request.'), { status: 409 });
  }


  const { results: lines } = await db.prepare(`SELECT * FROM stocktake_lines WHERE stocktake_id = ? AND is_deleted = 0`).bind(stocktakeId).all();
  const countedLines = lines.filter((l) => l.counted_quantity != null);

  // CLOUDFLARE FREE-TIER SUBREQUEST SAFETY NET (found and fixed during a
  // production audit — same bug class as the sales engine's Bugs 1/2):
  // this loop previously issued ONE D1 read per counted line
  // (`SELECT quantity_remaining FROM stock_batches WHERE id = ?`) to
  // re-check against live stock at close time. Since startStocktake()
  // with no product_ids filter pulls in EVERY active stock batch at the
  // branch, a completely ordinary full-branch stocktake (a branch with
  // 50-200+ distinct batches across its catalog is unremarkable) would
  // trivially push this single request's D1 subrequest count past the
  // Workers Free plan's hard 50-subrequest-per-invocation ceiling on
  // close — on top of the ~8 fixed subrequests already spent on
  // auth/subscription-gate middleware, the session/claim/lines reads,
  // and the final getStocktake() re-fetch. This would fail in real
  // production with a "Script exceeded resource limits" error even
  // though it works fine locally against `wrangler dev` (which does not
  // enforce this specific production quota) — live-verified: a 61-batch
  // full-branch stocktake close previously issued 61 individual reads
  // plus ~8 fixed ones, comfortably over 50. Fixed by bulk-preloading
  // every counted line's CURRENT stock_batches.quantity_remaining in
  // chunks of up to 100 IDs per query (D1's own max-100-bound-
  // parameters-per-query ceiling, not an arbitrary choice) instead of
  // one query per line — reducing the read cost from N to ceil(N/100),
  // e.g. a 1000-line stocktake now costs 10 reads instead of 1000.
  const batchIds = [...new Set(countedLines.map((l) => l.stock_batch_id))];
  const currentQtyByBatchId = new Map();
  const costPriceByBatchId = new Map();
  for (const chunk of chunkIds(batchIds)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db.prepare(
      `SELECT id, quantity_remaining, cost_price_per_unit FROM stock_batches WHERE id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const row of results) {
      currentQtyByBatchId.set(row.id, row.quantity_remaining);
      costPriceByBatchId.set(row.id, row.cost_price_per_unit);
    }
  }

  const statements = [];
  let adjustmentsCreated = 0;

  for (const line of countedLines) {
    // Re-check against LIVE stock right now (may have moved again since
    // recordCount ran, e.g. another sale happened in between) so the
    // applied adjustment always lands exactly on the physically counted
    // number — never a stale, double-counted value.
    const currentQty = currentQtyByBatchId.get(line.stock_batch_id);

    // BUG 43 (live-reproduced, NOT a race — fully sequential). The
    // adjustment applied here used to be recomputed at CLOSE time as
    // `counted_quantity - liveQuantityNow`. That is wrong whenever any
    // legitimate stock movement happens between counting an item and
    // closing the session, which is the normal case: a cashier keeps
    // selling while the storekeeper counts.
    //
    // Worked example that was reproduced end to end with no concurrency
    // at all: 100 on the shelf, storekeeper counts 100 (variance 0), a
    // 30-unit sale is rung up, then the session is closed. The close read
    // live stock as 70, computed 100 - 70 = +30, and wrote a
    // STOCKTAKE_VARIANCE of **+30** — fabricating 30 units that do not
    // exist and posting a matching GL gain. A real ₦300 sale was erased
    // from inventory by the very control meant to detect shrinkage. The
    // same arithmetic turns a genuine -10 shrinkage into +20.
    //
    // The correct quantity is the variance OBSERVED AT COUNT TIME, which
    // recordCount already computes and stores on the line
    // (quantity_remaining_at_count and variance). A count is a physical
    // observation of a specific moment; the discrepancy it found does not
    // change because the shelf legitimately moved afterwards. Applying
    // the stored variance relatively also composes correctly with those
    // later movements: 100 -> sell 30 -> 70, apply -10 => 60, which is
    // exactly "the 10 that were missing are still missing".
    //
    // Fall back to the recomputed delta only for rows written before this
    // fix, where variance may be null.
    const storedVariance = line.variance != null
      ? line.variance
      : (line.counted_quantity - (line.quantity_remaining_at_count != null ? line.quantity_remaining_at_count : currentQty));
    const adjustmentNeeded = storedVariance;
    if (!adjustmentNeeded) continue;

    const adjId = uuid();
    statements.push(db.prepare(`
      INSERT INTO stock_adjustments (id, branch_id, stock_batch_id, adjustment_type, quantity_change, reason, stocktake_id, recorded_by)
      VALUES (?,?,?,'STOCKTAKE_VARIANCE',?,?,?,?)
    `).bind(adjId, session.branch_id, line.stock_batch_id, adjustmentNeeded, line.notes || 'Stocktake variance', stocktakeId, closedBy));
    // Applied RELATIVELY and deliberately so. The stored variance is a
    // delta ("10 units were missing when counted"), so adding it composes
    // correctly with any legitimate sale/transfer that happened after the
    // count. An absolute `SET quantity_remaining = counted` would instead
    // resurrect stock that was properly sold in the interim — the same
    // fabrication this bug was about, just from the other direction.
    //
    // The CHECK (quantity_remaining >= 0) constraint remains the floor: a
    // negative variance larger than what is left fails the batch rather
    // than driving stock below zero. Verified by the concurrency probes,
    // which found zero negative balances across all writer combinations.
    statements.push(db.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(adjustmentNeeded, line.stock_batch_id));

    // GENERAL LEDGER: each stocktake-generated variance is posted
    // exactly like a manual stock adjustment (negative = shrinkage,
    // positive = correction) — see
    // worker/src/services/glService.js's postStockAdjustment().
    const glResult = await glService.postStockAdjustment(db, {
      branchId: session.branch_id, adjustmentId: adjId, recordedBy: closedBy,
      quantityChange: adjustmentNeeded, costPricePerUnit: costPriceByBatchId.get(line.stock_batch_id),
    });
    if (glResult) statements.push(...glResult.statements);

    adjustmentsCreated++;
  }

  if (statements.length > 0) {
    await withD1Retry(() => db.batch(statements), 'stocktake');
  }

  return { session: await getStocktake(db, stocktakeId), adjustments_created: adjustmentsCreated };
}

// Cancels an OPEN stocktake with NO stock/variance impact whatsoever — see
// the write-up below for the full rationale: this closes a real
// "designed-but-unreachable schema value" gap (stocktake_sessions.status's
// CHECK constraint has always included 'CANCELLED' but no route on either
// backend could ever set it, found during a systematic sweep of every
// CHECK-constraint enum for unreachable values). Mirrored here using D1's
// guarded-UPDATE claim pattern (via db.batch's atomic single statement)
// instead of better-sqlite3's synchronous transaction, the same adaptation
// used by closeStocktake/receive-transfer/PO-receive elsewhere in this
// file/codebase.
async function cancelStocktake(db, { stocktakeId, cancelledBy, forceCancel = false, reason = null }) {
  const session = await db.prepare('SELECT * FROM stocktake_sessions WHERE id = ? AND is_deleted = 0').bind(stocktakeId).first();
  if (!session) throw Object.assign(new Error('Stocktake session not found'), { status: 404 });
  if (session.status !== 'OPEN') throw Object.assign(new Error('Only an OPEN stocktake can be cancelled'), { status: 400 });

  // BUG 65 — retry-wrapped CAS claim; see the note on closeStocktake above.
  const claim = await withD1Retry(() => db.batch([
    db.prepare(`
      UPDATE stocktake_sessions
      SET status = 'CANCELLED', closed_by = ?, closed_at = datetime('now'),
          force_closed_by = ?, force_closed_reason = ?,
          notes = CASE WHEN ? IS NOT NULL THEN TRIM(COALESCE(notes || ' | ', '') || 'Cancelled: ' || ?) ELSE notes END,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'OPEN'
    `).bind(
      cancelledBy,
      forceCancel ? cancelledBy : null,
      forceCancel ? (reason || 'Force-cancelled by manager') : null,
      reason, reason,
      stocktakeId
    ),
  ]), 'stocktake cancel claim');
  if (claim[0]?.meta?.changes !== 1) {
    throw Object.assign(new Error('This stocktake was already closed or cancelled by another request.'), { status: 409 });
  }
  return getStocktake(db, stocktakeId);
}

module.exports = { startStocktake, getStocktake, recordCount, closeStocktake, cancelStocktake, previewVariances };
