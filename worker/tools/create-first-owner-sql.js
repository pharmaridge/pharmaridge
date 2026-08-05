// Creates a one-time, ignored SQL file for a real client deployment's FIRST
// OWNER account. Run from worker/ only after migrations are applied remotely.
//
// Required environment variables (set in the current PowerShell session only):
//   PHARMARIDGE_OWNER_NAME
//   PHARMARIDGE_OWNER_USERNAME
//   PHARMARIDGE_OWNER_PIN
// Optional:
//   PHARMARIDGE_OWNER_PHONE
//
// Output: worker/first-user.sql (gitignored). It contains a PBKDF2 hash, never
// the plaintext PIN. Execute it once with Wrangler, then delete the file.
const fs = require('fs');
const path = require('path');
const { hashPin, uuid } = require('../src/lib/crypto');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function sql(value) {
  return String(value).replace(/'/g, "''");
}

(async () => {
  const fullName = required('PHARMARIDGE_OWNER_NAME');
  const username = required('PHARMARIDGE_OWNER_USERNAME');
  const pin = required('PHARMARIDGE_OWNER_PIN');
  const phone = String(process.env.PHARMARIDGE_OWNER_PHONE || '').trim();

  if (fullName.length > 120) throw new Error('PHARMARIDGE_OWNER_NAME must be 120 characters or fewer.');
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error('PHARMARIDGE_OWNER_USERNAME must be 3–64 letters, numbers, dots, underscores or hyphens.');
  }
  if (pin.length < 8) throw new Error('Choose an owner PIN/password of at least 8 characters for a real deployment.');

  const pinHash = await hashPin(pin);
  const out = path.join(__dirname, '..', 'first-user.sql');
  const statement = `-- One-time first Owner bootstrap. Delete this file after running it.\n`
    + `INSERT INTO users (id, branch_id, full_name, phone, username, pin_hash, role, job_title)\n`
    + `VALUES ('${uuid()}', NULL, '${sql(fullName)}', ${phone ? `'${sql(phone)}'` : 'NULL'}, '${sql(username)}', '${sql(pinHash)}', 'OWNER', 'Proprietor');\n`;
  fs.writeFileSync(out, statement, { mode: 0o600 });
  console.log(`Created ${out}`);
  console.log('It contains only a PIN hash. Run it once against the NEW remote D1 database, then delete it.');
})().catch((error) => {
  console.error(`Bootstrap file was not created: ${error.message}`);
  process.exit(1);
});
