# PharmaRidge — Historical Functionality & Audit Inventory (Artifact Claim)

> **Archived evidence, not current certification.** This report was included in the source artifact. Its referenced test sources, test totals, Git history, and remote Cloudflare evidence were not included in the current recovery, so the execution claims below cannot presently be reproduced. It remains useful as an audit backlog and a list of intended guarantees, but not as a release approval. See [docs/RECOVERY-STATUS.md](docs/RECOVERY-STATUS.md) and [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).

**Artifact date:** 2026-08-01 · **Artifact claim:** never deployed to real Cloudflare

---

## PART 1 — THE FOUR ROLES AND WHAT EACH CAN DO

Rank order (higher = more authority). `ROLE_RANK` in `worker/src/lib/auth.js`:

| Rank | Role | Who it is | Branch scope |
|---|---|---|---|
| 4 | **ADMIN** | PharmaRidge's own support seat (the vendor) | Org-wide, schema-enforced `branch_id IS NULL` |
| 3 | **OWNER** | The pharmacy proprietor | Org-wide, schema-enforced `branch_id IS NULL` |
| 2 | **MANAGER** | Hired management | **Either** — this is the whole distinction (below) |
| 1 | **STAFF** | Cashier / sales attendant | Exactly one branch, schema-enforced `NOT NULL` |

### The two manager kinds are DERIVED, never stored

`roleLabel()` computes the title from `branch_id` alone:

- **General Manager** — `role='MANAGER'`, `branch_id IS NULL` → sees and runs every branch
- **Branch Manager** — `role='MANAGER'`, `branch_id` set → full manager powers, one branch only

There is deliberately **one** stored role value. A second column would create two facts
that can silently disagree, and the security-relevant one is `branch_id` — every
authorisation decision routes through `pinnedBranchIdOf()`. Promoting a Branch Manager to
General Manager is therefore a one-field change with no role migration and no re-issued JWTs.

### 1.1 STAFF (cashier) — 59 executed checks

| Can | Cannot |
|---|---|
| Record sales (POS), online **and fully offline** | See any other branch's anything (`BRANCH_SCOPE_VIOLATION`) |
| Open/close **their own** till only | Close a colleague's till (`STAFF_CLOSE_NOT_OWN_TILL`) |
| Clock in/out (GPS or registered-device) | Approve their own flagged shift |
| Void **own** sale, inside a window, till open, if owner allows | Void anyone else's sale, or outside the window |
| Adjust stock up to a capped allowance, if owner allows | Exceed the cap |
| Receive stock, raise POs, start a stocktake | Read supplier debt, tax, or expenses (manager-and-above) |
| See supplier **id + name only** (projection, Bug 72) | See supplier phone/address |
| Record customers/debtors | Change prices, VAT, WHT, or permissions |

Defaults are owner-tunable: 15-minute void window, 5-unit adjustment cap.

### 1.2 MANAGER — 65 executed checks

Everything STAFF can do, plus: full supplier records, expenses, purchase orders,
stock transfers, stocktake force-close, till **force-close** (reason mandatory),
attendance **override** and **force-clock-out** (reason mandatory), user management
below their own rank, PIN resets, lockout clearing, and the accounting/GL reports.

**A Branch Manager is fenced to their branch** — verified live: cannot read another
branch's roster, stock value, attendance or tills; cannot pull stock out of another
branch; cannot register a device into another branch; cannot transfer a person out of,
or into, a branch they do not run.

Cannot: VAT, WHT rates, manager/cashier permissions, plan settings (all `ownerOnly`);
cannot modify a peer manager; cannot promote anyone to OWNER; cannot approve their own
flagged attendance (Bug 71); cannot force-clock-out themselves (Bug 74).

### 1.3 OWNER (proprietor) — 57 executed checks

Everything a General Manager can do, plus the `ownerOnly` set: **VAT** rate and
enablement, **withholding-tax** rates (2024 Regulations schedule, editable),
**manager/cashier permissions** (who may void, approve expenses, change prices,
receive on credit, and the STAFF caps), and read-only visibility of their plan usage.

Cannot: create an ADMIN; be removed while they are the **last active owner**
(Bug 70 — blocks deactivate, delete **and** demote-by-transfer); transfer themselves.

### 1.4 ADMIN (vendor support seat) — 151 executed checks

Client-plan administration: subscription status, seat/branch limits, feature toggles,
branding, and support access to any client screen. Can reset any PIN and clear any lock.

**Deliberately not an employee** (`VENDOR_SEAT_NOT_AN_EMPLOYEE`): cannot clock in,
open a till, or record a sale; consumes **no paid staff slot**; hidden from the client's
own user list (returns **404, not 403** — the seat's existence is not disclosed).

Honest limitation, un-closeable by code: an ADMIN **can** reset a user's PIN and sign in
as them — inherent to any password-reset capability. Verified it cannot be *silent*:
the reset is attributed, and the old PIN stops working immediately.

---

## PART 2 — APPLICATION FUNCTIONALITY

**113 backend routes** across 26 modules. Exactly **2** are legitimately unreferenced by
the frontend (`GET /api/health`, `GET /api/branding/logo`) — enforced by a test, so no
backend capability can be added without a UI path.

| Module | Routes | What it does |
|---|---|---|
| `sales` | 4 | POS sale, void (with reason + authority rules), lookup, receipt data |
| `till` | 5 | Open, close, force-close, expected-cash computation, session list |
| `stock` | 4 | Batches, FEFO picking, expiry alerts, valuation |
| `stocktakes` | 6 | Open session, count lines, close with variance→adjustments, force-cancel |
| `adjustments` | 2 | Damage / expired / theft / correction / stocktake variance |
| `products` | 6 | Catalog, per-branch price overrides, POM & controlled flags |
| `catalog` | 6 | 6,801-row NAFDAC catalog search |
| `purchaseOrders` | 5 | Raise, receive (partial/full), cancel |
| `transfers` | 5 | Branch-to-branch stock: push, in-transit, receive, cancel |
| `suppliers` / `creditors` | 3 / 2 | Suppliers (role-projected), supplier debt & payments |
| `customers` | 5 | Customers, debtors, credit sales, repayments |
| `expenses` | 3 | Record, approve, list |
| `gl` | 5 | Double-entry ledger, trial balance, P&L, balance sheet |
| `wht` | 6 | Withholding tax payable *and* receivable, rates, remittance |
| `attendance` | 9 | Clock in/out, geofence/device verification, override, **force-clock-out**, device registry |
| `users` | 9 | CRUD, **transfer & promote**, **assignment history**, unlock, default-PIN warning |
| `branches` | 3 | Create, edit, deactivate (blocks all new branch-scoped activity) |
| `settings` | 4 | VAT, WHT, manager/staff permissions |
| `admin` | 2 | Vendor plan & client administration |
| `sync` | 5 | Offline queue push/pull, heartbeat, conflict review |
| `dashboard` | 7 | Summaries, plan usage, alerts |
| `branding` | 2 | Client logo & business identity |
| `auth` | 1 | Login (throttled, 8 failures → 15-min lock) |

**Database:** 41 tables · 14 views · 1 balance-enforcing trigger · 64 indexes.

**Cross-cutting guarantees, all executed:**
- **Offline-first PWA** — full POS works with no network; queued sales replay idempotently.
- **Money** — kobo-rounded at every boundary; soak-tested with 360 sales / 60 voids /
  120 expenses → trial balance exact, every journal entry balanced, zero drift.
- **Idempotency** — server keys pruned at 14 days; client quarantines at 10 (Bug 68).
- **Sessions** — sliding renewal; live row re-read every request, so deactivation, role
  change and branch change take effect **immediately**, not at token expiry.
- **Security headers** via `hono/secure-headers`; CORS safe by construction (Bearer only,
  never `Set-Cookie`, never `Allow-Credentials`).
- **Compliance** — tamper-evident SHA-256 chained controlled-substance register;
  POM refusals; expired-stock blocking at receipt.

---

## PART 3 — FRONTEND, RESPONSIVENESS AND THE OVERLAP QUESTION

20 screens, vanilla JS, zero runtime dependencies, CSP-compliant. Light/dark themes.

### What was measured, and how

| Measurement | Coverage | Result |
|---|---|---|
| Document horizontal overflow | 19 screens × 8 widths × 3 roles — 1202 checks | 0 overflow |
| **Control overlap (pairwise geometry)** | 19 screens × 5 widths, drawer **closed and open** — 475 checks | 0 overlap *(after Bug 76)* |
| Theme/contrast | 127 checks | pass |
| Transfer UI end-to-end in Chromium | 21 checks | pass |

### Your reported symptom — investigated directly

You reported that *"at its lowest the buttons tend to overlap each other."* Overflow and
overlap are **different measurements**, and only overflow had ever been tested. I wrote a
probe that compares every interactive element pairwise and found:

- **No two controls overlap anywhere**, at any width, on any screen — the symptom as
  literally described did not reproduce.
- But it found a **real, closely-related defect** that every previous pass had missed
  (below), where a control was *unreachable* rather than overlapping.

### 🔴 BUG 76 — a button wider than the phone, with no way to reach it (**FIXED**)

`.btn` carried `white-space: nowrap`, so a long label could not wrap and the button simply
grew past the screen. Measured at 320px: *"Verify Tamper-Evidence Chain for this Branch"*
rendered **391px wide in a 320px viewport — 105px, including its right edge, permanently
off-screen and untappable**, with no scroll container to reach it.

Every earlier responsive pass reported this screen green because **the document did not
overflow** — the parent clipped the button silently. That is precisely why overlap and
reachability needed their own measurement.

**Fix:** buttons may now wrap and can never exceed their container
(`white-space: normal; max-width: 100%; overflow-wrap: anywhere`).
**Result:** 252×51px, fully on-screen. **Revert-verified:** restoring `nowrap` reproduces
391px with 105px off-screen.

### Two things that LOOK like bugs and are not (verified, not assumed)

1. **The off-canvas drawer at `left:-280px`.** My first probe run reported 95 "failures"
   that were all the *closed* nav drawer parked off-screen — correct behaviour.
2. **Drawer links overlapping page content when open.** Verified with `elementFromPoint`:
   the scrim (z-44, `pointer-events:auto`) covers the page and the drawer (z-45) sits above
   it, so nothing behind is tappable. An overlay covering the page is an overlay working.

Tab strips (`.tabs`) carry `overflow-x:auto` and scroll — off-screen tabs are reachable
by swiping, so they are not defects either.

---

## PART 4 — AUDIT LEDGER

**76 bug classes found and fixed**, each live-reproduced first and each guard confirmed by
deliberately reverting it.

### Verified totals

| Suite | Result |
|---|---|
| Offline (23 suites) | 1943 checks, 0 failures |
| Integration | 150 checks, 0 failures |
| Live | 190 checks, 0 failures |
| **Core total** | **2283 checks, 0 failures** |

Browser/dev-server probes (not in the core total — they need Chromium and a running server):
responsive 1202 checks · **overlap 475 checks** · browser 127 · admin 88 · transfer 66 · manager 65 ·
staff 59 · owner 57 · lifecycle 43 · admin-UI 39 · admin-adversarial 24 · transfer-UI 21 ·
transient 20 · cron 14 · soak 14 · offline-durability 12 · stale-replay 12 · CORS 10.

### Highest-severity classes closed

Financial: GL cache poisoning · till-close race double-posting cash over/short ·
stocktake **fabricating** stock · WHT remittance double-post · kobo rounding bypass ·
CSV losses stored as text · P&L using UTC instead of WAT.

Security: MANAGER→OWNER privilege escalation via PIN reset · sync/push cross-tenant hole ·
insecure JWT secret · cross-branch account takeover · PIN reset not ending old sessions ·
supplier list with **no** role guard behind a hidden nav item · missing API security headers.

Data-loss / lockout: sole OWNER could permanently remove themselves (Bug 70) ·
offline device could record the same sale **twice** after a long outage (Bug 68) ·
offline queue quarantining valid sales · LWW silent overwrite made reviewable.

Governance: manager signing off **their own** flagged shift (Bug 71) ·
voided controlled sale still recorded as dispensed · overrides with no reason.

Lifecycle (this round): **Bug 75** — a person could never be moved between branches or
roles, and the reason the app gave was factually false · **Bug 74** — a departing
employee stayed "on duty" forever with no endpoint able to close the shift ·
**Bug 76** — the unreachable button above.

---

## PART 5 — WHAT IS *NOT* YET AUDITED (honest gaps)

### Blocking for a paying client

1. **Never deployed to real Cloudflare.** `wrangler deploy`, remote D1, Pages, custom
   domain and the `/api/*` route are **completely unexercised**. This is the single
   largest unknown in the project and no amount of local testing substitutes for it.
2. **Schema edits still live in `0001_initial_schema.sql`.** Correct *only* because
   nothing is deployed. The moment a client database exists, Bugs 39/49/74/75's schema
   changes must become numbered migrations.
3. **No load testing on real infrastructure.** `wrangler dev` serialises requests, so
   every concurrency result here was forced at SQL level, not proven under real parallelism.
4. **No alerting/monitoring.** Nothing pages anyone if the Worker starts failing.

### Should be reviewed before go-live

5. **POM/controlled classification needs a superintendent pharmacist's spot-check** —
   the NAFDAC catalog flags are data, and a licensing decision, not a code decision.
6. **Six demo accounts still ship on PIN `1234`** — warned loudly, deliberately not blocked
   (blocking breaks evaluation installs). Someone must actually change them.
7. **Only one ADMIN seat ships**; multi-engineer vendor support is untested.
8. **STAFF defaults (15-min void window, 5-unit cap) are my judgement**, not the client's.
9. **Bug 68's 10-day offline window relies on device clock accuracy.**

### Known behaviours a client should be told about

10. A single-owner pharmacy can never delete that owner — **create a second owner as
    onboarding step one**.
11. A sole manager at a single-branch pharmacy needs the owner to review their own
    flagged shift (Bug 71's deliberate consequence).
12. A cashier can still enumerate supplier **names** (Bug 72's projection keeps id+name).
13. No self-service owner PIN recovery — a forgotten owner PIN requires the vendor seat.

### Not yet examined at all

14. **Customer/debtor lifecycle depth** — credit limits, merging duplicate customers.
15. **Branch closure with work in flight** — open tills, POs and transfers at the moment
    a branch is deactivated.
16. **Multi-device same-user concurrency** — the same cashier on two terminals.
17. **PWA install on a real physical device** (tested only in headless Chromium).
18. **The `writableColumns` footgun in `syncService`** — defaults permissive when a field
    is absent, so a second pushable table added without it would silently reopen Bug 45.
19. **Printer/receipt hardware** — thermal printer output verified only as light-themed
    HTML, never on a real device.
20. **No git remote** — this history has been rolled back ~16 times by sandbox resets.

