const { Hono } = require('hono');
const { authRequired, managerOnly, pinnedBranchIdOf } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const { assertCanAddBranch, PlanLimitError } = require('../lib/planLimits');
const { readJsonBody, isExplicitFalse } = require('../lib/http');

const branches = new Hono();
branches.use('*', authRequired);

function validateGeofence(body, existing) {
  const latitude = body.latitude !== undefined ? body.latitude : existing?.latitude;
  const longitude = body.longitude !== undefined ? body.longitude : existing?.longitude;
  if ((latitude == null) !== (longitude == null)) return 'latitude and longitude must be provided together (or both omitted)';
  if (latitude != null && (typeof latitude !== 'number' || latitude < -90 || latitude > 90)) return 'latitude must be a number between -90 and 90';
  if (longitude != null && (typeof longitude !== 'number' || longitude < -180 || longitude > 180)) return 'longitude must be a number between -180 and 180';
  if (body.geofence_radius_meters != null && (typeof body.geofence_radius_meters !== 'number' || body.geofence_radius_meters <= 0)) return 'geofence_radius_meters must be a positive number';
  return null;
}

const ATTENDANCE_MODES = ['GEOLOCATION', 'REGISTERED_DEVICE'];

// BUG 86 — CLOSING A BRANCH SAID NOTHING ABOUT WORK LEFT IN FLIGHT.
//
// Live-reproduced: a branch was closed while holding an OPEN TILL with 25,000
// naira of float, a clocked-in cashier, a PENDING purchase order and an OPEN
// stocktake. The response was a bare 200 with no mention of any of it.
//
// Every one of those is now recoverable at a closed branch (closing a till,
// force-clocking-out a shift and cancelling a stocktake always were; cancelling
// a purchase order was stranded until BUG 84). So the closure itself is safe
// and is deliberately NOT blocked — an owner shutting a shop today should not
// be trapped by a stocktake somebody forgot to finish.
//
// What was missing is that nobody was TOLD. Cash in an unclosed drawer is real
// money nobody has counted, and a pending order is stock the reorder screen
// still expects. Client decision: warn and list, never block.
async function workInFlight(db, branchId) {
  const one = async (sql) => {
    const r = await db.prepare(sql).bind(branchId).first();
    return Number((r && r.n) || 0);
  };
  const [openTills, openShifts, pendingOrders, openStocktakes, transfersIn, transfersOut] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0"),
    one('SELECT COUNT(*) AS n FROM staff_attendance WHERE branch_id = ? AND clock_out_at IS NULL AND is_deleted = 0'),
    one("SELECT COUNT(*) AS n FROM purchase_orders WHERE branch_id = ? AND status IN ('PENDING','PARTIALLY_RECEIVED') AND is_deleted = 0"),
    one("SELECT COUNT(*) AS n FROM stocktake_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0"),
    one("SELECT COUNT(*) AS n FROM stock_transfers WHERE to_branch_id = ? AND status IN ('PENDING','IN_TRANSIT') AND is_deleted = 0"),
    one("SELECT COUNT(*) AS n FROM stock_transfers WHERE from_branch_id = ? AND status IN ('PENDING','IN_TRANSIT') AND is_deleted = 0"),
  ]);
  const items = [];
  if (openTills) items.push(`${openTills} till session${openTills === 1 ? '' : 's'} still open — the cash in the drawer has not been counted`);
  if (openShifts) items.push(`${openShifts} staff member${openShifts === 1 ? '' : 's'} still clocked in`);
  if (pendingOrders) items.push(`${pendingOrders} purchase order${pendingOrders === 1 ? '' : 's'} still outstanding`);
  if (openStocktakes) items.push(`${openStocktakes} stocktake${openStocktakes === 1 ? '' : 's'} still open`);
  if (transfersIn) items.push(`${transfersIn} stock transfer${transfersIn === 1 ? '' : 's'} heading to this branch`);
  if (transfersOut) items.push(`${transfersOut} stock transfer${transfersOut === 1 ? '' : 's'} sent from this branch and not yet received`);
  return {
    open_tills: openTills,
    open_shifts: openShifts,
    pending_purchase_orders: pendingOrders,
    open_stocktakes: openStocktakes,
    incoming_transfers: transfersIn,
    outgoing_transfers: transfersOut,
    items,
  };
}



branches.get('/', async (c) => {
  // WHY THIS LIST IS NOT BRANCH-FILTERED (checked during an OWNER/MANAGER
  // audit, and deliberate).
  //
  // A branch-pinned Branch Manager DOES see every branch here — but this
  // endpoint returns only the shop's own directory information: name,
  // address, phone, licence details, geofence settings. It carries no
  // money, no stock and no staff.
  //
  // Everything that matters IS scoped, and was verified by execution
  // rather than assumed: a Lagos-pinned manager requesting
  // ?branch_id=<Minna> on /stock, /expenses, /sales or /dashboard gets
  // LAGOS rows back, because resolveScopedBranchId overrides the caller's
  // claim with their pinned branch. Nothing of Minna's leaks.
  //
  // The list stays whole because the UI needs it: branch names label rows
  // in org-wide reports, transfer destinations must be selectable, and a
  // Branch Manager receiving a transfer has to know which shop sent it.
  // Hiding the directory would break those screens while protecting
  // nothing that is not already protected one layer down.
  const { results } = await c.env.DB.prepare('SELECT * FROM branches WHERE is_deleted = 0 ORDER BY name LIMIT 1000').all();
  return c.json(results);
});

branches.post('/', managerOnly, async (c) => {
  // CROSS-BRANCH HOLE FOUND AND FIXED (live-reproduced): a manager pinned
  // to Minna created a brand-new branch. Estate-level decisions — opening
  // or closing a branch — belong to the proprietor, not to someone hired
  // to run one shop. Creating branches also consumes the client's paid
  // plan allowance (see planLimits.assertCanAddBranch).
  if (pinnedBranchIdOf(c.get('user'))) {
    return c.json({
      error: 'As a Branch Manager you cannot create new branches. Ask the Owner or a General Manager.',
      code: 'BRANCH_SCOPE_VIOLATION',
    }, 403);
  }
  const body = await readJsonBody(c);
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const geofenceError = validateGeofence(body);
  if (geofenceError) return c.json({ error: geofenceError }, 400);
  if (body.attendance_mode !== undefined && !ATTENDANCE_MODES.includes(body.attendance_mode)) {
    return c.json({ error: `attendance_mode must be one of: ${ATTENDANCE_MODES.join(', ')}` }, 400);
  }

  try {
    await assertCanAddBranch(c.env.DB);
  } catch (e) {
    if (e instanceof PlanLimitError) return c.json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  const id = uuid();
  await c.env.DB.prepare(`
    INSERT INTO branches (id, name, address, phone, license_type, pcn_license_no, superintendent_pharmacist, latitude, longitude, geofence_radius_meters, attendance_mode, pcn_license_expiry_date, superintendent_registration_expiry_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, body.name, body.address || null, body.phone || null, body.license_type || 'PHARMACY', body.pcn_license_no || null, body.superintendent_pharmacist || null,
          body.latitude ?? null, body.longitude ?? null, body.geofence_radius_meters || 100, body.attendance_mode || 'GEOLOCATION', body.pcn_license_expiry_date || null, body.superintendent_registration_expiry_date || null).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(id).first(), 201);
});

branches.put('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Branch not found' }, 404);
  // A branch-scoped manager may edit ONLY their own branch's record
  // (address, phone, geofence...). Live-reproduced before this guard: a
  // Minna manager renamed the Lagos branch, and could equally have
  // deactivated it — which blocks every sale, till and clock-in there.
  {
    const pinned = pinnedBranchIdOf(c.get('user'));
    if (pinned && pinned !== id) {
      return c.json({
        error: 'You do not have access to this branch\'s records.',
        code: 'BRANCH_SCOPE_VIOLATION',
      }, 403);
    }
  }
  const body = await readJsonBody(c);

  const geofenceError = validateGeofence(body, existing);
  if (geofenceError) return c.json({ error: geofenceError }, 400);
  if (body.attendance_mode !== undefined && !ATTENDANCE_MODES.includes(body.attendance_mode)) {
    return c.json({ error: `attendance_mode must be one of: ${ATTENDANCE_MODES.join(', ')}` }, 400);
  }

  const fields = ['name', 'address', 'phone', 'license_type', 'pcn_license_no', 'superintendent_pharmacist', 'is_active', 'latitude', 'longitude', 'geofence_radius_meters', 'attendance_mode', 'pcn_license_expiry_date', 'superintendent_registration_expiry_date'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (updates.length === 0) return c.json(existing);
  const setClause = updates.map((f) => `${f} = ?`).join(', ');
  // DATA-INTEGRITY: see the full explanation below and
  // worker/src/routes/products.js's is_controlled fix — applied here for
  // correctness/parity, coercing a genuine JS boolean to the explicit 1/0
  // INTEGER this column's schema expects.
  const vals = updates.map((f) => (f === 'is_active' ? (body[f] ? 1 : 0) : body[f]));

  // BUG 86: capture what is still open BEFORE the closure lands, so the
  // response can tell the owner exactly what still needs settling.
  const closing = isExplicitFalse(body.is_active) && existing.is_active;
  const inFlight = closing ? await workInFlight(c.env.DB, id) : null;

  await c.env.DB.prepare(`UPDATE branches SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).bind(...vals, id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(id).first();

  if (closing && inFlight && inFlight.items.length) {
    return c.json({
      ...updated,
      closure_warning: {
        code: 'BRANCH_CLOSED_WITH_WORK_IN_FLIGHT',
        message: `${existing.name} is now closed, but some work was left unfinished: ${inFlight.items.join('; ')}. `
          + 'You can still settle all of it — closing a till, ending a shift, cancelling a stocktake and cancelling an outstanding order all still work at a closed branch. '
          + 'New trading (sales, clock-ins, receiving stock) is blocked from now on.',
        ...inFlight,
      },
    });
  }
  return c.json(updated);
});

// RELOCATE / REOPEN A CLOSED BRANCH  (client decision).
//
// When a pharmacy shuts a shop and opens another, the closed branch's slot is
// now free (BUG 85) — but the owner still faces a choice nobody was asking
// them: does the new shop CONTINUE the old one, or start clean?
//
//   CARRY_OVER  the same branch row is reopened at the new address. Every
//               sale, shift, till session, stocktake and ledger entry stays
//               attached, so last year's figures and this year's are one
//               continuous history. Correct when the business simply MOVED.
//
//   FRESH_START a brand-new branch row is created at the new address and the
//               old one stays closed. The old shop's history remains readable
//               under its own name, and the new shop's reports begin at zero.
//               Correct when the old shop was wound up and this is a new
//               venture that happens to be run by the same pharmacy.
//
// Both are legitimate and they are NOT interchangeable — merging two shops'
// trading history when they were different businesses distorts every
// year-on-year comparison, and splitting one shop's history because it moved
// down the road does the same in reverse. So the choice is explicit and
// required: there is no default.
//
// managerOnly matches branch creation; a branch-pinned manager is refused,
// because estate decisions belong to the proprietor.
branches.post('/:id/relocate', managerOnly, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Branch not found' }, 404);

  {
    const pinned = pinnedBranchIdOf(c.get('user'));
    if (pinned) {
      return c.json({
        error: 'Opening, closing and relocating branches is an estate decision for the Owner, not a single branch\'s manager.',
        code: 'BRANCH_SCOPE_VIOLATION',
      }, 403);
    }
  }

  const body = await readJsonBody(c);
  const MODES = ['CARRY_OVER', 'FRESH_START'];
  if (!MODES.includes(body.mode)) {
    return c.json({
      error: `Choose what happens to this branch's records: "CARRY_OVER" keeps ${existing.name}'s existing sales, shifts and ledger attached to the new address (use this when the shop simply MOVED), or "FRESH_START" opens a separate new branch and leaves ${existing.name}'s history under its own name (use this when the old shop was wound up).`,
      code: 'RELOCATION_MODE_REQUIRED',
      valid_modes: MODES,
    }, 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!address) return c.json({ error: 'A new address is required to relocate a branch.', code: 'ADDRESS_REQUIRED' }, 400);
  if (existing.is_active && body.mode === 'CARRY_OVER') {
    return c.json({
      error: `${existing.name} is still open. Close it first, or simply edit its address if it has not moved yet.`,
      code: 'BRANCH_STILL_OPEN',
    }, 400);
  }

  const geofenceError = validateGeofence(body, existing);
  if (geofenceError) return c.json({ error: geofenceError }, 400);

  if (body.mode === 'CARRY_OVER') {
    // Reopening consumes a slot again, so the plan limit must be re-checked —
    // the branch was not counted while it was closed (BUG 85).
    try {
      await assertCanAddBranch(c.env.DB);
    } catch (e) {
      if (e instanceof PlanLimitError) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
    await c.env.DB.prepare(`
      UPDATE branches
         SET name = ?, address = ?, phone = ?, latitude = ?, longitude = ?, geofence_radius_meters = ?,
             is_active = 1, updated_at = datetime('now')
       WHERE id = ?
    `).bind(
      name || existing.name,
      address,
      body.phone !== undefined ? body.phone : existing.phone,
      body.latitude !== undefined ? body.latitude : existing.latitude,
      body.longitude !== undefined ? body.longitude : existing.longitude,
      body.geofence_radius_meters !== undefined ? body.geofence_radius_meters : existing.geofence_radius_meters,
      id,
    ).run();
    const row = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(id).first();
    return c.json({
      ...row,
      relocation: {
        mode: 'CARRY_OVER',
        branch_id: id,
        message: `${row.name} has reopened at the new address. All of its previous sales, shifts, till sessions and ledger entries remain attached, so its history is continuous.`,
      },
    });
  }

  // FRESH_START — a genuinely new branch; the old one stays closed and keeps
  // its own history under its own name.
  try {
    await assertCanAddBranch(c.env.DB);
  } catch (e) {
    if (e instanceof PlanLimitError) return c.json({ error: e.message, code: e.code }, e.status);
    throw e;
  }
  if (!name) return c.json({ error: 'A name is required for the new branch.', code: 'NAME_REQUIRED' }, 400);
  const newId = uuid();
  await c.env.DB.prepare(`
    INSERT INTO branches (id, name, address, phone, license_type, latitude, longitude, geofence_radius_meters, attendance_mode, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,1)
  `).bind(
    newId, name, address,
    body.phone !== undefined ? body.phone : null,
    body.license_type || existing.license_type,
    body.latitude !== undefined ? body.latitude : null,
    body.longitude !== undefined ? body.longitude : null,
    body.geofence_radius_meters !== undefined ? body.geofence_radius_meters : existing.geofence_radius_meters,
    body.attendance_mode || existing.attendance_mode,
  ).run();
  const row = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(newId).first();
  return c.json({
    ...row,
    relocation: {
      mode: 'FRESH_START',
      branch_id: newId,
      previous_branch_id: id,
      message: `${name} has been opened as a separate branch starting from zero. ${existing.name} stays closed and keeps its own trading history, which remains readable in every report.`,
    },
  }, 201);
});

module.exports = branches;
// Public, UNAUTHENTICATED branding endpoint — Cloudflare Workers port of
// the original implementation See that file for the full rationale (login
// screen needs this before anyone signs in; only business_name and logo
// are exposed, never plan/subscription/contact fields).
