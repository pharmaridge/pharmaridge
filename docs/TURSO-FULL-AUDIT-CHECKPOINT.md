# Turso Full Audit Checkpoint

**Scope:** `sample-turso` public canary and an isolated, disposable Turso rehearsal database.

**Rule:** The public canary is probed read-only only. All write, stock, sale, accounting, cleanup, concurrency, and destructive checks run only in the disposable rehearsal database.

**Status:** Complete — all five stages passed. No production/public-sample business data was changed.

## Stage plan

| Stage | Scope | Status |
|---|---|---|
| 0 | Public-canary read-only reachability, provider, PWA, and static-asset fingerprint | Complete |
| 1 | Provision an isolated disposable Turso rehearsal database and validate schema baseline | Complete |
| 2 | Admin → Owner → branch/team → supplier/product/barcode → PO/receive → POS/receipt lifecycle | Complete — 14 passed |
| 3 | Stock, barcode-unit, duplicate, permissions, accounting, VAT/GL and trial-balance reconciliation | Complete — 27 passed |
| 4 | Browser/PWA/mobile rendering, service-worker, responsive and print-label probe against the rehearsal Worker | Complete — 6 passed |
| 5 | Read-only canary re-check, rehearsal report, deletion of temporary rehearsal database, final checkpoint | Complete |

## Stage 0 — public canary, read-only

Target:

```text
https://sample-turso.pharmaridge.workers.dev
```

Results:

```text
Root health: 5 × HTTP 200
/api/health: ok
JWT secret: configured
Database provider: TURSO
Turso Free storage reference: 5,120 MB
PWA cache: pharmaridge-v89
Barcode Code 128 asset: reachable
Branding endpoint: reachable
```

Static-asset fingerprints at the checkpoint:

```text
service worker SHA-256 prefix: 83ab936db034ee93
barcode-label asset SHA-256 prefix: b2c8f42453a9a151
```

No authenticated or mutating endpoint was called in Stage 0.

## Stage 1 — isolated schema rehearsal

A dedicated disposable Turso rehearsal database was provisioned in the same Turso group/region as the public canary. It received the exact two-migration baseline only.

```text
schema comparison: clean
foreign keys: enabled
NAFDAC catalog: 6,801 rows
barcode unique index: present
migration manifest: 2 rows
```

No public canary, D1 sample, Client record, or Client credential was modified.

## Stage 2 — real Worker lifecycle

The local Worker was started with `DATABASE_PROVIDER=TURSO` against the disposable rehearsal database. Random terminal-only identities were created directly in the rehearsal database; no credential was printed or persisted locally.

```text
TURSO PROVIDER ROUTE CANARY: 14 passed, 0 failed
```

The real HTTP lifecycle covered Admin login, Owner/branch/Staff creation, supplier/product/barcode registration, purchase order, receiving, stock, till, barcode POS sale, receipt trace, and balanced trial balance.

## Stage 3 — detailed domain and accounting controls

The enhanced rehearsal canary completed:

```text
TURSO PROVIDER ROUTE CANARY: 27 passed, 0 failed
```

Additional verified controls:

- Pack barcode registration and exact pack-unit lookup;
- global duplicate barcode rejection;
- numeric GS1 check-digit rejection;
- Staff product-management boundary;
- received opening stock quantity;
- pack price and base-unit conversion (one pack removes ten base units);
- barcode/unit mismatch rejection before sale creation;
- category sales history;
- Retail Category GL attribution;
- Owner-only void with mandatory reason;
- stock restoration after void;
- exact post-void trial-balance equality.

## Stage 4 — browser, PWA and mobile rehearsal

The real Turso Worker was run at phone geometry in Chromium after the lifecycle/domain checks.

```text
TURSO BROWSER / PWA AUDIT: 6 passed, 0 failed
```

Verified:

- mobile login and authenticated shell have no horizontal overflow;
- the service worker registers the `pharmaridge-v89` cache;
- the Code 128 barcode-label renderer is loaded in the real shell;
- the cached application shell remains reachable offline after a Turso-backed launch;
- no browser script error occurred.

## Stage 5 — final canary re-check and teardown

The public Turso canary was rechecked read-only after every rehearsal stage:

```text
Root health: 5 × HTTP 200
API health: verified
Database provider: TURSO
Turso Free storage reference: 5,120 MB
PWA cache: pharmaridge-v89
Service-worker SHA-256 prefix: 83ab936db034ee93
```

The entire disposable rehearsal database was then deleted successfully. No random test identity, synthetic branch, supplier, product, barcode, stock batch, sale, receipt, journal, or temporary token remains in Turso.

## Final result

```text
Public canary read-only check: passed
Schema baseline: passed
Turso Worker lifecycle: 27 passed, 0 failed
Turso browser/PWA/mobile: 6 passed, 0 failed
Accounting/trial balance: passed
Disposable rehearsal teardown: passed
```

The public canary remains intentionally clean: one Admin, no Client operational data, 6,801 NAFDAC rows, and two migration records.

## Resume point

No further audit action is pending. Keep the public canary available for Client evaluation and retain the D1 sample deployments as rollback references. Any future Client-data migration should begin from a new isolated rehearsal database, never this public sample or the clean Turso schema pilot.
