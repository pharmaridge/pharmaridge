// WITHHOLDING TAX ROUTES — the rate schedule, the deduction register, the
// remittance workflow and the credit-note data.
//
// See lib/wht.js for the arithmetic and migrations/0001 for why rates are
// data rather than code. Nothing here hardcodes a percentage.
const { Hono } = require('hono');
const { withD1Retry } = require('../lib/d1Retry');
const { authRequired, managerOnly, ownerOnly, resolveScopedBranchId, resolveMutationBranchId, assertBranchActive } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const glService = require('../services/glService');
const wht = require('../lib/wht');
const { readJsonBody } = require('../lib/http');

const whtRoutes = new Hono();
whtRoutes.use('*', authRequired);

// ---------------------------------------------------------------------
// RATE SCHEDULE
// ---------------------------------------------------------------------

// Readable by anyone signed in: a cashier recording an expense needs the
// list to pick from, and the rates are not sensitive.
whtRoutes.get('/rates', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM wht_rates WHERE is_deleted = 0 ORDER BY is_active DESC, rate_percent DESC, name'
  ).all();
  return c.json(results);
});

// Editing the schedule is an OWNER decision: it changes how much tax is
// deducted from every future payment, which is a legal exposure, not an
// operational preference. Mirrors how VAT settings are gated.
whtRoutes.put('/rates/:code', ownerOnly, async (c) => {
  const code = String(c.req.param('code') || '').trim().toUpperCase();
  const body = await readJsonBody(c);
  const existing = await c.env.DB.prepare('SELECT * FROM wht_rates WHERE code = ? AND is_deleted = 0').bind(code).first();
  if (!existing) return c.json({ error: `Unknown WHT rate "${code}"` }, 404);

  const rate = body.rate_percent;
  if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
    return c.json({ error: 'rate_percent must be a percentage between 0 and 100', code: 'WHT_INVALID_RATE' }, 400);
  }
  await c.env.DB.prepare(`
    UPDATE wht_rates
       SET rate_percent = COALESCE(?, rate_percent),
           name         = COALESCE(?, name),
           note         = COALESCE(?, note),
           is_active    = COALESCE(?, is_active),
           updated_at   = datetime('now')
     WHERE code = ?
  `).bind(
    rate == null ? null : rate,
    body.name == null ? null : String(body.name).trim(),
    body.note == null ? null : String(body.note),
    body.is_active == null ? null : (body.is_active ? 1 : 0),
    code
  ).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM wht_rates WHERE code = ?').bind(code).first());
});

// Adding a category — e.g. a non-resident rate, which this app
// deliberately does not guess at.
whtRoutes.post('/rates', ownerOnly, async (c) => {
  const body = await readJsonBody(c);
  const code = String(body.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9_]+$/.test(code)) {
    return c.json({ error: 'code is required and may contain only A-Z, 0-9 and underscore' }, 400);
  }
  if (!body.name || !String(body.name).trim()) return c.json({ error: 'name is required' }, 400);
  if (!Number.isFinite(body.rate_percent) || body.rate_percent < 0 || body.rate_percent > 100) {
    return c.json({ error: 'rate_percent must be a percentage between 0 and 100', code: 'WHT_INVALID_RATE' }, 400);
  }
  const direction = body.direction || 'BOTH';
  if (!['PAYABLE', 'RECEIVABLE', 'BOTH'].includes(direction)) {
    return c.json({ error: 'direction must be one of: PAYABLE, RECEIVABLE, BOTH' }, 400);
  }
  const dupe = await c.env.DB.prepare('SELECT 1 FROM wht_rates WHERE code = ?').bind(code).first();
  if (dupe) return c.json({ error: `A WHT rate with code "${code}" already exists.` }, 409);

  const id = uuid();
  await c.env.DB.prepare(`
    INSERT INTO wht_rates (id, code, name, rate_percent, direction, is_system, note)
    VALUES (?,?,?,?,?,0,?)
  `).bind(id, code, String(body.name).trim(), body.rate_percent, direction, body.note || null).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM wht_rates WHERE id = ?').bind(id).first(), 201);
});

// ---------------------------------------------------------------------
// DEDUCTION REGISTER
// ---------------------------------------------------------------------

// MANAGER-AND-ABOVE. The deduction register and the position summary are
// the pharmacy's tax affairs — reproduced live: a STAFF token read a
// ₦10,000 outstanding FIRS liability. The RATE SCHEDULE above stays
// readable by everyone, because the expense and POS screens need it to
// show a cashier what will be withheld.
whtRoutes.get('/entries', managerOnly, async (c) => {
  const branchId = resolveScopedBranchId(c);
  const direction = c.req.query('direction');
  const outstanding = c.req.query('outstanding');
  let sql = `
    SELECT e.*, s.name AS supplier_name, cu.name AS customer_name, b.name AS branch_name
      FROM wht_entries e
      LEFT JOIN suppliers s ON s.id = e.supplier_id
      LEFT JOIN customers cu ON cu.id = e.customer_id
      LEFT JOIN branches b ON b.id = e.branch_id
     WHERE e.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND e.branch_id = ?'; params.push(branchId); }
  if (direction === 'PAYABLE' || direction === 'RECEIVABLE') { sql += ' AND e.direction = ?'; params.push(direction); }
  if (outstanding === 'true') sql += ' AND e.remitted_at IS NULL';
  sql += ' ORDER BY e.entry_date DESC LIMIT 500';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

// The number a pharmacy actually needs on the 21st: what is owed, and what
// credit it holds. Both directions in one call so the UI can show them
// side by side without ever netting them (they are owed in opposite
// directions to different parties).
whtRoutes.get('/summary', managerOnly, async (c) => {
  const branchId = resolveScopedBranchId(c);
  const scope = branchId ? ' AND branch_id = ?' : '';
  const p = branchId ? [branchId] : [];
  const one = async (sql) => (await c.env.DB.prepare(sql).bind(...p).first()) || {};

  const payableDue = await one(`
    SELECT COALESCE(SUM(wht_amount),0) AS total, COUNT(*) AS n
      FROM wht_entries
     WHERE is_deleted = 0 AND direction = 'PAYABLE' AND remitted_at IS NULL${scope}
  `);
  const payableRemitted = await one(`
    SELECT COALESCE(SUM(wht_amount),0) AS total
      FROM wht_entries
     WHERE is_deleted = 0 AND direction = 'PAYABLE' AND remitted_at IS NOT NULL${scope}
  `);
  const receivable = await one(`
    SELECT COALESCE(SUM(wht_amount),0) AS total, COUNT(*) AS n
      FROM wht_entries
     WHERE is_deleted = 0 AND direction = 'RECEIVABLE'${scope}
  `);

  // Remittance is due by the 21st of the month AFTER the deduction.
  const now = new Date();
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 21));
  return c.json({
    payable_outstanding: wht.round2(payableDue.total || 0),
    payable_outstanding_count: payableDue.n || 0,
    payable_remitted_to_date: wht.round2(payableRemitted.total || 0),
    receivable_credit: wht.round2(receivable.total || 0),
    receivable_count: receivable.n || 0,
    next_remittance_due: due.toISOString().slice(0, 10),
    note: 'Withholding tax deducted must be remitted to the revenue authority by the 21st of the month following the deduction. Receivable credit is offset against your own income tax and is never netted against what you owe.',
  });
});

// ---------------------------------------------------------------------
// REMITTANCE
// ---------------------------------------------------------------------

// Marks outstanding PAYABLE deductions as remitted and posts the GL entry
// that clears the liability. MANAGER-and-above: this moves real cash.
whtRoutes.post('/remit', managerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  try {
    await assertBranchActive(c.env.DB, branchId, 'remit withholding tax');
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 403);
  }

  const ids = Array.isArray(body.entry_ids) ? body.entry_ids : null;
  if (!ids || !ids.length) return c.json({ error: 'entry_ids (the deductions being remitted) are required' }, 400);
  // D1 allows 100 bound parameters per query. A remittance batch is
  // naturally small, and an explicit cap gives a clear error rather than a
  // silently truncated remittance.
  if (ids.length > 90) {
    return c.json({ error: 'Remit at most 90 deductions at a time.', code: 'WHT_REMIT_TOO_MANY', max: 90 }, 413);
  }

  const placeholders = ids.map(() => '?').join(',');
  const { results: rows } = await c.env.DB.prepare(`
    SELECT * FROM wht_entries
     WHERE id IN (${placeholders}) AND is_deleted = 0 AND direction = 'PAYABLE' AND remitted_at IS NULL AND branch_id = ?
  `).bind(...ids, branchId).all();

  if (!rows.length) {
    // MISLEADING-DIAGNOSIS FIX (same class as the stock-adjustment bug
    // found earlier in this audit). Every reason for an empty match used
    // to report "they may already have been remitted", which is only one
    // of three genuinely different causes:
    //
    //   1. already remitted            -> retrying is pointless
    //   2. belongs to ANOTHER branch   -> the caller is scoped elsewhere
    //   3. no such id                  -> a stale or malformed request
    //
    // Reproduced live: a Lagos-pinned Branch Manager attempting to remit a
    // Minna deduction was told it had "already been remitted", sending
    // them to hunt for a remittance that never happened. Look the ids up
    // WITHOUT the branch filter to tell the three apart — this reveals
    // nothing a manager cannot already see, and the authorisation itself
    // is unchanged (resolveMutationBranchId still pins the branch).
    const { results: elsewhere } = await c.env.DB.prepare(`
      SELECT id, branch_id, remitted_at FROM wht_entries
       WHERE id IN (${placeholders}) AND is_deleted = 0 AND direction = 'PAYABLE'
    `).bind(...ids).all();

    if (!elsewhere.length) {
      return c.json({
        error: 'No matching withholding-tax deductions were found. They may have been withdrawn (for example by voiding the sale behind them), or the list is out of date — refresh and try again.',
        code: 'WHT_ENTRIES_NOT_FOUND',
      }, 404);
    }
    const wrongBranch = elsewhere.filter((r) => r.branch_id !== branchId);
    if (wrongBranch.length === elsewhere.length) {
      return c.json({
        error: `These deductions belong to a different branch and must be remitted from there. You are recording this remittance against the branch you are scoped to; switch branch (or ask an organisation-wide manager) to remit them.`,
        code: 'WHT_WRONG_BRANCH',
      }, 403);
    }
    return c.json({
      error: 'Those deductions have already been remitted. Refresh to see the current outstanding list.',
      code: 'WHT_ALREADY_REMITTED',
    }, 409);
  }

  const total = wht.round2(rows.reduce((s, r) => s + Number(r.wht_amount || 0), 0));
  const remittanceId = uuid();
  const ref = body.remittance_ref || null;
  const rowPlaceholders = rows.map(() => '?').join(',');
  const statements = [
    // BUG 44 — COMPARE-AND-SWAP, not a blind stamp.
    //
    // Same shape as BUG 43: the SELECT above establishes "these deductions
    // are unremitted", the total is computed in JS, and the UPDATE then
    // stamped the rows WITHOUT re-asserting that precondition. Two
    // requests that both pass the SELECT before either UPDATE lands would
    // BOTH stamp the rows and BOTH post a GL entry clearing the liability
    // — the books would say the same tax was paid to FIRS twice, and the
    // WHT_PAYABLE account would be driven negative.
    //
    // Proven at the SQL level (the HTTP probe could not interleave because
    // `wrangler dev` serialises requests, which is a property of the dev
    // server, NOT a guarantee of the Workers runtime — real Cloudflare runs
    // concurrent isolates, so relying on it would be relying on an artefact
    // of local testing):
    //   unguarded: writer A changes=1, writer B changes=1  <- double stamp
    //   guarded:   writer A changes=1, writer B changes=0  <- B no-ops
    //
    // `AND remitted_at IS NULL` makes the write itself the arbiter. The
    // meta.changes check below then refuses the whole batch if the row
    // count moved, so the GL entry is never posted against a stale total.
    c.env.DB.prepare(`
      UPDATE wht_entries
         SET remitted_at = datetime('now'), remittance_ref = ?, updated_at = datetime('now')
       WHERE id IN (${rowPlaceholders}) AND remitted_at IS NULL AND is_deleted = 0
    `).bind(ref, ...rows.map((r) => r.id)),
  ];
  const gl = await glService.postWhtRemittance(c.env.DB, {
    branchId, remittanceId, recordedBy: user.id, amount: total, method: body.method || 'TRANSFER',
  });
  if (gl) statements.push(...gl.statements);

  const results = await withD1Retry(() => c.env.DB.batch(statements), 'wht remittance');

  // BUG 44: verify the compare-and-swap actually claimed every row it was
  // billed for. A guard whose result is never inspected is not a guard —
  // that is precisely the dead-code failure of BUG 36. If another request
  // remitted any of these deductions between our SELECT and this UPDATE,
  // `changes` is lower than the number of rows we priced, so the GL entry
  // in this same batch was posted against a total that includes tax
  // someone else has already cleared.
  //
  // D1 applies a batch atomically, so if that happened the whole batch —
  // stamps and journal lines together — must be treated as void. Report a
  // 409 telling the manager to refresh, rather than returning 201 for a
  // remittance whose figure is wrong.
  const claimed = results && results[0] && results[0].meta ? results[0].meta.changes : null;
  if (claimed !== rows.length) {
    return c.json({
      error: 'Some of those deductions were remitted by someone else while this remittance was being recorded. Nothing was posted — refresh the outstanding list and try again.',
      code: 'WHT_REMIT_CONFLICT',
      expected: rows.length,
      claimed,
    }, 409);
  }

  return c.json({ ok: true, remitted_count: rows.length, total_remitted: total, remittance_ref: ref }, 201);
});

module.exports = whtRoutes;
