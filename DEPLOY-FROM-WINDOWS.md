# Deploying PharmaRidge from Windows

> Follow `docs/PRODUCTION-READINESS.md` first. This guide is a command translation, not production approval.

## Prerequisites

1. Install Node.js **22 LTS or newer** and reopen PowerShell.
2. Install Git and sign in to Cloudflare.
3. From the repository root, open PowerShell and run:

```powershell
cd worker
npm install
npx wrangler login
npm test
npm run preflight
```

`npm run preflight` will stop while `database_id` is still the placeholder; that is expected and must be corrected before deploy.

## Create and configure D1

```powershell
npx wrangler d1 create pharmaridge-db
```

Copy the returned database ID into `worker/wrangler.jsonc` at `d1_databases[0].database_id`. Do not commit a real client ID to a public repository.

Apply migrations:

```powershell
npm run db:migrate:remote
npx wrangler d1 execute pharmaridge-db --remote --command "SELECT COUNT(*) AS catalog_rows FROM nafdac_catalog;"
```

The catalog count must be `6801`.

## Configure the Worker secret and deploy

Generate a secret locally:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Set it when prompted:

```powershell
npx wrangler secret put JWT_SECRET
npm run preflight
npm run deploy
```

Do not place production secrets in `.dev.vars`, `.env`, PowerShell history, or a committed file.

## Deploy the PWA

From the repository root:

```powershell
cd ..
npx wrangler pages project create pharmaridge
npx wrangler pages deploy public --project-name pharmaridge
```

Attach the custom domain to Pages in the Cloudflare dashboard. Then add one Worker route in **Workers & Pages → Worker → Settings → Domains & Routes**:

```text
yourpharmacy.example/api/*
```

Pages must own the hostname; the Worker must own only `/api/*`. If login returns `Unexpected token '<'`, the API path is reaching the Pages SPA fallback instead of the Worker.

## Final smoke test

1. Load `https://yourpharmacy.example/api/health` and confirm JSON.
2. Load the app, log in, and confirm a normal sale and receipt.
3. Change demo PINs if seed data was used.
4. Install the PWA on an Android/iOS device, open it offline after first load, and replay a queued sale when connected.
5. Record the deployment version, D1 migration list, release approver, and smoke-test evidence.
