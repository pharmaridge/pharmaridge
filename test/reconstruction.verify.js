#!/usr/bin/env node
/*
 * Recovery-level structural verification.
 *
 * This is intentionally not presented as a replacement for the original
 * behavioural/integration suite (which was not included in the supplied
 * artifact). It validates the rebuilt tree, module wiring, static PWA asset
 * wiring, and the route-to-file contract on every clean checkout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const json = (relative) => JSON.parse(read(relative));

const packageJson = json('worker/package.json');
const lockfile = json('worker/package-lock.json');
const manifest = json('public/manifest.json');
assert.equal(packageJson.name, 'pharmaridge-worker');
assert.equal(lockfile.lockfileVersion, 3);
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.background_color, '#0a3b2c', 'PWA first splash background must be deep PharmaRidge green');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4, 'manifest must expose install icons');

const html = read('public/index.html');
const assetRefs = [
  ...[...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map((m) => m[1]),
];
for (const ref of assetRefs) {
  assert.ok(exists(`public/${ref.replace(/^\//, '')}`), `index.html references missing asset ${ref}`);
}
const favicon = (html.match(/<link\s+rel="icon"[^>]*href="([^"]+)"/) || [])[1];
assert.ok(favicon && exists(`public/${favicon.replace(/^\//, '')}`), 'index.html favicon must exist');
assert.match(html, /class="login-loading"/, 'first paint must show the animated logo loader while branding loads');
assert.match(html, /<animateTransform[^>]+type="rotate"/, 'the first-paint loader must contain an animated SVG ring');
assert.match(html, /id="sidebar-install-btn"/, 'authenticated sidebar must provide permanent PWA install/reinstall help');

const browserSource = walk(path.join(ROOT, 'public/js')).filter((file) => file.endsWith('.js'))
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const routerSource = read('public/js/router.js');
const viewFunctions = [...routerSource.matchAll(/\b(render[A-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
for (const viewFunction of viewFunctions) {
  assert.match(browserSource, new RegExp(`(?:async\\s+)?function\\s+${viewFunction}\\s*\\(`), `router references missing browser view ${viewFunction}`);
}

const sw = read('public/sw.js');
const shell = [...sw.matchAll(/^\s*'([^']+)'[,]?\s*$/gm)].map((m) => m[1])
  .filter((item) => item.startsWith('/'));
for (const ref of shell) {
  assert.ok(exists(`public/${ref.replace(/^\//, '')}`), `service worker caches missing asset ${ref}`);
}

for (const icon of manifest.icons) {
  assert.ok(exists(`public/${icon.src.replace(/^\//, '')}`), `manifest references missing icon ${icon.src}`);
}
assert.ok(exists('public/icons/apple-touch-icon.png'), 'Apple touch icon is required by index.html');
assert.ok(exists('public/branding/pharmaridge-logo.png'), 'default PharmaRidge logo artwork is required');
assert.ok(exists('public/branding/pharmaridge-mark.png'), 'default PharmaRidge icon artwork is required');
assert.ok(exists('public/branding/pharmaridge-pwa-logo.png'), 'prompt-derived PWA logo artwork is required');
const loginSource = read('public/js/views/login.js');
assert.match(loginSource, /\/branding\/pharmaridge-logo\.png/, 'unbranded login must display the premium full logo');
assert.match(loginSource, /live-sample-label">Live Sample 1/, 'login must show the concise Live Sample 1 label');
assert.match(loginSource, /login-submit-spinner/, 'login must provide an animated in-progress submit state');
assert.doesNotMatch(loginSource, /Shared live sample|PIN <b>1234<\/b>/, 'login must not expose shared admin credentials beneath the sign-in button');
const appSource = read('public/js/app.js');
assert.match(appSource, /openInstallModal/, 'sidebar must open a PWA install/reinstall compatibility modal');
assert.match(appSource, /PWA Download Not Compatible/, 'unsupported devices must receive a clear browser-use message');
assert.match(appSource, /startupLogin\.classList\.add\('is-loading'\)/, 'first-paint loader must activate while branding starts');
assert.match(appSource, /readyLogin\.classList\.remove\('is-loading'\)/, 'first-paint loader must turn off once the login is ready');
assert.match(appSource, /function afterLogout\(\)[\s\S]*?renderLogin\(\)/, 'logout must rebuild the login form and clear any stale sign-in spinner');
assert.match(html, /<svg class="brand-ico"[\s\S]*?fill="currentColor"/, 'default top navigation mark must be an SVG that inherits currentColor');

const indexSource = read('worker/src/index.js');
const mounts = [...indexSource.matchAll(/app\.route\('\/api\/[^']+',\s*require\('\.\/routes\/([^']+)'\)\)/g)]
  .map((m) => m[1]);
assert.ok(mounts.length >= 20, `expected the API entrypoint to mount its route modules; found ${mounts.length}`);
for (const route of mounts) {
  assert.ok(exists(`worker/src/routes/${route}.js`), `entrypoint mounts missing route module ${route}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const workerSourceFiles = walk(path.join(ROOT, 'worker/src')).filter((file) => file.endsWith('.js'));
for (const file of workerSourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const localRequires = [...source.matchAll(/require\(['"](\.\.?(?:\/[^'"]+)*)['"]\)/g)].map((m) => m[1]);
  for (const local of localRequires) {
    const resolved = path.resolve(path.dirname(file), `${local}.js`);
    assert.ok(fs.existsSync(resolved), `${path.relative(ROOT, file)} requires missing ${local}.js`);
  }
}

const authRoute = read('worker/src/routes/auth.js');
assert.match(authRoute, /\{\s*roleLabel\s*\}\s*=\s*require\(['"]\.\.\/lib\/auth['"]\)/, 'login response uses roleLabel and must import it from the auth library');

const schema = read('worker/migrations/0001_initial_schema.sql');
const catalog = read('worker/migrations/0002_nafdac_catalog.sql');
assert.match(schema, /CREATE TABLE users\s*\(/, 'core user table is missing');
assert.match(schema, /CREATE TRIGGER trg_gl_journal_entry_must_balance_before_posting/, 'GL balance trigger is missing');
assert.match(catalog, /CREATE TABLE nafdac_catalog\s*\(/, 'NAFDAC catalog migration is missing');
assert.match(catalog, /Kept:\s+6801 currently-ACTIVE/, 'catalog migration must retain its declared 6,801-row dataset');
assert.ok((catalog.match(/^\s*\('/gm) || []).length >= 6798, 'catalog migration is unexpectedly truncated');

console.log(`Recovery structure verified: ${workerSourceFiles.length} Worker modules, ${mounts.length} mounted routes, ${assetRefs.length} shell assets, 6,801 catalog rows.`);
