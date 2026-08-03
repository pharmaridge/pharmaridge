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

## Intentional clean-start state

No demo seed data or default `1234` accounts were loaded into the production database. This avoids exposing a live pharmacy system with public credentials.

**Before the application can be used, create the first Owner account.** That requires the proprietor's approved full name, username, and an initial PIN supplied through a secure channel. Do not add an owner PIN to Git, a shell history, a ticket, or chat history.

## Still required for go-live

- Create the first Owner account and immediately rotate its initial PIN after first login.
- Configure business identity, licence details, branch data, VAT/WHT settings, role permissions, and staff.
- Attach a custom domain when available; the current Workers.dev URL is appropriate for infrastructure verification, not the preferred client-facing address.
- Run physical-device PWA, offline sync, and thermal-printer tests.
- Add monitoring/alerting and record the responsible operational contacts.
