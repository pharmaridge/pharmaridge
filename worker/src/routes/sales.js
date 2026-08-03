const { Hono } = require('hono');
const { authRequired, resolveScopedBranchId, assertBranchAccess, assertBranchActive, assertNotVendorSeat, resolveMutationBranchId } = require('../lib/auth');
const { assertManagerPermission, assertStaffCanVoid } = require('../lib/planLimits');
const { idempotent } = require('../lib/idempotency');
const salesService = require('../services/salesService');
const { readJsonBody } = require('../lib/http');



const sales = new Hono();
sales.use('*', authRequired);

sales.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);

  let sql = `
    SELECT s.*, u.full_name AS served_by_name, cu.name AS customer_name, b.name AS branch_name
    FROM sales s JOIN users u ON u.id = s.served_by LEFT JOIN customers cu ON cu.id = s.customer_id JOIN branches b ON b.id = s.branch_id
    WHERE s.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND s.branch_id = ?'; params.push(branchId); }
  if (from) { sql += ' AND s.created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND s.created_at <= ?'; params.push(to); }
  sql += ' ORDER BY s.created_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

sales.get('/:id', async (c) => {
  const sale = await salesService.getSaleReceipt(c.env.DB, c.req.param('id'));
  if (!sale) return c.json({ error: 'Sale not found' }, 404);
  try {
    assertBranchAccess(c, sale.branch_id);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 403);
  }
  return c.json(sale);
});

sales.post('/', idempotent, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  // The vendor's support seat must never be the cashier of record. Live-
  // reproduced before this guard: an ADMIN sale posted N55 Sales Revenue,
  // N40 COGS, deducted real stock, and stamped the receipt
  // "served_by: PharmaRidge Support" in the client's own books. See
  // assertNotVendorSeat in lib/auth.js. ADMIN retains full read access to
  // sales, and voiding remains available as a genuine support action.
  const vendorErr = assertNotVendorSeat(user, 'record a sale');
  if (vendorErr) return c.json({ error: vendorErr.message, code: vendorErr.code }, vendorErr.status);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);

  try {
    await assertBranchActive(c.env.DB, branchId, 'record a sale');
    // DATA-INTEGRITY: see the identical fix + full exploit write-up in the
    // original design — an explicitly- provided till_session_id that does not
    // correspond to a currently-OPEN session for this branch (nonexistent, or
    // already closed — e.g. the realistic offline-queue-replay scenario where
    // a manager force-closes a stuck till before a queued sale replays) is
    // treated exactly like an omitted one, falling through to the same
    // auto-attach-the-real-current-open-till logic, never silently attaching a
    // sale to the wrong already-finalized session (which would make that
    // sale's cash permanently uncounted by any till reconciliation) or leaking
    // a raw D1 foreign-key error.
    let tillSessionId = body.till_session_id || null;
    if (tillSessionId) {
      const stillOpen = await c.env.DB.prepare(`SELECT id FROM till_sessions WHERE id = ? AND branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(tillSessionId, branchId).first();
      if (!stillOpen) tillSessionId = null;
    }
    if (!tillSessionId) {
      const openTill = await c.env.DB.prepare(`SELECT id FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(branchId).first();
      tillSessionId = openTill ? openTill.id : null;
    }

    // CASH ACCOUNTABILITY — BUG 37 (live-reproduced).
    //
    // The fallback above is correct and deliberate: a stale/closed/foreign
    // till id must never attach a sale to a finalized session. But when the
    // fallback ALSO finds no open till, tillSessionId stayed null and the
    // sale was accepted anyway — HTTP 201, cash collected, `till_session_id`
    // silently NULL. Reproduced three ways against a live server (closed
    // till id, nonexistent id, another branch's till id); each returned 201
    // and stored NULL. Result: ₦75 of CASH sat in a drawer belonging to no
    // shift, invisible to computeExpectedCash and therefore to every till
    // reconciliation and every over/short figure. That is unreconcilable
    // cash — the exact hole a pharmacy owner buys this system to close.
    //
    // Only CASH is gated. Card/transfer settle through the bank and are
    // reconciled elsewhere, and credit sales collect no cash at the counter,
    // so blocking those would stop legitimate trade for no integrity gain.
    // The POS already disables checkout when no till is open.
    //
    // OFFLINE REPLAY IS EXEMPT — and this exemption is not optional.
    // Reproduced while testing the guard above: a cashier sells for cash
    // offline during a shift, the shift ends and the till is closed, and
    // only then does the queue drain. The replay found no open till, got
    // this 409, and offline.js correctly treats ANY 4xx as permanent — so
    // it moved a REAL cash sale, whose stock had already left the shelf,
    // into the permanently-failed store. Refusing a replay does not stop
    // the money being taken; it only deletes the record of it. That is
    // strictly worse than an unlinked sale, and it is the same class as
    // the earlier "offline queue quarantined valid sales" defect.
    //
    // A replay is a statement about the PAST ("this already happened"),
    // while a live checkout is a request about the NOW ("take this
    // money"). Only the latter can be meaningfully refused. Replays are
    // marked by the client (api.js sets X-Offline-Replay when draining the
    // queue) and are accepted, attaching to the current open till if there
    // is one and otherwise recorded unlinked but VISIBLE: the till audit
    // on the dashboard already surfaces unlinked cash so it is
    // investigated rather than silently absorbed.
    const isOfflineReplay = c.req.header('X-Offline-Replay') === '1';
    const collectsCash = Array.isArray(body.payments)
      && body.payments.some((p) => p && p.method === 'CASH' && Number(p.amount) > 0);
    if (!tillSessionId && collectsCash && !isOfflineReplay) {
      return c.json({
        error: 'No till session is open for this branch. Open a till before taking cash, so the money is counted against a shift.',
        code: 'NO_OPEN_TILL_FOR_CASH_SALE',
      }, 409);
    }

    const receipt = await salesService.createSale(c.env.DB, {
      branchId,
      servedBy: user.id,
      // BUG 83: the credit-limit override is manager-and-above only, so the
      // engine needs the caller's role. Taken from the authenticated user,
      // never from the request body.
      servedByRole: user.role,
      creditOverrideReason: body.credit_override_reason || null,
      customerId: body.customer_id || null,
      // BUG 95: who the change belongs to when the drawer cannot make it.
      // A name OR a phone number is enough — demanding a full customer record
      // at a busy counter is how the feature would go unused, and an unused
      // feature means the cashier goes back to remembering.
      changeOwedFor: body.change_owed_for || null,
      items: body.items || [],
      discount: body.discount || 0,
      payments: body.payments || [],
      tillSessionId,
      // WHT the CUSTOMER withheld from this invoice (contract supply to a
      // hospital/NGO/government buyer). Counts toward settling the total —
      // without it the sale would be rejected as underpaid. See
      // salesService.createSale and lib/wht.js.
      whtSuffered: body.wht_suffered || 0,
      whtRateCode: body.wht_rate_code || null,
      whtCounterpartyTin: body.wht_counterparty_tin || null,
    });
    return c.json(receipt, 201);
  } catch (e) {
    // BUG 83: the credit-limit refusal carries the LIMIT, the CURRENT DEBT and
    // the RESULTING TOTAL, so the cashier can see exactly how far over they
    // are and how much to collect. This handler forwarded only error+code, so
    // those figures were silently dropped — the caller got `{}` for them.
    // Forwarded explicitly rather than spreading the whole error object, which
    // would risk leaking internals into an API response.
    const extra = {};
    for (const k of ['credit_limit', 'already_owed', 'would_owe']) {
      if (e[k] !== undefined) extra[k] = e[k];
    }
    return c.json({ error: e.message, code: e.code, ...extra }, e.status || (e.code ? 422 : 400));
  }
});

sales.post('/:id/void', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    // OWNER-CONTROLLED MANAGER PERMISSION (migration 0003): the owner may
    // withhold void authority from managers. Voiding reverses revenue and
    // COGS in the GL, so it is the highest-risk routine manager action.
    // OWNER and ADMIN are never restricted.
    const permErr = await assertManagerPermission(c.env.DB, user, 'managers_can_void_sales');
    if (permErr) return c.json({ error: permErr.message, code: permErr.code }, permErr.status);
    const sale = await c.env.DB.prepare(
      'SELECT branch_id, served_by, created_at, till_session_id FROM sales WHERE id = ? AND is_deleted = 0'
    ).bind(c.req.param('id')).first();
    if (!sale) return c.json({ error: 'Sale not found' }, 404);
    assertBranchAccess(c, sale.branch_id);

    // OWNER-CONTROLLED STAFF PERMISSION (client decision after this was
    // live-reproduced): a plain cashier could void their own completed sale
    // with no gate whatsoever — the classic sell-for-cash / void / pocket
    // pattern, which leaves books showing no sale and stock already gone.
    //
    // NOT a flat ban: a mis-keyed sale at a busy counter is common and a
    // lone cashier on a night shift must be able to correct it. A cashier
    // may void their OWN sale, inside a short window, while the till is
    // still open. Everything else needs a manager. See
    // lib/planLimits.assertStaffCanVoid.
    const staffErr = await assertStaffCanVoid(c.env.DB, user, sale);
    if (staffErr) return c.json({ error: staffErr.message, code: staffErr.code }, staffErr.status);

    // BUG 80 — A CASH REVERSAL WITH NO EXPLANATION.
    //
    // `voidSale(..., body.reason)` stored `reason || null`, so a void with no
    // reason at all returned 200 and wrote void_reason = NULL. Live-reproduced.
    //
    // A void is the single highest-risk routine action on the system: it
    // reverses revenue and COGS in the GL, takes cash back out of the drawer,
    // and returns stock to the shelf. It is also the exact shape of the
    // sell-for-cash / void / pocket-the-difference pattern the staff void
    // window exists to contain. The reason is the ONLY artefact a proprietor
    // has when asking, six weeks later, why ₦40,000 of sales were reversed on
    // a Tuesday.
    //
    // Every comparable action in this codebase already demands one — a till
    // force-close (FORCE_REASON_REQUIRED), an attendance override
    // (OVERRIDE_REASON_REQUIRED), a force clock-out, a stock adjustment, a
    // user transfer. The void, the riskiest of them, was the one that did not.
    // The UI has always prompted for it; only the server never insisted, so
    // any direct API call skipped it entirely.
    const voidReason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (voidReason.length < 4) {
      return c.json({
        error: 'Give a reason for voiding this sale — it reverses the money, the stock and the books, and this note is the only record of why.',
        code: 'VOID_REASON_REQUIRED',
      }, 400);
    }
    const receipt = await salesService.voidSale(c.env.DB, c.req.param('id'), user.id, voidReason);
    return c.json(receipt);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

module.exports = sales;
