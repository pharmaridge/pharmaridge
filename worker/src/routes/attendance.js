const { Hono } = require('hono');
const { authRequired, managerOnly, assertBranchActive, assertNotVendorSeat, resolveMutationBranchId, resolveScopedBranchId, assertBranchAccess, pinnedBranchIdOf } = require('../lib/auth');
const { requireFeature } = require('../lib/planLimits');
const attendanceService = require('../services/attendanceService');
const { readJsonBody } = require('../lib/http');


const attendance = new Hono();
attendance.use('*', authRequired);
// See the original implementation — mutating attendance actions are
// blocked at the API layer when the admin has disabled this module for the
// client; history stays readable.
attendance.use('/clock-in', requireFeature('attendance_module_enabled', 'Staff Attendance'));
attendance.use('/:id/clock-out', requireFeature('attendance_module_enabled', 'Staff Attendance'));
attendance.use('/:id/override', requireFeature('attendance_module_enabled', 'Staff Attendance'));
attendance.use('/:id/force-clock-out', requireFeature('attendance_module_enabled', 'Staff Attendance'));
attendance.use('/devices', requireFeature('attendance_module_enabled', 'Staff Attendance'));
attendance.use('/devices/:id/revoke', requireFeature('attendance_module_enabled', 'Staff Attendance'));

attendance.get('/me/current', async (c) => {
  const user = c.get('user');
  const open = await attendanceService.getOpenAttendance(c.env.DB, user.id);
  if (!open) return c.json(null);
  return c.json(await attendanceService.getAttendance(c.env.DB, open.id));
});

attendance.post('/clock-in', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  // The vendor's support seat is not an employee — see
  // assertNotVendorSeat in lib/auth.js for the live-reproduced bug where
  // "PharmaRidge Support" appeared in the client's own staff attendance
  // (payroll) register.
  const vendorErr = assertNotVendorSeat(user, 'clock in or out of a branch');
  if (vendorErr) return c.json({ error: vendorErr.message, code: vendorErr.code }, vendorErr.status);
  const branchId = resolveMutationBranchId(c, body.branch_id);
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  try {
    await assertBranchActive(c.env.DB, branchId, 'accept a clock-in');
    const record = await attendanceService.clockIn(c.env.DB, { branchId, userId: user.id, location: body.location || null, deviceId: body.device_id || null });
    return c.json(record, 201);
  } catch (e) {
    // PARITY FIX (found while adding branch-deactivation enforcement):
    // this previously checked `e.code ? 409 : (e.status || 400)`,
    // which would have WRONGLY mapped our new BRANCH_INACTIVE error
    // (which carries BOTH .status=403 AND .code='BRANCH_INACTIVE') to
    // 409 instead of 403 — .status must be checked FIRST whenever an
    // error sets it explicitly, exactly like every other route in this
    // codebase already does.
    return c.json({ error: e.message, code: e.code }, e.status || (e.code ? 409 : 400));
  }
});


attendance.post('/:id/clock-out', async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const record = await attendanceService.clockOut(c.env.DB, { attendanceId: c.req.param('id'), userId: user.id, location: body.location || null, deviceId: body.device_id || null });
    return c.json(record);
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.code === 'FORBIDDEN' ? 403 : (e.status || 400));
  }
});

attendance.post('/:id/override', managerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    // CROSS-BRANCH HOLE FOUND AND FIXED (live-reproduced): a manager
    // pinned to Minna signed off a Lagos staff member's flagged
    // attendance record. That record is payroll evidence — an override is
    // a manager vouching "this person really was on duty" — so it must be
    // performed by someone with authority over THAT branch.
    const att = await c.env.DB.prepare('SELECT branch_id FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!att) return c.json({ error: 'Attendance record not found' }, 404);
    assertBranchAccess(c, att.branch_id);
    const record = await attendanceService.managerOverride(c.env.DB, { attendanceId: c.req.param('id'), managerId: user.id, reason: body.reason });
    return c.json(record);
  } catch (e) {
    // BUG 51: this catch dropped `e.code`, so OVERRIDE_REASON_REQUIRED
    // reached the client as a bare message with nothing to branch on.
    // Every other route in this codebase returns the code alongside the
    // message; this one silently did not.
    return c.json({ error: e.message, code: e.code }, e.status || 400);
  }
});

// BUG 74 — end a shift on someone else's behalf.
//
// The recovery path that till force-close and stocktake force-cancel already
// had, and attendance did not. Manager-gated and branch-scoped exactly like
// the override beside it, because deciding when someone's shift ended is the
// same kind of payroll authority as vouching that it happened.
attendance.post('/:id/force-clock-out', managerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  try {
    const att = await c.env.DB.prepare('SELECT branch_id FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!att) return c.json({ error: 'Attendance record not found' }, 404);
    assertBranchAccess(c, att.branch_id);
    const record = await attendanceService.forceClockOut(c.env.DB, {
      attendanceId: c.req.param('id'),
      managerId: user.id,
      reason: body.reason,
      clockOutAt: body.clock_out_at || null,
    });
    return c.json(record);
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.status || 400);
  }
});

// --- Branch device registry (REGISTERED_DEVICE attendance mode) ---
attendance.get('/devices', managerOnly, async (c) => {
  // A branch-scoped manager is forced to their own branch; an org-wide
  // manager must still name one explicitly.
  const branchId = resolveScopedBranchId(c) || c.req.query('branch_id');
  if (!branchId) return c.json({ error: 'branch_id is required' }, 400);
  return c.json(await attendanceService.listBranchDevices(c.env.DB, branchId));
});

attendance.post('/devices', managerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  if (!body.branch_id || !body.device_id) return c.json({ error: 'branch_id and device_id are required' }, 400);
  // CROSS-BRANCH HOLE FOUND AND FIXED (live-reproduced): a manager pinned
  // to Minna registered a device INTO Lagos. A registered device is what
  // REGISTERED_DEVICE attendance mode trusts to accept clock-ins, so this
  // let a foreign manager plant an approved terminal at another branch.
  // Force-scope to the caller's own branch, exactly like every other
  // branch-owned write.
  const registerBranchId = resolveMutationBranchId(c, body.branch_id);
  try {
    const result = await attendanceService.registerDevice(c.env.DB, { branchId: registerBranchId, deviceId: body.device_id, label: body.label, registeredBy: user.id });
    return c.json(result, 201);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

attendance.post('/devices/:id/revoke', managerOnly, async (c) => {
  const user = c.get('user');
  const body = await readJsonBody(c);
  if (!body.branch_id) return c.json({ error: 'branch_id is required' }, 400);
  // Same scoping rule as registration above: a pinned manager may only
  // revoke devices belonging to their own branch.
  const revokeBranchId = resolveMutationBranchId(c, body.branch_id);
  try {
    const result = await attendanceService.revokeDevice(c.env.DB, { branchDeviceId: c.req.param('id'), branchId: revokeBranchId, revokedBy: user.id });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, e.status || 400);
  }
});

attendance.get('/', async (c) => {
  const user = c.get('user');
  const branchId = resolveScopedBranchId(c);
  const flaggedOnly = c.req.query('flagged_only') === 'true';
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);

  // BUG 78 — THE PAYROLL MODULE NEVER COMPUTED HOURS.
  //
  // staff_attendance is described throughout this codebase as payroll
  // evidence, and the whole geofence/override apparatus exists to decide
  // whether a shift should be PAID. But nothing anywhere — not the API, not
  // the screen, not the CSV export — ever turned two timestamps into a
  // duration. Verified: the row carries 28 fields and not one of them is a
  // length of time. An owner paying staff had to subtract raw UTC strings by
  // hand, per shift, per person, every month; that is precisely the arithmetic
  // people get wrong, and it is the arithmetic the product exists to remove.
  //
  // Computed in SQL rather than JS because both columns are stored as UTC
  // `datetime('now')` text: julianday() differences them without any timezone
  // ambiguity, and the value is then identical for every client regardless of
  // the device's own clock or locale. (Display stays local — UI.shortDate
  // converts to the viewer's zone — but the DURATION must not depend on who
  // is looking at it.)
  //
  // NULL for an open shift, deliberately: a running shift has no length yet,
  // and inventing "so far" would put a number in a payroll column that grows
  // every time the page is refreshed.
  let sql = `
    SELECT a.*, u.full_name AS user_full_name, b.name AS branch_name, m.full_name AS override_by_name,
           f.full_name AS force_closed_by_name,
           CASE WHEN a.clock_out_at IS NULL THEN NULL
                ELSE CAST(ROUND((julianday(a.clock_out_at) - julianday(a.clock_in_at)) * 1440) AS INTEGER)
           END AS worked_minutes
    FROM staff_attendance a
    JOIN users u ON u.id = a.user_id
    JOIN branches b ON b.id = a.branch_id
    LEFT JOIN users m ON m.id = a.manager_override_by
    LEFT JOIN users f ON f.id = a.force_closed_by
    WHERE a.is_deleted = 0
  `;
  const params = [];
  if (branchId) { sql += ' AND a.branch_id = ?'; params.push(branchId); }
  if (flaggedOnly) {
    const placeholders = attendanceService.FLAGGED_STATUSES.map(() => '?').join(',');
    sql += ` AND (a.clock_in_status IN (${placeholders}) OR a.clock_out_status IN (${placeholders})) AND a.manager_override_by IS NULL`;
    params.push(...attendanceService.FLAGGED_STATUSES, ...attendanceService.FLAGGED_STATUSES);
  }
  sql += ' ORDER BY a.clock_in_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

module.exports = attendance;
const { roleLabel } = require('../lib/auth');
