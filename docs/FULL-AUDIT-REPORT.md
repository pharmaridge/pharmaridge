# Full Domain, Frontend, and 90-Day Simulation Audit

**Run date:** 2026-08-04
**Scope:** local fresh D1 databases only; production sample data was not used for audit execution.

## Result

| Audit surface | Passing checks |
|---|---:|
| Fresh-D1 full domain audit | 1,026 |
| Scenario-driven frontend control, dropdown and geometry audit | 1,956 |
| PWA/browser theme, contrast, print and responsive audit | 127 |
| Login spinner/logout lifecycle audit | 3 |
| PWA icon, manifest and Android safe-zone audit | 45 |
| Three-month operating simulation audit | 20 |
| **Total executed checks** | **3,177** |

## Two-way audit method

The API/domain tests write through real REST routes, then re-read operational records, ledgers, journal entries, balances, and database constraints. The frontend tests drive controls, forms, triggers, navigation, dropdowns, role-gated views, responsive widths, and modal actions in Chromium, then correlate the visible outcome with the API/database result.

Every major test script starts from a fresh migrated and seeded local D1 state. That prevents a prior sale, session, open till, branch setting, or service worker cache from falsely affecting another result.

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
