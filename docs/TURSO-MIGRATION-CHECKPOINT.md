# Turso Migration Checkpoint

**Stage:** 2.5 — request-scoped provider adoption

**Status:** Stages 0–2.5 completed safely. The Turso pilot has the verified reference/setup schema only; no Client operational data was written to Turso, and D1 remains the active runtime.

**Purpose:** Establish a verified, reversible provider seam and an exact schema baseline before any Client-data migration begins.

## Guardrails

- The running `sample`, `sample1`, and `sample2` Cloudflare Worker/D1 deployments remain the production/test source of truth during the migration.
- No D1 data was exported, changed, or deleted in this stage.
- No Turso credentials, database URL, JWT, or Cloudflare credential is stored in this repository, this checkpoint, source code, or documentation.
- The supplied Turso target was inspected with read-only statements only.
- A single Turso database cannot replace the three isolated Client databases without changing the tenancy model. It is therefore a **pilot target** until separate per-Client Turso databases are provisioned.

## Preflight result

| Check | Result |
|---|---|
| Remote connection using the supplied database-scoped credential | Verified |
| SQLite engine reachable | 3.50.4 |
| Integrity check | `ok` |
| PharmaRidge tables, views, indexes, or triggers already present | No |
| Existing non-internal schema objects | Only Turso's internal MVCC metadata table |
| Application writes performed | 0 |

This confirms the remote target is empty from PharmaRidge's perspective and is safe for a controlled schema-compatibility pilot. It does **not** authorise a production cutover.

## Stage 1 result — adapter compatibility spike

A new internal adapter was added at:

```text
worker/src/lib/databaseAdapter.js
```

It introduces a narrow compatibility surface for the future migration:

```text
prepare(sql).bind(...).first()
prepare(sql).bind(...).all()
prepare(sql).bind(...).run()
batch(statements)
```

- **D1 remains the default provider.** No application route, service, Cloudflare Worker binding, or live deployment was pointed at Turso.
- Turso is selected only by the explicit `DATABASE_PROVIDER=TURSO` setting; the adapter requires `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to be supplied at runtime.
- The Turso implementation uses `@tursodatabase/serverless/compat` and maps result rows plus `meta.changes` to the D1-shaped response expected by existing compare-and-swap guards.
- Turso batches are explicitly requested in `write` transaction mode to preserve D1's all-or-nothing batch intent.
- Mixed D1/Turso statement batches and unknown provider values fail closed.

Validation file:

```text
worker/test/audit.turso-adapter.js
```

Latest result:

```text
TURSO ADAPTER AUDIT: 12 passed, 0 failed
```

The audit included a live, read-only Turso prepared query and a read-only two-statement adapter batch. A post-test schema read confirmed that the target still contains only Turso's internal MVCC metadata table. No PharmaRidge table, data row, or migration record was created.

## Stage 2 result — schema compatibility pilot

The approved empty Turso pilot now contains the current PharmaRidge **reference/setup baseline only**. No Client operational data was copied from D1.

A guarded runner was added at:

```text
worker/tools/turso-schema-pilot.js
```

The runner:

- refuses to apply to any non-empty non-internal Turso target;
- requires an explicit terminal-only confirmation before writing;
- applies the existing two source migrations as one transaction per migration without splitting trigger bodies on semicolons;
- records only the two source filename/hash pairs in a Turso-local migration manifest;
- creates no third business-schema migration;
- compares named schema objects, table columns, foreign keys, indexes, triggers, views, seed counts, barcode uniqueness, and migration hashes against a fresh local application of the same two migrations.

Final live verification:

```text
clean schema comparison: true
foreign-key enforcement: true
missing schema objects: 0
unexpected non-internal schema objects: 0
changed schema objects: 0
changed table shapes: 0
NAFDAC catalog: 6,801 rows
barcode unique index: 1
migration manifest rows: 2
```

Turso starts a fresh connection with `PRAGMA foreign_keys` disabled. The adapter now enables it before every application statement path, and the live adapter audit proves the pragma reports `1`. This restores D1's always-on foreign-key guarantee before any route is allowed to adopt Turso.

The pilot has the default chart of accounts, WHT rates, and client settings created by the existing initial schema, but it has no Client Admin/Owner/Staff accounts, branches, products, stock, customers, suppliers, sales, receipts, or GL transactions.

## Stage 2.5 result — request-scoped provider adoption

All **370** executable request-context database call sites now resolve through:

```text
worker/src/lib/database.js → database(c)
```

`worker/src/index.js` selects the provider once per Hono request and stores it in the request context. The default remains the native D1 binding; no existing Worker changes provider unless a future deployment explicitly sets `DATABASE_PROVIDER=TURSO` and supplies Turso Worker secrets.

This removes route-by-route provider drift while retaining the D1 fallback required by isolated unit tests. It also means a future Turso canary can be enabled per Worker rather than by editing each route again.

Validation:

```text
DATABASE PROVIDER CONTEXT AUDIT: 4 passed, 0 failed
BARCODE FLOW AUDIT (D1 default): 15 passed, 0 failed
DATA MANAGEMENT AUDIT: 21 passed, 0 failed
```

No Cloudflare Worker was redeployed during this stage. The current D1 instances remain the active runtime.

## Current D1 baseline locked for comparison

Only these migrations are valid in the current application baseline:

| Migration | SHA-256 |
|---|---|
| `worker/migrations/0001_initial_schema.sql` | `7fef666dfed90edda2a157bacf078532eb8a6b3a8b88fc96137dd93f186e51bd` |
| `worker/migrations/0002_nafdac_catalog.sql` | `83ae4f788e042ec91dbd5d8caf431babe0cd1a1ab5ec794ce3b21103287eac45` |

The baseline contains application tables, indexes, foreign keys, triggers, the retail-category and barcode model, the chart of accounts, and the 6,801-row NAFDAC catalog. It must be reconciled exactly before any Client is redirected.

## Proposed staged path

### Stage 1 — Adapter and compatibility spike — completed

1. Add a small database adapter behind the current D1 API contract.
2. Keep D1 as the default runtime and keep every deployed Worker pointed at D1.
3. Add a Turso client implementation behind an explicit feature flag, with credentials read only from Worker secrets.
4. Prove parameter binding, batches, transactions, affected-row metadata, and error mapping against the empty Turso pilot.
5. Run syntax, barcode, sale, stock, accounting, and role-scope tests locally against both adapters where possible.

**Exit gate:** no route changes directly call a Turso client; they call the adapter. D1 remains behaviourally unchanged.

### Stage 2 — Schema compatibility pilot — completed

1. Translate only the two D1 migrations into a Turso migration runner; do not add a third business-schema migration.
2. Apply the translated schema to the empty Turso pilot.
3. Compare tables, indexes, foreign keys, triggers, uniqueness rules, default chart/settings, and all 6,801 catalog rows.
4. Verify barcode uniqueness, retail categories, GL balancing triggers, and foreign-key behaviour.

**Exit gate:** schema comparison is clean and no D1 database has been changed.

### Stage 3 — Isolated sample-data rehearsal

1. Choose one non-production sample database only.
2. Export a consistent D1 snapshot.
3. Import it into a separate Turso rehearsal database, never directly into the pilot or a Client production database.
4. Reconcile row counts, stock quantities, sales totals, VAT, WHT, debtor/creditor balances, and GL trial balance.
5. Run the complete POS/barcode/receipt/accounting regression suite.

**Exit gate:** independent reconciliation reports agree and rollback to D1 is proven.

### Stage 4 — One-client canary

1. Provision a dedicated Turso database and database-scoped token for one selected Client.
2. Migrate that Client during an agreed maintenance window.
3. Preserve D1 read-only as the rollback source until finance and stock sign-off.
4. Observe read/write behaviour, latency, errors, and accounting reconciliation before migrating another Client.

### Stage 5 — Controlled rollout

Migrate remaining Clients one at a time with separate Turso databases and separate credentials. Do not combine Client data in one database unless a deliberate, tested multi-tenant authorization model is implemented first.

## Resume point

The next safe action is **Stage 3 only**: provision a separate Turso rehearsal database, export one non-production D1 sample into it, and reconcile every operational and accounting control before any Client Worker is redirected. The current Turso schema pilot must remain the clean reference baseline; it is not a Client-data import target.
