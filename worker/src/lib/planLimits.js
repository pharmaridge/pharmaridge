// Plan-limits / subscription-gate helpers — Cloudflare D1 port of the
// original implementation Same single-tenant-per-client model and the same
// three enforcement mechanisms (branch/staff hard caps, feature toggles,
// subscription status gate); only the storage calls differ (D1's async
// prepared-statement API vs better-sqlite3's synchronous one). Kept
// deliberately parallel in structure/wording to the Node version so the
// two backends are easy to audit side by side.
const DEFAULT_SETTINGS = {
  id: 1, max_branches: 999, max_staff: 999,
  subscription_status: 'ACTIVE', subscription_plan: 'Standard',
  subscription_renewal_date: null,
  attendance_module_enabled: 1, controlled_register_enabled: 1, multi_branch_enabled: 1,
  vat_enabled: 0, vat_rate_percent: 7.5,
  admin_contact_name: null, admin_contact_phone: null, admin_contact_email: null,
  business_name: null, logo_data_url: null, notes: null,
  // OWNER-controlled manager permissions (migration 0003). Fail-open
  // defaults match the migration's DEFAULT 1 so a missing settings row
  // never silently strips managers of authority mid-shift.
  managers_can_void_sales: 1, managers_can_approve_expenses: 1, managers_can_edit_prices: 1,
};

async function getClientSettings(db) {
  const row = await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  // Defensive fallback: a freshly-migrated database always inserts this
  // row (see migrations/0001_initial_schema.sql), but if it were ever
  // somehow missing we must never fail every request in the app — fail
  // open with generous defaults rather than bricking the client's
  // entire system.
  return row || DEFAULT_SETTINGS;
}

function contactLine(settings) {
  const parts = [];
  if (settings.admin_contact_name) parts.push(settings.admin_contact_name);
  if (settings.admin_contact_phone) parts.push(`phone: ${settings.admin_contact_phone}`);
  if (settings.admin_contact_email) parts.push(`email: ${settings.admin_contact_email}`);
  return parts.length ? parts.join(', ') : 'PharmaRidge support';
}

// BUG 85 — A CLOSED BRANCH KEPT CONSUMING A PAID SLOT.
//
// This counted every non-deleted branch, INCLUDING deactivated ones, while
// activeStaffCount (below) has always filtered on is_active. The two halves of
// the same billing model therefore contradicted each other, verified live:
// deactivating a staff member immediately freed their seat and a replacement
// could be hired at the cap, but closing a branch freed nothing — a pharmacy
// that shut one shop could not open a replacement without buying an upgrade.
//
// Client decision: a closed branch does NOT consume a slot. The pharmacy is
// paying for shops it is actually trading from. Its history stays readable
// forever (nothing is deleted), and the branch can be reopened or relocated.
async function activeBranchCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM branches WHERE is_deleted = 0 AND is_active = 1').first();
  return row.n;
}

// Staff usage counts every operational account (STAFF, MANAGER, OWNER)
// but deliberately excludes ADMIN — the vendor's own Admin Portal
// seat is never part of what the client is paying for per-seat.
async function activeStaffCount(db) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM users
    WHERE is_active = 1 AND is_deleted = 0 AND role IN ('STAFF','MANAGER','OWNER')
  `).first();
  return row.n;
}

function effectiveMaxBranches(settings) {
  return settings.multi_branch_enabled ? settings.max_branches : 1;
}

class PlanLimitError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
    this.code = 'PLAN_LIMIT_EXCEEDED';
  }
}
class FeatureDisabledError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
    this.code = 'FEATURE_DISABLED';
  }
}
class SubscriptionInactiveError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
    this.code = 'SUBSCRIPTION_INACTIVE';
  }
}

async function assertCanAddBranch(db) {
  const settings = await getClientSettings(db);
  const cap = effectiveMaxBranches(settings);
  const used = await activeBranchCount(db);
  if (used >= cap) {
    throw new PlanLimitError(
      `Your plan allows a maximum of ${cap} branch${cap === 1 ? '' : 'es'} (currently using ${used}). ` +
      `To add more branches, please contact ${contactLine(settings)} to upgrade your plan.`
    );
  }
}

async function assertCanAddStaff(db) {
  const settings = await getClientSettings(db);
  const used = await activeStaffCount(db);
  if (used >= settings.max_staff) {
    throw new PlanLimitError(
      `Your plan allows a maximum of ${settings.max_staff} staff account${settings.max_staff === 1 ? '' : 's'} ` +
      `(currently using ${used}). To add more staff, please contact ${contactLine(settings)} to upgrade your plan.`
    );
  }
}

async function assertFeatureEnabled(db, featureColumn, featureLabel) {
  const settings = await getClientSettings(db);
  if (!settings[featureColumn]) {
    throw new FeatureDisabledError(
      `The ${featureLabel} module is not enabled on your current plan. ` +
      `Please contact ${contactLine(settings)} to enable it.`
    );
  }
}

// Hono middleware factory — mirrors requireFeature() in the Node
// deployment's planLimits.js.
function requireFeature(featureColumn, featureLabel) {
  return async (c, next) => {
    try {
      await assertFeatureEnabled(c.env.DB, featureColumn, featureLabel);
      await next();
    } catch (e) {
      if (e instanceof FeatureDisabledError) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  };
}

// Hono middleware — blocks all business-mutating requests (everything but
// GET) once this client's subscription is SUSPENDED/EXPIRED. Read traffic
// and the ADMIN's own seat are always allowed through — see
// subscriptionGate in the original implementation for the full rationale.
async function subscriptionGate(c, next) {
  if (c.req.method === 'GET') return next();
  const user = c.get('user');
  if (user && user.role === 'ADMIN') return next();

  const settings = await getClientSettings(c.env.DB);
  if (settings.subscription_status === 'SUSPENDED' || settings.subscription_status === 'EXPIRED') {
    const err = new SubscriptionInactiveError(
      `This account's subscription is currently ${settings.subscription_status.toLowerCase()}. ` +
      `New actions are disabled until this is resolved — please contact ${contactLine(settings)}.`
    );
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  await next();
}

// OWNER-CONTROLLED MANAGER PERMISSIONS (migration 0003, client decision).
//
// The OWNER may restrict what a plain MANAGER can do org-wide. These are
// the CLIENT's own governance switches, deliberately distinct from the
// vendor-owned plan/feature flags above.
//
// Scope of the restriction is intentionally narrow and asymmetric:
//   * MANAGER  -> subject to the toggle
//   * OWNER    -> never restricted (it is their own policy)
//   * ADMIN    -> never restricted (vendor support must always be able
//                 to correct a client's data)
// A toggle that could lock the owner out of their own books would be a
// footgun, so the guard checks role === 'MANAGER' explicitly rather than
// "not owner".
const MANAGER_PERMISSIONS = {
  managers_can_void_sales: 'void a sale',
  managers_can_approve_expenses: 'approve expenses',
  managers_can_edit_prices: 'change product prices',
};

async function assertManagerPermission(db, user, settingKey) {
  if (!user || user.role !== 'MANAGER') return null;
  const settings = await getClientSettings(db);
  // Treat only an explicit 0 as "denied": an older database that predates
  // migration 0003 returns undefined and must keep working unchanged.
  if (settings[settingKey] === 0 || settings[settingKey] === false) {
    return Object.assign(
      new Error(
        `The Owner has restricted this action: managers are not permitted to ${MANAGER_PERMISSIONS[settingKey] || 'perform this action'}. ` +
        'Ask the Owner to perform it, or to re-enable this permission in My Plan.'
      ),
      { status: 403, code: 'MANAGER_PERMISSION_DENIED' }
    );
  }
  return null;
}

// OWNER-CONTROLLED *STAFF* PERMISSIONS (client decision after a live audit
// demonstration that a plain cashier could void their own completed sale
// AND write off stock, with no gate at all).
//
// Both are the classic retail-theft patterns: sell for cash then void the
// sale and keep the note; or take the goods and record them as DAMAGE.
// Reproduced live before these guards existed.
//
// The design is deliberately a NARROW ALLOWANCE rather than a ban, because
// the same two actions are how honest mistakes get corrected. A mis-keyed
// sale at a busy counter is common, and a lone cashier on a night shift
// must be able to fix it without phoning the owner. So:
//
//   * a cashier may void only their OWN sale, only within a short window,
//     and only while the till is still open;
//   * a cashier may write off only a small quantity per adjustment.
//
// Anything outside those bounds needs a manager. The owner can tighten
// either switch to "manager approval always" from My Plan.
//
// Scope, mirroring assertManagerPermission: STAFF only. MANAGER, OWNER and
// ADMIN are never subject to these.
const STAFF_PERMISSION_DEFAULTS = {
  staff_can_void_sales: 1,
  staff_void_window_minutes: 15,
  staff_can_adjust_stock: 1,
  staff_adjustment_max_units: 5,
};

// Reads a staff-permission setting, defaulting when the column is absent
// (an older database) so behaviour never silently tightens on upgrade.
function staffSetting(settings, key) {
  const v = settings[key];
  return v === undefined || v === null ? STAFF_PERMISSION_DEFAULTS[key] : v;
}

// May this STAFF member void this sale? Returns an Error to return, or null.
//
// `sale` must carry served_by, created_at and till_session_id.
async function assertStaffCanVoid(db, user, sale) {
  if (!user || user.role !== 'STAFF') return null;
  const settings = await getClientSettings(db);

  if (!staffSetting(settings, 'staff_can_void_sales')) {
    return Object.assign(
      new Error('Voiding a sale needs a manager. Ask a manager to void this one for you.'),
      { status: 403, code: 'STAFF_VOID_REQUIRES_MANAGER' }
    );
  }
  // Their OWN sale only. Voiding a colleague's sale is not a mis-key
  // correction, it is reversing someone else's takings.
  if (sale.served_by && sale.served_by !== user.id) {
    return Object.assign(
      new Error('You can only void a sale you served yourself. Ask a manager to void this one.'),
      { status: 403, code: 'STAFF_VOID_NOT_OWN_SALE' }
    );
  }
  // Within the window. Measured from the sale, in the database, so a
  // device with a wrong clock cannot widen it.
  const windowMinutes = Number(staffSetting(settings, 'staff_void_window_minutes'));
  if (windowMinutes > 0 && sale.created_at) {
    const row = await db.prepare(
      "SELECT (julianday('now') - julianday(?)) * 24 * 60 AS age_minutes"
    ).bind(sale.created_at).first();
    const age = row && Number(row.age_minutes);
    if (Number.isFinite(age) && age > windowMinutes) {
      return Object.assign(
        new Error(
          `This sale is older than the ${windowMinutes}-minute window cashiers may correct within `
          + `(it was recorded ${Math.round(age)} minutes ago). Ask a manager to void it.`
        ),
        { status: 403, code: 'STAFF_VOID_WINDOW_EXPIRED' }
      );
    }
  }
  // Only while the till is still open. Once a till is closed the cash has
  // been counted and reconciled; reversing a sale behind that figure is
  // exactly what the window is meant to prevent.
  if (sale.till_session_id) {
    const till = await db.prepare('SELECT status FROM till_sessions WHERE id = ?').bind(sale.till_session_id).first();
    if (till && till.status !== 'OPEN') {
      return Object.assign(
        new Error('The till for this sale has already been closed and counted. Ask a manager to void it.'),
        { status: 403, code: 'STAFF_VOID_TILL_CLOSED' }
      );
    }
  }
  return null;
}

// May this STAFF member post this stock adjustment? Returns an Error, or null.
async function assertStaffCanAdjust(db, user, quantityChange) {
  if (!user || user.role !== 'STAFF') return null;
  const settings = await getClientSettings(db);

  if (!staffSetting(settings, 'staff_can_adjust_stock')) {
    return Object.assign(
      new Error('Writing off stock needs a manager. Ask a manager to record this adjustment.'),
      { status: 403, code: 'STAFF_ADJUST_REQUIRES_MANAGER' }
    );
  }
  const cap = Number(staffSetting(settings, 'staff_adjustment_max_units'));
  if (Math.abs(Number(quantityChange)) > cap) {
    return Object.assign(
      new Error(
        `Cashiers may adjust at most ${cap} unit${cap === 1 ? '' : 's'} at a time `
        + `(this one is ${Math.abs(Number(quantityChange))}). Ask a manager to record it.`
      ),
      { status: 403, code: 'STAFF_ADJUST_OVER_CAP' }
    );
  }
  return null;
}

module.exports = {
  MANAGER_PERMISSIONS,
  assertManagerPermission,
  STAFF_PERMISSION_DEFAULTS, staffSetting, assertStaffCanVoid, assertStaffCanAdjust,
  getClientSettings, contactLine, activeBranchCount, activeStaffCount, effectiveMaxBranches,
  assertCanAddBranch, assertCanAddStaff, assertFeatureEnabled, requireFeature, subscriptionGate,
  PlanLimitError, FeatureDisabledError, SubscriptionInactiveError,
};
