// Rebuilds the PUBLIC LIVE SAMPLE data set.
//
// This is deliberately different from generate-seed.js. The public sample
// starts with ONE known account only: the PharmaRidge ADMIN. A prospect then
// experiences the real first-run flow — Admin creates an Owner, Owner creates
// branches/staff, then receives stock. No real pharmacy data belongs here.
//
// The NAFDAC reference catalog remains intact and is copied into the ordinary
// products table with zero stock, so the newly-created owner can immediately
// search/select any approved product while receiving their first delivery.
const fs = require('fs');
const path = require('path');
const { hashPin, uuid } = require('./src/lib/crypto');

async function main() {
  const adminId = uuid();
  const adminPinHash = await hashPin('1234');
  const esc = (value) => String(value).replace(/'/g, "''");

  // Child-first deletion order is intentional: D1 enforces foreign keys.
  // System/reference data (nafdac_catalog, gl_accounts, wht_rates and the
  // one client_settings row) survives; all operational/sample state resets.
  const sql = `
-- PUBLIC LIVE SAMPLE RESET — generated, never edit by hand.
-- Admin login after reset: admin / 1234

DELETE FROM controlled_substance_register;
DELETE FROM prescriptions;
DELETE FROM sale_payments;
DELETE FROM sale_items;
DELETE FROM sales;
DELETE FROM debtor_ledger;
DELETE FROM change_owed;
DELETE FROM branch_safe_ledger;
DELETE FROM creditor_ledger;
DELETE FROM expenses;
DELETE FROM wht_entries;
DELETE FROM gl_journal_lines;
DELETE FROM gl_journal_entries;
DELETE FROM stocktake_lines;
DELETE FROM stocktake_sessions;
DELETE FROM stock_adjustments;
DELETE FROM stock_transfers;
DELETE FROM staff_attendance;
DELETE FROM till_sessions;
DELETE FROM stock_batches;
DELETE FROM purchase_order_receipts;
DELETE FROM purchase_order_items;
DELETE FROM purchase_orders;
DELETE FROM product_price_overrides;
DELETE FROM customers;
DELETE FROM suppliers;
DELETE FROM branch_devices;
DELETE FROM pending_user_transfers;
DELETE FROM user_assignment_history;
DELETE FROM idempotency_keys;
DELETE FROM user_sessions;
DELETE FROM login_attempts;
DELETE FROM sync_conflicts;
DELETE FROM sync_change_log;
DELETE FROM branch_sync_status;
-- Owner data-management audit rows contain no business records, but the
-- shared public sample is deliberately reset to a blank demonstration state.
DELETE FROM data_cleanup_log;

-- Clear user/branch/product business state. NAFDAC catalog remains as the
-- reference source; products below are rebuilt from every active catalog row.
UPDATE client_settings SET updated_by = NULL WHERE id = 1;
DELETE FROM users;
DELETE FROM branches;
DELETE FROM products;

INSERT INTO users (id, branch_id, full_name, username, pin_hash, role, job_title)
VALUES ('${adminId}', NULL, 'PharmaRidge Sample Administrator', 'admin', '${esc(adminPinHash)}', 'ADMIN', 'Live Sample Administrator');

-- Give prospects enough capacity to create an Owner, branches and staff while
-- testing. These are sample limits only; client deployments set their own.
UPDATE client_settings SET
  max_branches = 25,
  max_staff = 100,
  subscription_status = 'ACTIVE',
  subscription_plan = 'Live Sample',
  subscription_renewal_date = date('now', '+365 days'),
  attendance_module_enabled = 1,
  controlled_register_enabled = 1,
  multi_branch_enabled = 1,
  business_name = 'PharmaRidge Live Sample',
  logo_data_url = NULL,
  notes = 'Shared public demonstration environment. Resettable; do not store real data.',
  data_reset_at = NULL,
  updated_by = '${adminId}',
  updated_at = datetime('now')
WHERE id = 1;

-- No stock is created. Every approved NAFDAC item is however available as a
-- normal product record, ready for a new owner to receive into stock.
INSERT INTO products (
  id, name, generic_name, category, nafdac_reg_no, is_controlled,
  dispensing_type, base_unit, units_per_pack, packs_per_carton,
  reorder_level, nafdac_catalog_id
)
SELECT
  lower(hex(randomblob(16))),
  product_name,
  ingredient_name,
  category,
  nafdac_reg_no,
  is_controlled,
  dispensing_type,
  base_unit,
  1,
  NULL,
  0,
  id
FROM nafdac_catalog;
`;

  const output = path.join(__dirname, 'live-sample-reset.sql');
  fs.writeFileSync(output, sql.trim() + '\n');
  console.log(`[live-sample] wrote ${output}`);
  console.log('[live-sample] initial login: admin / 1234');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
