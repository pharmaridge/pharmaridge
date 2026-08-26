# Secure first-Admin bootstrap from a terminal

Use this only for a newly created database that has **no Admin account**. For a
formatted existing PharmaRidge database, use the schema-format process in
[`DATA-MANAGEMENT.md`](DATA-MANAGEMENT.md): it preserves the existing active
Admin account and its password hash.

The Admin username may be `admin`, but the password/PIN must be unique to the
deployment. Never place a real password/PIN in source code, a seed file, Git,
a command history, a screenshot, or this document.

## Windows PowerShell

From `worker/`, capture the sensitive password/PIN without echoing it and run
the one-time generator:

```powershell
$env:PHARMARIDGE_ADMIN_NAME = Read-Host "Admin full name"
$env:PHARMARIDGE_ADMIN_USERNAME = "admin"
$env:PHARMARIDGE_ADMIN_PHONE = Read-Host "Admin phone (optional)"
$SecurePin = Read-Host "Unique Admin password/PIN" -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePin)
try {
    $env:PHARMARIDGE_ADMIN_PIN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    npm run db:bootstrap:admin
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    Remove-Item Env:\PHARMARIDGE_ADMIN_NAME, Env:\PHARMARIDGE_ADMIN_USERNAME, Env:\PHARMARIDGE_ADMIN_PHONE, Env:\PHARMARIDGE_ADMIN_PIN -ErrorAction SilentlyContinue
}
```

The command creates the ignored `worker/first-admin.sql` file with a PBKDF2
hash, not plaintext. Review the target database name, take a backup if it is
not new, then execute it once:

```powershell
npx wrangler d1 execute pharmaridge-db --remote --file=./first-admin.sql
Remove-Item ./first-admin.sql
```

## macOS or Linux shell

```bash
read -r -p 'Admin full name: ' PHARMARIDGE_ADMIN_NAME
export PHARMARIDGE_ADMIN_NAME
export PHARMARIDGE_ADMIN_USERNAME='admin'
read -r -s -p 'Unique Admin password/PIN: ' PHARMARIDGE_ADMIN_PIN; echo
export PHARMARIDGE_ADMIN_PIN
npm run db:bootstrap:admin
npx wrangler d1 execute pharmaridge-db --remote --file=./first-admin.sql
rm -f ./first-admin.sql
unset PHARMARIDGE_ADMIN_NAME PHARMARIDGE_ADMIN_USERNAME PHARMARIDGE_ADMIN_PIN
```

## Verify without exposing a credential

Confirm only that one active Admin row exists; do not print password hashes:

```bash
npx wrangler d1 execute pharmaridge-db --remote --command "SELECT COUNT(*) AS active_admins FROM users WHERE role='ADMIN' AND is_active=1 AND is_deleted=0;"
```

Sign in privately, create the pharmacy Owner through the Admin portal, then
let the Owner create branches and operational accounts. Delete the generated
SQL file immediately after its one use.
