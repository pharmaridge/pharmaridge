
-- =====================================================================
-- MULTI-BRANCH PHARMACY / PATENT MEDICINE STORE MANAGEMENT SYSTEM
-- SQLite schema v2 — offline-first PWA, production-hardened
-- =====================================================================
--
-- CHANGELOG vs v1 (why each change exists):
--
--  [SYNC]   Every mutable table now carries updated_at + is_deleted
--           (soft delete) so offline branches can merge changes with
--           last-write-wins conflict resolution and deletions survive
--           a sync round-trip instead of silently vanishing.
--  [SYNC]   branch_sync_status + sync_change_log give the manager a
--           live, queryable view of each branch's sync health
--           (last push/pull, pending local changes, staleness).
--  [RX]     prescriptions table links a sale to prescriber + patient
--           details for POM (prescription-only-medicine) dispensing.
--  [RX]     products.dispensing_type (OTC/POM) drives whether the POS
--           requires a prescription before completing the sale.
--  [CTRL]   controlled_substance_register is an append-only, hash-
--           chained (tamper-evident) log of every controlled-drug
--           dispense: buyer identity, phone/ID, qty, dispenser.
--  [UOM]    sale_items.unit_type (BASE_UNIT/PACK/CARTON) + a
--           products-level conversion table let POS sell/discount at
--           carton or pack level while stock still decrements in
--           base units under the hood.
--  [STOCKTAKE] stocktake_sessions / stocktake_lines model a full
--           physical-count cycle (freeze system qty -> record counted
--           qty -> compute variance -> auto-generate stock_adjustments)
--           instead of jumping straight to ad-hoc adjustments.
--  [CASH]   sale_payments now records cash_tendered/change_given so
--           till reconciliation isn't thrown off by customers paying
--           with a bigger note than the total.
--  [PRICE]  product_price_overrides gives each branch its own default
--           selling price for a product (Lagos vs Minna pricing),
--           used to pre-fill price when a branch receives a new batch;
--           the batch's own selling_price_per_unit remains the actual
--           price of record for that stock (already branch-scoped).
--  [ATTENDANCE] staff_attendance records clock-in/out with an optional
--           GPS geofence check against branches.latitude/longitude:
--           on-site vs off-site is computed server-side (Haversine
--           distance) and stored per record, never silently blocking a
--           clock-in — an off-site/no-location attempt is flagged for
--           manager review/override rather than rejected outright,
--           since GPS accuracy and permissions vary a lot by device.
--  [LICENSE] branches.pcn_license_expiry_date /
--           superintendent_registration_expiry_date +
--           v_license_expiry_alerts give managers advance warning
--           before a premises licence or superintendent registration
--           lapses.
--  [AUDIT]  v_void_audit_by_user surfaces each staff member's void
--           rate as a lightweight shrinkage/fraud signal.
--  [TIMEZONE] v_daily_sales_by_branch / v_daily_sales_total bucket by
--           West Africa Time (UTC+1), not raw UTC — see migration 009
--           for the live-verified bug this fixes (a sale made between
--           00:00-00:59 Lagos time was bucketed under the previous
--           calendar day in every day-based report).
--
-- The app must run this once per connection:
--   PRAGMA foreign_keys = ON;
-- =====================================================================

-- NOTE (Cloudflare D1): the original standalone `PRAGMA foreign_keys = ON;`
-- statement is commented out below. D1 ALWAYS enforces foreign keys and runs
-- every statement inside an implicit transaction, so this pragma cannot be set
-- by user SQL — leaving it in can abort `wrangler d1 migrations apply`.
-- Behaviour is unchanged: FK enforcement is on by default on D1.
-- If you ever run this schema against plain SQLite (better-sqlite3 / sqlite3
-- CLI), re-enable the line below, or set the pragma per-connection in code.
-- PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- BRANCHES
-- ---------------------------------------------------------------------
CREATE TABLE branches (
    id                        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name                      TEXT NOT NULL,
    address                   TEXT,
    phone                     TEXT,
    license_type              TEXT NOT NULL CHECK (license_type IN ('PPMV','PHARMACY')) DEFAULT 'PHARMACY',
    pcn_license_no            TEXT,
    superintendent_pharmacist TEXT,
    -- Geofencing (attendance / anti-buddy-punching):
    latitude                  REAL,              -- branch premises GPS latitude; NULL = geofence not configured yet
    longitude                 REAL,              -- branch premises GPS longitude
    geofence_radius_meters    INTEGER NOT NULL DEFAULT 100,  -- how far from (latitude, longitude) counts as "on site"
    -- Attendance verification mode — chosen by the MANAGER per branch,
    -- since different branches genuinely need different methods:
    --   GEOLOCATION     — mobile/handheld staff; clock-in/out is
    --                     classified against the geofence above
    --                     (ON_SITE/OFF_SITE/NO_LOCATION), never blocking.
    --   REGISTERED_DEVICE — branches with one or more fixed
    --                     till/back-office laptops; clock-in/out is
    --                     classified by whether the browser's own
    --                     persistent device id (see branch_devices
    --                     below) matches a laptop the manager has
    --                     actually registered for THIS branch, never
    --                     blocking either — an unrecognized device is
    --                     flagged for manager review exactly the same
    --                     way an off-site GPS reading is.
    -- Both modes are equally "best-effort signal, not a hard gate" —
    -- consistent with the rest of this attendance feature.
    attendance_mode           TEXT NOT NULL CHECK (attendance_mode IN ('GEOLOCATION','REGISTERED_DEVICE')) DEFAULT 'GEOLOCATION',
    -- Regulatory license renewal tracking:
    pcn_license_expiry_date          TEXT,       -- ISO date; when the premises PCN/PPMV licence must be renewed
    superintendent_registration_expiry_date TEXT, -- ISO date; when the superintendent pharmacist's PCN registration expires
    is_active                 INTEGER NOT NULL DEFAULT 1,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- BRANCH DEVICES  (registered laptops/terminals for REGISTERED_DEVICE
-- attendance mode)
-- ---------------------------------------------------------------------
-- A "device" here is NOT a hardware serial number — no web browser can
-- read one (blocked for privacy by every modern browser, including on
-- native-feeling PWA installs), so no web-based system, this one
-- included, can identify a laptop by its real hardware ID. What CAN be
-- done, and what this table stores, is a random identifier generated
-- once client-side and persisted in that browser's localStorage (see
-- public/js/deviceId.js) — this uniquely identifies "this browser
-- profile on this laptop" for as long as no one clears site data or
-- switches browsers/profiles on that machine, which is the same
-- practical guarantee commercial POS terminal-locking features rely on.
-- A branch can have one, two, or many registered devices; the manager
-- can register a new one or revoke (soft-delete) an existing one at any
-- time as circumstances change (a laptop is replaced, lost, or reissued).
CREATE TABLE branch_devices (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    device_id     TEXT NOT NULL,       -- the browser-generated persistent id
    label         TEXT,                -- manager-assigned friendly name, e.g. "Front counter laptop"
    registered_by TEXT NOT NULL REFERENCES users(id),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_by    TEXT REFERENCES users(id),
    revoked_at    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
-- A given device_id may only be actively registered to ONE branch at a
-- time (a partial unique index, same pattern as the till/stocktake/
-- attendance "one open per X" guards elsewhere in this schema) — a
-- laptop physically belongs to one location, so if it needs reassigning
-- the old registration must be revoked first, which keeps device
-- ownership auditable rather than ambiguous.
CREATE UNIQUE INDEX idx_branch_devices_active_device ON branch_devices(device_id) WHERE is_deleted = 0 AND revoked_at IS NULL;
CREATE INDEX idx_branch_devices_branch ON branch_devices(branch_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- USERS  (MANAGER sees everything, STAFF is scoped to one branch)
-- ---------------------------------------------------------------------
-- Role hierarchy (highest to lowest privilege):
--   ADMIN   — the software vendor/platform administrator ("Admin
--             Portal"). Exactly one deployment-wide seat (normally 1-2
--             people at PharmaRidge, the company selling this
--             software), NOT part of the pharmacy client's own staff.
--             Sets/enforces this client's plan limits (max branches,
--             max staff, feature toggles, subscription status) and this
--             deployment's branding (business name + logo shown
--             throughout the app) via /api/admin/*. Never counted
--             against the client's own staff limit, always bypasses the
--             subscription gate (so the vendor can never be locked out
--             of their own client's instance), and is hidden from the
--             ordinary Users & Branches screen the client's own
--             MANAGER/OWNER staff use to manage their team.
--   OWNER   — the pharmacy proprietor/business owner. Full operational
--             access identical to MANAGER (every branch, all reports),
--             PLUS visibility into their own subscription/plan limits
--             (branches used vs allowed, staff used vs allowed,
--             subscription status/renewal, which features are enabled)
--             via /api/dashboard/plan. Distinct from MANAGER mainly so
--             a client can have day-to-day managers who run operations
--             without necessarily being the person accountable for the
--             commercial relationship with the vendor.
--   MANAGER — day-to-day operations admin. Presented to users under one
--             of two job titles, decided ENTIRELY by whether the account
--             carries a branch_id:
--
--               General Manager  branch_id IS NULL  — sees and runs every
--                                                    branch (the default,
--                                                    and the only shape
--                                                    that existed in v2)
--               Branch Manager   branch_id IS SET   — full manager
--                                                    authority over
--                                                    exactly ONE branch,
--                                                    and cannot see any
--                                                    other branch's cash,
--                                                    stock, staff or
--                                                    reports
--
--             DELIBERATELY ONE STORED ROLE, NOT TWO. branch_id is already
--             the single source of truth for every authorisation decision
--             in the codebase (see pinnedBranchIdOf() in
--             worker/src/lib/auth.js — resolveScopedBranchId,
--             resolveMutationBranchId and assertBranchAccess all route
--             through it). A separate BRANCH_MANAGER role value would be a
--             SECOND fact encoding the same thing, and the two could then
--             disagree: a BRANCH_MANAGER row with a NULL branch_id, or a
--             MANAGER row carrying one, would both be unrepresentable
--             nonsense the schema would have to police. Deriving the title
--             instead (roleLabel() in lib/auth.js) makes contradiction
--             impossible by construction, and makes promotion a one-field
--             change — clear branch_id and a Branch Manager becomes a
--             General Manager, with no role migration and no re-issued
--             tokens.
--   STAFF   — scoped to exactly one branch (POS, till, attendance, etc).
CREATE TABLE users (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id   TEXT REFERENCES branches(id),
    full_name   TEXT NOT NULL,
    phone       TEXT,
    username    TEXT NOT NULL UNIQUE,
    pin_hash    TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('ADMIN','OWNER','MANAGER','STAFF')),
    job_title   TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    -- BUG 49. Timestamp of the last CREDENTIAL change (PIN reset). Any JWT
    -- issued before this instant is refused by authRequired().
    --
    -- A PIN reset is the pharmacy's emergency lever: a cashier's PIN is
    -- shoulder-surfed, the manager resets it, and the old PIN stops
    -- working immediately. But the SESSION opened with the old PIN kept
    -- full access until natural expiry — live-reproduced: after a reset
    -- the old PIN returned 401 while the old TOKEN still returned 200.
    -- Whoever held that session could keep selling, voiding and taking
    -- cash for the rest of the day, which is exactly what the reset was
    -- meant to stop.
    --
    -- Deliberately a SEPARATE column rather than reusing updated_at:
    -- updated_at bumps for innocuous edits (a corrected name, a new job
    -- title, a phone number), and logging someone out mid-sale because a
    -- manager fixed a typo in their surname would be its own defect.
    -- Only a credential change belongs here.
    credentials_changed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    -- ADMIN (the vendor's support seat) and OWNER (the proprietor) are
    -- never branch employees, so they must not carry a branch. STAFF must
    -- always have one. MANAGER may go either way — that is precisely what
    -- distinguishes a General Manager from a Branch Manager.
    CHECK (
        (role IN ('ADMIN','OWNER') AND branch_id IS NULL) OR
        (role = 'MANAGER')                                OR
        (role = 'STAFF'            AND branch_id IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------
-- USER ASSIGNMENT HISTORY  (BUG 75 — transfers and promotions)
-- ---------------------------------------------------------------------
-- Until this table existed, PharmaRidge simply REFUSED to move a person:
-- PUT /users/:id with a new role or branch answered 400 ROLE_NOT_EDITABLE /
-- BRANCH_NOT_EDITABLE and told the operator to "deactivate this account and
-- create a new one". That instruction produced a genuinely broken outcome —
-- `users.username` is UNIQUE table-wide and both delete and deactivate are
-- SOFT, so the old username stays reserved forever and the operator was
-- forced to invent a second identity ("lagos.staff.minna") for one human.
-- Verified consequences of that split: two rows in the user list for one
-- person, and attendance/payroll grouped by user_id reporting them as two
-- employees.
--
-- The refusal's stated justification was ALSO factually wrong, and that was
-- proven by execution rather than argued: every historical table carries its
-- OWN branch_id (sales, till_sessions, staff_attendance, expenses,
-- stock_adjustments all confirmed via pragma_table_info). Forcing a user from
-- Lagos to Minna at SQL level and re-reading their earlier Lagos sale showed
-- branch_id UNCHANGED (still Lagos), served_by_name unchanged, and the trial
-- balance still balanced to the kobo. History is anchored to each row, never
-- derived from the user's current branch — so moving a person cannot rewrite
-- it. The schema CHECK on users already rejects every invalid role/branch
-- combination (verified: role='STAFF' with a NULL branch_id is refused by
-- SQLITE_CONSTRAINT_CHECK), so a move cannot create a nonsensical account.
--
-- What was genuinely missing was not safety but ACCOUNTABILITY: a role or
-- branch change is a change in what a person is trusted to do with money, and
-- it left no trace whatsoever. This table is that trace. It is append-only by
-- construction — there is no UPDATE or DELETE path in the codebase — so the
-- sequence of assignments a person held is reconstructable forever, which is
-- exactly what a proprietor needs when asking "who authorised this cashier to
-- approve expenses in March?".
--
-- Client decision (recorded): a promotion NEVER restates existing records.
-- Old sales, shifts and tills keep the branch and authority they were made
-- under, and this dated history is what lets a reader tell which records
-- predate a promotion.
CREATE TABLE user_assignment_history (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id       TEXT NOT NULL REFERENCES users(id),
    -- Both sides recorded in full so the row is readable on its own, without
    -- having to replay every earlier row to work out where the person was.
    from_role     TEXT NOT NULL CHECK (from_role IN ('ADMIN','OWNER','MANAGER','STAFF')),
    from_branch_id TEXT REFERENCES branches(id),
    to_role       TEXT NOT NULL CHECK (to_role IN ('OWNER','MANAGER','STAFF')),
    to_branch_id  TEXT REFERENCES branches(id),
    -- Denormalised labels: a branch can be renamed, and the history must keep
    -- reading correctly as it was at the time.
    from_role_label TEXT,
    to_role_label   TEXT,
    reason        TEXT NOT NULL,
    changed_by    TEXT NOT NULL REFERENCES users(id),
    changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_assignment_history_user ON user_assignment_history(user_id, changed_at);

-- ---------------------------------------------------------------------
-- PENDING USER TRANSFERS  (BUG 108 — a transfer applied under someone's feet)
-- ---------------------------------------------------------------------
-- A stock transfer has always had two halves: one branch sends, the other
-- CONFIRMS receipt. Moving a PERSON had only one half — the manager pressed
-- the button and the change was live instantly.
--
-- That is the same offline hazard as Bug 107, applied to people. A cashier
-- working offline at Ikeja is reassigned to Surulere mid-shift; their queued
-- sales, their open till and their clock-in all belong to a branch they are
-- no longer attached to, and they find out only when the device reconnects
-- and the work is refused.
--
-- So a transfer is now STAGED here and applied only when the person
-- themselves confirms it — they are the one who knows whether they have
-- finished at the old counter. Until then nothing about their access changes
-- and everything they do offline stays valid.
--
-- ESCAPE HATCH: an OWNER or General Manager may FORCE a staged transfer
-- through (someone has left, lost their phone, or simply refuses). Recorded
-- as forced, with who forced it, so "they confirmed" and "it was imposed"
-- are never confused in the history.
CREATE TABLE pending_user_transfers (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id        TEXT NOT NULL REFERENCES users(id),
    from_role      TEXT NOT NULL,
    from_branch_id TEXT REFERENCES branches(id),
    to_role        TEXT NOT NULL CHECK (to_role IN ('OWNER','MANAGER','STAFF')),
    to_branch_id   TEXT REFERENCES branches(id),
    reason         TEXT NOT NULL,
    requested_by   TEXT NOT NULL REFERENCES users(id),
    requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
    status         TEXT NOT NULL CHECK (status IN ('AWAITING_CONFIRMATION','CONFIRMED','DECLINED','CANCELLED','FORCED'))
                     DEFAULT 'AWAITING_CONFIRMATION',
    resolved_at    TEXT,
    resolved_by    TEXT REFERENCES users(id),
    decline_reason TEXT,
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
-- One open request per person: a second manager staging a different move for
-- the same cashier while the first is unanswered is how you get two truths.
CREATE UNIQUE INDEX idx_pending_user_transfer_open
    ON pending_user_transfers(user_id) WHERE status = 'AWAITING_CONFIRMATION' AND is_deleted = 0;
CREATE INDEX idx_pending_user_transfer_status ON pending_user_transfers(status, requested_at);

-- ---------------------------------------------------------------------
-- CLIENT SETTINGS  (single-row table — this deployment's plan/limits
-- AND branding)
-- ---------------------------------------------------------------------
-- Single-tenant-per-client deployment model: each paying pharmacy gets
-- its own isolated instance/database, so "the client's plan" is exactly
-- one row here, not a multi-tenant table keyed by a tenant id. The
-- ADMIN (platform vendor, via the Admin Portal) sets these values as
-- part of the commercial relationship with the client; the OWNER can
-- see (but never edit) their own usage against these limits via
-- /api/dashboard/plan. `id` is fixed to 1 by convention/CHECK so the
-- table can never accidentally grow a second row.
--
-- business_name / logo_data_url let the ADMIN white-label this
-- deployment to the specific pharmacy client's own business name/logo
-- (shown in the topbar, login screen, browser tab title, and PWA
-- install manifest) instead of the generic "PharmaRidge" software
-- product name — see /api/branding (public, unauthenticated — the
-- login screen needs it before anyone signs in) and
-- /api/branding/logo (serves the decoded logo image bytes with the
-- correct Content-Type, since browsers need a real same-origin image
-- URL for <img>/manifest icons, not a giant data: URI everywhere).
-- logo_data_url is validated server-side on every write (real image
-- magic-byte sniff, not just the declared MIME type; hard 500 KB cap)
-- — see assertValidLogoDataUrl() in server/lib/branding.js /
-- worker/src/lib/branding.js.
CREATE TABLE client_settings (
    id                              INTEGER PRIMARY KEY CHECK (id = 1),
    max_branches                    INTEGER NOT NULL DEFAULT 5,
    max_staff                       INTEGER NOT NULL DEFAULT 25,
    subscription_status             TEXT NOT NULL CHECK (subscription_status IN ('TRIAL','ACTIVE','SUSPENDED','EXPIRED')) DEFAULT 'ACTIVE',
    subscription_plan               TEXT NOT NULL DEFAULT 'Standard',
    subscription_renewal_date       TEXT,
    attendance_module_enabled       INTEGER NOT NULL DEFAULT 1,
    controlled_register_enabled     INTEGER NOT NULL DEFAULT 1,
    multi_branch_enabled            INTEGER NOT NULL DEFAULT 1,
    -- VAT (Value Added Tax) tracking — UNLIKE the three feature toggles
    -- above (attendance/controlled-register/multi-branch, all vendor
    -- plan-limit features set by the ADMIN via the Admin Portal), VAT
    -- registration is the CLIENT's OWN tax-compliance status with FIRS
    -- (Nigeria's Federal Inland Revenue Service), not something the
    -- software vendor controls — so this is deliberately editable by
    -- the pharmacy's own OWNER (see PUT /api/settings/vat, gated by
    -- ownerOnly rather than adminOnly), with the ADMIN retaining the
    -- ability to see/override it too via the Admin Portal for support
    -- purposes. OFF by default: a client only starts collecting VAT
    -- once they explicitly register for it and turn this on — this
    -- schema must never silently start charging tax nobody asked for.
    -- 7.5% is Nigeria's current FIRS standard VAT rate (verified via
    -- web_search, not assumed from training data) and is the default
    -- vat_rate_percent a client sees when they first enable it, but the
    -- OWNER may adjust it if the statutory rate ever changes.
    -- VAT-INCLUSIVE PRICING MODEL (explicit client decision — see
    -- README.md's VAT write-up for the full rationale): enabling VAT
    -- does NOT increase what a customer pays at checkout — matching how
    -- Nigerian retail shelf prices already work. sales.total is
    -- unchanged by this toggle; VAT is instead EXTRACTED from the
    -- existing total for reporting/remittance bookkeeping only (see
    -- glService.postSale()'s VAT split and sales.vat_amount below).
    vat_enabled                     INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent                REAL NOT NULL DEFAULT 7.5,
    -- OWNER-CONTROLLED MANAGER PERMISSIONS. Distinct from the
    -- vendor-owned plan/feature columns above: these are the CLIENT's own
    -- governance switches over what their managers may do, changed by the
    -- OWNER via My Plan (PUT /api/settings/manager-permissions) and
    -- enforced server-side by assertManagerPermission() in
    -- lib/planLimits.js. Default 1 so behaviour is unchanged until an
    -- owner deliberately restricts something. OWNER and ADMIN are never
    -- restricted by these — a switch that could lock the proprietor out
    -- of their own books would be a footgun.
    managers_can_void_sales         INTEGER NOT NULL DEFAULT 1,
    managers_can_approve_expenses   INTEGER NOT NULL DEFAULT 1,
    managers_can_edit_prices        INTEGER NOT NULL DEFAULT 1,

    -- OWNER-CONTROLLED *STAFF* PERMISSIONS (client decision after a live
    -- audit demonstration). The three switches above govern MANAGERs; these
    -- two govern plain cashiers, and they exist because a cashier holding
    -- both of these powers can run the two classic retail-theft patterns
    -- unaided:
    --
    --   VOID:       sell for cash, void the sale, keep the note. The books
    --               show no sale, the stock is already gone.
    --   WRITE-OFF:  take the goods, record them as DAMAGE. Shrinkage looks
    --               like breakage.
    --
    -- Both were reproduced live against a real Worker before these columns
    -- existed: a STAFF token voided its own completed sale and posted a
    -- -5 DAMAGE adjustment, with no gate of any kind.
    --
    -- Deliberately NOT a flat ban. A mis-keyed sale at a busy counter is
    -- common and a lone cashier on a night shift must be able to correct
    -- it, so the default is a NARROW allowance rather than off:
    --
    --   staff_can_void_sales      1 = a cashier may void their OWN sale,
    --                                 within staff_void_window_minutes,
    --                                 while the till is still open
    --                             0 = manager approval required
    --   staff_can_adjust_stock    1 = a cashier may write off up to
    --                                 staff_adjustment_max_units per
    --                                 adjustment
    --                             0 = manager approval required
    --
    -- The window and the cap are what make the allowance safe: they cover
    -- "I just rang that up wrong" and "I dropped a bottle" without covering
    -- "I am reversing yesterday's takings" or "a whole carton was damaged".
    staff_can_void_sales            INTEGER NOT NULL DEFAULT 1,
    staff_void_window_minutes       INTEGER NOT NULL DEFAULT 15 CHECK (staff_void_window_minutes >= 0),
    staff_can_adjust_stock          INTEGER NOT NULL DEFAULT 1,
    staff_adjustment_max_units      INTEGER NOT NULL DEFAULT 5 CHECK (staff_adjustment_max_units >= 0),
    -- STAFF SPENDING FROM THE BRANCH SAFE (client decision).
    --
    -- The safe started manager-only, because a cashier moving the reserve
    -- unsupervised is the classic shrinkage route. But that made a real job
    -- impossible: the cashier sent to buy a carton the drawer cannot cover
    -- had to find a manager first, and shops do not work that way.
    --
    -- Resolved the same way as voids and write-offs above: a NARROW,
    -- OWNER-SET ALLOWANCE rather than a ban or a free hand.
    --
    --   staff_can_spend_from_safe  1 = a cashier may fund a purchase from the
    --                                  safe, up to the cap below
    --                              0 = manager approval required (the
    --                                  original behaviour)
    --   staff_safe_spend_max       the most a cashier may draw from the safe
    --                              in ONE purchase.
    --                              0 = NO CAP (deliberate: the client asked
    --                                  to be able to set "no limit"), so this
    --                                  is read as unlimited, never as "zero
    --                                  allowed" — the can/cannot decision is
    --                                  the boolean above, not this number.
    --
    -- Who may CHANGE these two is deliberately wider than the switches above:
    -- a Branch Manager runs the shop the cashier is standing in, so they may
    -- set their own branch's allowance. See routes/settings.js.
    staff_can_spend_from_safe       INTEGER NOT NULL DEFAULT 1,
    staff_safe_spend_max            REAL NOT NULL DEFAULT 20000 CHECK (staff_safe_spend_max >= 0),
    admin_contact_name              TEXT,
    admin_contact_phone             TEXT,
    admin_contact_email             TEXT,
    business_name                   TEXT,          -- client's own trading name, shown in place of "PharmaRidge" throughout the UI once set
    logo_data_url                   TEXT,           -- data: URL (base64), validated + capped at 500 KB before storage — see assertValidLogoDataUrl()
    notes                           TEXT,          -- internal admin-only notes (contract terms, discounts, etc.)
    updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                      TEXT REFERENCES users(id)
);


-- ---------------------------------------------------------------------
-- SUPPLIERS
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    phone       TEXT,
    address     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- PRODUCTS  (one shared master catalog across all branches)
-- ---------------------------------------------------------------------
CREATE TABLE products (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name              TEXT NOT NULL,
    generic_name      TEXT,
    category          TEXT,
    nafdac_reg_no     TEXT,
    is_controlled     INTEGER NOT NULL DEFAULT 0,
    dispensing_type   TEXT NOT NULL CHECK (dispensing_type IN ('OTC','POM')) DEFAULT 'OTC',
    base_unit         TEXT NOT NULL DEFAULT 'tablet',
    units_per_pack    INTEGER NOT NULL DEFAULT 1,     -- e.g. 10 tablets per strip/pack
    packs_per_carton  INTEGER,                        -- e.g. 10 strips per carton (optional)
    reorder_level     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);

-- Per-branch default selling price override for a product. Used to
-- pre-fill the selling price when a branch receives a new stock_batch,
-- so Lagos and Minna can each carry a different default price for the
-- same master product. The batch row itself is still what actually
-- prices any given sale (see design note in stock_batches).
CREATE TABLE product_price_overrides (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    product_id             TEXT NOT NULL REFERENCES products(id),
    default_selling_price  REAL NOT NULL,   -- per base_unit
    pack_price             REAL,            -- per pack (units_per_pack base units)
    carton_price           REAL,            -- per carton (packs_per_carton packs)
    updated_by             TEXT REFERENCES users(id),
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (branch_id, product_id)
);

-- ---------------------------------------------------------------------
-- PURCHASE ORDERS  (a branch ordering stock from a supplier)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    supplier_id  TEXT REFERENCES suppliers(id),
    status       TEXT NOT NULL CHECK (status IN ('PENDING','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) DEFAULT 'PENDING',
    ordered_by   TEXT REFERENCES users(id),
    ordered_at   TEXT NOT NULL DEFAULT (datetime('now')),
    notes        TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE purchase_order_items (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    product_id          TEXT NOT NULL REFERENCES products(id),
    quantity_ordered    INTEGER NOT NULL,
    expected_unit_cost  REAL,
    -- PARTIAL-RECEIVING SUPPORT (feature added during a production
    -- audit pass — closes a real "designed but unreachable schema
    -- value" gap: purchase_orders.status has always included
    -- 'PARTIALLY_RECEIVED' in its CHECK constraint, but no route on
    -- either backend could ever actually set it — /:id/receive was
    -- strictly all-or-nothing, so a supplier shipping only part of an
    -- order (extremely common in real pharmacy wholesale — "60 of the
    -- 100 units ordered arrived today, the rest next week") had no way
    -- to be recorded accurately; a manager was forced to either wait
    -- to receive the WHOLE order at once (leaving genuinely-arrived
    -- stock unrecorded and unsellable in the meantime) or receive the
    -- full ordered quantity against partial real goods (fabricating
    -- stock that was never actually delivered). This running total
    -- tracks how many units of this line have been received so far
    -- across ANY number of separate /receive calls against the same
    -- PO — each call's batches are validated against
    -- (quantity_ordered - quantity_received) REMAINING per line, never
    -- against quantity_ordered directly, so it is impossible to
    -- over-receive a line even across many partial receipts — and the
    -- CHECK (quantity_received <= quantity_ordered) constraint below
    -- is the DATABASE-LEVEL enforcement of that same invariant,
    -- matching this schema''s established "never rely on application
    -- code alone for a financial-integrity invariant" pattern.
    quantity_received   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0 AND quantity_received <= quantity_ordered),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);

-- One row per actual delivery/receiving EVENT against a purchase order
-- (a real-world "Goods Received Note") — a PO with partial deliveries
-- has one purchase_order_receipts row per delivery, each with its own
-- batches, cost, and (if on supplier credit) its own creditor_ledger/
-- General Ledger posting. This is the unit both this schema's GL
-- idempotency guard (glService.alreadyPosted('PO_RECEIVE', sourceId))
-- and the frontend's receiving-history display key off — using the
-- PARENT purchase_orders.id as the GL source_id (as the original,
-- all-or-nothing-only implementation did) would have made every
-- receive AFTER the first one on the same PO silently post NOTHING to
-- the GL, since alreadyPosted() would already show that PO id as
-- posted from the first partial delivery.
CREATE TABLE purchase_order_receipts (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    received_by         TEXT REFERENCES users(id),
    on_credit           INTEGER NOT NULL DEFAULT 0,
    total_cost          REAL NOT NULL,
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- STOCK BATCHES  (branch-specific stock, tracked by batch + expiry)
-- ---------------------------------------------------------------------
CREATE TABLE stock_batches (
    id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id               TEXT NOT NULL REFERENCES branches(id),
    product_id              TEXT NOT NULL REFERENCES products(id),
    batch_no                TEXT,
    expiry_date             TEXT,
    quantity_received       INTEGER NOT NULL,
    quantity_remaining      INTEGER NOT NULL CHECK (quantity_remaining >= 0),  -- database-enforced floor: this is
                                                                                -- the safety net that makes
                                                                                -- concurrent, lock-free stock
                                                                                -- decrements safe on Cloudflare D1
                                                                                -- (see services/salesService.js in
                                                                                -- the worker/ deployment) — an
                                                                                -- UPDATE that would push this
                                                                                -- negative is rejected atomically
                                                                                -- by SQLite itself, not by
                                                                                -- application-level locking.
    cost_price_per_unit     REAL NOT NULL,
    selling_price_per_unit  REAL NOT NULL,     -- price per base_unit (this batch, this branch)
    pack_price              REAL,              -- optional override: price per pack for THIS batch
    carton_price            REAL,              -- optional override: price per carton for THIS batch
    -- BUG 112 — HOW THIS BATCH ARRIVED, AND HOW IT IS MEANT TO BE SOLD.
    --
    -- The product record carries the manufacturer's DEFAULT pack size, but a
    -- real delivery does not always match it: the same drug arrives in 10x10
    -- cartons from one supplier and 24x1 from another, and both end up on the
    -- same shelf. Recording the nesting AS RECEIVED, per batch, is what makes
    -- "10 cartons" mean the right number of tablets for THAT delivery.
    --
    -- selling_pattern is the counter's instruction: sell this by the carton,
    -- by the pack, or by the piece. It is deliberately independent of how the
    -- stock arrived — buying by the carton and selling by the tablet is the
    -- entire pharmacy business model.
    received_unit           TEXT CHECK (received_unit IN ('CARTON','PACK','PIECE')),
    received_unit_count     INTEGER,           -- e.g. 10 (cartons), before conversion
    units_per_pack_at_receipt   INTEGER,       -- pieces in a pack, as delivered
    packs_per_carton_at_receipt INTEGER,       -- packs in a carton, as delivered
    selling_pattern         TEXT CHECK (selling_pattern IN ('CARTON','PACK','PIECE')),
    total_cost              REAL,              -- what was paid for the whole line, as invoiced
    supplier_id             TEXT REFERENCES suppliers(id),
    purchase_order_id       TEXT REFERENCES purchase_orders(id),
    received_by             TEXT REFERENCES users(id),
    received_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted              INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- CUSTOMERS  (for credit-sale / debtor tracking)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id   TEXT REFERENCES branches(id),
    name        TEXT NOT NULL,
    phone       TEXT,
    address     TEXT,
    id_type     TEXT,     -- e.g. 'NIN','Voter\'s Card','Driver\'s License' — for controlled-drug KYC
    id_number   TEXT,
    -- BUG 83 — CREDIT WAS COMPLETELY UNCAPPED.
    --
    -- Before this column existed there was no ceiling of any kind: no
    -- credit_limit anywhere in the schema, the backend or the frontend, and
    -- nothing in createSale compared a CREDIT payment against anything.
    -- Live-reproduced: a plain CASHIER extended 7,500 naira of credit to one
    -- walk-in across six consecutive sales, with no approval and no warning.
    -- For a Nigerian pharmacy, uncollectable debt is one of the most common
    -- ways a profitable shop runs out of cash.
    --
    -- DEFAULT 0 IS DELIBERATE AND IS THE WHOLE POINT (client decision):
    -- a customer is cash-only until somebody with authority deliberately
    -- grants them credit. A permissive default would silently reproduce the
    -- bug for every customer created from here on.
    --
    -- Stored per customer rather than as one global figure because a pharmacy
    -- extends very different trust to a neighbourhood regular, a corporate
    -- account and a passing stranger. NULL is NOT used to mean "unlimited":
    -- an unlimited ceiling is precisely what this column exists to prevent, so
    -- it is NOT NULL and a deliberate large number expresses high trust.
    credit_limit REAL NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    -- Tracks which device last wrote this row, purely to make sync-
    -- conflict DETECTION precise (see sync_conflicts / syncService.js):
    -- without this, we can't tell "the same device edited this record
    -- twice in a row" (perfectly normal, not a conflict) apart from
    -- "two different devices both edited this record while offline and
    -- one push is about to silently discard the other's changes" (a
    -- genuine conflict worth surfacing to a manager). NULL means this
    -- row has never been touched via the offline push mechanism (e.g.
    -- created directly through the ordinary online REST API).
    last_write_device_id TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- SALES  (POS transactions)
-- ---------------------------------------------------------------------
CREATE TABLE sales (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    served_by       TEXT NOT NULL REFERENCES users(id),
    customer_id     TEXT REFERENCES customers(id),
    subtotal        REAL NOT NULL,
    discount        REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL,
    -- VAT-INCLUSIVE tracking (client decision — see client_settings.vat_enabled's
    -- comment for the full pricing-model rationale): `total` above is
    -- NEVER increased by VAT — it stays exactly the customer-facing
    -- price it always was. vat_amount is the portion of `total` that
    -- represents VAT, EXTRACTED (not added) at the client's configured
    -- vat_rate_percent, purely for FIRS remittance reporting/GL
    -- posting. Always 0 for a sale made while VAT tracking is
    -- disabled, or for any sale predating this feature — never
    -- retroactively recomputed, matching this schema's general
    -- "a historical record reflects the rules in effect when it was
    -- created" principle (e.g. product_price_overrides, till sessions).
    vat_amount      REAL NOT NULL DEFAULT 0,
    is_credit_sale  INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK (status IN ('COMPLETED','VOIDED','REFUNDED')) DEFAULT 'COMPLETED',
    voided_by       TEXT REFERENCES users(id),
    void_reason     TEXT,
    -- BUG 83. Set when a manager knowingly took this customer past their
    -- credit limit. Recorded on the SALE rather than only on the customer so
    -- the authorisation stays attached to the transaction it authorised —
    -- the customer's limit may be raised or lowered later, but this row will
    -- always say the debt was allowed to grow here, and why.
    credit_override_reason TEXT,
    till_session_id TEXT REFERENCES till_sessions(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sale_items (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id            TEXT NOT NULL REFERENCES sales(id),
    stock_batch_id     TEXT NOT NULL REFERENCES stock_batches(id),
    product_id         TEXT NOT NULL REFERENCES products(id),
    unit_type          TEXT NOT NULL CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON')) DEFAULT 'BASE_UNIT',
    quantity           INTEGER NOT NULL,        -- quantity in the chosen unit_type
    quantity_base_units INTEGER NOT NULL,       -- quantity converted to base_unit (used for stock deduction)
    unit_price         REAL NOT NULL,           -- price per unit_type (pack/carton/base)
    line_total         REAL NOT NULL,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);

-- Split payments: one sale is very often part cash, part transfer, part
-- POS card. cash_tendered/change_given keep till reconciliation correct
-- when a customer overpays in cash and receives change.
CREATE TABLE sale_payments (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id        TEXT NOT NULL REFERENCES sales(id),
    method         TEXT NOT NULL CHECK (method IN ('CASH','POS_CARD','TRANSFER','CREDIT')),
    amount         REAL NOT NULL,     -- amount actually applied to the sale (net of change)
    cash_tendered  REAL,              -- CASH only: physical amount handed over by customer
    change_given   REAL DEFAULT 0,    -- CASH only: cash_tendered - amount
    reference      TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    -- BUG 39: the API accepted {amount: 25, cash_tendered: 10} and stored
    -- change_given = -15. Negative change is physically impossible — it
    -- says the drawer handed money back to itself — and the receipt hides
    -- it (`change_given > 0`), so the wrong row was invisible. The service
    -- layer now refuses a short tender, and these CHECKs are the second
    -- line: salesService is the only writer TODAY, but "what else writes
    -- this value?" is exactly how the earlier quantity_remaining bypasses
    -- were found, so the invariant is asserted where no code path can
    -- dodge it. (Table-level CHECKs must follow every column definition —
    -- placing them mid-table is a syntax error in SQLite.)
    CHECK (change_given IS NULL OR change_given >= 0),
    CHECK (cash_tendered IS NULL OR cash_tendered >= 0)
);

-- ---------------------------------------------------------------------
-- PRESCRIPTIONS  (POM dispensing trail — prescriber + patient details)
-- ---------------------------------------------------------------------
CREATE TABLE prescriptions (
    id                          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id                     TEXT REFERENCES sales(id),
    sale_item_id                TEXT REFERENCES sale_items(id),
    prescriber_name             TEXT,
    prescriber_pcn_or_mdcn_no   TEXT,
    patient_name                TEXT,
    patient_phone               TEXT,
    dosage_notes                TEXT,
    recorded_by                 TEXT REFERENCES users(id),
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- CONTROLLED SUBSTANCE REGISTER
-- Tamper-evident, append-only. Every row's entry_hash is
-- SHA256(prev_hash + canonical(fields)); prev_hash chains to the
-- previous row for the SAME branch. Any edit/delete breaks the chain,
-- which /api/controlled-drugs/verify checks and flags to the manager.
-- ---------------------------------------------------------------------
CREATE TABLE controlled_substance_register (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    sale_id            TEXT REFERENCES sales(id),
    sale_item_id       TEXT REFERENCES sale_items(id),
    product_id         TEXT NOT NULL REFERENCES products(id),
    quantity_dispensed INTEGER NOT NULL,        -- base_unit
    buyer_name         TEXT NOT NULL,
    buyer_phone        TEXT NOT NULL,
    buyer_id_type      TEXT,                    -- NIN / Voter's Card / Driver's Licence ...
    buyer_id_number    TEXT,
    prescription_id    TEXT REFERENCES prescriptions(id),
    dispensed_by       TEXT NOT NULL REFERENCES users(id),
    prev_hash          TEXT,                    -- hash of previous row at this branch, or NULL for first
    entry_hash         TEXT NOT NULL,            -- SHA256 chain hash of this row
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    -- deliberately NO updated_at / is_deleted / UPDATE-DELETE path:
    -- this register must be append-only for regulatory audit purposes.
);

-- ---------------------------------------------------------------------
-- DEBTOR LEDGER  (money owed TO the pharmacy by customers)
-- ---------------------------------------------------------------------
CREATE TABLE debtor_ledger (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    customer_id  TEXT NOT NULL REFERENCES customers(id),
    sale_id      TEXT REFERENCES sales(id),
    entry_type   TEXT NOT NULL CHECK (entry_type IN ('DEBIT','PAYMENT')),
    amount       REAL NOT NULL,
    recorded_by  TEXT REFERENCES users(id),
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);


-- ---------------------------------------------------------------------
-- CHANGE OWED TO CUSTOMERS  (BUG 95)
-- ---------------------------------------------------------------------
CREATE TABLE change_owed (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    -- 7-digit claim code quoted to the customer. Text, not integer, so a
    -- leading zero can never be lost.
    claim_code      TEXT NOT NULL UNIQUE,
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    -- The sale that generated the shortfall. Kept for the audit trail and so
    -- the original receipt can reprint the claim.
    sale_id         TEXT REFERENCES sales(id),
    -- OPTIONAL link to a registered customer. Most no-change events are
    -- walk-ins who will never be a customer record, and forcing registration
    -- at a busy counter is how a feature goes unused.
    customer_id     TEXT REFERENCES customers(id),
    -- REQUIRED identification: a name, or a phone number, or both. Enforced
    -- in the service layer as "at least one of these is non-empty".
    customer_name   TEXT NOT NULL,
    customer_phone  TEXT,
    amount          REAL NOT NULL CHECK (amount > 0),
    -- What the customer bought, snapshotted as text at the time of sale so the
    -- claim is self-describing forever.
    sale_summary    TEXT,
    status          TEXT NOT NULL DEFAULT 'OUTSTANDING'
                    CHECK (status IN ('OUTSTANDING','SETTLED','WRITTEN_OFF')),
    -- How it was finally discharged. NULL while OUTSTANDING.
    settlement_method TEXT CHECK (settlement_method IN ('CASH_PAID','APPLIED_TO_SALE','WRITTEN_OFF')),
    -- If APPLIED_TO_SALE, the purchase it was rolled into.
    settled_sale_id TEXT REFERENCES sales(id),
    settled_at      TEXT,
    settled_by      TEXT REFERENCES users(id),
    settled_notes   TEXT,
    recorded_by     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

-- The three ways a cashier finds a claim at the counter. The code is the fast
-- path; name and phone are the fallback the client explicitly asked for when
-- the slip is lost. Partial indexes on OUTSTANDING keep the common lookup
-- ("what do we still owe?") off the settled history entirely.
CREATE UNIQUE INDEX idx_change_owed_code ON change_owed(claim_code);
CREATE INDEX idx_change_owed_name ON change_owed(customer_name) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_phone ON change_owed(customer_phone) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_branch ON change_owed(branch_id, status, created_at);
CREATE INDEX idx_change_owed_sale ON change_owed(sale_id);
CREATE INDEX idx_change_owed_customer ON change_owed(customer_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- BRANCH SAFE  (cash held at a branch OUTSIDE the counter drawer)
-- ---------------------------------------------------------------------
-- WHY THIS EXISTS. Bug 96 established that a CASH expense may never exceed the
-- money in the till, because a cash box cannot hold negative money. That guard
-- is right, but on its own it made a real and routine transaction impossible:
-- a branch cannot buy a N50,000 delivery, or pay N80,000 rent, out of a drawer
-- that floats N25,000 — yet Nigerian pharmacies do exactly that every week,
-- from the shop safe.
--
-- So the safe is the missing counterpart, not a workaround. It models what is
-- physically true of a branch: there are TWO pots of cash at a shop, and they
-- are different things.
--
--   CASH (the drawer)      the counter till. One open session at a time,
--                          counted and reconciled at every close, and the only
--                          pot a cashier ever touches.
--   BRANCH_SAFE            the shop's cash reserve. Not counted at till close,
--                          not touched by a sale, and it is where the money for
--                          a big supplier payment or the rent actually comes
--                          from.
--
-- WHO CONTROLS IT (client decision): the OWNER, a GENERAL MANAGER, and the
-- BRANCH MANAGER of that branch. Explicitly NOT staff — a cashier moving money
-- between the drawer and the safe unsupervised is the oldest shrinkage route in
-- retail. STAFF may read the balance (they need to know whether a purchase can
-- be funded) but may not move a naira.
--
-- Append-only, exactly like debtor_ledger and creditor_ledger: the balance is
-- always SUM(signed amounts), never a stored figure that can drift out of step
-- with its own history. Every row names a person and carries a reason.
CREATE TABLE branch_safe_ledger (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    -- DEPOSIT       money INTO the safe (owner float, cash swept up from the
    --               drawer at close, a loan from another branch)
    -- WITHDRAWAL    money OUT of the safe that is NOT itself a recorded
    --               business cost (e.g. topping the drawer back up)
    -- EXPENSE_PAID  the safe funded an expense row (expenses.paid_by_method =
    --               'SAFE'); source_id names it
    -- SUPPLIER_PAID the safe funded a creditor payment; source_id names it
    -- TILL_TRANSFER movement between this branch's drawer and its safe
    entry_type    TEXT NOT NULL CHECK (entry_type IN ('DEPOSIT','WITHDRAWAL','EXPENSE_PAID','SUPPLIER_PAID','TILL_TRANSFER')),
    -- SIGNED. Positive adds to the safe, negative removes. Stored signed rather
    -- than as a magnitude plus a direction so the balance is a plain SUM() and
    -- no reader can misinterpret the sign convention.
    amount        REAL NOT NULL CHECK (amount <> 0),
    -- What this movement paid for, when it paid for something: an expenses.id
    -- or a creditor_ledger.id. Not a FK because the source table varies, the
    -- same pattern gl_journal_entries.source_id already uses.
    source_type   TEXT CHECK (source_type IN ('EXPENSE','SUPPLIER_PAYMENT','TILL_SESSION')),
    source_id     TEXT,
    -- Never optional. A safe movement with no stated reason is exactly the
    -- record an owner cannot audit six weeks later.
    reason        TEXT NOT NULL,
    recorded_by   TEXT NOT NULL REFERENCES users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_branch_safe_branch ON branch_safe_ledger(branch_id, created_at);
CREATE INDEX idx_branch_safe_source ON branch_safe_ledger(source_type, source_id);

-- Outstanding change per branch, for the counter list and the dashboard tile.
CREATE VIEW v_change_owed_outstanding AS
SELECT
    co.branch_id,
    b.name AS branch_name,
    COUNT(*)              AS claim_count,
    COALESCE(SUM(co.amount), 0) AS total_owed
FROM change_owed co
JOIN branches b ON b.id = co.branch_id
WHERE co.status = 'OUTSTANDING' AND co.is_deleted = 0
GROUP BY co.branch_id, b.name;

-- Current safe balance per branch. A SUM over an append-only ledger, so it can
-- never disagree with its own history.
CREATE VIEW v_branch_safe_balances AS
SELECT
    b.id   AS branch_id,
    b.name AS branch_name,
    COALESCE(SUM(sl.amount), 0) AS safe_balance,
    COUNT(sl.id) AS movement_count,
    MAX(sl.created_at) AS last_movement_at
FROM branches b
LEFT JOIN branch_safe_ledger sl ON sl.branch_id = b.id AND sl.is_deleted = 0
WHERE b.is_deleted = 0
GROUP BY b.id, b.name;

-- ---------------------------------------------------------------------
-- CREDITOR LEDGER  (money the pharmacy owes its suppliers)
-- ---------------------------------------------------------------------
CREATE TABLE creditor_ledger (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    supplier_id        TEXT NOT NULL REFERENCES suppliers(id),
    purchase_order_id  TEXT REFERENCES purchase_orders(id),
    entry_type         TEXT NOT NULL CHECK (entry_type IN ('DEBIT','PAYMENT')),
    amount             REAL NOT NULL,
    recorded_by        TEXT REFERENCES users(id),
    notes              TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- EXPENSES
-- ---------------------------------------------------------------------
CREATE TABLE expenses (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    category        TEXT NOT NULL,
    description     TEXT,
    amount          REAL NOT NULL,
    -- 'SAFE' (added with the branch safe): this expense was funded from the
    -- shop's cash reserve, NOT from the counter drawer. Kept distinct from
    -- 'CASH' because the two pots reconcile separately — a till close counts
    -- the drawer only, and treating safe spending as drawer spending is what
    -- drove a seeded till to an impossible negative balance (Bug 96).
    paid_by_method  TEXT CHECK (paid_by_method IN ('CASH','POS_CARD','TRANSFER','SAFE')),
    recorded_by     TEXT NOT NULL REFERENCES users(id),
    approved_by     TEXT REFERENCES users(id),
    expense_date    TEXT NOT NULL DEFAULT (datetime('now')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    -- BUG 118. Set when this cash expense was recorded while NO till session
    -- was open at the branch. computeExpectedCash windows expenses by
    -- created_at >= till.opened_at, so without this marker the spend is
    -- picked up by the NEXT session and charged to a cashier who never made
    -- it: a N75,000 rent payment made with no session open left the following
    -- shift expecting -N54,232, unclosable without forcing, and posted a
    -- fictitious shortage to CASH_OVER_SHORT.
    --
    -- Recorded at write time because that is the only moment the truth is
    -- known: there was no drawer, so no drawer reconciliation may claim it.
    no_open_till_at_record INTEGER NOT NULL DEFAULT 0,
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- TILL SESSIONS  (cash-in-drawer reconciliation per shift)
-- ---------------------------------------------------------------------
CREATE TABLE till_sessions (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    opened_by              TEXT NOT NULL REFERENCES users(id),
    opening_cash           REAL NOT NULL DEFAULT 0,
    opened_at              TEXT NOT NULL DEFAULT (datetime('now')),
    status                 TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')) DEFAULT 'OPEN',
    closed_by              TEXT REFERENCES users(id),
    expected_closing_cash  REAL,
    counted_closing_cash   REAL,
    discrepancy            REAL,
    closed_at              TEXT,
    notes                  TEXT,
    -- Manager recovery workflow: if whoever opened this till leaves for
    -- the day without closing it, the partial-unique "one OPEN till per
    -- branch" index (idx_till_sessions_one_open_per_branch below) would
    -- otherwise permanently block every other staff member at that
    -- branch from opening a new till until the original session is
    -- closed. force_closed_by/force_closed_reason let a MANAGER (never
    -- STAFF) close someone else's still-open till on their behalf,
    -- clearly distinguished from a normal self-close in every listing
    -- so it's always visible as an exception, not silently identical to
    -- the cashier's own close.
    force_closed_by        TEXT REFERENCES users(id),
    force_closed_reason    TEXT,
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- STAFF ATTENDANCE  (clock-in/out with optional GPS geofence verification)
--
-- Design notes:
--  - clock_in_lat/lng/accuracy capture the device's Web Geolocation API
--    reading at the moment of clock-in (and mirrored fields for
--    clock-out). These are nullable: geolocation is best-effort, not a
--    hard requirement, because desktop PCs without GPS/Wi-Fi positioning
--    hardware fall back to coarse IP-based geolocation (can be miles off)
--    or may have location permission denied entirely.
--  - distance_from_branch_meters is computed server-side (Haversine
--    formula, see services/attendanceService.js) at the moment of
--    clock-in against the branch's configured (latitude, longitude).
--    Storing the computed distance (not just raw coordinates) means the
--    "was this on-site?" determination survives even if the branch's
--    geofence center is edited later.
--  - verification_status captures the outcome plainly for reporting:
--      ON_SITE          -> within the branch's geofence_radius_meters
--      OFF_SITE         -> outside the radius (flagged, but recorded —
--                          not silently blocked, see manager override below)
--      NO_LOCATION      -> device provided no GPS coordinates at all
--                          (permission denied / unsupported / desktop
--                          with no positioning hardware)
--      GEOFENCE_NOT_SET -> the branch has no latitude/longitude
--                          configured yet, so on/off-site cannot be judged
--  - manager_override_by: if a manager approves an off-site or
--    no-location clock-in (e.g. GPS is down, or a legitimate reason for
--    being off-premises), that's recorded here for audit purposes rather
--    than silently allowing it — accountability without blocking staff
--    who have a real GPS/hardware limitation from clocking in at all.
--  - HONEST LIMITATION: like any browser-based geolocation check, the
--    lat/lng a device reports can be spoofed (mock-location apps on a
--    rooted/jailbroken device, browser devtools location override,
--    IP-based geolocation proxies). This system deters casual "buddy
--    punching" and gives managers a real, auditable signal to review —
--    it is a deterrent and reporting tool, not a cryptographic proof of
--    physical presence. For that reason clock-ins are always recorded
--    (never hard-blocked) and every classification is visible to
--    managers for review rather than presented as an infallible gate.
-- ---------------------------------------------------------------------
CREATE TABLE staff_attendance (
    id                          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id                   TEXT NOT NULL REFERENCES branches(id),
    user_id                     TEXT NOT NULL REFERENCES users(id),
    clock_in_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    clock_in_lat                REAL,
    clock_in_lng                REAL,
    clock_in_accuracy_meters    REAL,
    clock_in_distance_meters    REAL,             -- computed distance from branch geofence center
    clock_in_device_id          TEXT,             -- browser-persistent device id reported at clock-in (REGISTERED_DEVICE mode)
    clock_in_status             TEXT NOT NULL CHECK (clock_in_status IN (
                                     'ON_SITE','OFF_SITE','NO_LOCATION','GEOFENCE_NOT_SET',
                                     'DEVICE_RECOGNIZED','DEVICE_NOT_RECOGNIZED','DEVICE_NOT_SET'
                                 )) DEFAULT 'NO_LOCATION',
    clock_out_at                TEXT,
    clock_out_lat               REAL,
    clock_out_lng               REAL,
    clock_out_accuracy_meters   REAL,
    clock_out_distance_meters   REAL,
    clock_out_device_id         TEXT,             -- browser-persistent device id reported at clock-out (REGISTERED_DEVICE mode)
    clock_out_status            TEXT CHECK (clock_out_status IN (
                                     'ON_SITE','OFF_SITE','NO_LOCATION','GEOFENCE_NOT_SET',
                                     'DEVICE_RECOGNIZED','DEVICE_NOT_RECOGNIZED','DEVICE_NOT_SET'
                                 )),
    manager_override_by         TEXT REFERENCES users(id),   -- set if a manager knowingly approved an OFF_SITE/NO_LOCATION/unrecognized-device clock-in
    manager_override_reason     TEXT,
    -- BUG 74 — A SHIFT LEFT OPEN BY A DEPARTING EMPLOYEE COULD NEVER BE CLOSED.
    --
    -- clockOut() enforces `record.user_id !== userId -> FORBIDDEN`, which is
    -- correct for the ordinary case (nobody may clock a colleague out and
    -- fabricate their hours). But it left NO path at all for the one case that
    -- always eventually happens: the person is deactivated, deleted, or simply
    -- leaves, while still clocked in. Live-reproduced end to end:
    --     staff clock-in                                   -> 201
    --     owner PUT /users/:id {is_active:false}           -> 200 (no warning)
    --     owner POST /attendance/:id/clock-out             -> 403 FORBIDDEN
    --     owner POST /attendance/:id/override              -> 200 but clock_out_at STAYS NULL
    --     the ex-employee reads as "Still clocked in" forever
    -- and on reinstatement they could never clock in again (ALREADY_CLOCKED_IN,
    -- enforced by idx_attendance_one_open_per_user).
    --
    -- Tills already have force_closed_by/force_closed_reason and stocktakes
    -- have force-cancel; attendance was the one open-state table with no
    -- recovery path. These two columns close that asymmetry, and deliberately
    -- MIRROR the till_sessions naming so every report can tell a shift the
    -- employee ended themselves from one a manager ended on their behalf —
    -- which is a payroll-relevant distinction, not a cosmetic one.
    force_closed_by             TEXT REFERENCES users(id),
    force_closed_reason         TEXT,
    notes                       TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- STOCKTAKES  (scheduled physical inventory counts -> variance -> adjustments)
-- ---------------------------------------------------------------------
CREATE TABLE stocktake_sessions (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    started_by   TEXT NOT NULL REFERENCES users(id),
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    status       TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED')) DEFAULT 'OPEN',
    closed_by    TEXT REFERENCES users(id),
    closed_at    TEXT,
    notes        TEXT,
    -- Same manager recovery workflow as till_sessions.force_closed_by
    -- above — the partial-unique "one OPEN stocktake per branch" index
    -- would otherwise permanently block a branch if whoever started a
    -- count never finishes it (leaves, forgets, device lost, etc.).
    force_closed_by     TEXT REFERENCES users(id),
    force_closed_reason TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stocktake_lines (
    id                          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    stocktake_id                TEXT NOT NULL REFERENCES stocktake_sessions(id),
    stock_batch_id              TEXT NOT NULL REFERENCES stock_batches(id),
    system_quantity             INTEGER NOT NULL,     -- quantity_remaining snapshot at session start (historical reference only)
    quantity_remaining_at_count INTEGER,              -- quantity_remaining AT THE MOMENT counted_quantity was recorded — this,
                                                       -- not system_quantity, is what variance is computed against, so that
                                                       -- normal sales/adjustments happening while the stocktake is still open
                                                       -- are never mistaken for shrinkage (see migrations/001).
    counted_quantity            INTEGER,              -- filled in by staff during the count
    variance                    INTEGER,              -- counted_quantity - quantity_remaining_at_count
    counted_by                  TEXT REFERENCES users(id),
    counted_at                  TEXT,
    notes                       TEXT,
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- STOCK ADJUSTMENTS  (damage, expiry write-off, theft loss, correction)
-- ---------------------------------------------------------------------
CREATE TABLE stock_adjustments (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id        TEXT NOT NULL REFERENCES branches(id),
    stock_batch_id   TEXT NOT NULL REFERENCES stock_batches(id),
    adjustment_type  TEXT NOT NULL CHECK (adjustment_type IN ('DAMAGE','EXPIRED','THEFT_LOSS','MANUAL_CORRECTION','STOCKTAKE_VARIANCE')),
    quantity_change  INTEGER NOT NULL,
    reason           TEXT,
    stocktake_id     TEXT REFERENCES stocktake_sessions(id),
    recorded_by      TEXT NOT NULL REFERENCES users(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- STOCK TRANSFERS  (moving stock between branches)
-- ---------------------------------------------------------------------
CREATE TABLE stock_transfers (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    from_branch_id  TEXT NOT NULL REFERENCES branches(id),
    to_branch_id    TEXT NOT NULL REFERENCES branches(id),
    stock_batch_id  TEXT NOT NULL REFERENCES stock_batches(id),
    quantity        INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('PENDING','IN_TRANSIT','RECEIVED','CANCELLED')) DEFAULT 'PENDING',
    initiated_by    TEXT NOT NULL REFERENCES users(id),
    received_by     TEXT REFERENCES users(id),
    initiated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    received_at     TEXT,
    new_batch_id    TEXT REFERENCES stock_batches(id),  -- the new batch row created at to_branch_id on receipt
    -- BUG 107 — OFFLINE SALES vs AN IN-FLIGHT TRANSFER.
    --
    -- `quantity` is what the manager INTENDED to send. What actually arrives
    -- can legitimately be less: a cashier at the source branch sells from the
    -- same batch while offline, and that sale only reaches the server after
    -- the transfer was raised. Before this, receiving then failed outright
    -- with "Source batch no longer has enough stock" and the transfer stuck
    -- at PENDING forever — the stock unsellable at BOTH branches.
    --
    -- These three columns let the receive step SELF-CORRECT: it moves what is
    -- really there, records the difference, and completes. `quantity` is left
    -- untouched as the original intent, which is what makes the shortfall
    -- auditable rather than invisible.
    --
    -- Deliberately NOT a new `status` value: SQLite cannot ALTER a CHECK
    -- constraint, and 'ADJUSTED' would also have broken every existing reader
    -- that switches on PENDING/IN_TRANSIT/RECEIVED/CANCELLED. A received
    -- transfer is RECEIVED; whether it was adjusted is a property of it.
    quantity_received  INTEGER,          -- what actually moved (NULL until received)
    shortfall_quantity INTEGER NOT NULL DEFAULT 0,
    shortfall_reason   TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    CHECK (from_branch_id != to_branch_id),
    CHECK (shortfall_quantity >= 0),
    CHECK (quantity_received IS NULL OR quantity_received >= 0)
);
-- On RECEIVED: decrement quantity_remaining on the source stock_batches row,
-- and insert a NEW stock_batches row at to_branch_id with the same
-- batch_no / expiry_date / prices, so the batch stays traceable at its
-- new location. new_batch_id records that link.

-- ---------------------------------------------------------------------
-- SYNC TRACKING  (manager visibility into every branch's sync health)
-- ---------------------------------------------------------------------

-- One row per branch device, kept up to date by heartbeats/push/pull
-- calls from that branch's local app instance.
CREATE TABLE branch_sync_status (
    branch_id            TEXT PRIMARY KEY REFERENCES branches(id),
    device_id            TEXT,
    app_version          TEXT,
    last_heartbeat_at    TEXT,
    last_push_at         TEXT,     -- last time this branch successfully pushed local changes up
    last_pull_at         TEXT,     -- last time this branch pulled central reference data down
    pending_push_count   INTEGER NOT NULL DEFAULT 0,  -- unsynced local rows, self-reported by device
    last_sync_error      TEXT,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit trail of every push/pull that touched the server,
-- so a manager (or support) can see sync history, not just latest state.
CREATE TABLE sync_change_log (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT REFERENCES branches(id),
    device_id    TEXT,
    direction    TEXT NOT NULL CHECK (direction IN ('PUSH','PULL','HEARTBEAT')),
    table_name   TEXT,
    row_count    INTEGER DEFAULT 0,
    status       TEXT NOT NULL CHECK (status IN ('SUCCESS','PARTIAL','FAILED')) DEFAULT 'SUCCESS',
    error_message TEXT,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- SYNC CONFLICTS
--
-- The generic table-level push mechanism in services/syncService.js
-- (currently: customers only — see that file's header comment on why
-- it's deliberately NOT used for sales/stock/ledgers) resolves
-- concurrent edits to the SAME row from two different offline branches
-- via last-write-wins on `updated_at`. LWW is simple and fine for the
-- common case, but it has a real, previously-undocumented failure mode:
-- if Branch A and Branch B both edit the same shared customer record
-- while both offline (e.g. A updates the phone number, B updates the
-- address, both before either has synced), the row that syncs SECOND
-- silently overwrites the first — B's address change survives, A's
-- phone change is gone, with no error, no warning, nothing in the
-- history to show it happened. This table makes that visible instead
-- of silent: every time upsertRow() detects it is about to discard a
-- losing write (not just skip a stale no-op), it records the discarded
-- version here BEFORE overwriting, so a manager can review what was
-- lost and manually reconcile it if it mattered. This does not prevent
-- the overwrite (a full merge/CRDT engine is a much larger undertaking
-- — see the "Roadmap" note in README.md) but it closes the "nobody
-- would ever even know it happened" gap.
-- ---------------------------------------------------------------------
CREATE TABLE sync_conflicts (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    table_name          TEXT NOT NULL,
    row_id              TEXT NOT NULL,
    branch_id           TEXT REFERENCES branches(id),      -- branch whose push caused the overwrite
    device_id           TEXT,
    losing_version_json TEXT NOT NULL,   -- full JSON snapshot of the row that was about to be discarded
    winning_version_json TEXT NOT NULL,  -- full JSON snapshot of the incoming row that overwrote it
    detected_at         TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by         TEXT REFERENCES users(id),   -- set once a manager has looked at this and decided no further action (or manually reconciled) is needed
    reviewed_at         TEXT
);
CREATE INDEX idx_sync_conflicts_unreviewed ON sync_conflicts(detected_at) WHERE reviewed_by IS NULL;

-- ---------------------------------------------------------------------
-- IDEMPOTENCY KEYS
-- Protects every mutating request against duplicate execution when a
-- client retries after losing the response (flaky connection, or the
-- offline queue replaying a request that actually already succeeded on
-- the server before connectivity dropped). A client sends the same
-- Idempotency-Key header on every attempt of the *same* logical action;
-- the server executes it once and replays the stored response for any
-- repeat with the same key. This is what makes it safe for the PWA's
-- offline queue to blindly retry queued sales/expenses/etc. without
-- risking double stock deduction, double cash counted, or a duplicate
-- controlled-drug register entry.
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    idempotency_key   TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id),
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    request_hash      TEXT NOT NULL,   -- hash of the request body, to detect a key being reused for a DIFFERENT request
    response_status   INTEGER,
    response_body     TEXT,            -- JSON-serialized response, replayed verbatim on retry
    status            TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')) DEFAULT 'IN_PROGRESS',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (idempotency_key, user_id)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

-- ---------------------------------------------------------------------
-- LOGIN ATTEMPT THROTTLING + AUTHENTICATION AUDIT TRAIL
-- ---------------------------------------------------------------------
--
-- WHY (reproduced live against real workerd + D1 during a production
-- audit, before this table existed):
--
--   60 consecutive wrong PINs against the `owner` account all returned a
--   plain 401 in 1,150ms total — 19ms per attempt, with no lockout, no
--   throttle, and no record anywhere that it had happened. The correct
--   PIN then worked immediately afterwards.
--
--   This product authenticates with SHORT NUMERIC PINs (the minimum is 4
--   characters, and 4-digit PINs are the norm on a shared pharmacy
--   terminal — they are typed dozens of times a shift in front of
--   customers). A 4-digit PIN is a 10,000-value keyspace. At the
--   measured rate that is ~190 seconds to exhaust single-threaded, and
--   trivially parallelisable. Usernames are not secret either: the
--   Users screen lists every one of them to any manager, and the login
--   screen advertises the demo accounts by name.
--
--   So without this table, any person who could reach the login page
--   could take over the OWNER account of a live pharmacy in about three
--   minutes, and leave no trace of having tried.
--
-- WHY IT LIVES IN THE INITIAL SCHEMA RATHER THAN ITS OWN MIGRATION:
--
--   This shipped as migration 0004 while the product was still
--   pre-deployment. It was folded in here for the same reason 0003 was:
--   there is no production migration history to preserve, and — unlike
--   an ordinary feature table — a PARTIALLY APPLIED migration set leaves
--   this one SILENTLY DISABLED rather than visibly broken.
--
--   lib/loginThrottle.js deliberately FAILS OPEN: if its bookkeeping
--   query throws because this table is absent, authentication proceeds
--   normally. That is the right call for a rate limiter (a pharmacy that
--   cannot sell because the throttle is broken is worse than the attack
--   it prevents) but it means a deploy that applied 0001 and stopped
--   would run with NO brute-force protection, logging only to
--   `wrangler tail`, and every screen would look completely healthy.
--   Measured directly: with this table absent, 40 consecutive wrong PINs
--   were all ALLOWED (0 locked); with it present, 8 were allowed and 32
--   were refused with 429. Binding the table to the same statement that
--   creates `users` makes "auth exists but is unprotected" unreachable.
--
-- WHAT THIS ADDS:
--
--   login_attempts — one row per authentication attempt, successful or
--   not. Two jobs, deliberately in one table:
--
--     1. THROTTLING. The login route counts recent FAILED attempts for
--        the same username and refuses further attempts once a threshold
--        is crossed, until a cool-off window passes.
--
--     2. AUDIT TRAIL. "Who has been trying to get into the owner's
--        account, and from where?" is a question a pharmacy proprietor
--        can now actually answer. Successful logins are recorded too, so
--        a real compromise can be distinguished from a failed attempt.
--
-- DESIGN NOTES (D1/Workers specific):
--
--   * Keyed on USERNAME, not user_id: an attacker guessing at a username
--     that does not exist must be throttled identically, or the endpoint
--     becomes a username oracle (fast 401 = no such user, slow/locked =
--     real user). The route therefore records an attempt even when the
--     username is unknown.
--
--   * No per-IP dimension. `CF-Connecting-IP` is available, but a
--     Nigerian pharmacy's staff frequently share one mobile hotspot or
--     sit behind carrier-grade NAT, so IP-based lockout would lock out
--     the whole shop because one cashier fat-fingered a PIN. Username
--     scoping targets the account actually under attack. IP is still
--     RECORDED for the audit trail.
--
--   * Rows are pruned by the existing Cron Trigger (see
--     lib/retention.js), the same mechanism that already prunes
--     idempotency_keys and sync_change_log, so this table cannot grow
--     unboundedly in a free-tier D1 database.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- WITHHOLDING TAX (WHT) — Deduction of Tax at Source
-- ---------------------------------------------------------------------
--
-- WHT is NOT another tax. It is an ADVANCE PAYMENT of income tax that the
-- PAYER deducts at source and remits to the revenue authority on the
-- payee's behalf. Two completely separate directions exist, and conflating
-- them is the classic way WHT accounting goes wrong:
--
--   PAYABLE (the pharmacy is the tax agent). The pharmacy pays a landlord
--   ₦100,000 rent, withholds 10% = ₦10,000, hands the landlord ₦90,000 and
--   owes FIRS/NRS ₦10,000. The landlord's income is still ₦100,000 — the
--   expense is NOT reduced. This is a LIABILITY, exactly like VAT_PAYABLE.
--
--   RECEIVABLE (the pharmacy is the payee). A hospital buys ₦1,000,000 of
--   drugs on contract, withholds 2% = ₦20,000 and pays ₦980,000. The
--   pharmacy's revenue is still ₦1,000,000; the ₦20,000 is an ASSET — a
--   prepaid income-tax credit it later offsets against its own CIT bill.
--
-- THE INVARIANT THAT MATTERS, in both directions:
--
--     gross = net_paid + wht_amount
--
-- The gross figure is what hits the expense/revenue account. Only the CASH
-- leg is reduced. Getting this backwards understates expenses (payable
-- side) or revenue (receivable side) and produces a P&L that disagrees
-- with the invoices behind it.
--
-- RATES ARE DATA, NOT CODE. Nigerian WHT rates have changed repeatedly —
-- the Deduction of Tax at Source (Withholding) Regulations 2024, gazetted
-- 2 October 2024 and effective 1 January 2025, cut supply of goods from
-- 5%/2.5% to 2% and professional fees from 10% to 5%, while RAISING
-- directors' fees to 15%. A hardcoded table would be wrong within a year
-- and would need a redeploy to fix. The seeded rows below are the 2024
-- Regulations schedule for RESIDENT recipients; the owner can edit any
-- rate and add categories (client decision), and `is_system` marks the
-- ones this app shipped so a client edit is always distinguishable from a
-- default.
--
-- The small-company exemption (transaction ≤ ₦2,000,000 in the calendar
-- month AND the supplier holds a valid TIN) is deliberately advisory: the
-- app WARNS but never blocks (client decision, consistent with how default
-- demo PINs are handled). Whether a given pharmacy qualifies depends on
-- its own turnover, which this system does not authoritatively know.
-- ---------------------------------------------------------------------

CREATE TABLE wht_rates (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code          TEXT NOT NULL UNIQUE,   -- stable machine key, e.g. 'RENT'
    name          TEXT NOT NULL,          -- what a Nigerian bookkeeper calls it
    rate_percent  REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    direction     TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE','BOTH')) DEFAULT 'BOTH',
    is_system     INTEGER NOT NULL DEFAULT 0,  -- 1 = shipped by this app; a client edit is still allowed but stays distinguishable
    is_active     INTEGER NOT NULL DEFAULT 1,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_wht_rates_active ON wht_rates(is_active, is_deleted);

-- Every deduction, both directions, in one auditable place. This is what
-- backs the WHT report, the credit notes a pharmacy must issue to its
-- payees, and the monthly remittance figure (due by the 21st of the
-- following month).
CREATE TABLE wht_entries (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    direction       TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE')),
    -- What generated it. Not a FK: the source table varies by type, the
    -- same deliberate choice already made for gl_journal_entries.source_id.
    source_type     TEXT NOT NULL CHECK (source_type IN ('EXPENSE','SUPPLIER_PAYMENT','PO_RECEIVE','SALE')),
    source_id       TEXT NOT NULL,
    rate_code       TEXT NOT NULL,        -- snapshot of wht_rates.code at deduction time
    rate_percent    REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    -- The three money figures are ALL stored rather than derived, because
    -- a rate can be edited later and a historical deduction must never
    -- silently re-compute. gross = net + wht, enforced below.
    gross_amount    REAL NOT NULL CHECK (gross_amount >= 0),
    wht_amount      REAL NOT NULL CHECK (wht_amount >= 0),
    net_amount      REAL NOT NULL CHECK (net_amount >= 0),
    -- Counterparty, for the credit note. Exactly one of these is set in
    -- practice; both are nullable because a rent payment may name neither.
    supplier_id     TEXT REFERENCES suppliers(id),
    customer_id     TEXT REFERENCES customers(id),
    counterparty_name TEXT,               -- free text for a landlord/consultant with no supplier row
    counterparty_tin  TEXT,               -- required on a real credit note
    certificate_no  TEXT,                 -- the WHT credit note reference issued/received
    remitted_at     TEXT,                 -- NULL until remitted to the revenue authority
    remittance_ref  TEXT,
    recorded_by     TEXT NOT NULL REFERENCES users(id),
    entry_date      TEXT NOT NULL DEFAULT (datetime('now')),
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    -- STORAGE-LEVEL GUARD on the one invariant the whole feature rests on.
    -- Rounded to 2dp so IEEE-754 dust from money arithmetic cannot trip it,
    -- matching the tolerance already proven for the GL balance trigger.
    CHECK (ROUND(gross_amount - net_amount - wht_amount, 2) = 0)
);
CREATE INDEX idx_wht_entries_branch_date ON wht_entries(branch_id, entry_date);
CREATE INDEX idx_wht_entries_source ON wht_entries(source_type, source_id);
CREATE INDEX idx_wht_entries_remittance ON wht_entries(direction, remitted_at);

CREATE TABLE login_attempts (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    username      TEXT NOT NULL,          -- as submitted; may not correspond to a real user
    user_id       TEXT REFERENCES users(id),  -- resolved only when the username exists
    succeeded     INTEGER NOT NULL DEFAULT 0,
    ip_address    TEXT,                   -- CF-Connecting-IP, audit only (never used for lockout)
    user_agent    TEXT,
    attempted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The throttle's hot path: "how many FAILED attempts for this username
-- since <cutoff>?" Ordering by attempted_at lets the same index serve the
-- audit view's "most recent attempts" query.
CREATE INDEX idx_login_attempts_username_time ON login_attempts(username, attempted_at);

-- Retention pruning scans by timestamp alone.
CREATE INDEX idx_login_attempts_time ON login_attempts(attempted_at);

-- =====================================================================
-- GENERAL LEDGER & CHART OF ACCOUNTS  (double-entry accounting core)
-- =====================================================================
-- Every other ledger table in this schema (debtor_ledger,
-- creditor_ledger, expenses, plus sales/purchase-orders/stock_
-- adjustments themselves) is a purpose-built, single-purpose record of
-- ONE side of a transaction — e.g. debtor_ledger tracks "what a
-- customer owes" but has no notion of which GL account that debt lives
-- in, and expenses tracks "money spent" with no corresponding credit
-- to Cash/Bank. That is entirely sufficient for the operational
-- screens that read them (customer balance, supplier balance, till
-- reconciliation) but cannot answer accounting-standard questions like
-- "what is this branch's Profit & Loss for January?" or "what is the
-- pharmacy's Balance Sheet right now?" — those require a unified
-- General Ledger where every transaction posts as a BALANCED set of
-- debits and credits against a fixed Chart of Accounts (Assets,
-- Liabilities, Equity, Revenue, Expenses), independent of and
-- alongside the existing operational ledgers above (which are NOT
-- being removed or replaced — a cashier/manager's day-to-day workflow
-- is unchanged; the GL is a parallel, purely additive accounting layer
-- that automatically mirrors every money-movement event those
-- existing tables already record).
--
-- DESIGN PRINCIPLES:
--  1. NEVER a single-sided entry: every gl_journal_entries row is
--     backed by 2+ gl_journal_lines rows whose debits and credits sum
--     to exactly zero (enforced both in application code — see
--     server/services/glService.js's postJournalEntry() — AND by a
--     database trigger below as a second, storage-level line of
--     defense, matching this codebase's established "enforce
--     financial-integrity invariants at the database layer, not just
--     in application code" pattern used elsewhere, e.g.
--     stock_batches.quantity_remaining's CHECK >= 0 constraint).
--  2. NEVER edited or deleted after posting: correcting a mistake
--     posts a new REVERSING entry (debits/credits swapped), exactly
--     mirroring how voidSale() already reverses debtor_ledger by
--     inserting a new PAYMENT row rather than deleting the original
--     DEBIT row — this preserves a complete, tamper-evident audit
--     trail, which is the whole point of double-entry bookkeeping.
--  3. SOURCE-LINKED, not source-replacing: every journal entry stores
--     which existing table/row triggered it (source_type/source_id),
--     so "why does this account have this balance" is always
--     traceable back to the real sale/expense/payment/adjustment that
--     caused it — this GL is a derived, generated-from-events ledger,
--     never a place data is hand-entered outside of normal business
--     operations (no manual journal-entry UI is exposed to STAFF/
--     MANAGER; see gl_journal_entries.source_type's CHECK constraint,
--     which has no 'MANUAL' option in this initial implementation).
--  4. PER-BRANCH, mirroring the rest of this multi-branch schema: each
--     branch effectively has its own trial balance (gl_accounts is
--     shared/global — one Chart of Accounts for the whole
--     organization, matching standard multi-branch accounting
--     practice — but every gl_journal_entries row is branch-scoped,
--     exactly like sales/expenses/debtor_ledger/creditor_ledger
--     already are), so branch-scoped vs. organization-wide P&L/Balance
--     Sheet reporting both fall out naturally from the same tables.
-- ---------------------------------------------------------------------

-- Chart of Accounts. `account_type` drives which financial statement an
-- account appears on (ASSET/LIABILITY/EQUITY -> Balance Sheet;
-- REVENUE/EXPENSE -> Profit & Loss) and its NORMAL BALANCE side
-- (ASSET/EXPENSE accounts normally carry a debit balance; LIABILITY/
-- EQUITY/REVENUE accounts normally carry a credit balance) — see
-- glService.js's ACCOUNT_TYPE_NORMAL_BALANCE map for where this is
-- actually used when computing a human-readable balance sign.
-- `is_system` marks an account this application itself posts to
-- automatically (created by the seed data / migration below) as
-- distinct from any account an ADMIN might add later for their own
-- chart-of-accounts customization — system accounts cannot be deleted
-- (only deactivated via is_active) since the posting engine has a
-- hardcoded dependency on their `code` values existing.
CREATE TABLE gl_accounts (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code          TEXT NOT NULL UNIQUE,   -- short stable identifier the posting engine references directly, e.g. 'CASH', 'INVENTORY_ASSET', 'SALES_REVENUE'
    name          TEXT NOT NULL,          -- human-readable label shown in reports, e.g. "Cash on Hand"
    account_type  TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
    parent_id     TEXT REFERENCES gl_accounts(id),  -- optional grouping, e.g. per-category expense sub-accounts under a parent "Operating Expenses" header account
    description   TEXT,
    is_system     INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

-- One row per business event that has financial impact (a sale, a
-- purchase-order receipt, a customer/supplier payment, an expense, a
-- stock write-off, a sale void). `source_type`/`source_id` trace back
-- to the exact row in the pre-existing operational tables that caused
-- this posting — this is how "why is this account's balance what it
-- is" stays fully auditable back to real operational events, and also
-- how the posting engine detects "has this event already been
-- posted?" (see glService.js's idempotent-posting-by-source-lookup,
-- which prevents a double-post if, say, voidSale() and its GL-
-- reversal helper were ever accidentally invoked twice for the same
-- sale — the same "guard against double-processing the same source
-- event" principle already used for the controlled-substance
-- register's one-entry-per-dispense design elsewhere in this schema).
CREATE TABLE gl_journal_entries (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    entry_date    TEXT NOT NULL DEFAULT (datetime('now')),
    source_type   TEXT NOT NULL CHECK (source_type IN (
                      'SALE','SALE_VOID','PO_RECEIVE','CUSTOMER_PAYMENT','SUPPLIER_PAYMENT',
                      'EXPENSE','STOCK_ADJUSTMENT','STOCK_TRANSFER_OUT','STOCK_TRANSFER_IN','TILL_CLOSE','WHT_REMITTANCE',
                      -- BUG 95, three distinct events so the liability can be
                      -- aged and audited independently of the sale that made it:
                      'CHANGE_OWED',        -- shortfall recorded at the counter
                      'CHANGE_SETTLEMENT',  -- collected, or applied to a purchase
                      'CHANGE_WRITE_OFF',   -- OWNER wrote an unclaimed balance off
                      -- Branch safe: cash moving in or out of the shop's reserve,
                      -- and between the reserve and the counter drawer.
                      'SAFE_MOVEMENT'
                  )),
    source_id     TEXT NOT NULL,          -- id of the sales/expenses/etc. row that caused this entry (not a FK: the source table varies by source_type)
    description   TEXT,
    posted_by     TEXT REFERENCES users(id),   -- NULL for system-posted entries with no single acting user distinct from the source event's own recorded_by/served_by
    -- Transient internal state used ONLY to make the balanced-entry
    -- trigger below correct for a MULTI-LINE entry: postJournalEntry()
    -- (both backends) always inserts the entry row as 'DRAFT', then
    -- every one of its gl_journal_lines rows, then finally UPDATEs
    -- this column to 'POSTED' as the LAST statement in the same
    -- transaction/batch — which is exactly the moment the trigger below
    -- checks the balance, i.e. once and only once, after every line for
    -- this entry genuinely exists. Because the whole sequence runs
    -- inside one atomic transaction (db.transaction() on Node,
    -- db.batch() on the Cloudflare Worker), no other connection can
    -- ever observe a committed 'DRAFT' row — every row any query ever
    -- sees is already 'POSTED'. An earlier design used an AFTER INSERT
    -- trigger directly on gl_journal_lines instead, which was a real
    -- bug caught during schema review before this ever shipped: for a
    -- legitimate entry with 3+ lines, that trigger would incorrectly
    -- ABORT on the second line's insert (only 2 of 3 lines present yet,
    -- so the running sum is not zero) even though the complete entry,
    -- once fully inserted, balances perfectly fine.
    status        TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED')) DEFAULT 'DRAFT',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

-- The actual debit/credit lines for a journal entry. Exactly one of
-- debit/credit is non-zero per row (enforced by the CHECK below) —
-- this is the standard "single amount column split into two, mutually
-- exclusive per row" representation used by essentially every real
-- double-entry ledger implementation, rather than a signed single
-- amount column, because it makes "sum all debits" / "sum all credits"
-- trivial aggregate queries and makes an accidentally-flipped sign bug
-- structurally harder to introduce.
CREATE TABLE gl_journal_lines (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    journal_entry_id   TEXT NOT NULL REFERENCES gl_journal_entries(id),
    account_id         TEXT NOT NULL REFERENCES gl_accounts(id),
    debit              REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit             REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
    memo               TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

-- DATABASE-LEVEL ENFORCEMENT that every journal entry balances (total
-- debits = total credits) before it can ever transition to POSTED —
-- the second line of defense behind glService.js's own application-
-- level balance check performed before it ever issues the INSERTs,
-- matching this codebase's established pattern of never relying on
-- application code ALONE for a financial-integrity invariant (see
-- e.g. stock_batches.quantity_remaining's CHECK >= 0 constraint, which
-- is the actual concurrency-safety guarantee the Cloudflare D1
-- deployment depends on). Fires on the DRAFT -> POSTED transition
-- specifically (see the status column's comment above for why this
-- transition, not a per-line-insert trigger, is the structurally
-- correct place to check): if the sum of this entry's lines' debits
-- does not exactly equal the sum of its credits (rounded to kobo/cent
-- precision to tolerate harmless floating-point noise), or it has
-- fewer than 2 lines (a single-sided "entry" is not a real journal
-- entry at all), the UPDATE is aborted and the entire surrounding
-- transaction rolls back — the source event (sale/expense/payment/
-- etc.) that triggered this posting attempt is never left half-
-- applied, since every posting call site wraps the source event's own
-- writes and this GL posting in the SAME transaction (see
-- glService.js).
CREATE TRIGGER trg_gl_journal_entry_must_balance_before_posting
BEFORE UPDATE OF status ON gl_journal_entries
WHEN NEW.status = 'POSTED' AND OLD.status = 'DRAFT'
BEGIN
  -- Cloudflare D1's remote parser mishandles a bare `SELECT CASE` inside a
  -- trigger (it returns SQLITE_ERROR: incomplete input, although SQLite and
  -- local D1 accept it). Parenthesising the CASE is semantically identical and
  -- is the verified remote-safe form — see Cloudflare workers-sdk issue #4326.
  SELECT (CASE
    WHEN (SELECT COUNT(*) FROM gl_journal_lines WHERE journal_entry_id = NEW.id) < 2
      THEN RAISE(ABORT, 'gl_journal_entries: cannot post an entry with fewer than 2 lines')
    WHEN (
      SELECT ROUND(COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0), 2)
      FROM gl_journal_lines WHERE journal_entry_id = NEW.id
    ) != 0
      THEN RAISE(ABORT, 'gl_journal_entries: entry does not balance (sum of debits must equal sum of credits)')
  END);
END;

-- =====================================================================
-- INDEXES
-- =====================================================================
CREATE INDEX idx_users_branch                ON users(branch_id);
CREATE INDEX idx_stock_batches_branch        ON stock_batches(branch_id);
CREATE INDEX idx_stock_batches_product       ON stock_batches(product_id);
CREATE INDEX idx_stock_batches_expiry        ON stock_batches(expiry_date);
CREATE INDEX idx_stock_batches_branch_prod   ON stock_batches(branch_id, product_id, expiry_date);
CREATE INDEX idx_po_receipts_po              ON purchase_order_receipts(purchase_order_id);
CREATE INDEX idx_sales_branch                ON sales(branch_id);
CREATE INDEX idx_sales_created               ON sales(created_at);
CREATE INDEX idx_sale_items_sale             ON sale_items(sale_id);
CREATE INDEX idx_sale_items_batch            ON sale_items(stock_batch_id);
CREATE INDEX idx_sale_payments_sale          ON sale_payments(sale_id);
CREATE INDEX idx_debtor_ledger_customer      ON debtor_ledger(customer_id);
CREATE INDEX idx_debtor_ledger_branch        ON debtor_ledger(branch_id);
CREATE INDEX idx_creditor_ledger_branch      ON creditor_ledger(branch_id);
CREATE INDEX idx_expenses_branch             ON expenses(branch_id);
CREATE INDEX idx_till_sessions_branch        ON till_sessions(branch_id);
-- Enforces "at most one OPEN till session per branch" at the database
-- level (a partial unique index only applies to rows matching the
-- WHERE clause) — this is the authoritative guarantee the Cloudflare D1
-- deployment relies on for race-safety since it has no interactive
-- transactions to lock against; it's a useful second line of defense
-- on the Node deployment too.
CREATE UNIQUE INDEX idx_till_sessions_one_open_per_branch ON till_sessions(branch_id) WHERE status = 'OPEN' AND is_deleted = 0;
CREATE INDEX idx_stock_adjustments_batch     ON stock_adjustments(stock_batch_id);
CREATE INDEX idx_stock_transfers_from        ON stock_transfers(from_branch_id);
CREATE INDEX idx_stock_transfers_to          ON stock_transfers(to_branch_id);
CREATE INDEX idx_prescriptions_sale          ON prescriptions(sale_id);
CREATE INDEX idx_controlled_register_branch  ON controlled_substance_register(branch_id, created_at);
CREATE INDEX idx_controlled_register_product ON controlled_substance_register(product_id);
-- Prevents the tamper-evident hash chain from forking under concurrent
-- controlled-drug dispensing at the same branch — see migration 010 for
-- the full, live-verified rationale (a real bug found on the Cloudflare
-- D1 deployment, not present on the Node/better-sqlite3 deployment's
-- serialized transactions). 'GENESIS' (application-level constant
-- CHAIN_GENESIS_MARKER) is stored in prev_hash for a branch's very
-- first entry instead of NULL, since SQL's NULL != NULL would otherwise
-- let two concurrent "first ever entry" inserts both succeed.
CREATE UNIQUE INDEX idx_controlled_register_chain_link ON controlled_substance_register(branch_id, prev_hash);
CREATE INDEX idx_stocktake_lines_session     ON stocktake_lines(stocktake_id);
-- Same rationale as idx_till_sessions_one_open_per_branch above: enforces
-- "at most one OPEN stocktake session per branch" at the database level.
CREATE UNIQUE INDEX idx_stocktake_one_open_per_branch ON stocktake_sessions(branch_id) WHERE status = 'OPEN' AND is_deleted = 0;
CREATE INDEX idx_price_overrides_branch_prod ON product_price_overrides(branch_id, product_id);
CREATE INDEX idx_sync_change_log_synced_at   ON sync_change_log(synced_at);
CREATE INDEX idx_sync_change_log_branch      ON sync_change_log(branch_id, synced_at);
CREATE INDEX idx_attendance_branch_date      ON staff_attendance(branch_id, clock_in_at);
CREATE INDEX idx_gl_accounts_type            ON gl_accounts(account_type);
CREATE INDEX idx_gl_journal_entries_branch   ON gl_journal_entries(branch_id, entry_date);
CREATE INDEX idx_gl_journal_entries_source   ON gl_journal_entries(source_type, source_id);
CREATE INDEX idx_gl_journal_lines_entry      ON gl_journal_lines(journal_entry_id);
CREATE INDEX idx_gl_journal_lines_account    ON gl_journal_lines(account_id);
CREATE INDEX idx_attendance_user_date        ON staff_attendance(user_id, clock_in_at);
-- Enforces "at most one open (not yet clocked out) shift per staff
-- member" at the database level — same rationale as the till/stocktake
-- partial unique indexes above.
CREATE UNIQUE INDEX idx_attendance_one_open_per_user ON staff_attendance(user_id) WHERE clock_out_at IS NULL AND is_deleted = 0;

-- =====================================================================
-- VIEWS
-- =====================================================================

-- Per-branch daily sales (soft-delete + void aware).
--
-- Bucketed by West Africa Time (WAT, UTC+1 — fixed year-round offset,
-- Nigeria observes no DST), not raw UTC: `created_at` is stored in UTC
-- (SQLite's `datetime('now')` default), but this is a Nigeria-only
-- product whose staff think and report in Lagos wall-clock time. Using
-- raw `date(created_at)` would bucket any sale made between 00:00 and
-- 00:59 Lagos time under the PREVIOUS calendar day, every single day —
-- a real bug found and fixed via migration 009 (see that file's comment
-- for the full live-verified impact). `date(created_at, '+1 hours')`
-- shifts UTC forward to WAT before truncating to a calendar date.
CREATE VIEW v_daily_sales_by_branch AS
SELECT
    branch_id,
    date(created_at, '+1 hours')  AS sale_date,
    COUNT(*)          AS transaction_count,
    SUM(total)        AS gross_sales,
    SUM(discount)     AS total_discount
FROM sales
WHERE status = 'COMPLETED' AND is_deleted = 0
GROUP BY branch_id, date(created_at, '+1 hours');

-- Organization-wide daily total (manager's "TOTAL" view)
CREATE VIEW v_daily_sales_total AS
SELECT
    sale_date,
    SUM(transaction_count) AS transaction_count,
    SUM(gross_sales)       AS gross_sales,
    SUM(total_discount)    AS total_discount
FROM v_daily_sales_by_branch
GROUP BY sale_date;

-- Current stock value, per branch
CREATE VIEW v_stock_value_by_branch AS
SELECT
    branch_id,
    SUM(quantity_remaining * cost_price_per_unit)    AS stock_value_at_cost,
    SUM(quantity_remaining * selling_price_per_unit) AS stock_value_at_retail
FROM stock_batches
WHERE is_deleted = 0
GROUP BY branch_id;

-- Expiry alerts across all branches (manager) or filter by branch_id (staff)
CREATE VIEW v_expiry_alerts AS
SELECT
    sb.id AS batch_id,
    sb.branch_id,
    b.name AS branch_name,
    p.name AS product_name,
    sb.batch_no,
    sb.expiry_date,
    sb.quantity_remaining,
    CAST(julianday(sb.expiry_date) - julianday('now') AS INTEGER) AS days_to_expiry
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
WHERE sb.quantity_remaining > 0
  AND sb.expiry_date IS NOT NULL
  AND sb.is_deleted = 0
ORDER BY sb.expiry_date ASC;

-- Low stock alerts (quantity_remaining below product reorder_level, per branch)
CREATE VIEW v_low_stock_alerts AS
SELECT
    sb.branch_id,
    b.name AS branch_name,
    p.id AS product_id,
    p.name AS product_name,
    p.reorder_level,
    SUM(sb.quantity_remaining) AS quantity_on_hand
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
WHERE sb.is_deleted = 0
GROUP BY sb.branch_id, p.id
HAVING quantity_on_hand <= p.reorder_level;

-- Outstanding debtor balances (customers who still owe)
CREATE VIEW v_debtor_balances AS
SELECT
    branch_id,
    customer_id,
    SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END) AS balance_owed
FROM debtor_ledger
WHERE is_deleted = 0
GROUP BY branch_id, customer_id
HAVING balance_owed > 0;

-- Outstanding creditor balances (what the pharmacy owes suppliers)
CREATE VIEW v_creditor_balances AS
SELECT
    branch_id,
    supplier_id,
    SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END) AS balance_owed
FROM creditor_ledger
WHERE is_deleted = 0
GROUP BY branch_id, supplier_id
HAVING balance_owed > 0;

-- Manager's sync-health dashboard: every branch + its latest sync status,
-- with a computed ONLINE/STALE/OFFLINE flag based on heartbeat recency.
CREATE VIEW v_branch_sync_overview AS
SELECT
    b.id AS branch_id,
    b.name AS branch_name,
    s.device_id,
    s.app_version,
    s.last_heartbeat_at,
    s.last_push_at,
    s.last_pull_at,
    COALESCE(s.pending_push_count, 0) AS pending_push_count,
    s.last_sync_error,
    CASE
        WHEN s.last_heartbeat_at IS NULL THEN 'NEVER_SYNCED'
        WHEN (julianday('now') - julianday(s.last_heartbeat_at)) * 24 * 60 <= 5  THEN 'ONLINE'
        WHEN (julianday('now') - julianday(s.last_heartbeat_at)) * 24 * 60 <= 60 THEN 'STALE'
        ELSE 'OFFLINE'
    END AS connectivity_status
FROM branches b
LEFT JOIN branch_sync_status s ON s.branch_id = b.id
WHERE b.is_deleted = 0;

-- Branches whose PCN/PPMV premises licence or superintendent pharmacist
-- registration is expired or expiring soon — surfaced on the manager
-- dashboard so a renewal is never missed (a lapsed licence is a direct
-- regulatory/operational risk for the business).
CREATE VIEW v_license_expiry_alerts AS
SELECT
    id AS branch_id,
    name AS branch_name,
    license_type,
    pcn_license_no,
    pcn_license_expiry_date,
    CAST(julianday(pcn_license_expiry_date) - julianday('now') AS INTEGER) AS pcn_days_to_expiry,
    superintendent_pharmacist,
    superintendent_registration_expiry_date,
    CAST(julianday(superintendent_registration_expiry_date) - julianday('now') AS INTEGER) AS superintendent_days_to_expiry
FROM branches
WHERE is_deleted = 0
  AND (
    (pcn_license_expiry_date IS NOT NULL AND julianday(pcn_license_expiry_date) - julianday('now') <= 90)
    OR (superintendent_registration_expiry_date IS NOT NULL AND julianday(superintendent_registration_expiry_date) - julianday('now') <= 90)
  );

-- Per-staff void/refund activity — a manager-facing fraud/shrinkage
-- signal. A staff member who voids an unusually high share of their own
-- completed sales (relative to their total transaction count) is worth a
-- closer look; this view surfaces the raw counts so the app/manager can
-- rank and threshold it however they like.
CREATE VIEW v_void_audit_by_user AS
SELECT
    s.branch_id,
    s.served_by AS user_id,
    u.full_name AS user_full_name,
    COUNT(*) AS total_sales,
    SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voided_sales,
    SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END) AS voided_value,
    ROUND(100.0 * SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS void_rate_pct
FROM sales s
JOIN users u ON u.id = s.served_by
WHERE s.is_deleted = 0
GROUP BY s.branch_id, s.served_by;

-- ---------------------------------------------------------------------
-- GENERAL LEDGER REPORTING VIEWS
-- ---------------------------------------------------------------------
-- Per-branch, per-account running balance — the foundational view every
-- other GL report (trial balance, P&L, Balance Sheet) is built from.
-- Returns RAW debit/credit totals, not a signed "balance" figure, since
-- whether a bigger debit or bigger credit total represents a positive
-- or negative balance depends on the account's normal-balance side
-- (ASSET/EXPENSE = debit-normal, LIABILITY/EQUITY/REVENUE =
-- credit-normal) — that sign convention is applied in
-- server/services/glService.js's / worker/src/services/glService.js's
-- getTrialBalance(), not baked into this view, so the same raw numbers
-- stay meaningful regardless of which report is reading them.
CREATE VIEW v_gl_account_balances AS
SELECT
    gje.branch_id,
    gjl.account_id,
    ga.code AS account_code,
    ga.name AS account_name,
    ga.account_type,
    COALESCE(SUM(gjl.debit), 0) AS total_debits,
    COALESCE(SUM(gjl.credit), 0) AS total_credits
FROM gl_journal_lines gjl
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
JOIN gl_accounts ga ON ga.id = gjl.account_id
WHERE gje.status = 'POSTED' AND gje.is_deleted = 0
GROUP BY gje.branch_id, gjl.account_id;

-- Organization-wide (all-branches) equivalent of v_gl_account_balances,
-- for a manager/owner viewing consolidated financials rather than one
-- branch's own books — mirrors the same branch-scoped/organization-wide
-- dual-view pattern already used throughout this schema (e.g.
-- v_daily_sales_by_branch vs. v_daily_sales_total).
CREATE VIEW v_gl_account_balances_total AS
SELECT
    gjl.account_id,
    ga.code AS account_code,
    ga.name AS account_name,
    ga.account_type,
    COALESCE(SUM(gjl.debit), 0) AS total_debits,
    COALESCE(SUM(gjl.credit), 0) AS total_credits
FROM gl_journal_lines gjl
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
JOIN gl_accounts ga ON ga.id = gjl.account_id
WHERE gje.status = 'POSTED' AND gje.is_deleted = 0
GROUP BY gjl.account_id;

-- =====================================================================
-- EXAMPLE ACCESS PATTERNS (how the app enforces manager vs staff scope)
-- =====================================================================
-- STAFF dashboard — always filtered to their own branch:
--   SELECT * FROM v_daily_sales_by_branch WHERE branch_id = :current_user_branch_id;
--   SELECT * FROM v_expiry_alerts        WHERE branch_id = :current_user_branch_id;
--
-- MANAGER dashboard — TOTAL across every branch:
--   SELECT * FROM v_daily_sales_total;
--   SELECT SUM(stock_value_at_cost) FROM v_stock_value_by_branch;
--
-- MANAGER drilling into ONE branch (same views, just add the filter):
--   SELECT * FROM v_daily_sales_by_branch WHERE branch_id = :chosen_branch_id;
--
-- MANAGER sync dashboard:
--   SELECT * FROM v_branch_sync_overview ORDER BY connectivity_status, branch_name;

-- =====================================================================
-- DEFAULT CLIENT SETTINGS ROW
-- =====================================================================
-- A fresh install always has exactly one client_settings row so
-- /api/dashboard/plan and /api/admin/settings never have to
-- special-case "no row yet". The ADMIN (vendor, via the Admin Portal)
-- updates these values as part of onboarding this specific paying
-- client (see migrations/006 and 007 for how an EXISTING database
-- picks this up on upgrade).
INSERT INTO client_settings (id, max_branches, max_staff, subscription_status, subscription_plan)
VALUES (1, 5, 25, 'ACTIVE', 'Standard');

-- =====================================================================
-- DEFAULT CHART OF ACCOUNTS (system accounts the posting engine
-- references directly by `code` — see server/services/glService.js's
-- ACCOUNTS map). A fresh install always has exactly these accounts so
-- every source event (sale, expense, payment, stock write-off, PO
-- receipt) has somewhere to post from the very first transaction —
-- mirrors the same "a fresh install always has exactly one
-- client_settings row so nothing has to special-case its absence"
-- principle immediately above. An ADMIN/OWNER may add further, non-
-- system accounts later (e.g. a real "Bank — GTBank Current Account"
-- once bank reconciliation is wired up) via the Chart of Accounts
-- screen, but these `is_system = 1` rows themselves are permanent —
-- the posting engine has a hardcoded dependency on their `code` values
-- always existing and being active.
-- ---------------------------------------------------------------------
-- ASSETS
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'CASH', 'Cash on Hand', 'ASSET', 1, 'Physical cash in till drawers across all branches — debited by CASH sale payments, credited by CASH expenses.'),
  (lower(hex(randomblob(16))), 'BANK_POS_CLEARING', 'Bank / POS Clearing Account', 'ASSET', 1, 'POS card and bank transfer payments received — a clearing account representing funds that have been paid electronically but not yet manually reconciled against a real bank statement (see the Bank Reconciliation feature).'),
  (lower(hex(randomblob(16))), 'ACCOUNTS_RECEIVABLE', 'Accounts Receivable (Customer Debts)', 'ASSET', 1, 'Money owed TO the pharmacy by customers on credit sales — mirrors the debtor_ledger operational table''s total.'),
  (lower(hex(randomblob(16))), 'INVENTORY_ASSET', 'Inventory Asset', 'ASSET', 1, 'The cost-basis value of stock on hand — debited when stock is received (at cost), credited when stock is sold (at cost, via Cost of Goods Sold) or written off (via Inventory Shrinkage Expense).'),
  (lower(hex(randomblob(16))), 'WHT_RECEIVABLE', 'Withholding Tax Receivable (Prepaid Income Tax)', 'ASSET', 1, 'Withholding tax that CUSTOMERS have deducted from payments to this pharmacy — typically a hospital, NGO or government buyer withholding 2% on a contract supply. The pharmacy''s revenue is still the GROSS invoice value; this account holds the withheld slice as a prepaid income-tax credit the pharmacy later offsets against its own Companies Income Tax liability, supported by the WHT credit note the customer must issue. Debited when a WHT-bearing sale is recorded, cleared when the credit is actually utilised against a tax assessment. This is an ASSET the pharmacy owns, NOT an expense, and it must never be netted against WHT Payable — the two are owed in opposite directions to different parties.'),
  (lower(hex(randomblob(16))), 'INTER_BRANCH_TRANSFER_CLEARING', 'Inter-Branch Transfer Clearing', 'ASSET', 1, 'A per-organization clearing account used ONLY as the offsetting side of an inter-branch stock transfer''s two independent, branch-scoped journal entries (see glService.js''s postStockTransferOut()/postStockTransferIn()): the sending branch DEBITS this account and CREDITS Inventory Asset (removing the transferred stock''s cost value from its own books); the receiving branch DEBITS Inventory Asset and CREDITS this same account (adding it back at the new branch). Since both entries reference the identical account and amount, this account''s organization-wide balance nets to exactly zero at all times — a non-zero organization-wide balance would indicate a transfer that was only ever posted on one side, which should never happen since both legs post inside the same /receive transaction/batch.');

INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'BRANCH_SAFE', 'Cash in Branch Safe', 'ASSET', 1,
   'Cash held at a branch OUTSIDE the counter drawer — the shop safe. A second, separate pot from CASH (Cash on Hand), which is the till and is reconciled at every till close. Money moves between them explicitly (branch_safe_ledger.entry_type = TILL_TRANSFER) and never implicitly. The safe is what funds a supplier delivery or a rent payment that the drawer could never cover; recording those against CASH is what produced a physically impossible negative till balance before the safe existed (Bug 96). DEBITED by deposits and by cash swept up from the drawer; CREDITED when it pays an expense, pays a supplier, or tops the drawer back up. Only the OWNER, a GENERAL MANAGER, or that branch''s own BRANCH MANAGER may move it.');

INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'CHANGE_OWED_PAYABLE', 'Change Owed to Customers', 'LIABILITY', 1,
   'Cash the pharmacy is holding because it could not give a customer their change — the classic "no N100 note" event at a Nigerian counter. CREDITED when a sale is completed with a change shortfall (the full tendered cash is debited to CASH, so the drawer reconciles to what is physically in it); DEBITED when the customer collects the money, when it is applied against a later purchase, or when the OWNER writes an unclaimed balance off to other income. A non-zero balance is other people''s money sitting in the till, and it must never be netted against Accounts Receivable — a customer who is owed change may simultaneously owe the pharmacy on credit, and the two are settled independently.');

-- Written-off unclaimed change lands here rather than in Sales Revenue: it is
-- not a sale, it is a windfall, and keeping it separate stops it flattering
-- the gross-margin figures an owner uses to judge buying and pricing.
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'OTHER_INCOME', 'Other Income', 'REVENUE', 1,
   'Income that is not a sale of goods. Currently: unclaimed customer change written off by the OWNER after a deliberate decision (see change_owed.status = WRITTEN_OFF). Kept out of Sales Revenue so gross margin continues to describe trading performance only.');

-- LIABILITIES
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'ACCOUNTS_PAYABLE', 'Accounts Payable (Supplier Debts)', 'LIABILITY', 1, 'Money the pharmacy owes its suppliers on credit purchases — mirrors the creditor_ledger operational table''s total.'),
  (lower(hex(randomblob(16))), 'VAT_PAYABLE', 'VAT Payable', 'LIABILITY', 1, 'VAT collected on sales, owed to FIRS — only ever posted to when the optional VAT/tax tracking feature is enabled (see client_settings.vat_enabled); zero balance for any deployment that has not turned it on.'),
  (lower(hex(randomblob(16))), 'WHT_PAYABLE', 'Withholding Tax Payable', 'LIABILITY', 1, 'Withholding tax the pharmacy has DEDUCTED at source from its own payments (rent, professional fees, supplier invoices) and now owes the revenue authority, due by the 21st of the following month. Credited when a WHT-bearing expense/supplier payment/PO receipt is recorded, debited when the deduction is remitted. Critically, the deduction does NOT reduce the expense: the full gross amount still hits the expense account and only the CASH leg is reduced, because the payee''s income — and therefore the pharmacy''s cost — is the gross figure. A non-zero balance here is money the pharmacy is holding on behalf of FIRS/NRS, not its own cash to spend.');

-- EQUITY
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'RETAINED_EARNINGS', 'Retained Earnings', 'EQUITY', 1, 'Accumulated net profit/loss carried forward — the Balance Sheet''s plug figure that makes Assets = Liabilities + Equity balance; this deployment does not currently run a period-close/roll-forward process (see the Financial Closing Periods feature), so this stays at its opening value until that is used.');

-- REVENUE
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'SALES_REVENUE', 'Sales Revenue', 'REVENUE', 1, 'Gross revenue from completed sales, before discounts — credited by every sale''s subtotal.'),
  (lower(hex(randomblob(16))), 'SALES_DISCOUNTS', 'Sales Discounts', 'REVENUE', 1, 'Contra-revenue account: discounts given on sales are DEBITED here (reducing net revenue) rather than netted directly against Sales Revenue, so the Chart of Accounts can report gross sales and total discounts given as separate, independently useful figures.');

-- EXPENSES
INSERT INTO gl_accounts (id, code, name, account_type, is_system, description) VALUES
  (lower(hex(randomblob(16))), 'COST_OF_GOODS_SOLD', 'Cost of Goods Sold', 'EXPENSE', 1, 'The cost-basis (not selling price) of stock sold — debited (and Inventory Asset credited) at the same moment a sale is completed, so gross profit (Sales Revenue − COGS) is always immediately correct.'),
  (lower(hex(randomblob(16))), 'INVENTORY_SHRINKAGE_EXPENSE', 'Inventory Shrinkage Expense', 'EXPENSE', 1, 'Stock written off via damage, theft, expiry, or a stocktake variance shortfall (server/routes/adjustments.js, stocktakeService.js) — debited here and Inventory Asset credited, at cost. A stocktake/manual-correction SURPLUS (a positive quantity_change — physical count higher than system expected) posts the reverse direction against this same account, i.e. this account can show a net CREDIT balance for a branch with more surplus corrections than genuine shrinkage, which is itself a useful anomaly signal (surpluses are far rarer than shrinkage in a legitimate pharmacy and are worth a manager''s attention).'),
  (lower(hex(randomblob(16))), 'OPERATING_EXPENSES', 'Operating Expenses', 'EXPENSE', 1, 'Parent header account grouping every per-category expense sub-account below (Rent, Generator Fuel, Salaries, etc. — see gl_accounts.parent_id and glService.js''s getOrCreateExpenseCategoryAccount(), which auto-creates a new child account here the first time a given expenses.category value is used, matching this schema''s existing "grow the catalog from real usage, never require upfront configuration" philosophy already used for e.g. products/suppliers).'),
  (lower(hex(randomblob(16))), 'CASH_OVER_SHORT', 'Cash Over/Short', 'EXPENSE', 1, 'Till-close cash discrepancies (physically counted cash vs. system-expected cash, from till_sessions.discrepancy) — see glService.js''s postTillClose(). A SHORTAGE (counted less than expected) debits this account (an expense — cash is unaccountably missing); an OVERAGE (counted more than expected) credits it (effectively negative expense/found money). Also credited/debited against Cash on Hand so the CASH account always reflects the true PHYSICALLY COUNTED figure after every till close, not the theoretical expected figure — without this posting, small recurring till-counting errors or till-level theft would silently and permanently drift the Cash account away from physical reality with no accounting trail.');

-- ---------------------------------------------------------------------
-- WHT RATE SCHEDULE — Deduction of Tax at Source (Withholding)
-- Regulations 2024, gazetted 2 October 2024, effective 1 January 2025.
-- ---------------------------------------------------------------------
-- RESIDENT recipient rates. These supersede the older figures still in
-- wide circulation: supply of goods is now 2% (not 5% or 2.5%), and
-- professional/consultancy/technical/management fees are now 5% (not
-- 10%), while directors' fees ROSE to 15%. Using a stale rate under- or
-- over-deducts, and both create problems with the revenue authority.
--
-- Seeded as `is_system = 1` but fully editable by the owner: Nigerian
-- rates change, and a pharmacy must be able to correct one without
-- waiting for a software release. Non-resident recipients attract higher
-- rates in several categories; a client who deals with non-residents adds
-- those as their own rows rather than this app guessing residency.
INSERT INTO wht_rates (id, code, name, rate_percent, direction, is_system, note) VALUES
  (lower(hex(randomblob(16))), 'RENT', 'Rent, Hire or Lease', 10.0, 'BOTH', 1, 'Rent on land, buildings or equipment. 10% for resident corporate and non-corporate recipients.'),
  (lower(hex(randomblob(16))), 'PROFESSIONAL_FEES', 'Professional, Consultancy, Technical & Management Fees', 5.0, 'BOTH', 1, 'Reduced from 10% to 5% by the 2024 Regulations for residents. Non-residents attract 10%, treated as a final tax.'),
  (lower(hex(randomblob(16))), 'COMMISSION', 'Commission & Brokerage', 5.0, 'BOTH', 1, '5% for residents; 10% for non-residents.'),
  (lower(hex(randomblob(16))), 'SUPPLY_OF_GOODS', 'Supply of Goods or Materials', 2.0, 'BOTH', 1, 'Reduced to 2% by the 2024 Regulations. IMPORTANT EXEMPTION: goods manufactured or materials produced by the supplier itself are NOT liable — so a deduction against a manufacturer is usually wrong, while a distributor or wholesaler is liable.'),
  (lower(hex(randomblob(16))), 'OTHER_SERVICES', 'Supply or Rendering of Other Services', 2.0, 'BOTH', 1, 'Any service not specifically listed in the Schedule: 2% for residents, 5% for non-residents. Covers cleaning, security, haulage and similar.'),
  (lower(hex(randomblob(16))), 'CONSTRUCTION', 'Construction of Roads, Bridges, Buildings & Power Plants', 2.0, 'PAYABLE', 1, '2% for residents. Other construction and related activities attract 5%.'),
  (lower(hex(randomblob(16))), 'DIRECTORS_FEES', 'Directorsّ Fees', 15.0, 'PAYABLE', 1, 'INCREASED to 15% by the 2024 Regulations for residents (20% non-resident, final tax). Note some practitioners argue s.72 PITA''s 10% still governs; the owner can edit this rate if their tax adviser directs otherwise.'),
  (lower(hex(randomblob(16))), 'DIVIDEND_INTEREST', 'Dividend & Interest', 10.0, 'BOTH', 1, 'Unchanged at 10%. Interest and fees paid to a Nigerian bank by direct debit of funds domiciled with that bank are exempt.'),
  (lower(hex(randomblob(16))), 'ROYALTY', 'Royalty', 10.0, 'BOTH', 1, '10% to corporate recipients, 5% to individuals.');
