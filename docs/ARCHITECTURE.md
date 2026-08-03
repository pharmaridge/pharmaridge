# PharmaRidge Architecture — Decoupled Structure

## Runtime topology

```text
Browser PWA (public/)
  ├─ cached application shell and IndexedDB queue
  ├─ vanilla-JS screens / shared browser modules
  └─ same-origin /api/* requests
                  │
                  ▼
Cloudflare Worker (worker/src/)
  ├─ index.js: HTTP composition, error boundary, cron
  ├─ routes/: HTTP, input, role/scope orchestration
  ├─ services/: transaction/event workflows and accounting effects
  └─ lib/: reusable policy, validation, storage, crypto, utility rules
                  │
                  ▼
Cloudflare D1 / SQLite (worker/migrations/)
  ├─ operational records
  ├─ append-only/auditable ledgers
  ├─ reporting views
  └─ database-level integrity constraints and GL balance trigger
```

## Directory ownership

| Area | Owns | Must not own |
|---|---|---|
| `worker/src/index.js` | Middleware composition, route mounting, top-level error mapping, scheduled retention | Domain calculations or direct domain workflow writes |
| `worker/src/routes/` | HTTP status/response shape, request parsing, RBAC and branch-scope orchestration | Reusable business calculations, duplicated accounting postings |
| `worker/src/services/` | Cross-table workflows, D1 batch construction, inventory, till, GL, attendance, sync workflows | Browser concerns or presentation HTML |
| `worker/src/lib/` | Pure rules, validation, crypto, D1 utility wrappers, plan-policy gates | Feature-specific route response formatting |
| `worker/migrations/` | Immutable database evolution and reference data | Retroactive edits after first production migration |
| `public/js/` | Browser state, API/offline transport, PWA behavior, common UI/print utilities | Server-side authorization decisions |
| `public/js/views/` | One screen's rendering and interactions | Global route composition or direct storage access |
| `public/css/` | Design tokens and responsive layout rules | Per-screen imperative logic |
| `docs/` | Current operating/recovery documents | Source-of-truth business logic |

## Domain modules recovered

| Domain | Routes | Services / key policies |
|---|---|---|
| Identity & governance | `auth`, `users`, `admin`, `settings`, `branches`, `branding` | `auth`, `crypto`, `loginThrottle`, `planLimits`, `userTransferService` |
| Inventory & procurement | `products`, `catalog`, `stock`, `purchaseOrders`, `stocktakes`, `adjustments`, `transfers` | `stockEntry`, `receiving`, `stocktakeService` |
| Sales & cash operations | `sales`, `till`, `safe`, `changeOwed`, `customers`, `creditors`, `expenses` | `salesService`, `tillService`, `branchSafeService`, `changeOwedService`, `cashSources` |
| Accounting & tax | `gl`, `wht` | `glService`, `wht` |
| Compliance & people | `attendance`, `controlledRegister` | `attendanceService` |
| Synchronisation & observation | `sync`, `dashboard` | `syncService`, `retention`, `storageHealth`, `d1Retry`, `d1Limits` |

## Enforced dependency direction

```text
views → browser shared modules → /api
routes → services + lib
services → lib + D1
lib → platform primitives only
migrations → database only
```

A future change should maintain this direction. In particular:

- a frontend visibility rule is never authorization; routes/services remain authoritative;
- routes should not independently post GL entries or recalculate shared money/stock rules;
- a service should reuse `lib/business.js` / `lib/wht.js` instead of reproducing numerical rules;
- production schema changes must be new numbered migrations, never edits to `0001` or `0002`; and
- every PWA shell asset added to `index.html` must also be considered for `public/sw.js`.

## Refactoring sequence for future development

The recovery preserves behavior before redesign. Do not combine broad architectural changes with a production deployment.

1. **Establish test parity.** Restore the missing historical tests or build behaviour-focused replacements around sales, stock, GL posting, RBAC, sync, and migrations.
2. **Introduce a domain contract test per route.** Each route gets successful, invalid, unauthorized, cross-branch, and retry/idempotency coverage.
3. **Extract route-local response mappers.** Several large route files can progressively move response projection/validation into domain-local helpers without moving business rules.
4. **Standardise mutation orchestration.** Make the pattern `parse → authorize → validate → service → response` visibly uniform across routes.
5. **Move finance events to explicit domain-event constructors.** Preserve the current atomic D1 batch behavior while making the source event and its GL/WHT effects easier to inspect and test.
6. **Only then consider UI component extraction.** The current vanilla-JS screen boundaries are a good initial separation; refactor common form/table/modal patterns only after browser regression coverage exists.
