# Owner Data Management & Capacity Alerts

## Purpose

PharmaRidge estimates active D1 database usage and warns before the default 500 MB free-tier reference ceiling becomes critical. The estimate is a capacity early-warning tool, not a billing meter or a guarantee that deletion immediately changes Cloudflare's physical storage allocation.

- **Owner:** sees the storage warning on Dashboard and My Plan, and is the only pharmacy role allowed to use Data Management.
- **General Manager:** sees the same organisation-wide warning on Dashboard and their plan/allowance view, but cannot delete data. They should alert the Owner.
- **Branch Managers and Staff:** do not receive the organisation capacity control or destructive action.

Warnings appear at 75% estimated use and become critical at 90%. At a real storage ceiling, writes can fail while reads still work; storage should therefore be reviewed before trading is affected.

## Owner workflow

Open **My Plan → Owner Data Management → Review data-management options**.

The dialog always follows this sequence:

1. Pick one of the five scopes below.
2. For a period, select the inclusive start and end dates.
3. Select **Preview impact**. The server returns current matching row counts and checks for unresolved work.
4. Export or verify every report/backup the business must keep.
5. Tick both acknowledgements and type the displayed phrase exactly.
6. Select **Permanently remove matching data**.

The API repeats role, date, active-operation, acknowledgement and typed-phrase checks. The browser UI is not the only protection.

## Available scopes

| Scope | What it removes | What remains |
|---|---|---|
| **Delete selected period** | Activity dated within the chosen inclusive range: sale details/payments, associated prescription/controlled-register entries, ledgers, WHT, GL entries/lines, expenses, stocktakes/adjustments/transfers, till/attendance history and technical history where applicable. | Current branch/team setup, products, suppliers, customers and stock batches. A till with a sale outside the range is retained rather than orphaned. |
| **Clear all business data** | Trading, stock, accounting, supplier/customer/product master, purchasing, attendance/till, sync and technical history. | Existing Owner, Manager and Staff credentials, plus branch setup and devices. This is for a fresh trading dataset without re-onboarding the team. |
| **Clear operational data; keep accounting continuity** | Live sales, stock, purchasing, customer/supplier, attendance, staff-transfer and sync records. | Branches and credentials, chart of accounts, posted GL journal entries/lines and branch-safe cash history. Trial Balance, P&L and Balance Sheet retain their cumulative figures. Detailed source records, WHT, debtor and creditor registers are deleted, so historical GL source IDs no longer open an operational record. |
| **Clear operations; keep accounting and current stock** | Sales, customers, suppliers, purchase orders/receipts, attendance, transfers, stocktake/adjustment history and sync records. Empty stock batches and products with no current batch are removed. | Branches and credentials; each active batch with `quantity_remaining > 0`; the matching product and branch price record; chart of accounts; posted GL entries/lines; branch-safe cash history. Supplier and purchase-order links are cleared from the retained batches before their source records are deleted, so stock remains sellable without retaining old supplier/order data. |
| **Full business and team reset** | Everything in the previous scope, then branch devices, branches, and every Manager/Staff credential. | Owner and PharmaRidge Support accounts, plan/settings, VAT/WHT configuration, system GL/chart configuration, NAFDAC reference catalog and a minimal cleanup log. The Owner who ran it remains signed in to build the new setup. |

This is not a command to drop the D1 database, delete the vendor support account, or remove the current Owner account. Those protections are intentional: a successful reset must not lock the pharmacy out of its own deployment.

## Admin-only deployment reset

For a retired deployment or a deliberately fresh client database, the terminal-only **Admin-only reset** generator is separate from the Owner browser flow:

```bash
PHARMARIDGE_CONFIRM_RESET=RESET_CLIENT_DATA npm run db:generate:preserve-admin-reset
```

It generates an ignored SQL file for review and one deliberate local or remote D1 execution. It removes every non-Admin account and all client operations, while retaining the database schema/migrations, application settings, chart/tax reference configuration and NAFDAC reference catalog that the application needs to start. It does **not** retain any Owner, Manager, Staff, branch, sale, stock, customer, supplier or journal-entry data. Back up and verify the intended D1 target before using it; the browser Data Management flow is the right option when accounting continuity must remain.

### Consolidated schema format

New deployments use just two migrations: `0001_initial_schema.sql` for the complete operational baseline and `0002_nafdac_catalog.sql` for the NAFDAC reference catalog. For an intentionally retired D1 deployment that must be rebuilt onto that baseline, generate the paired **schema format / Admin restore** files:

```bash
PHARMARIDGE_CONFIRM_SCHEMA_RESET=FORMAT_SCHEMA_PRESERVE_ADMIN npm run db:generate:preserve-admin-schema-format
```

The procedure temporarily preserves only existing active Admin row(s), removes all application tables and migration history, reapplies the two baseline migrations, then restores those Admin row(s). It retains the existing password hash; it deliberately does **not** place a known or shared password in code, seed SQL, Git or the public sample. All other users, branches, operations, accounting records and catalog rows are rebuilt from the new migrations.

## Safety controls

A cleanup is blocked until the selected scope has no:

- open till,
- open stocktake,
- open attendance shift,
- pending/in-transit stock transfer,
- pending staff transfer, or
- device-reported unsynced offline queue.

Every cleanup writes a small `data_cleanup_log` row containing the scope, initiator, range and pre-delete counts. It deliberately does **not** preserve customer, supplier, patient or financial record contents.

Any cleanup stamps a reset time. An offline request queued before that time is refused with `DATA_RESET_REPLAY_BLOCKED` when it reconnects; it must be reviewed or discarded on that device rather than silently recreating data after a clean-up. The server cannot see a device that has never reported itself, so the Owner should ensure every active device is online and synchronized before proceeding.

## Retention and capacity

Deletion is irreversible from the application. Before deleting financial, VAT/WHT, prescription or controlled-drug data, the Owner must determine what records the business is required to retain with its accountant, tax adviser and relevant pharmacy/controlled-drug obligations.

Data removal can reduce active rows and PharmaRidge's capacity estimate, but Cloudflare controls physical allocation/compaction. A critical warning should also trigger a capacity/upgrade conversation; cleanup is not presented as a guarantee of immediate billing or allocated-storage reduction.

## Validation

`npm run test:data-management` runs the isolated data-management regression audit. It checks Owner-only access, date-range deletion, typed confirmation, active-till and unsynced-queue blocks, all-business retention of accounts/branches, full-reset deletion order, Manager/Staff credential removal, Owner session preservation, reset queue fencing, cleanup-log retention, accounting-only continuity, and stock-plus-accounting continuity retaining live batches/products/prices while detaching deleted supplier/order links.

`npm run test:data-management:consecutive-terms` runs the longer continuity proof locally: three consecutive 90-day operating terms for accounting-only protection, then three further 90-day terms for accounting-plus-current-stock protection. After every term it calls the real Owner cleanup API, re-reads Trial Balance, branch-safe history, current batches/products/prices, and verifies the next term can trade. Each policy ends with a deliberate all-business deletion check.
