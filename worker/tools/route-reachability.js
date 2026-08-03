// BACK-TO-FRONT REACHABILITY REPORT.
//
// Answers the question this audit keeps returning to: "is every capability
// the backend ships actually reachable from the UI?" That is how the WHT
// register was found shipping with no screen at all.
//
// Deliberately a REPORT, not a test: some routes are legitimately not
// called by the PWA (health checks, the sync endpoint the offline queue
// uses through a different helper, vendor-only admin paths). The audit
// suite asserts the curated list; this tool regenerates the evidence.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, '..', 'public');

function declaredRoutes() {
  const idx = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
  const mounts = {};
  for (const m of idx.matchAll(/app\.route\('(\/api\/[^']+)',\s*require\('\.\/routes\/(\w+)'\)\)/g)) {
    mounts[m[2]] = m[1];
  }
  const out = [];
  // Routes declared directly on the app object (health, manifest, etc.)
  for (const m of idx.matchAll(/app\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    out.push({ method: m[1].toUpperCase(), path: m[2], file: 'index.js' });
  }
  for (const [file, base] of Object.entries(mounts)) {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes', file + '.js'), 'utf8');
    const v = src.match(/const (\w+) = new Hono\(\)/);
    if (!v) continue;
    const re = new RegExp('\\b' + v[1] + '\\.(get|post|put|delete|patch)\\(\\s*[\'`]([^\'`]+)', 'g');
    for (const m of src.matchAll(re)) {
      const suffix = m[2] === '/' ? '' : m[2];
      out.push({ method: m[1].toUpperCase(), path: (base + suffix).replace(/\/+$/, '') || base, file });
    }
  }
  return out;
}

// COMMENTS ARE NOT CALLERS.
//
// This codebase documents its endpoints heavily — accounting.js explains
// "/api/wht/entries returns the deduction register" in a comment right
// above the code that calls it. Scanning raw source therefore reports a
// route as "reachable" when only a COMMENT mentions it, which is exactly
// backwards: the comment usually survives when the call is deleted.
//
// Caught by deliberately sabotaging a real call and watching the guard
// stay green. Strip comments (and, importantly, do not strip anything
// that merely looks like one inside a string) before matching.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;      // ' " or `
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next === undefined ? '' : next; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

function frontendSource() {
  let fe = '';
  const dirs = [path.join(PUB, 'js'), path.join(PUB, 'js/views')];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.js')) fe += stripComments(fs.readFileSync(path.join(d, f), 'utf8')) + '\n';
    }
  }
  fe += stripComments(fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'));
  return fe;
}

// A declared path becomes a matcher tolerant of template params and query
// strings: '/api/users/:id/unlock' must match `/users/${u.id}/unlock`.
function pathMatcher(p) {
  const body = p.replace(/^\/api/, '').split('/').map((seg) => {
    if (seg.startsWith(':')) return '(?:[^/\\s`\'"?]+)';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp('[`\'"]' + body + '(?:[?`\'"]|\\$\\{|/)');
}

function unreferenced() {
  const fe = frontendSource();
  return declaredRoutes().filter((r) => !pathMatcher(r.path).test(fe));
}

if (require.main === module) {
  const all = declaredRoutes();
  const missing = unreferenced();
  console.log(`Backend routes declared: ${all.length}`);
  console.log(`Not referenced anywhere in the frontend: ${missing.length}\n`);
  for (const r of missing) console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(44)} (${r.file})`);
}

module.exports = { declaredRoutes, frontendSource, pathMatcher, unreferenced, stripComments };
