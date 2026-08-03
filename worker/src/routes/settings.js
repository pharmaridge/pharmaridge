// Client-owned business settings — DISTINCT from routes/admin.js's
// vendor-controlled plan limits/feature toggles. Mirrors the original
// design for the full rationale.
const { Hono } = require('hono');
const { authRequired, ownerOnly, managerOnly } = require('../lib/auth');
const { getClientSettings } = require('../lib/planLimits');
const { readJsonBody, rejectUnknownFields } = require('../lib/http');

const settings = new Hono();
settings.use('*', authRequired);

settings.get('/vat', async (c) => {
  const s = await getClientSettings(c.env.DB);
  return c.json({
    vat_enabled: !!s.vat_enabled,
    vat_rate_percent: s.vat_rate_percent,
  });
});

settings.put('/vat', ownerOnly, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJsonBody(c);
  // BUG 77 — a typo here used to answer 200 with VAT unchanged.
  {
    const bad = rejectUnknownFields(body, ['vat_enabled', 'vat_rate_percent'], { label: 'VAT settings' });
    if (bad) return c.json(bad, 400);
  }
  const { vat_enabled, vat_rate_percent } = body;

  const sets = [];
  const vals = [];
  if (vat_enabled !== undefined) {
    sets.push('vat_enabled = ?');
    vals.push(vat_enabled ? 1 : 0);
  }
  if (vat_rate_percent !== undefined) {
    if (!Number.isFinite(vat_rate_percent) || vat_rate_percent < 0 || vat_rate_percent > 100) {
      return c.json({ error: 'vat_rate_percent must be a number between 0 and 100' }, 400);
    }
    sets.push('vat_rate_percent = ?');
    vals.push(vat_rate_percent);
  }
  if (sets.length === 0) {
    const s = await getClientSettings(db);
    return c.json({ vat_enabled: !!s.vat_enabled, vat_rate_percent: s.vat_rate_percent });
  }
  sets.push("updated_at = datetime('now')", 'updated_by = ?');
  vals.push(user.id);
  await db.prepare(`UPDATE client_settings SET ${sets.join(', ')} WHERE id = 1`).bind(...vals).run();
  const s = await getClientSettings(db);
  return c.json({ vat_enabled: !!s.vat_enabled, vat_rate_percent: s.vat_rate_percent });
});

// OWNER-CONTROLLED MANAGER PERMISSIONS (migration 0003, client decision).
//
// Distinct from routes/admin.js's vendor-owned plan limits: these are the
// CLIENT's own governance switches over what their MANAGERs may do, so
// they live behind ownerOnly (which also admits ADMIN for support).
//
// Readable by any authenticated user because the frontend needs them to
// hide buttons a manager cannot use — hiding a control the server would
// refuse is exactly the front-to-back alignment this audit is for.
const MANAGER_PERMISSION_FIELDS = ['managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices'];

// OWNER-CONTROLLED *STAFF* PERMISSIONS. Same endpoint, because they are
// the same kind of thing from the owner's point of view — "what may my
// people do?" — and splitting them across two screens would make the
// governance picture harder to see, not easier.
//
// Two are booleans, two are NUMBERS (a window in minutes and a unit cap),
// so they are handled separately below rather than folded into the boolean
// loop. See lib/planLimits.assertStaffCanVoid/assertStaffCanAdjust.
const STAFF_PERMISSION_BOOLS = ['staff_can_void_sales', 'staff_can_adjust_stock', 'staff_can_spend_from_safe'];
const STAFF_PERMISSION_NUMBERS = {
  staff_void_window_minutes: { min: 0, max: 1440, dflt: 15 },
  staff_adjustment_max_units: { min: 0, max: 10000, dflt: 5 },
  // The most a cashier may draw from the safe for ONE purchase.
  // 0 = NO CAP, at the client's explicit request ("it could be set to no cap
  // or set with a cap"). Zero is never read as "nothing allowed" — that is
  // what staff_can_spend_from_safe is for. Ten million is not a policy, it is
  // a typo guard: a figure above it is far more likely a slipped keypress than
  // a decision, and "no cap" already has its own value.
  staff_safe_spend_max: { min: 0, max: 10000000, dflt: 20000, money: true },
};

// WHO MAY CHANGE WHAT (client decision).
//
// The manager switches, and the staff void/write-off allowances, are the
// OWNER's governance over their own managers — a manager who could widen their
// own authority is not restricted at all, so those stay ownerOnly.
//
// The staff SAFE allowance is different in kind. It is an operating decision
// about the shop a manager actually runs: how much a cashier may take from the
// reserve to buy something today. The client asked for it to be settable by "a
// manager or owner", and it does not widen the manager's own powers — only the
// staff allowance beneath them. So this pair, and only this pair, is
// manager-settable.
const MANAGER_SETTABLE = new Set(['staff_can_spend_from_safe', 'staff_safe_spend_max']);

function readPermissions(s) {
  const out = {};
  for (const f of MANAGER_PERMISSION_FIELDS) out[f] = s[f] === undefined ? true : !!s[f];
  for (const f of STAFF_PERMISSION_BOOLS) out[f] = s[f] === undefined ? true : !!s[f];
  for (const [f, spec] of Object.entries(STAFF_PERMISSION_NUMBERS)) {
    out[f] = s[f] === undefined || s[f] === null ? spec.dflt : Number(s[f]);
  }
  return out;
}

settings.get('/manager-permissions', async (c) => {
  // Default to enabled when a column is absent (an older database) so the
  // UI never wrongly greys out a live capability.
  return c.json(readPermissions(await getClientSettings(c.env.DB)));
});

settings.put('/manager-permissions', managerOnly, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJsonBody(c);
  // BUG 77 — same class: `staff_can_void` (the real field is
  // `staff_can_void_sales`) answered 200 while the cashier kept the power.
  {
    const bad = rejectUnknownFields(
      body,
      [...MANAGER_PERMISSION_FIELDS, ...STAFF_PERMISSION_BOOLS, ...Object.keys(STAFF_PERMISSION_NUMBERS)],
      { label: 'manager/cashier permissions' },
    );
    if (bad) return c.json(bad, 400);
  }
  // A MANAGER may set the staff safe allowance and nothing else here. Checked
  // by naming the fields they touched rather than by trusting the route guard,
  // because the route now admits managers for that one purpose — a manager who
  // could also flip `managers_can_void_sales` would simply be granting
  // themselves the power the Owner withheld.
  if (c.get('user').role === 'MANAGER') {
    const forbidden = Object.keys(body).filter((k) => !MANAGER_SETTABLE.has(k));
    if (forbidden.length) {
      return c.json({
        error: `As a manager you can set the cashiers' safe allowance, but not: ${forbidden.join(', ')}. `
          + 'Those belong to the Owner.',
        code: 'OWNER_ONLY_SETTING',
      }, 403);
    }
  }
  const sets = [];
  const vals = [];
  for (const f of [...MANAGER_PERMISSION_FIELDS, ...STAFF_PERMISSION_BOOLS]) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== 'boolean') {
      return c.json({ error: `${f} must be true or false` }, 400);
    }
    sets.push(`${f} = ?`);
    vals.push(body[f] ? 1 : 0);
  }
  // The window and the cap are what make the staff allowance safe, so they
  // are validated rather than trusted: a negative window would silently
  // disable the check, and an enormous cap would make it meaningless.
  for (const [f, spec] of Object.entries(STAFF_PERMISSION_NUMBERS)) {
    if (body[f] === undefined) continue;
    const v = body[f];
    // The money field takes any amount to the kobo; the rest are counts.
    const wellFormed = spec.money
      ? (Number.isFinite(v) && v >= spec.min && v <= spec.max)
      : (Number.isInteger(v) && v >= spec.min && v <= spec.max);
    if (!wellFormed) {
      return c.json({ error: spec.money
        ? `${f} must be an amount between ${spec.min} and ${spec.max} (0 means no limit)`
        : `${f} must be a whole number between ${spec.min} and ${spec.max}` }, 400);
    }
    sets.push(`${f} = ?`);
    vals.push(body[f]);
  }
  if (sets.length === 0) {
    return c.json(readPermissions(await getClientSettings(db)));
  }
  sets.push("updated_at = datetime('now')", 'updated_by = ?');
  vals.push(user.id);
  await db.prepare(`UPDATE client_settings SET ${sets.join(', ')} WHERE id = 1`).bind(...vals).run();
  return c.json(readPermissions(await getClientSettings(db)));
});

module.exports = settings;
