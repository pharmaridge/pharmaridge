# Production Readiness Gate

**Current verdict: NOT APPROVED FOR PRODUCTION.** The repository has been structurally reconstructed and locally validated, but the supplied artifact did not contain its claimed functional/browser/integration test sources and has never been exercised on the target Cloudflare account.

## Mandatory blockers

- [ ] Use **Node.js 22+**. `npm run preflight` deliberately rejects lower versions.
- [ ] Create the production D1 database and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `worker/wrangler.jsonc`.
- [ ] Set a unique high-entropy production `JWT_SECRET` using `wrangler secret put JWT_SECRET`; never reuse a development value.
- [ ] Apply both migrations remotely to an empty/staging D1 database and record the result.
- [ ] Restore or replace the absent behavioral test suite. At minimum cover authentication/RBAC, sale creation/voids, stock decrement races, till close, GL balancing, WHT, offline idempotency, and branch scope.
- [ ] Deploy to a staging Worker and Pages project on the same hostname; route only `your-domain/api/*` to the Worker.
- [ ] Execute a real-device PWA install/offline/reconnect/receipt-print smoke test.
- [ ] Change every seeded/demo PIN (`1234`) before any public or client use.
- [ ] Obtain pharmacist/compliance review of POM and controlled-drug classifications.
- [ ] Have an owner configure branch data, licence dates, attendance mode, geofence/device records, VAT/WHT policy, permissions, and plan limits.

## Local gate

```bash
cd worker
npm install
npm test                 # recovered structural verification only
npm run preflight        # must pass before deployment
```

`npm run preflight` is intentionally expected to fail in a clean recovery checkout until the real D1 database ID is configured. It checks the runtime version, D1 binding placeholder, required migrations, PWA shell files, and the recovery-status warning.

## Staging deployment procedure

1. Create a D1 database and configure only the **staging** ID in `wrangler.jsonc` or use a staging-specific configuration.
2. Apply migrations with `npm run db:migrate:remote`.
3. Set the staging `JWT_SECRET`.
4. Deploy the Worker: `npm run deploy`.
5. Deploy the `public/` directory to a staging Cloudflare Pages project.
6. Add the same-host route `staging.example.com/api/*` to the Worker. Do not split the browser into a separate API origin unless CORS is deliberately designed and tested.
7. Verify `/api/health`, login, complete sale, controlled/POM workflow, void, cash close, transfer, and role restrictions.
8. Test offline queue replay with a deliberately interrupted request and confirm idempotent replay.
9. Export the D1 schema/data before any further migration work.

## Production release controls

- Back up/export D1 before each migration and retain restore instructions.
- Use separate staging and production D1 databases/secrets.
- Require a change log for every migration and never edit a migration already applied remotely.
- Review Worker logs (`wrangler tail`) during the first operating day.
- Configure external uptime/error alerting; no monitoring configuration was included in the artifact.
- Keep a release record: Git commit/hash, Wrangler version, migration list, deployment timestamp, approver, and smoke-test evidence.
- Bump `CACHE_NAME` in `public/sw.js` whenever cached shell assets change, then verify update activation on a physical device.

## Evidence retained

See `docs/RECOVERY-STATUS.md` for the artifact hash, exact reconstruction boundary, validations completed, and missing evidence.
