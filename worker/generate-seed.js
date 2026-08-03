// Generates seed.sql — a D1-compatible SQL seed file with real
// PBKDF2-hashed demo PINs (matching src/lib/crypto.js exactly, since
// D1 has no way to run arbitrary JS at seed time the way the Node
// deployment's seed.js can). Run once, then apply the output with:
//   npx wrangler d1 execute pharmaridge-db --local --file=./seed.sql
//   npx wrangler d1 execute pharmaridge-db --remote --file=./seed.sql
const fs = require('fs');
const path = require('path');
const { hashPin, uuid } = require('./src/lib/crypto');

async function main() {
  const managerId = uuid();
  const ownerId = uuid();
  const adminId = uuid();
  const lagosId = uuid();
  const minnaId = uuid();
  const lagosStaffId = uuid();
  const minnaStaffId = uuid();
  const panadolId = uuid();
  const tramadolId = uuid();
  const amoxilId = uuid();
  const emzolynId = uuid();
  const batchPanadolLagos = uuid();
  const batchTramadolLagos = uuid();
  const batchEmzolynLagos = uuid();
  const batchAmoxilMinna = uuid();

  const lagosMgrId = uuid();

  const managerHash = await hashPin('1234');
  const lagosMgrHash = await hashPin('1234');
  const ownerHash = await hashPin('1234');
  const adminHash = await hashPin('1234');
  const lagosStaffHash = await hashPin('1234');
  const minnaStaffHash = await hashPin('1234');

  const esc = (s) => String(s).replace(/'/g, "''");

  const sql = `
-- Demo seed data for PharmaRidge (Cloudflare D1 deployment).
-- Login (PIN 1234 for all):
--   manager      GENERAL MANAGER  — every branch
--   lagos.mgr    BRANCH MANAGER   — Lagos only (cannot see Minna at all)
--   owner        OWNER            — every branch, owns plan/VAT settings
--   admin        PharmaRidge support seat (Admin Portal)
--   lagos.staff / minna.staff     — one branch each
--
-- lagos.mgr exists so the Branch Manager role is REACHABLE on a fresh
-- install: without a seeded example, the branch-scoping feature could
-- only be exercised by first creating an account, and a first-time
-- evaluator would never see it.
-- PINs are pre-hashed with the SAME PBKDF2 parameters src/lib/crypto.js
-- uses at runtime, so they verify correctly through the real login flow.

INSERT INTO branches (id, name, address, phone, license_type, pcn_license_no, superintendent_pharmacist, latitude, longitude, geofence_radius_meters, pcn_license_expiry_date, superintendent_registration_expiry_date)
VALUES ('${lagosId}', 'GreenLife Pharmacy - Lagos (Ikeja)', '12 Allen Avenue, Ikeja, Lagos', '08012345678', 'PHARMACY', 'PCN/LAG/00123', 'Pharm. Ada Chukwu', 6.6018, 3.3515, 100, date('now','+45 days'), date('now','+3 years'));

INSERT INTO branches (id, name, address, phone, license_type, pcn_license_no, latitude, longitude, geofence_radius_meters, pcn_license_expiry_date)
VALUES ('${minnaId}', 'GreenLife Patent Medicine Store - Minna', '5 Bosso Road, Minna, Niger State', '08087654321', 'PPMV', 'PPMV/NG/00456', 9.6139, 6.5569, 100, date('now','+3 years'));

INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${managerId}', NULL, 'Chinedu Okafor', '08011111111', 'manager', '${esc(managerHash)}', 'MANAGER', 'Operations Lead');
INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${lagosMgrId}', '${lagosId}', 'Aisha Bello', '08055555555', 'lagos.mgr', '${esc(lagosMgrHash)}', 'MANAGER', 'Pharmacist-in-Charge');
INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${ownerId}', NULL, 'Grace Okonkwo', '08044444444', 'owner', '${esc(ownerHash)}', 'OWNER', 'Proprietor');
INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${adminId}', NULL, 'PharmaRidge Support', '08000000000', 'admin', '${esc(adminHash)}', 'ADMIN', 'Platform Administrator');
INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${lagosStaffId}', '${lagosId}', 'Bisi Adewale', '08022222222', 'lagos.staff', '${esc(lagosStaffHash)}', 'STAFF', 'Sales Attendant');
INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)
VALUES ('${minnaStaffId}', '${minnaId}', 'Musa Ibrahim', '08033333333', 'minna.staff', '${esc(minnaStaffHash)}', 'STAFF', 'Storekeeper');

-- Client plan/limits (single-tenant-per-client model — see
-- worker/src/lib/planLimits.js). schema.sql already inserts a default
-- row with id=1, so this UPDATEs it with demo values instead of
-- INSERTing a duplicate row. business_name is deliberately set (not
-- left NULL) so the demo showcases the white-label branding feature
-- actually working: the login screen/topbar show "GreenLife Pharmacy"
-- (the demo CLIENT's own trading name) with a small "Powered by
-- PharmaRidge" attribution — see server/routes/branding.js /
-- worker/src/routes/branding.js.
UPDATE client_settings SET
  max_branches = 20, max_staff = 30, subscription_status = 'ACTIVE', subscription_plan = 'Standard',
  subscription_renewal_date = date('now','+300 days'), attendance_module_enabled = 1, controlled_register_enabled = 1, multi_branch_enabled = 1,
  admin_contact_name = 'PharmaRidge Support', admin_contact_phone = '0800-000-0000', admin_contact_email = 'support@pharmaridge.example',
  business_name = 'GreenLife Pharmacy',
  notes = 'Demo/seed plan — adjust via Admin Portal.'
WHERE id = 1;

INSERT INTO products (id, name, generic_name, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level)
VALUES ('${panadolId}', 'Panadol Extra', 'Paracetamol 500mg + Caffeine', 'Analgesic', '04-1234', 0, 'OTC', 'tablet', 10, 10, 200);
INSERT INTO products (id, name, generic_name, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level)
VALUES ('${tramadolId}', 'Tramadol 100mg', 'Tramadol Hydrochloride', 'Analgesic (Controlled)', '04-5678', 1, 'POM', 'capsule', 10, 10, 50);
INSERT INTO products (id, name, generic_name, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level)
VALUES ('${amoxilId}', 'Amoxil 500mg', 'Amoxicillin 500mg', 'Antibiotic', '04-9012', 0, 'OTC', 'capsule', 10, 10, 150);
INSERT INTO products (id, name, generic_name, category, nafdac_reg_no, is_controlled, dispensing_type, base_unit, units_per_pack, packs_per_carton, reorder_level)
VALUES ('${emzolynId}', 'Emzolyn with Codeine', 'Codeine Linctus', 'Cough Syrup (Controlled)', '04-3456', 1, 'POM', 'bottle', 1, 24, 20);

INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, pack_price, carton_price, received_by)
VALUES ('${batchPanadolLagos}', '${lagosId}', '${panadolId}', 'PDX-24A', '2027-03-31', 5000, 5000, 15, 25, 240, 2300, '${lagosStaffId}');
INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, received_by)
VALUES ('${batchTramadolLagos}', '${lagosId}', '${tramadolId}', 'TRM-24D', date('now','+30 days'), 500, 500, 30, 60, '${lagosStaffId}');
INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, received_by)
VALUES ('${batchEmzolynLagos}', '${lagosId}', '${emzolynId}', 'EMZ-24E', date('now','+20 days'), 100, 100, 700, 1200, '${lagosStaffId}');
INSERT INTO stock_batches (id, branch_id, product_id, batch_no, expiry_date, quantity_received, quantity_remaining, cost_price_per_unit, selling_price_per_unit, pack_price, carton_price, received_by)
VALUES ('${batchAmoxilMinna}', '${minnaId}', '${amoxilId}', 'AMX-24B', '2026-11-30', 1200, 1200, 40, 55, 520, 5000, '${minnaStaffId}');
`;

  fs.writeFileSync(path.join(__dirname, 'seed.sql'), sql.trim() + '\n');
  console.log('[seed] Wrote worker/seed.sql');
  console.log('[seed] Apply with:');
  console.log('  npx wrangler d1 execute pharmaridge-db --local --file=./seed.sql   (local dev)');
  console.log('  npx wrangler d1 execute pharmaridge-db --remote --file=./seed.sql  (production — run ONCE)');
}

main();
