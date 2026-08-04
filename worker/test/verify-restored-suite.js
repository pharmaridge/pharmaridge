#!/usr/bin/env node
/* Restored test-artifact integrity check.
 *
 * The test artifact arrived as one concatenated text file. This guard makes
 * the restored suite executable as a suite again: every recovered JS file must
 * parse, the core live-audit entrypoints must be present, and the icon builder
 * must have the browser dependency it declares.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_ROOT = __dirname;
const WORKER_ROOT = path.resolve(TEST_ROOT, '..');
const expected = [
  'audit.money.js',
  'audit.wht.js',
  'audit.workflows.js',
  'audit.sync.js',
  'lib-fefo.js',
  'tools/build-icons.js',
  'tools/probe-icon.js',
  'tools/seed-scenarios.js',
  'tools/shots-manual.js',
  'TESTING-PLAYBOOK.md',
  'run-core-live.sh',
  'run-browser-pwa.sh',
  'build-onboarding-guide.sh',
  'run-role-domain-audits.sh',
  'run-login-lifecycle-audit.sh',
  'run-full-domain-audit.sh',
  'run-full-frontend-audit.sh',
  'tools/probe-login-lifecycle.js',
  'audit.single-session.js',
];
for (const relative of expected) {
  assert.ok(fs.existsSync(path.join(TEST_ROOT, relative)), `missing restored test asset: ${relative}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(TEST_ROOT).filter((file) => file.endsWith('.js'));
for (const sourceFile of sourceFiles) {
  const parsed = spawnSync(process.execPath, ['--check', sourceFile], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, `${path.relative(WORKER_ROOT, sourceFile)} does not parse:\n${parsed.stderr}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(WORKER_ROOT, 'package.json'), 'utf8'));
assert.ok(packageJson.devDependencies && packageJson.devDependencies.puppeteer, 'Puppeteer is required by restored browser/icon tools');
assert.equal(packageJson.scripts['assets:icons'], 'node test/tools/build-icons.js');
assert.equal(packageJson.scripts['test:icons'], 'node test/tools/probe-icon.js');
assert.equal(packageJson.scripts['test:live:core'], 'bash test/run-core-live.sh');
assert.equal(packageJson.scripts['test:browser:pwa'], 'bash test/run-browser-pwa.sh');
assert.equal(packageJson.scripts['docs:onboarding'], 'bash test/build-onboarding-guide.sh');
assert.equal(packageJson.scripts['test:live:roles'], 'bash test/run-role-domain-audits.sh');
assert.equal(packageJson.scripts['test:browser:login'], 'bash test/run-login-lifecycle-audit.sh');
assert.equal(packageJson.scripts['test:live:full-domain'], 'bash test/run-full-domain-audit.sh');
assert.equal(packageJson.scripts['test:frontend:full'], 'bash test/run-full-frontend-audit.sh');

console.log(`Restored test suite verified: ${sourceFiles.length} JavaScript files parse; core live audits and browser/icon tooling are wired.`);
