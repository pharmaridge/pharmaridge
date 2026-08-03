// Staff attendance service for the D1 deployment — mirrors the original
// implementation exactly in business logic (geofence classification is
// shared via lib/business.js). Supports both attendance verification modes
// (see branches.attendance_mode in schema.sql): GEOLOCATION (GPS geofence)
// and REGISTERED_DEVICE (branch_devices registry lookup).
const { uuid } = require('../lib/crypto');
const { classifyLocation } = require('../lib/business');
// BUG 65: this service ran a CAS batch with NO transient-fault tolerance while
// every other batching path in the codebase had it. Cloudflare documents a
// family of D1 faults ("Network connection lost.", "...caused object to be
// reset.") as ROUTINE — "a handful of errors every several hours is not
// unexpected" — and tells you to retry them. Unwrapped, one of those blips
// surfaces to a cashier trying to END THEIR SHIFT as a bare 500, and to a
// cashier trying to START one as a failed clock-in. Retrying is safe here for
// the same reason it is everywhere else: the statement is a guarded CAS
// (`WHERE clock_out_at IS NULL`), so re-running it cannot double-apply.
const { withD1Retry } = require('../lib/d1Retry');

async function getBranch(db, branchId) {
  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(branchId).first();
  if (!branch) throw Object.assign(new Error('Branch not found'), { status: 404 });
  return branch;
}

async function classifyDevice(db, branchId, deviceId) {
  if (!deviceId) return 'DEVICE_NOT_SET';
  const registered = await db.prepare(`
    SELECT id FROM branch_devices WHERE branch_id = ? AND device_id = ? AND is_deleted = 0 AND revoked_at IS NULL
  `).bind(branchId, deviceId).first();
  return registered ? 'DEVICE_RECOGNIZED' : 'DEVICE_NOT_RECOGNIZED';
}

async function verifyAttendance(db, branch, location, deviceId) {
  if (branch.attendance_mode === 'REGISTERED_DEVICE') {
    return { status: await classifyDevice(db, branch.id, deviceId), distanceMeters: null };
  }
  return classifyLocation(branch, location?.lat, location?.lng);
}

const FLAGGED_STATUSES = ['OFF_SITE', 'NO_LOCATION', 'GEOFENCE_NOT_SET', 'DEVICE_NOT_RECOGNIZED', 'DEVICE_NOT_SET'];

async function getOpenAttendance(db, userId) {
  return db.prepare(`SELECT * FROM staff_attendance WHERE user_id = ? AND clock_out_at IS NULL AND is_deleted = 0 ORDER BY clock_in_at DESC LIMIT 1`).bind(userId).first();
}

async function clockIn(db, { branchId, userId, location, deviceId }) {
  const branch = await getBranch(db, branchId);
  const { status, distanceMeters } = await verifyAttendance(db, branch, location, deviceId);

  const id = uuid();
  try {
    // idx_attendance_one_open_per_user (partial UNIQUE index) is the
    // authoritative guard against double clock-in; this INSERT either
    // succeeds outright or throws a UNIQUE constraint error.
    //
    // Retry-wrapped (BUG 65). Safe despite being an INSERT: the id is a
    // client-independent uuid generated ONCE above the retry, so a re-run
    // inserts the same primary key rather than a second row — and the partial
    // UNIQUE index would refuse a duplicate open shift anyway. Only
    // Cloudflare's documented transient faults are retried; the UNIQUE
    // violation that signals a genuine double clock-in is re-thrown
    // immediately and untouched (verified in probe-transient.js section B).
    await withD1Retry(() => db.prepare(`
      INSERT INTO staff_attendance (id, branch_id, user_id, clock_in_lat, clock_in_lng, clock_in_accuracy_meters, clock_in_distance_meters, clock_in_device_id, clock_in_status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(id, branchId, userId, location?.lat ?? null, location?.lng ?? null, location?.accuracy ?? null, distanceMeters, deviceId || null, status).run(), 'attendance clock-in');
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) {
      throw Object.assign(new Error('You are already clocked in. Clock out first before clocking in again.'), { code: 'ALREADY_CLOCKED_IN' });
    }
    throw e;
  }

  return getAttendance(db, id);
}

async function clockOut(db, { attendanceId, userId, location, deviceId }) {
  const record = await db.prepare('SELECT * FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(attendanceId).first();
  if (!record) throw Object.assign(new Error('Attendance record not found'), { status: 404 });
  if (record.user_id !== userId) throw Object.assign(new Error('You can only clock yourself out.'), { code: 'FORBIDDEN' });
  if (record.clock_out_at) throw Object.assign(new Error('This shift has already been clocked out.'), { status: 400 });

  const branch = await getBranch(db, record.branch_id);
  const { status, distanceMeters } = await verifyAttendance(db, branch, location, deviceId);

  // Guarded: only takes effect if still open, protecting against a
  // concurrent double clock-out on the exact same record.
  const claim = await withD1Retry(() => db.batch([
    db.prepare(`
      UPDATE staff_attendance
      SET clock_out_at = datetime('now'), clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy_meters = ?, clock_out_distance_meters = ?, clock_out_device_id = ?, clock_out_status = ?, updated_at = datetime('now')
      WHERE id = ? AND clock_out_at IS NULL
    `).bind(location?.lat ?? null, location?.lng ?? null, location?.accuracy ?? null, distanceMeters, deviceId || null, status, attendanceId),
  ]), 'attendance clock-out');
  if (claim[0]?.meta?.changes !== 1) {
    throw Object.assign(new Error('This shift has already been clocked out.'), { status: 400 });
  }

  return getAttendance(db, attendanceId);
}

async function managerOverride(db, { attendanceId, managerId, reason }) {
  const record = await db.prepare('SELECT * FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(attendanceId).first();
  if (!record) throw Object.assign(new Error('Attendance record not found'), { status: 404 });

  // BUG 51 (live-reproduced). `reason || null` accepted an override with NO
  // reason at all and returned 200, storing manager_override_reason = NULL.
  //
  // An override is a manager personally vouching "this person really was on
  // duty" for a record the system FLAGGED — clocked in off-site, with no
  // location, or from an unrecognised device. It is the moment a human
  // takes responsibility for paying someone the geofence says was not
  // there, and it is the only artefact a proprietor has when asking why a
  // flagged shift was approved. An unexplained sign-off is indistinguishable
  // from a manager clicking through a queue of flags without reading them —
  // which is precisely the behaviour the flag exists to prevent.
  //
  // Same reasoning the UI already applies to a till force-close ("A reason
  // is required to force-close another user's till"); attendance simply
  // never enforced it on either side.
  // BUG 71 — A MANAGER COULD SIGN OFF THEIR OWN FLAGGED SHIFT.
  //
  // An override is a manager vouching "this person really was on duty" for a
  // record the system flagged. When the manager IS that person, the sign-off
  // vouches for nobody: it is the same human on both sides, approving their
  // own pay for a shift the geofence could not verify.
  //
  // Live-reproduced: a manager clocked in with no location (flagged
  // NO_LOCATION), then overrode it. Result 200, with
  // manager_override_by === user_id on the same row. The record then reads to
  // a proprietor, an auditor or a wage tribunal exactly like a properly
  // reviewed one — the flag is cleared and a plausible reason is attached.
  //
  // This is the same principle the codebase already applies to a till
  // force-close and to STAFF voids: the person who benefits cannot be the
  // person who authorises. A previous audit note claimed attendance already
  // refused this; it never did, and the claim went unchecked until now.
  //
  // A manager whose own shift is genuinely flagged is not stuck: another
  // manager, the owner, or PharmaRidge support can review it. That is the
  // point — someone else has to look.
  if (record.user_id === managerId) {
    throw Object.assign(
      new Error('You cannot approve your own flagged attendance record. An override is someone vouching that a shift the system could not verify really happened, so it has to be signed off by a different manager, the owner, or PharmaRidge support.'),
      { status: 403, code: 'SELF_OVERRIDE_FORBIDDEN' },
    );
  }

  const cleaned = typeof reason === 'string' ? reason.trim() : '';
  if (cleaned.length < 4) {
    throw Object.assign(
      new Error('Give a reason for approving this flagged attendance record — it is the only explanation anyone will have later for why someone was paid for a shift the system could not verify.'),
      { status: 400, code: 'OVERRIDE_REASON_REQUIRED' },
    );
  }

  // APPEND, never overwrite. A second override used to silently replace the
  // first reason, erasing the earlier manager's stated justification along
  // with any trace that the record had been reviewed twice. Both sign-offs
  // are payroll evidence, so both survive.
  const previous = record.manager_override_reason;
  const stamped = previous ? `${previous} | ${cleaned}` : cleaned;

  await db.prepare(`UPDATE staff_attendance SET manager_override_by = ?, manager_override_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(managerId, stamped, attendanceId).run();
  return getAttendance(db, attendanceId);
}

// BUG 74 — FORCE CLOCK-OUT.
//
// clockOut() refuses to end anyone else's shift, which is right: nobody may
// fabricate a colleague's hours. But that left the one case that always
// eventually happens with NO path at all — the person is deactivated,
// deleted, or simply leaves while still clocked in. Live-reproduced: after
// deactivation the owner got 403 FORBIDDEN from clock-out and 200 from
// override with clock_out_at still NULL, so the ex-employee read as "Still
// clocked in" permanently; and because idx_attendance_one_open_per_user is a
// partial UNIQUE index, reinstating them produced ALREADY_CLOCKED_IN forever.
//
// Tills already had force_closed_by/force_closed_reason and stocktakes had
// force-cancel. Attendance was the only open-state table with no recovery,
// which is the asymmetry this closes.
//
// Recorded as a manager intervention rather than a normal clock-out, because
// the difference is payroll-relevant: a proprietor must be able to see that
// the employee did not end this shift themselves, and who decided the end
// time on their behalf.
async function forceClockOut(db, { attendanceId, managerId, reason, clockOutAt = null }) {
  const record = await db.prepare('SELECT * FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(attendanceId).first();
  if (!record) throw Object.assign(new Error('Attendance record not found'), { status: 404 });
  if (record.clock_out_at) throw Object.assign(new Error('This shift has already been clocked out.'), { status: 400 });

  // Same principle as Bug 71's self-override and the till force-close: the
  // person whose hours are being decided cannot be the person deciding them.
  // A manager who forgot to clock out uses the ordinary clock-out, which is
  // still open to them; this path is strictly for ending SOMEONE ELSE's
  // shift, so pointing it at yourself is either a mistake or self-dealing.
  if (record.user_id === managerId) {
    throw Object.assign(
      new Error('Use the normal Clock Out for your own shift. Force clock-out is for ending someone else\'s shift on their behalf, so it cannot be used on yourself.'),
      { status: 403, code: 'SELF_FORCE_CLOCKOUT_FORBIDDEN' },
    );
  }

  const cleaned = typeof reason === 'string' ? reason.trim() : '';
  if (cleaned.length < 4) {
    throw Object.assign(
      new Error('Give a reason for ending this person\'s shift on their behalf — it is the only record of why their hours were closed by someone else.'),
      { status: 400, code: 'FORCE_CLOCKOUT_REASON_REQUIRED' },
    );
  }

  // An explicit end time is allowed because the realistic case is a manager
  // discovering the next morning that last night's cashier never clocked out.
  // Recording datetime('now') then would credit them a whole extra night.
  // It may not precede the clock-in (that would yield negative hours) and may
  // not be in the future (that would pay for time not yet worked).
  let endClause = "datetime('now')";
  const params = [];
  if (clockOutAt) {
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(clockOutAt))) {
      throw Object.assign(new Error('clock_out_at must look like YYYY-MM-DD HH:MM:SS.'), { status: 400, code: 'INVALID_CLOCK_OUT_TIME' });
    }
    const normalised = String(clockOutAt).replace('T', ' ');
    const bounds = await db.prepare(
      `SELECT ? < ? AS before_start, ? > datetime('now', '+2 minutes') AS in_future`,
    ).bind(normalised, record.clock_in_at, normalised).first();
    if (bounds && Number(bounds.before_start)) {
      throw Object.assign(new Error('The clock-out time cannot be before the clock-in time.'), { status: 400, code: 'INVALID_CLOCK_OUT_TIME' });
    }
    if (bounds && Number(bounds.in_future)) {
      throw Object.assign(new Error('The clock-out time cannot be in the future.'), { status: 400, code: 'INVALID_CLOCK_OUT_TIME' });
    }
    endClause = '?';
    params.push(normalised);
  }

  // Guarded on clock_out_at IS NULL — a true compare-and-swap, so two
  // managers force-closing the same shift cannot both succeed. Retry-wrapped
  // per BUG 65: a re-run after a transient fault matches no rows and yields
  // changes=0, which the guard below reports as the loser.
  const claim = await withD1Retry(() => db.batch([
    db.prepare(`
      UPDATE staff_attendance
         SET clock_out_at = ${endClause},
             clock_out_status = 'NO_LOCATION',
             force_closed_by = ?,
             force_closed_reason = ?,
             updated_at = datetime('now')
       WHERE id = ? AND clock_out_at IS NULL
    `).bind(...params, managerId, cleaned, attendanceId),
  ]), 'attendance force clock-out');
  if (claim[0]?.meta?.changes !== 1) {
    throw Object.assign(new Error('This shift has already been clocked out.'), { status: 400 });
  }
  return getAttendance(db, attendanceId);
}

// Used when an account is deactivated or deleted: a departing employee must
// not be left permanently "on duty". Returns a statement so the caller can
// commit it atomically with the removal itself.
function autoCloseShiftStatement(db, { userId, actorId, reason }) {
  return db.prepare(`
    UPDATE staff_attendance
       SET clock_out_at = datetime('now'),
           clock_out_status = 'NO_LOCATION',
           force_closed_by = ?,
           force_closed_reason = ?,
           updated_at = datetime('now')
     WHERE user_id = ? AND clock_out_at IS NULL AND is_deleted = 0
  `).bind(actorId, reason, userId);
}

async function getAttendance(db, id) {
  return db.prepare(`
    SELECT a.*, u.full_name AS user_full_name, b.name AS branch_name, m.full_name AS override_by_name
    FROM staff_attendance a JOIN users u ON u.id = a.user_id JOIN branches b ON b.id = a.branch_id LEFT JOIN users m ON m.id = a.manager_override_by
    WHERE a.id = ?
  `).bind(id).first();
}

// --- Branch device registry (REGISTERED_DEVICE attendance mode) ---

async function listBranchDevices(db, branchId) {
  const { results } = await db.prepare(`
    SELECT bd.*, u.full_name AS registered_by_name, r.full_name AS revoked_by_name
    FROM branch_devices bd
    JOIN users u ON u.id = bd.registered_by
    LEFT JOIN users r ON r.id = bd.revoked_by
    WHERE bd.branch_id = ? AND bd.is_deleted = 0
    ORDER BY bd.revoked_at IS NOT NULL, bd.registered_at DESC
  `).bind(branchId).all();
  return results;
}

async function registerDevice(db, { branchId, deviceId, label, registeredBy }) {
  if (!deviceId) throw Object.assign(new Error('deviceId is required'), { status: 400 });
  const activeElsewhere = await db.prepare(`
    SELECT branch_id FROM branch_devices WHERE device_id = ? AND is_deleted = 0 AND revoked_at IS NULL
  `).bind(deviceId).first();
  if (activeElsewhere) {
    if (activeElsewhere.branch_id === branchId) {
      throw Object.assign(new Error('This device is already registered to this branch.'), { status: 400 });
    }
    throw Object.assign(new Error('This device is already registered to a different branch. Revoke it there first before registering it here.'), { status: 400 });
  }
  const id = uuid();
  await db.prepare(`INSERT INTO branch_devices (id, branch_id, device_id, label, registered_by) VALUES (?,?,?,?,?)`)
    .bind(id, branchId, deviceId, label || null, registeredBy).run();
  const devices = await listBranchDevices(db, branchId);
  return devices.find((d) => d.id === id);
}

async function revokeDevice(db, { branchDeviceId, branchId, revokedBy }) {
  const device = await db.prepare('SELECT * FROM branch_devices WHERE id = ? AND branch_id = ? AND is_deleted = 0').bind(branchDeviceId, branchId).first();
  if (!device) throw Object.assign(new Error('Registered device not found for this branch.'), { status: 400 });
  if (device.revoked_at) throw Object.assign(new Error('This device is already revoked.'), { status: 400 });
  await db.prepare(`UPDATE branch_devices SET revoked_by = ?, revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .bind(revokedBy, branchDeviceId).run();
  const devices = await listBranchDevices(db, branchId);
  return devices.find((d) => d.id === branchDeviceId);
}

module.exports = {
  clockIn, clockOut, managerOverride, getAttendance, getOpenAttendance, FLAGGED_STATUSES,
  listBranchDevices, registerDevice, revokeDevice,
  forceClockOut, autoCloseShiftStatement,
};
