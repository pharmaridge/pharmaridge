// TRANSIENT-FAULT COVERAGE PROBE (offline, no server needed).
//
// lib/d1Retry.js exists because Cloudflare documents a family of D1 errors as
// ROUTINE operational noise ("a handful of errors every several hours is not
// unexpected") and tells you to retry them. Its header claims the money paths
// are covered. This checks that claim by EXECUTING each service against a D1
// stub that fails transiently once, and seeing whether the call survives.
//
// A path that is NOT wrapped turns a documented, routine blip into a 500 for
// the person standing at the counter.
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const { isTransientD1Error, withD1Retry, TRANSIENT_PATTERNS } = require('../../src/lib/d1Retry.js');

(async () => {
  console.log('\n=== A. THE CLASSIFIER MATCHES CLOUDFLARE\'S DOCUMENTED LIST ===');
  // Verbatim from https://developers.cloudflare.com/d1/observability/debug-d1/
  const documented = [
    'D1 DB reset because its code was updated.',
    'Internal error while starting up D1 DB storage caused object to be reset.',
    'Network connection lost.',
    'Internal error in D1 DB storage caused object to be reset.',
    'Cannot resolve D1 DB due to transient issue on remote node.',
  ];
  for (const m of documented) {
    check(`treated as transient: "${m.slice(0, 46)}..."`, isTransientD1Error(new Error(m)), m);
  }

  console.log('\n=== B. REAL APPLICATION ERRORS ARE **NOT** RETRIED ===');
  // Retrying a constraint violation would turn a clean 400 into three
  // identical failures and a slow one. Worse, retrying a business guard could
  // mask it. These MUST pass straight through.
  const permanent = [
    'CHECK constraint failed: quantity_remaining',
    'UNIQUE constraint failed: users.username',
    'FOREIGN KEY constraint failed',
    'NOT NULL constraint failed: sales.total_amount',
    'INSUFFICIENT_STOCK',
    'Insufficient stock for Paracetamol',
    'D1_ERROR: no such table: widgets',
    'Unauthorized',
  ];
  for (const m of permanent) {
    check(`NOT retried: "${m.slice(0, 46)}"`, !isTransientD1Error(new Error(m)), m);
  }
  check('an empty/undefined error is not treated as transient',
    !isTransientD1Error(new Error('')) && !isTransientD1Error(undefined) && !isTransientD1Error(null));

  console.log('\n=== C. withD1Retry ACTUALLY RECOVERS, AND ACTUALLY GIVES UP ===');
  {
    let calls = 0;
    const r = await withD1Retry(async () => {
      calls++;
      if (calls < 3) throw new Error('Network connection lost.');
      return 'committed';
    }, 'test');
    check('a call that blips twice still succeeds', r === 'committed' && calls === 3, `calls=${calls}`);
  }
  {
    let calls = 0;
    let threw = null;
    try {
      await withD1Retry(async () => { calls++; throw new Error('Network connection lost.'); }, 'test');
    } catch (e) { threw = e; }
    check('a permanently broken call gives up after 3 attempts', calls === 3 && !!threw, `calls=${calls}`);
  }
  {
    let calls = 0;
    let threw = null;
    try {
      await withD1Retry(async () => { calls++; throw new Error('CHECK constraint failed: x'); }, 'test');
    } catch (e) { threw = e; }
    check('a constraint error fails IMMEDIATELY (one attempt, not three)',
      calls === 1 && threw && /CHECK constraint/.test(threw.message), `calls=${calls}`);
  }

  console.log('\n=== D. EVERY MUTATING PATH THAT BATCHES IS COVERED ===');
  // The header of d1Retry.js asserts the money paths are wrapped. Verify it
  // against the source rather than trusting the comment — a new route added
  // later is exactly how this decays.
  const fs = require('fs');
  const SRC = path.join(__dirname, '..', '..', 'src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const files = walk(SRC).filter((f) => f.endsWith('.js'));

  // PER-CALL-SITE, NOT PER-FILE.
  //
  // MY OWN CHECK WAS TOO COARSE AND I ONLY FOUND OUT BY REVERTING: the first
  // version asked "does this FILE mention withD1Retry?". After wrapping
  // attendance clock-IN, the file mentioned it — so deliberately unwrapping
  // clock-OUT still passed. A file-level check reports green over a gap the
  // moment a file has two batch sites and only one is covered.
  //
  // This inspects each `.batch(` occurrence and looks backwards on the same
  // statement for the wrapper.
  const sites = [];
  for (const f of files) {
    const rel = path.relative(SRC, f);
    if (rel === 'lib/d1Retry.js' || rel === 'lib/d1Limits.js') continue; // the mechanism itself
    const code = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    let idx = -1;
    while ((idx = code.indexOf('.batch(', idx + 1)) !== -1) {
      // Look back to the start of this statement (previous `;` or `{`).
      const stmtStart = Math.max(code.lastIndexOf(';', idx), code.lastIndexOf('{', idx), code.lastIndexOf('\n\n', idx));
      const stmt = code.slice(stmtStart + 1, idx);
      sites.push({ rel, wrapped: /withD1Retry\s*\(/.test(stmt) });
    }
  }
  check('found every batching call site', sites.length >= 20, `${sites.length} call sites`);
  const bare = sites.filter((s) => !s.wrapped).map((s) => s.rel);
  check('EVERY db.batch() call site is transient-fault tolerant',
    bare.length === 0,
    [...new Set(bare)].join(', ') + ' — a documented routine D1 blip becomes a 500 here');

  console.log('\n=== E. NO DEAD BATCH HELPER ===');
  // lib/db.js exported runBatch() with ZERO callers. A future route reaching
  // for the "obvious" helper would get an UNWRAPPED batch and silently opt out
  // of retry — a trap, not a convenience.
  const dbSrc = fs.readFileSync(path.join(SRC, 'lib', 'db.js'), 'utf8');
  // ASSERT THE INTENT, NOT THE SHAPE. The first version of this check demanded
  // that runBatch() have callers, which was the wrong requirement — a helper
  // with no callers is harmless; a helper that runs an UNPROTECTED batch is
  // the trap. What matters is that anything in the "obvious helpers" module
  // which touches .batch() is retry-aware, so reaching for it is safe by
  // default rather than a silent opt-out.
  const dbCode = dbSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dbBatches = /\.batch\s*\(/.test(dbCode);
  check('any batch helper in lib/db.js is retry-aware by default',
    !dbBatches || /withD1Retry/.test(dbCode),
    'an unprotected helper under an inviting name silently opts future routes out of retry');

  console.log('\n' + '='.repeat(62));
  console.log(`TRANSIENT PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
