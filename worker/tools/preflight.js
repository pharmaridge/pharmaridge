#!/usr/bin/env node
/* Production deployment guardrails.
 *
 * This does not contact Cloudflare or read production secrets. It catches the
 * deterministic configuration mistakes that otherwise turn into a broken or
 * insecure deployment: unsupported Node runtime, placeholder D1 binding, and
 * accidental local credential files. Run `npm run preflight` immediately
 * before `npm run deploy`.
 */
const fs = require('node:fs');
const path = require('node:path');

const workerRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(workerRoot, '..');
const failures = [];
const warnings = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  failures.push(`Node.js ${process.versions.node} detected; Wrangler 4 in this project requires Node.js 22 or newer.`);
}

const wranglerPath = path.join(workerRoot, 'wrangler.jsonc');
const wrangler = fs.readFileSync(wranglerPath, 'utf8');
const databaseMatch = wrangler.match(/"database_id"\s*:\s*"([^"]+)"/);
if (!databaseMatch || !databaseMatch[1] || /REPLACE_WITH|YOUR_D1|placeholder/i.test(databaseMatch[1])) {
  failures.push('worker/wrangler.jsonc still contains the D1 database_id placeholder. Create the production D1 database and set its real ID before deploy.');
}

const expected = [
  'migrations/0001_initial_schema.sql',
  'migrations/0002_nafdac_catalog.sql',
  'src/index.js',
  '../public/index.html',
  '../public/sw.js',
  '../public/icons/icon-192.png',
  '../public/icons/icon-512.png',
];
for (const relative of expected) {
  if (!fs.existsSync(path.resolve(workerRoot, relative))) {
    failures.push(`Required deployment file is missing: ${relative}`);
  }
}

const localSecrets = [path.join(workerRoot, '.dev.vars'), path.join(repoRoot, '.env')]
  .filter((file) => fs.existsSync(file));
if (localSecrets.length) {
  warnings.push(`Local credential file(s) present and correctly gitignored: ${localSecrets.map((file) => path.relative(repoRoot, file)).join(', ')}. Confirm they are not deployed or committed.`);
}


for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log('Preflight passed: runtime, D1 binding, deployment assets, and local-secret safeguards are ready.');
