# Deployment Status — 2026-08-04

## Live infrastructure

| Component | Status |
|---|---|
| GitHub repository / `main` | Pushed and tracking `origin/main` |
| Cloudflare Worker | Deployed |
| Live application URL | `https://pharmaridge-api.pharmaridge.workers.dev` |
| Worker Static Assets | Deployed from `public/`; API paths run Worker-first |
| Production D1 database | Created and migrated |
| D1 schema verification | 41 application tables, 6,801 NAFDAC catalog rows, 19 system GL accounts, 1 client-settings row |
| JWT secret | Configured as a Cloudflare Worker secret; value is not stored in this repository |
| Scheduled retention trigger | Deployed: every six hours |

## Live verification completed

- `GET /api/health` returns `ok: true`, confirms the JWT secret is configured, and reports D1 storage health.
- `GET /api/manifest.json` returns the dynamic PWA manifest.
- The app shell is served with CSP, `nosniff`, frame protection, referrer policy, and the geolocation permissions policy.
- A login attempt against the clean database returns a normal `401 Invalid credentials`, not a deployment/runtime error.

## Shared live-sample state

The production database is intentionally loaded with **demonstration data only** so prospective clients can explore the application.

| Username | PIN | Purpose |
|---|---|---|
| `owner` | `1234` | Full pharmacy-owner sample view across every branch and report |
| `admin` | `1234` | PharmaRidge Admin Portal sample view |

These are deliberately public sample credentials, not client credentials. The instance contains GreenLife demonstration branches, products, staff, and transaction data. It may be reset after demonstrations; do not enter real patient, customer, staff, supplier, or financial information.

## Still required before a real client go-live

- Create client-specific Owner/Admin accounts with non-default credentials in a separate client database.
- Configure business identity, licence details, branch data, VAT/WHT settings, role permissions, and staff.
- Attach a custom domain when available; the current Workers.dev URL is appropriate for the live sample, not the preferred client-facing address.
- Run physical-device PWA, offline sync, and thermal-printer tests.
- Add monitoring/alerting and record the responsible operational contacts.
