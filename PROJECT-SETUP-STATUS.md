# PharmaRidge — Historical Setup Status (Artifact Claim)

> **Archived evidence, not current certification.** This document was included inside the uploaded artifact and makes claims about an earlier 13,801-line reconstruction and historical test execution. The artifact delivered for the current recovery is 38,605 lines and did not include the tests named below. Treat the claims here as historical context only; see [docs/RECOVERY-STATUS.md](docs/RECOVERY-STATUS.md) for present evidence and [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) for release blockers.

---

## 1. What the project is

PharmaRidge — a multi-branch Nigerian pharmacy / PPMV management system.
Offline-first PWA frontend + Cloudflare Workers & D1 edge backend.

Feature surface: POS with FEFO batch picking, controlled-drug register with a
verifiable hash chain, till/cash reconciliation, stocktakes, purchase orders,
branch transfers, debtors/creditors, expenses, GPS-geofence & registered-device
staff attendance, double-entry general ledger, plan limits / subscription gating,
white-label branding, and an offline sync engine.

---

## 2. Verification performed

| Check | Result |
|---|---|
| Line accounting (13,801 lines → 78 files) | ✅ exact, no remainder |
| `node --check` on all 76 `.js` files | ✅ all parse |
| `worker/src/index.js` as ESM | ✅ parses |
| `package.json`, `manifest.json` JSON validity | ✅ valid |
| Every relative `require()` resolves to a real file | ✅ 0 missing |
| All 23 `app.route()` mounts have a matching route file | ✅ 23/23 |
| All `<script>` tags in `index.html` resolve | ✅ all present |
| `npm install` in `worker/` | ✅ succeeds (hono + wrangler) |

---

## 3. Repo layout

```
pharmaridge/
├── worker/                        # Cloudflare Workers + D1 backend
│   ├── wrangler.jsonc             # D1 binding, cron trigger, routing notes
│   ├── package.json               # hono ^4.12.32, wrangler ^4.114.0
│   ├── generate-seed.js           # emits seed.sql with real PBKDF2 PINs
│   ├── seed.sql                   # generated demo data (gitignored)
│   ├── .dev.vars                  # local JWT_SECRET (gitignored) — added by setup
│   ├── test/integration.test.js   # 150 tests, runs against real wrangler dev + D1
│   └── src/
│       ├── index.js               # Hono app, CORS, gates, cron, error handler
│       ├── routes/    (23 files)  # auth, sales, till, stock, gl, admin, sync, …
│       ├── services/  (6 files)   # sales(690L), gl(428L), sync, stocktake, till, attendance
│       └── lib/       (8 files)   # auth, crypto, db, business, planLimits, idempotency, …
└── public/                        # Cloudflare Pages frontend (vanilla JS PWA)
    ├── index.html, manifest.json, sw.js, _redirects, _headers
    ├── css/style.css
    └── js/
        ├── app.js, api.js, offline.js, router.js, state.js, ui.js, branding.js, deviceId.js
        └── views/ (23 screens)    # pos, dashboard, accounting, admin, attendance, …
```

Backend ~5,100 LOC · frontend ~5,600 LOC · tests ~2,900 LOC.

---

## 4. Gap status — RESOLVED

1. ✅ **`worker/migrations/0001_initial_schema.sql`** — supplied and installed.
   41 tables, 14 views, 1 balance-enforcing trigger, 64 indexes. Verified to
   execute cleanly, satisfy every table/view/column the code references, and
   accept the generated seed. One line patched for D1 (see §4a).
   **`worker/migrations/0002_nafdac_catalog.sql`** ships alongside it with the
   6,801-product NAFDAC approved-product catalog. Both apply together via
   `npm run db:migrate:local` / `:remote`.
2. ✅ **`public/icons/*`** — 5 PNGs generated in the brand green (#0b3d2e):
   192, 512, both maskable variants, and apple-touch-icon. `APP_SHELL` is now
   complete, so the service worker installs and offline mode works.
3. ✅ **`README.md`** — written, with the full deployment guide.
4. ⬜ `DEPLOYMENT-CLOUDFLARE.md` — still absent, but its content (the `/api/*`
   routing walkthrough) is now covered in README §5–6. Only the cross-reference
   in code comments is dangling.
5. ✅ Single backend — Cloudflare Workers + D1. The Node/Express
   deployment once referenced in code comments has been dropped; all stale
   references are gone.

### 4a. The one schema edit

The standalone `PRAGMA foreign_keys = ON;` on line 62 was commented out.
D1 runs every statement in an implicit transaction and always enforces foreign
keys, so user SQL cannot set that pragma — leaving it can abort
`wrangler d1 migrations apply`. Behaviour is unchanged. The line is preserved,
commented, with a note for anyone running the schema against plain SQLite.
**Exactly one line changed; no table, view, index, or constraint was touched.**

---

## 5. Configuration you must supply

| Item | Where | Status |
|---|---|---|
| `JWT_SECRET` | `worker/.dev.vars` local; `wrangler secret put JWT_SECRET` prod | ✅ dev placeholder created — **change before prod** |
| `database_id` | `worker/wrangler.jsonc` | ⚠️ still `REPLACE_WITH_YOUR_D1_DATABASE_ID` |
| `/api/*` route | Cloudflare dashboard → Worker → Domains & Routes | ⚠️ manual, per `wrangler.jsonc` |

Note: the toolchain needs **Node.js ≥ 22** (wrangler v4 refuses v20).

---

## 6. Run order once the schema exists

```bash
cd worker
npm install
npx wrangler d1 create pharmaridge-db     # paste the id into wrangler.jsonc
npm run db:migrate:local                  # applies BOTH migrations
npm run db:seed:local

# 1943 checks, no server needed:
npm test

# Live suites — devserver.sh guarantees a fresh DB and exactly one server:
bash test/devserver.sh
WORKER_BASE=http://127.0.0.1:9001 npm run test:integration   # 150
WORKER_BASE=http://127.0.0.1:9001 npm run test:live          # 189
```

Demo logins (all PIN `1234`): `manager` (General Manager), `lagos.mgr` (Branch Manager — Lagos only), `owner`, `admin`, `lagos.staff`, `minna.staff`.
**Change every one of them before go-live.**

---

## 7. Status

**Deployable, and fully exercised.** Schema, catalog, icons, print/export and
deployment docs are all in place.

- **2283 checks pass** — 1943 on plain Node, plus 150 integration and 190 live
  checks against a real `wrangler dev` + real D1.
- Both migrations apply through Wrangler itself.

**Requires Node ≥ 22** (Wrangler 4 refuses Node 20).

For deployment, follow [`DEPLOY-FROM-WINDOWS.md`](DEPLOY-FROM-WINDOWS.md) if you
are on Windows, or [`README.md`](README.md) §5 otherwise.

**Still outstanding:** this has never been deployed to real Cloudflare (local
`wrangler dev` cannot enforce the free tier's 50-subrequest or 10 ms CPU
ceilings).
[`AUDIT-REPORT.md`](AUDIT-REPORT.md) for the full limitations list.
