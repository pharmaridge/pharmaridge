# Turso Migration Checkpoint

**Stage:** 4 — Cloudflare Turso sample canary deployed

**Status:** Stages 0–4 completed safely. One new public sample Worker runs against a dedicated clean Turso database; existing Client D1 databases and Workers remain unchanged for rollback.

**Purpose:** Establish a verified, reversible provider seam, exact schema baseline, real Worker-route rehearsal, and one clean public-sample Turso canary before any Client migration.

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

## Stage 3 result — isolated Turso provider rehearsal

A temporary, dedicated Turso rehearsal database was provisioned in the same region as the schema pilot. It received the verified two-migration schema, then ran a disposable local Worker with:

```text
DATABASE_PROVIDER=TURSO
```

The rehearsal used random, terminal-only test identities. It did not reuse, reveal, or persist a Client PIN in source, Git, documentation, generated SQL, or the workspace.

The selected D1 source, `sample2`, was first inspected read-only. It contained only its active Admin and reference setup; it had **zero** branches, products, barcodes, stock, customers, suppliers, sales, and GL journals. There was therefore no operational Client dataset to export. The Admin record was deliberately not exported or copied.

Instead, the isolated rehearsal exercised the same operational flow with synthetic records:

```text
TURSO PROVIDER ROUTE CANARY: 14 passed, 0 failed
```

Verified through the real Worker routes:

1. Turso-backed health response;
2. Admin login;
3. Admin creates Owner;
4. Owner creates a branch and Staff account;
5. Owner creates supplier and barcoded product;
6. purchase order, receiving, stock, and accounting post;
7. Staff opens till and scans the barcode at POS;
8. sale and receipt retain barcode trace;
9. trial balance remains exactly equal.

A Turso row-shape defect was discovered during the first run: Turso compatibility rows were array-like when JSON-serialized, while D1 routes expect JSON objects. The adapter now converts every result row into a D1-style object before a route returns it. The regression is covered by the live adapter audit.

After the successful canary, the entire rehearsal database was deleted. The clean schema-reference pilot remains untouched, and no synthetic records or temporary credentials were retained.

## Stage 4 provisioning result — dedicated clean sample target

A dedicated Turso database was provisioned for the new public canary. It is separate from both the clean schema-reference pilot and the deleted rehearsal database.

Verified before any Worker deployment:

```text
clean two-migration schema: true
foreign-key enforcement: true
NAFDAC catalog: 6,801 rows
schema migration manifest: 2 rows
active Admin accounts: 1
non-Admin accounts: 0
branches/products/barcodes/stock/sales/GL: 0
```

The sole Admin was created directly from terminal-only bootstrap input. Its plaintext credential, hash, Turso database token, platform token, and database URL are not written to this checkpoint, source, Git, generated SQL, or deployment configuration.

The Stage 4 Worker deployment is complete:

```text
Worker: sample-turso
Database provider: TURSO
Public URL: https://sample-turso.pharmaridge.workers.dev
Initial Worker version: b443fcf9-b762-4bd3-ae2e-6dbe470b3527
Current Worker version: 4a6c3d06-3e33-4b80-9b4f-0ddea93a957b
```

The Worker has only production provider flags in its public configuration. Its Turso database URL, Turso database token, and unique JWT signing secret are stored as Cloudflare Worker secrets and are not present in this repository or checkpoint.

Post-deployment verification:

```text
five root health requests: HTTP 200
API health: verified
Turso Free storage reference: 5,120 MB
PWA cache: pharmaridge-v89
sole Admin login: verified
active Admin: 1
non-Admin accounts: 0
branches/products/barcodes/stock/sales: 0
NAFDAC catalog: 6,801 rows
schema migration manifest: 2 rows
barcode unique index: 1
foreign keys: enabled
```

No barcode, stock, sale, accounting, or destructive test was run against the public canary. Those flows were already exercised in the deleted isolated rehearsal database. The existing D1 sample Workers remain rollback references.

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

### Stage 3 — Isolated sample-data rehearsal — completed

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

The next safe action is **Stage 5 observation only**: keep the new Turso canary available for Client evaluation, monitor its health and provider errors, and retain every existing D1 sample Worker/database unchanged as rollback references. Do not migrate a Client dataset or redirect an existing D1 sample until the canary is accepted in writing. The clean Turso schema pilot remains a reference baseline; it is not a Client-data import target.
