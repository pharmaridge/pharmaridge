// DATABASE PROVIDER CONTEXT AUDIT — Stage 2.5.
// Ensures no route/service can accidentally bypass the request-scoped provider
// seam during the gradual D1 → Turso migration. D1 remains the default until
// a future explicit deployment switch.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.js') ? [full] : []);
  });
}

(() => {
  console.log('=== DATABASE PROVIDER CONTEXT AUDIT ===');
  const files = walk(SRC);
  const direct = [];
  const missingAccessor = [];
  for (const file of files) {
    const relative = path.relative(SRC, file);
    const source = fs.readFileSync(file, 'utf8');
    // database.js is the deliberately tiny D1 fallback for isolated unit
    // tests. Any executable D1 call elsewhere would bypass provider choice.
    if (relative !== path.join('lib', 'database.js') && /c\.env\.DB\s*\./.test(source)) direct.push(relative);
    if (/(?:database\(c\))/.test(source) && !/require\(['"].*database['"]\)/.test(source) && relative !== 'index.js' && relative !== path.join('lib', 'database.js')) missingAccessor.push(relative);
  }
  const index = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const helper = fs.readFileSync(path.join(SRC, 'lib', 'database.js'), 'utf8');
  check('every executable database call uses the provider seam', direct.length === 0, direct.join(', '));
  check('every route/lib caller imports the request-scoped accessor', missingAccessor.length === 0, missingAccessor.join(', '));
  check('the app resolves a provider once per request', /c\.set\('database', getDatabase\(c\.env\)\)/.test(index));
  check('D1 stays the safe fallback for existing isolated unit tests', /if \(c && c\.env && c\.env\.DB\) return c\.env\.DB;/.test(helper));
  console.log(`\nDATABASE PROVIDER CONTEXT AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
