# PharmaRidge

> **Recovery notice — 2026-08-04.** The project source and a second test artifact have been reconstructed into this repository. The restored suite now includes live cash/till, WHT/GL, procurement/transfer, sync, icon, and browser/PWA checks. Historical aggregate totals in older project documents still are not production certification. See [docs/RECOVERY-STATUS.md](docs/RECOVERY-STATUS.md), [worker/test/README.md](worker/test/README.md), and [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).

**Multi-branch pharmacy / patent medicine store management system for Nigeria.**
Offline-first PWA frontend + Cloudflare Workers & D1 edge backend.

| | |
|---|---|
| **Backend** | Cloudflare Workers, Hono 4, D1 (SQLite) — ~5,100 LOC |
| **Frontend** | Vanilla-JS PWA, no build step, 23 screens — ~5,600 LOC |
| **Database** | 41 tables · 14 views · 1 trigger · 64 indexes |
| **Drug catalog** | **6,801 NAFDAC-approved products** across 1,197 active ingredients, searchable |
| **Current verification** | Structural + SQLite migration checks; 227 restored core live-audit checks; 127 browser/PWA checks; 35 icon checks — all passing locally |
| **UI** | Light **and dark** theme, zero external dependencies — no framework, icon font or webfont |
| **Audit** | Restored test evidence: [`worker/test/README.md`](worker/test/README.md); historical audit inventory: [`AUDIT-REPORT.md`](AUDIT-REPORT.md) |
| **Onboarding guide** | 64-page role-based PDF: [`docs/PharmaRidge-Onboarding-Guide.pdf`](docs/PharmaRidge-Onboarding-Guide.pdf) |
| **Deploying?** | Windows walkthrough: [`DEPLOY-FROM-WINDOWS.md`](DEPLOY-FROM-WINDOWS.md) |
| **Node** | **22+ required** (Wrangler 4 refuses Node 20) |

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Local development](#4-local-development)
5. [**Deploying to production**](#5-deploying-to-production) ← the main guide
6. [Routing: the one thing people get wrong](#6-routing-the-one-thing-people-get-wrong)
7. [Post-deployment checklist](#7-post-deployment-checklist)
8. [Operations](#8-operations)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What it does

- **POS** — FEFO (first-expiry-first-out) batch picking, sell by base unit / pack / carton, split payments, cash change, offline queueing.
- **Expiry enforced at entry** — no medicine batch can enter stock without a real, future expiry date and a batch number. A NULL expiry would otherwise be invisible to the expiry report, unblockable by the expired-sale guard, and sellable forever. Non-medicines (devices, dressings) are admitted via an explicit "does not expire" tick, so it is a recorded decision rather than a blank field.
- **Compliance** — POM prescription capture, controlled-drug register as an append-only **hash chain** (tamper-evident, verifiable from the UI), NAFDAC/PCN license expiry alerts.
- **Print & export everything** — receipts print to an 80mm thermal roll *or* A4, and every financial and operational record (trial balance, P&L, balance sheet, journal, sales, stock, expiry, debtors, creditors, expenses, controlled register, attendance, stocktake, till, purchase orders, staff) prints as a branded document or downloads as CSV. "Save as PDF" comes free from the browser's own print dialog on desktop, Android and iOS — no plugin, no upload, works offline.
- **NAFDAC drug catalog** — build inventory by *selecting* from 6,801 approved products instead of typing them. Autocomplete by brand, active ingredient or NAFDAC number; prescription-only and controlled-drug status are derived from the active ingredient and pre-filled. Out of stock at the POS? It offers in-stock products sharing the same active ingredient. Anything not on the list is still added manually.
- **Inventory** — batch + expiry tracking, purchase orders with partial receipts, inter-branch transfers, stocktakes with live variance, adjustments.
- **Money** — till/cash reconciliation, debtors & creditors ledgers, expenses with approval, and a real **double-entry general ledger** (Trial Balance, P&L, Balance Sheet) posted automatically from every business event.
- **Nigerian tax** — optional **VAT** (inclusive extraction, so switching it on never changes what a customer pays) and **Withholding Tax** in both directions: tax you deduct from rent/fees/suppliers and owe the revenue authority by the 21st, and tax your corporate customers deduct from your invoices, tracked as a reclaimable credit. Ships the Deduction of Tax at Source (Withholding) Regulations 2024 rate schedule, editable by the owner.
- **Staff** — attendance via GPS geofence *or* registered-device, with manager review of flagged records.
- **Offline-first** — full app shell cached; sales/expenses replay through the original endpoint with `Idempotency-Key`, so a dropped connection can never duplicate a sale.
- **White-label** — the client's own business name + logo replace PharmaRidge branding throughout, including the PWA install experience.

Roles: `STAFF` → `MANAGER` → `OWNER` → `ADMIN` (vendor).

A `MANAGER` is presented to users under one of two job titles, decided by
whether the account is assigned to a branch:

| Shown as | Stored as | Scope |
|---|---|---|
| **General Manager** | `role=MANAGER`, `branch_id` NULL | Sees and runs every branch |
| **Branch Manager** | `role=MANAGER`, `branch_id` set | Runs exactly one branch; cannot see any other |

`branch_id` is the single source of truth for both the title and every
authorisation decision, so the label can never disagree with what the
account can actually do. Promoting a Branch Manager to General Manager is
just clearing `branch_id` — no role change, no migration.

---

## 2. Architecture

```
┌──────────────────────┐        ┌────────────────────────┐
│  Cloudflare Pages    │        │  Cloudflare Worker     │
│  public/             │        │  worker/src/           │
│  static PWA + SW     │──/api/*──▶  Hono router         │
│  yourpharmacy.com    │        │  23 routes, 6 services │
└──────────────────────┘        └───────────┬────────────┘
                                            │
                                    ┌───────▼────────┐
                                    │   D1 (SQLite)  │
                                    │  pharmaridge-db│
                                    └────────────────┘
```

**Both halves sit on one hostname.** Pages serves everything; only `/api/*` is routed to the Worker. That keeps the frontend's relative `fetch('/api/...')` calls working with zero code changes and **avoids CORS entirely**.

```
pharmaridge/
├── worker/
│   ├── wrangler.jsonc              # D1 binding, cron trigger
│   ├── migrations/0001_initial_schema.sql
│   ├── generate-seed.js            # emits seed.sql with real PBKDF2 PINs
│   ├── test/                       # historical suite paths referenced by package scripts; sources were not in the supplied artifact
│   └── src/{index.js, routes/, services/, lib/}
└── public/                         # deploy this folder to Pages
    ├── index.html, sw.js, manifest.json, _redirects, _headers
    └── css/, js/, icons/
```

---

## 3. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22** | Wrangler v4 refuses to run on Node 20. Check with `node -v`. |
| Cloudflare account | Free tier is enough to start. |
| Wrangler | Installed via `npm install`; no global install needed. |
| A domain on Cloudflare | Needed for the single-hostname routing in §6. |

```bash
npx wrangler login
```

---

## 4. Local development

```bash
cd worker
npm install
```

**Create the local D1 database and apply the schema:**

```bash
npx wrangler d1 create pharmaridge-db      # copy the printed database_id
```

Paste that id into `worker/wrangler.jsonc` → `d1_databases[0].database_id`.

```bash
npm run db:migrate:local                   # applies all migrations: 41 tables, 14 views, 1 trigger, NAFDAC catalog
npm run db:seed:local                      # generates seed.sql + loads demo data
```

**Set the local JWT secret.** Create `worker/.dev.vars` from the tracked example, then replace the value with a local-only random secret:

```bash
cp .dev.vars.example .dev.vars
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set the printed value as `JWT_SECRET=...` in `.dev.vars`. The file is gitignored; never reuse its value in production.

**Run it:**

```bash
npx wrangler dev --port 9001               # terminal 1 — API
npx wrangler pages dev ../public --port 8788 --proxy 9001   # terminal 2 — frontend
```

Open `http://localhost:8788`.

**Demo logins** (all PIN `1234`): `manager` (General Manager), `lagos.mgr` (Branch Manager — Lagos only), `owner`, `admin`, `lagos.staff`, `minna.staff`.

**Run verification** (Node.js 22+ for the live/browser commands):

```bash
npm test                       # fast structural recovery verification
npm run test:restored:syntax   # parses and verifies the restored test artifact
npm run assets:icons           # rebuilds every PWA icon from one artwork source
npm run test:icons             # validates icon geometry, mask safety and SW wiring
npm run test:live:core         # fresh-D1 cash, WHT/GL, workflows and sync audits
npm run test:browser:pwa       # fresh-D1 Chromium PWA/theme/accessibility audit
```

`test:live:core` resets local D1 before each audit so database mutation from one audit
cannot affect another. The restored suite, commands, and evidence boundary are documented
in [worker/test/README.md](worker/test/README.md) and [docs/RECOVERY-STATUS.md](docs/RECOVERY-STATUS.md).

---

## 5. Deploying to production

### Step 1 — Create the production D1 database

```bash
cd worker
npx wrangler d1 create pharmaridge-db
```

Copy the `database_id` from the output into `worker/wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "pharmaridge-db",
    "database_id": "paste-your-real-id-here",   // ← replace the placeholder
    "migrations_dir": "migrations"
  }
]
```

> The file ships with `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Deploy fails until you change it.

### Step 2 — Apply the schema to production

```bash
npm run db:migrate:remote
```

Verify:

```bash
npx wrangler d1 execute pharmaridge-db --remote \
  --command "SELECT COUNT(*) AS business_tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf%';"
```

Expect **41** application tables after both migrations, and confirm the drug catalog loaded:

```bash
npx wrangler d1 execute pharmaridge-db --remote --command "SELECT COUNT(*) AS drugs FROM nafdac_catalog;"
```

Expect **6801**.

> The `NOT LIKE` filter is deliberate. A bare `COUNT(*) ... WHERE type='table'`
> returns **37**, because Cloudflare adds `d1_migrations` and `_cf_METADATA`
> and SQLite adds `sqlite_sequence`. Filtering those out gives a number you can
> actually compare against.

Two migrations run here: `0001_initial_schema.sql` (the core schema) and
`0002_nafdac_catalog.sql` (6,801 NAFDAC-approved products). The first also seeds
the 14-account chart of accounts and the default `client_settings` row — the GL
cannot post without them, so never skip it.

> **Full step-by-step walkthrough for Windows**, including installing the
> tools from scratch: [`DEPLOY-FROM-WINDOWS.md`](DEPLOY-FROM-WINDOWS.md). The
> steps below are the same procedure in condensed form.

### Step 3 — Set the JWT secret

```bash
npx wrangler secret put JWT_SECRET
```

Paste a long random value when prompted. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> **Never reuse the `.dev.vars` value.** Anyone holding this secret can mint valid tokens for any role, including `ADMIN`. Rotating it later logs everyone out — that's expected.

### Step 4 — Seed production data (choose one)

**Option A — demo/pilot data** (the two GreenLife branches and demo logins):

```bash
npm run db:seed:remote
```

**Option B — real client, clean start.** Skip the seed. Create the first `OWNER` manually so someone can log in, hashing the PIN with the app's own PBKDF2 parameters:

```bash
node -e "
const {hashPin,uuid}=require('./src/lib/crypto');
hashPin('1234').then(h=>console.log(\`INSERT INTO users (id,branch_id,full_name,phone,username,pin_hash,role,job_title) VALUES ('\${uuid()}',NULL,'Owner Name','08000000000','owner','\${h}','OWNER','Proprietor');\`));
" > first-user.sql

npx wrangler d1 execute pharmaridge-db --remote --file=./first-user.sql
```

Change that PIN at first login.

> ⚠️ Run the seed **once**. Re-running duplicates branches and products.

### Step 5 — Deploy the Worker

```bash
npm run deploy
```

Confirm it's alive (`workers.dev` URL is in the deploy output):

```bash
curl https://pharmaridge-api.<your-subdomain>.workers.dev/api/health
# {"ok":true,"env":"production","time":"..."}
```

### Step 6 — Deploy the frontend to Pages

```bash
cd ..
npx wrangler pages project create pharmaridge   # first time only
npx wrangler pages deploy public --project-name pharmaridge
```

There is **no build step** — `public/` ships as-is. `_redirects` (SPA fallback) and `_headers` (CSP, nosniff, frame options, `sw.js` no-cache) are picked up automatically.

### Step 7 — Attach your custom domain

In the Cloudflare dashboard: **Workers & Pages → pharmaridge → Custom domains → Set up a domain** → `yourpharmacy.com`.

### Step 8 — Route `/api/*` to the Worker ← **don't skip**

**Dashboard:** Workers & Pages → `pharmaridge-api` → Settings → **Domains & Routes** → **Add route**:

```
Route:  yourpharmacy.com/api/*
Zone:   yourpharmacy.com
```

**Or in `worker/wrangler.jsonc`** (version-controlled, so a deploy from another machine
cannot forget it — then `npm run deploy` applies it):

```jsonc
"routes": [
  { "pattern": "yourpharmacy.com/api/*", "zone_name": "yourpharmacy.com" }
]
```

> There is **no** `wrangler route add` command in Wrangler 4 — it fails with
> `Unknown argument: route`. Earlier revisions of this guide said otherwise.
> Verified against Wrangler 4.114.0.

Optionally also route `yourpharmacy.com/api/manifest.json` so the PWA install screen picks up client branding.

### Step 9 — Verify

```bash
curl https://yourpharmacy.com/api/health        # Worker responding on your domain
curl -I https://yourpharmacy.com/               # Pages serving the app shell
```

Then load `https://yourpharmacy.com`, log in, and confirm the install prompt appears.

---

## 6. Routing: the one thing people get wrong

`routes` supports two shapes and they are not interchangeable. `{ "pattern": "api.example.com", "custom_domain": true }` means the Worker **owns the whole hostname** — Cloudflare provisions DNS and the certificate, and wildcards are rejected. `{ "pattern": "example.com/api/*", "zone_name": "example.com" }` means the Worker claims **one path prefix** in front of an existing origin. This deployment is the second form: Pages owns the hostname, the Worker takes `/api/*`. Set it in `wrangler.jsonc` (preferred — it is version-controlled) or in the dashboard. It requires a proxied DNS record for the hostname to already exist, which Step 7 creates by attaching the domain to Pages.

**Why it matters:**

| Without the `/api/*` route | With it |
|---|---|
| Pages answers `/api/...` with the SPA fallback → every API call returns **HTML** | Worker answers → JSON |
| Login fails with a JSON parse error | Works |
| Tempting "fix": host the API on `api.yourpharmacy.com` → now you've invented a **CORS problem** the design deliberately avoids | No CORS, no preflight |

If login returns something like `Unexpected token '<'`, this route is missing. That is the single most common deployment failure.

---

## 7. Post-deployment checklist

- [ ] `database_id` replaced in `wrangler.jsonc`
- [ ] `npm run db:migrate:remote` run — 41 application tables + 6,801 catalog rows confirmed
- [ ] `JWT_SECRET` set via `wrangler secret put` (not `.dev.vars`)
- [ ] Seeded once, **or** first OWNER inserted manually
- [ ] Worker deployed; `/api/health` returns `ok:true`
- [ ] Pages deployed with custom domain attached
- [ ] **`yourpharmacy.com/api/*` route added**
- [ ] Logged in successfully on the real domain
- [ ] **All demo PINs changed** (`1234` is public knowledge — see this README)
- [ ] Admin Portal → set business name, logo, plan limits, subscription status
- [ ] Branch geofence lat/long + radius set, or attendance switched to `REGISTERED_DEVICE`
- [ ] PWA installs on an Android device and loads offline once
- [ ] Cron trigger visible under the Worker's **Triggers** tab

---

## 8. Operations

**Cron.** `wrangler.jsonc` registers `0 */6 * * *`; the `scheduled` handler prunes `idempotency_keys` and `sync_change_log` (90-day retention). Without it both grow unbounded. It's created automatically on deploy.

**Logs.**

```bash
cd worker && npm run tail
```

**Backups.** D1 has point-in-time recovery, but take your own export before every migration:

```bash
npx wrangler d1 export pharmaridge-db --remote --output backup-$(date +%F).sql
```

**Future migrations.** Add `migrations/0002_*.sql` — never edit `0001` once it's applied in production.

```bash
npx wrangler d1 migrations list pharmaridge-db --remote
npm run db:migrate:remote
```

**Updating the app.** Bump `CACHE_NAME` in `public/sw.js` (currently `pharmaridge-v73`) whenever you change cached assets, or field devices keep the stale shell.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Wrangler requires at least Node.js v22` | Upgrade Node (nvm/Volta). |
| Login: `Unexpected token '<'` | `/api/*` route missing — §6. |
| `D1_ERROR: no such table: users` | Migration not applied to **remote**: `npm run db:migrate:remote`. |
| All requests 401 right after deploy | `JWT_SECRET` unset in production, or rotated (rotation logs everyone out). |
| `no such column` on a fresh deploy | Migration partially applied — export, recreate the DB, re-migrate. |
| Duplicate branches/products | Seed ran twice. Truncate and reseed. |
| Offline mode never activates | An icon or asset in `sw.js`'s `APP_SHELL` 404s — `cache.addAll()` rejects atomically and the SW never installs. Check DevTools → Application → Service Workers. |
| 403 on every POST, GETs fine | Subscription is `SUSPENDED`/`EXPIRED`. Admin Portal → set `ACTIVE`. |
| Sales blocked at plan limit | `max_branches` / `max_staff` reached — raise in Admin Portal. |
| Day-boundary numbers look off | Reports bucket by **WAT (UTC+1)** deliberately; a 00:30 Lagos sale belongs to that day, not the UTC one. |
| Attendance always `GEOFENCE_NOT_SET` | Branch has no lat/long/radius. Users & Branches → edit branch. |

---

## Security notes

- PINs are **PBKDF2-SHA256, 20,000 iterations**, per-user salt — never stored in plaintext.
- Auth is **bearer JWT** (12h), no cookies, so CSRF isn't applicable.
- The controlled-drug register is hash-chained; `/api/controlled-register/verify/:branchId` detects any tampering.
- `_headers` applies a strict CSP (`default-src 'self'`), `nosniff`, `SAMEORIGIN`, and `no-referrer` to all static assets.
- Change every demo PIN before going live.

---

## License

Proprietary — © PharmaRidge. All rights reserved.
