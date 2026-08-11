# Full Domain, Frontend, and 90-Day Simulation Audit

**Run date:** 2026-08-05
**Scope:** local fresh D1 databases only; production sample data was not used for audit execution.

## Result

| Audit surface | Passing checks |
|---|---:|
| Fresh-D1 full domain audit (including Data Management and promotion authority) | 1,055 |
| Scenario-driven frontend control, dropdown and geometry audit (including Data Management, password reveals, promotion dropdowns and POS checkout lifecycle) | 1,992 |
| PWA/browser theme, contrast, print, responsive and splash audit | 137 |
| PWA icon and transparent canonical-launcher audit | 42 |
| Three-month operating simulation audit | 20 |
| **Total executed checks** | **3,246** |

## Two-way audit method

The API/domain tests write through real REST routes, then re-read operational records, ledgers, journal entries, balances, and database constraints. The frontend tests drive controls, forms, triggers, navigation, dropdowns, role-gated views, responsive widths, and modal actions in Chromium, then correlate the visible outcome with the API/database result.

Every major test script starts from a fresh migrated and seeded local D1 state. That prevents a prior sale, session, open till, branch setting, or service worker cache from falsely affecting another result.

## Password visibility and promotion authority coverage

The latest re-run adds a role-and-device boundary sweep:

- General Manager can appoint another employee as a General Manager; the role change is staged, reasoned and recorded.
- Branch Manager is limited to Staff/Branch Manager choices inside their own branch and is refused an organisation-wide promotion.
- Owner may appoint an Owner; Staff cannot alter another person; no role can create or assign the vendor Admin seat through the transfer workflow.
- Login, Add User and Reset PIN all begin masked, expose the same deliberate view/hide control, and keep a 44px phone target with a separated input/action gap.
- Browser probes verify role dropdowns, real API authority, password reveal behaviour, mobile card/action spacing, no overflow, no clipped text, and POS completion through receipt/cart-clear/server-record correlation.

## Owner Data Management coverage

The re-run includes the Owner-only retention and capacity control from both directions:

- browser/mobile control reachability and no-overflow geometry for the Owner modal;
- all three scopes: selected period, all business data, and full business-and-team reset;
- exact typed confirmation plus export/retention acknowledgements enforced on the server;
- General Manager and vendor Admin denied by both the UI and API;
- open till, active operations and reported offline queue blockers;
- preservation of Owner access, support/Admin access, tax/system configuration and the NAFDAC reference catalogue after full reset;
- removal of Manager/Staff credentials and branches only in the full-reset scope; and
- stale offline replay fencing plus retained minimal cleanup audit log.

## Three-month operating simulation

A dedicated simulation creates 90 dated operating days through live application APIs, then backdates the generated records in one local D1 batch for report/history coverage. It exercises:

- 90 completed sales across two branches;
- cash, credit and change-owed transactions;
- VAT extraction and monthly WHT-bearing expenses;
- customer debts and repayments;
- supplier credit receipts and safe-funded settlement;
- till sessions, safe movements, attendance history, stock receipts and a completed stock transfer;
- dated sales/GL/WHT/attendance records across at least 80 calendar days.

The simulation audit verifies date span, VAT/WHT arithmetic, claim codes, creditor/debtor activity, stock non-negativity, closed-till history, safe ledger activity, attendance records, transfer completion, products, Trial Balance, and role permissions.

## Role and cross-domain coverage

The full run covers Admin, Owner, General Manager, Branch Manager and Staff authority boundaries, including:

- single active device session per account;
- explicit logout token revocation;
- account replacement after a second-device login;
- owner creation/branch/staff/promotion/demotion flows;
- branch scope on stock, tills, cash, attendance, users, suppliers and reports;
- stock and staff transfers, open till/shift/stocktake recovery, and lifecycle constraints.

## Current public sample state

After the audit and simulation, the production sample database was reset using `npm run sample:reset:remote` semantics:

```text
Active Admin: 1 (admin / 1234)
Owners: 0
Branches: 0
Staff: 0
Sales: 0
Stock batches: 0
Products: 6,801 NAFDAC-derived rows
```

The shared sample is deliberately a clean Admin-first environment. It is not an audit fixture and must not contain real client data.
