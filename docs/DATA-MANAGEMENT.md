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

1. Pick one of the three scopes below.
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
| **Full business and team reset** | Everything in the previous scope, then branch devices, branches, and every Manager/Staff credential. | Owner and PharmaRidge Support accounts, plan/settings, VAT/WHT configuration, system GL/chart configuration, NAFDAC reference catalog and a minimal cleanup log. The Owner who ran it remains signed in to build the new setup. |

This is not a command to drop the D1 database, delete the vendor support account, or remove the current Owner account. Those protections are intentional: a successful reset must not lock the pharmacy out of its own deployment.

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

`npm run test:data-management` runs the isolated data-management regression audit. It checks Owner-only access, date-range deletion, typed confirmation, active-till and unsynced-queue blocks, all-business retention of accounts/branches, full-reset deletion order, Manager/Staff credential removal, Owner session preservation, reset queue fencing and cleanup-log retention.
