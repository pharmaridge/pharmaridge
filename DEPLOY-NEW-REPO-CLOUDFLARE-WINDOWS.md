# Deploy PharmaRidge from a Downloaded Folder to a New GitHub Repository and Cloudflare

This is the **Windows Terminal / PowerShell** procedure for a folder you downloaded and opened in VS Code. It creates a **new private GitHub repository**, a **new Cloudflare D1 database**, a **new Worker Assets deployment** (frontend and API together), and a secure first PharmaRidge Admin account.

> **Do not deploy the downloaded sample configuration unchanged.** It may name a sample Worker and sample D1 database. This guide changes both before any remote command is run.
>
> All commands below are PowerShell commands. Open the folder in VS Code, then open **Terminal → New Terminal**. The terminal prompt must be at the `pharmaridge` folder that contains `public`, `worker`, and `README.md`.

---

## 0. What this deployment creates

```text
Your new private GitHub repository
        │
        ├── Cloudflare Worker Assets
        │     ├── public/ (PWA frontend)
        │     └── /api/* (Hono Worker API)
        │
        └── New Cloudflare D1 database
              ├── migrations 0001–0004
              ├── 6,801 NAFDAC catalog rows
              └── your first secure PharmaRidge Admin account
```

This guide uses **Worker Assets**, not Cloudflare Pages. One `wrangler deploy` publishes both the PWA files in `public/` and the API in `worker/src/`. This is the simplest and safest first production topology because the browser and API stay on one hostname.

---

## 1. Install the Windows tools once

Run these from an **Administrator PowerShell** only if the tools are not already installed. Close and reopen VS Code after installation.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.cli
```

Verify from the VS Code terminal:

```powershell
node --version
npm --version
git --version
gh --version
```

PharmaRidge requires **Node.js 22 or newer**. If `node --version` starts with `v20` or below, install/update Node 22 LTS before continuing.

---

## 2. Confirm you are in the downloaded PharmaRidge folder

```powershell
Get-Location
Get-ChildItem
```

You should see at least:

```text
public
worker
README.md
.gitignore
```

If necessary, change directory. Replace the example path with your real download location:

```powershell
Set-Location "C:\Users\YOUR-WINDOWS-USER\Downloads\pharmaridge"
```

---

## 3. Create a new Git repository safely

### Option A — make this downloaded folder a completely new repository

Use this if you do **not** want the original project Git history or remote attached.

> `Remove-Item .git` removes Git history/remote metadata only. It does not delete the PharmaRidge source files.

```powershell
if (Test-Path .git) {
    Remove-Item -Recurse -Force .git
}

git init
git branch -M main
git config user.name "YOUR NAME OR COMPANY"
git config user.email "you@your-company.example"
```

Check that secrets are ignored before committing anything:

```powershell
git check-ignore worker\.dev.vars
Get-Content .gitignore
```

Expected: `worker\.dev.vars` is ignored. Never remove that protection.

Create the first local commit:

```powershell
git add .
git status
git commit -m "Initial PharmaRidge client deployment"
```

### Create and push a new private GitHub repository from the terminal

Authenticate GitHub CLI once. Choose **GitHub.com**, **HTTPS**, then complete the browser sign-in it opens:

```powershell
gh auth login
```

Choose a short repository name. Example:

```powershell
$RepoName = "my-pharmacy-pharmaridge"
gh repo create $RepoName --private --source=. --remote=origin --push
```

Verify:

```powershell
git remote -v
git status
git log -1 --oneline
```

### Option B — you already created an empty private repository in GitHub

Do not run `gh repo create`. Copy the HTTPS URL from GitHub, then run:

```powershell
git remote add origin "https://github.com/YOUR-GITHUB-USER/YOUR-NEW-REPOSITORY.git"
git push -u origin main
```

If `origin` already exists and points to the downloaded project’s old repository:

```powershell
git remote remove origin
git remote add origin "https://github.com/YOUR-GITHUB-USER/YOUR-NEW-REPOSITORY.git"
git push -u origin main
```

---

## 4. Install the Worker dependencies

From the repository root:

```powershell
Set-Location .\worker
npm ci
```

Use `npm ci`, not `npm audit fix --force`. The lock file pins the tested Worker/Cloudflare dependency set.

Confirm Wrangler can sign in to your Cloudflare account:

```powershell
npx wrangler login
npx wrangler whoami
```

The browser window that opens during login is normal. Do not paste a Cloudflare API token into a Git-tracked file.

---

## 5. Choose names for the new Cloudflare resources

Use lowercase letters, numbers and hyphens. Do **not** reuse the downloaded sample Worker/database names.

```powershell
$WorkerName = "my-pharmacy-app"
$DatabaseName = "my-pharmacy-db"
```

Create a brand-new D1 database:

```powershell
npx wrangler d1 create $DatabaseName
```

Cloudflare prints output similar to:

```text
✅ Successfully created DB 'my-pharmacy-db'
[[d1_databases]]
binding = "DB"
database_name = "my-pharmacy-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id`, then store it in a PowerShell variable for this session:

```powershell
$DatabaseId = Read-Host "Paste the new Cloudflare D1 database_id"
```

Do not use the old/downloaded database ID.

---

## 6. Point `worker/wrangler.jsonc` at your new Worker and D1 database

Run this from the `worker` folder:

```powershell
$ConfigFile = Join-Path $PWD "wrangler.jsonc"
$Config = Get-Content -Raw $ConfigFile

$Config = [regex]::Replace($Config, '("name"\s*:\s*")[^"]+(")', ('$1' + $WorkerName + '$2'), 1)
$Config = [regex]::Replace($Config, '("database_name"\s*:\s*")[^"]+(")', ('$1' + $DatabaseName + '$2'), 1)
$Config = [regex]::Replace($Config, '("database_id"\s*:\s*")[^"]+(")', ('$1' + $DatabaseId + '$2'), 1)

[System.IO.File]::WriteAllText($ConfigFile, $Config, (New-Object System.Text.UTF8Encoding($false)))
```

Review the three changed values before deploying:

```powershell
Select-String -Path .\wrangler.jsonc -Pattern '"name"|"database_name"|"database_id"'
```

You must see your new Worker name, new D1 name and new D1 ID.

Commit this non-secret configuration to your **private** repository:

```powershell
Set-Location ..
git add .\worker\wrangler.jsonc
git commit -m "Configure new Cloudflare Worker and D1 database"
git push
Set-Location .\worker
```

> A D1 database ID is not a password, but keeping a real client deployment repository private is still recommended. Never commit API tokens, `.dev.vars`, `.env`, `first-admin.sql`, a database export, or a real client backup.

---

## 7. Apply all D1 migrations to the new remote database

Run this exactly once for the new empty database:

```powershell
npx wrangler d1 migrations apply $DatabaseName --remote
```

List the applied migrations:

```powershell
npx wrangler d1 migrations list $DatabaseName --remote
```

Verify the NAFDAC catalog loaded:

```powershell
npx wrangler d1 execute $DatabaseName --remote --command "SELECT COUNT(*) AS catalog_rows FROM nafdac_catalog;"
```

Expected result:

```text
6801
```

Do **not** run `npm run db:seed:remote` for a real pharmacy deployment. That command creates demonstration people, branches, stock and PINs. The real deployment should begin clean.

---

## 8. Set the production JWT secret

Generate a one-time strong secret in the terminal:

```powershell
$JwtSecret = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Store it in Cloudflare when prompted:

```powershell
$JwtSecret | npx wrangler secret put JWT_SECRET
Remove-Variable JwtSecret
```

Verify the secret name exists without printing its value:

```powershell
npx wrangler secret list
```

Never place the production secret in any of these:

```text
worker\.dev.vars
.env
GitHub commit messages
PowerShell scripts committed to Git
screenshots
```

---

## 9. Create the first PharmaRidge Admin account securely

A new D1 database has the schema and catalog, but no people. Create the first **PharmaRidge Admin** locally as a generated, gitignored SQL file. This Admin is the deployment/bootstrap seat; it creates the client Owner only after the Worker is live.

From `worker`:

```powershell
$env:PHARMARIDGE_ADMIN_NAME = Read-Host "PharmaRidge Admin full name"
$env:PHARMARIDGE_ADMIN_USERNAME = Read-Host "PharmaRidge Admin username"
$env:PHARMARIDGE_ADMIN_PHONE = Read-Host "PharmaRidge Admin phone (optional)"

$SecurePin = Read-Host "Choose a 12+ character Admin PIN/password" -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePin)
try {
    $env:PHARMARIDGE_ADMIN_PIN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    npm run db:bootstrap:admin
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    Remove-Variable SecurePin -ErrorAction SilentlyContinue
}

npx wrangler d1 execute $DatabaseName --remote --file .\first-admin.sql

Remove-Item Env:\PHARMARIDGE_ADMIN_NAME, Env:\PHARMARIDGE_ADMIN_USERNAME, Env:\PHARMARIDGE_ADMIN_PHONE, Env:\PHARMARIDGE_ADMIN_PIN -ErrorAction SilentlyContinue
Remove-Item .\first-admin.sql
```

Verify that exactly one active Admin exists. This query returns no PIN or hash:

```powershell
npx wrangler d1 execute $DatabaseName --remote --command "SELECT username, role, is_active FROM users WHERE role = 'ADMIN';"
```

Do not create a client Owner in SQL. The Admin signs in after the Worker is deployed and creates the client Owner through Users & Branches, so the normal onboarding audit trail starts at the first real client account.

---

## 10. Deploy the Worker and PWA assets

The Worker configuration already points at `../public`, so this command deploys both the API and the downloaded PWA folder:

```powershell
npm run deploy
```

Wrangler prints a URL like:

```text
https://my-pharmacy-app.<your-subdomain>.workers.dev
```

Store it for the smoke test:

```powershell
$WorkerUrl = Read-Host "Paste the deployed workers.dev URL without a trailing slash"
Invoke-RestMethod "$WorkerUrl/api/health"
```

Expected: JSON containing at least `"ok": true` and `"env": "production"`.

Open the app in the browser:

```powershell
Start-Process $WorkerUrl
```

---

## 11. Create the client Owner after deployment

1. Sign in with the secure PharmaRidge Admin account created in step 9.
2. Open **Users & Branches**.
3. Create the named client Owner with a unique PIN/password issued privately to that person.
4. Ask the Owner to sign in and complete the normal first-run setup: branches, managers, staff, suppliers, customers and first stock receipt.

Do not create, publish, or reuse a sample/default credential.

---

## 12. Optional: attach a client-owned custom domain through Cloudflare

First make sure the domain is already added to the same Cloudflare account. For a dedicated app hostname, use a Worker custom domain, for example:

```text
app.yourpharmacy.example
```

Open the config from the terminal:

```powershell
code .\wrangler.jsonc
```

Change the end of the configuration so the `assets` block has a trailing comma, then add this route block. Replace the hostname:

```jsonc
  "assets": {
    "directory": "../public",
    "run_worker_first": ["/api/*"]
  },
  "routes": [
    { "pattern": "app.yourpharmacy.example", "custom_domain": true }
  ]
```

Deploy again:

```powershell
npm run deploy
```

Verify the custom domain:

```powershell
$AppUrl = "https://app.yourpharmacy.example"
Invoke-RestMethod "$AppUrl/api/health"
Start-Process $AppUrl
```

This Worker Assets deployment serves the whole app and `/api/*` from the same hostname. Do not separately deploy `public/` to Pages unless you intentionally redesign routing.

---

## 13. First production smoke test

Complete these in the browser before handing the app to a pharmacy team:

1. Owner signs in.
2. Owner creates one real branch, Manager and Staff member.
3. Manager creates a supplier and receives a small test product batch.
4. Staff opens a till, completes one cash sale and prints/reviews the receipt.
5. Manager closes the till with the physical expected amount.
6. Owner checks Dashboard, Accounting, VAT/WHT settings, Users and Data Management.
7. Install the PWA on the intended counter phone/laptop, then remove/reinstall if a launcher icon has been cached from a prior build.
8. Confirm `https://YOUR-DOMAIN/api/health` still returns JSON, not HTML.

---

## 14. Day-two deploy/update routine

From the VS Code terminal at the repository root:

```powershell
git pull
Set-Location .\worker
npm ci
npx wrangler d1 migrations apply $DatabaseName --remote
npm run deploy
Set-Location ..
git status
```

Use this order every time:

```text
pull source → install locked dependencies → apply new migrations → deploy → smoke-test
```

Do not run a destructive reset script against a real pharmacy database. Take/export a backup and confirm the target database name before any remote D1 command.

---

## 15. Useful PowerShell checks

```powershell
# Current Cloudflare account identity
npx wrangler whoami

# Worker deployment details
npx wrangler deployments list

# Applied migrations
npx wrangler d1 migrations list $DatabaseName --remote

# Production health
Invoke-RestMethod "$WorkerUrl/api/health"

# Confirm the catalog remains present
npx wrangler d1 execute $DatabaseName --remote --command "SELECT COUNT(*) AS catalog_rows FROM nafdac_catalog;"

# Confirm Git has no accidental secrets waiting to commit
git status
git check-ignore worker\.dev.vars
```

## Stop immediately if any of these happen

```text
Worker name is still sample
Database name/ID is from the downloaded project
Git status shows .dev.vars, .env, first-admin.sql, backup SQL, or a database file
/api/health returns HTML instead of JSON
You are about to run a remote seed/reset command against a real database
```

Correct the configuration first; do not “try it and see” with production pharmacy data.
