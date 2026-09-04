const { Hono } = require('hono');
const { authRequired, adminOnly } = require('../lib/auth');
const { getClientSettings, activeBranchCount, activeStaffCount, effectiveMaxBranches } = require('../lib/planLimits');
const { assertValidLogoDataUrl } = require('../lib/branding');
const { readJsonBody } = require('../lib/http');

const admin = new Hono();
admin.use('*', authRequired);
admin.use('*', adminOnly);

const EDITABLE_FIELDS = [
  'max_branches', 'max_staff',
  'subscription_status', 'subscription_plan', 'subscription_renewal_date',
  'attendance_module_enabled', 'controlled_register_enabled', 'multi_branch_enabled',
  'admin_contact_name', 'admin_contact_phone', 'admin_contact_email',
  'business_name', 'logo_data_url', 'notes',
];
const BOOLEAN_FIELDS = ['attendance_module_enabled', 'controlled_register_enabled', 'multi_branch_enabled'];

// Columns on client_settings that exist but are deliberately NOT editable
// from the Admin Portal, because they belong to the PHARMACY rather than
// to PharmaRidge: its tax position, and what it permits its own managers
// to do. The OWNER changes these on My Plan / Settings. Naming them
// explicitly lets the API explain WHY a request was refused instead of
// lumping them in with a typo'd field name.
const CLIENT_OWNED_FIELDS = [
  'vat_enabled', 'vat_rate_percent',
  'managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices',
];
const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'];

async function usageSnapshot(db, settings) {
  return {
    branches_used: await activeBranchCount(db),
    staff_used: await activeStaffCount(db),
    effective_max_branches: effectiveMaxBranches(settings),
  };
}

// A plan may never be lowered below resources that are still active. Without
// this guard an Admin could save “2 branches / 2 staff” against 3 live shops
// and 4 people, leaving the client on a plan it cannot actually comply with.
// The refusal is atomic: no requested plan field is written until the Owner
// first closes/deactivates enough resources (or chooses a higher limit).
async function downgradeConflict(db, settings, body) {
  const proposedMultiBranch = body.multi_branch_enabled === undefined
    ? !!settings.multi_branch_enabled : !!body.multi_branch_enabled;
  const proposedBranches = body.max_branches === undefined ? settings.max_branches : body.max_branches;
  const proposedStaff = body.max_staff === undefined ? settings.max_staff : body.max_staff;
  const effectiveBranches = proposedMultiBranch ? proposedBranches : 1;
  const [branchesUsed, staffUsed] = await Promise.all([activeBranchCount(db), activeStaffCount(db)]);
  const reductions = [];
  if (branchesUsed > effectiveBranches) {
    reductions.push({ resource: 'active branch', used: branchesUsed, requested: effectiveBranches, reduce_by: branchesUsed - effectiveBranches,
      action: `Close or deactivate at least ${branchesUsed - effectiveBranches} active branch${branchesUsed - effectiveBranches === 1 ? '' : 'es'} before lowering this limit.` });
  }
  if (staffUsed > proposedStaff) {
    reductions.push({ resource: 'active staff account', used: staffUsed, requested: proposedStaff, reduce_by: staffUsed - proposedStaff,
      action: `Deactivate at least ${staffUsed - proposedStaff} active Staff, Manager or Owner account${staffUsed - proposedStaff === 1 ? '' : 's'} before lowering this limit.` });
  }
  if (!reductions.length) return null;
  return {
    error: `Cannot lower this plan yet: active usage is above the requested allowance. ${reductions.map((r) => r.action).join(' ')}`,
    code: 'PLAN_DOWNGRADE_REQUIRES_REDUCTION',
    current_usage: { branches: branchesUsed, staff: staffUsed },
    requested_limits: { max_branches: proposedBranches, effective_max_branches: effectiveBranches, max_staff: proposedStaff },
    reductions,
  };
}

admin.get('/settings', async (c) => {
  const db = c.env.DB;
  const settings = await getClientSettings(db);
  return c.json({ ...settings, usage: await usageSnapshot(db, settings) });
});

admin.put('/settings', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJsonBody(c);
  const updates = EDITABLE_FIELDS.filter((f) => body[f] !== undefined);

  // SILENT-SUCCESS FIX (found during an ADMIN/OWNER alignment audit).
  //
  // Anything not in EDITABLE_FIELDS is dropped — correctly, because the
  // Admin Portal is the VENDOR's console and must not reach the client's
  // own settings (vat_enabled, vat_rate_percent and the three
  // managers_can_* permissions are deliberately absent from that list:
  // they belong to the pharmacy, not to PharmaRidge support).
  //
  // But dropping them SILENTLY and returning 200 with the unchanged
  // settings told the caller the change had applied. Reproduced live:
  // PUT {"vat_rate_percent":50} returned 200 and a full settings payload,
  // while the rate stayed where it was. A support engineer would believe
  // they had changed a client's tax rate; a typo in a field name would
  // look like a successful save; and the same shape would hide a real
  // front-end/back-end contract drift after any future rename.
  //
  // Distinguish the three cases instead of collapsing them into one 200:
  //   * nothing sent at all            -> 200, a plain read (unchanged)
  //   * only unrecognised fields sent  -> 400, naming them
  //   * a mix                          -> 400, rather than applying half
  //     of what was asked for without saying so
  const RESPONSE_ONLY = new Set(['id', 'usage', 'updated_at', 'updated_by']);
  const unknown = Object.keys(body).filter(
    (k) => !EDITABLE_FIELDS.includes(k) && !RESPONSE_ONLY.has(k)
  );
  if (unknown.length > 0) {
    const clientOwned = unknown.filter((k) => CLIENT_OWNED_FIELDS.includes(k));
    return c.json({
      error: clientOwned.length
        ? `These settings belong to the pharmacy, not to the Admin Portal, and cannot be changed from here: ${clientOwned.join(', ')}. The account OWNER changes them on their own Settings / My Plan screen.`
        : `Unrecognised setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Nothing was changed.`,
      code: clientOwned.length ? 'CLIENT_OWNED_SETTING' : 'UNKNOWN_SETTING',
      rejected: unknown,
      editable: EDITABLE_FIELDS,
    }, 400);
  }

  if (updates.length === 0) {
    const settings = await getClientSettings(db);
    return c.json({ ...settings, usage: await usageSnapshot(db, settings) });
  }

  if (body.subscription_status !== undefined && !SUBSCRIPTION_STATUSES.includes(body.subscription_status)) {
    return c.json({ error: `subscription_status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}` }, 400);
  }
  if (body.max_branches !== undefined && (!Number.isInteger(body.max_branches) || body.max_branches < 1)) {
    return c.json({ error: 'max_branches must be a positive integer' }, 400);
  }
  if (body.max_staff !== undefined && (!Number.isInteger(body.max_staff) || body.max_staff < 1)) {
    return c.json({ error: 'max_staff must be a positive integer' }, 400);
  }
  if (body.business_name !== undefined && body.business_name !== null) {
    const name = String(body.business_name).trim();
    if (name.length === 0) return c.json({ error: 'business_name cannot be blank — pass null to clear it back to the default.' }, 400);
    if (name.length > 80) return c.json({ error: 'business_name must be 80 characters or fewer.' }, 400);
  }
  if (body.logo_data_url !== undefined && body.logo_data_url !== null) {
    try {
      assertValidLogoDataUrl(body.logo_data_url);
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  }

  const currentSettings = await getClientSettings(db);
  const conflict = await downgradeConflict(db, currentSettings, body);
  if (conflict) return c.json(conflict, 409);

  const sets = [];
  const vals = [];
  for (const f of updates) {
    sets.push(`${f} = ?`);
    vals.push(BOOLEAN_FIELDS.includes(f) ? (body[f] ? 1 : 0) : body[f]);
  }
  sets.push("updated_at = datetime('now')", 'updated_by = ?');
  vals.push(user.id);
  await db.prepare(`UPDATE client_settings SET ${sets.join(', ')} WHERE id = 1`).bind(...vals).run();

  const settings = await getClientSettings(db);
  return c.json({ ...settings, usage: await usageSnapshot(db, settings) });
});

module.exports = admin;
