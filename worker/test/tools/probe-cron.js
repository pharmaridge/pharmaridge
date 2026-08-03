// CRON DURABILITY PROBE
//
// The scheduled handler is the ONLY thing standing between a client's D1
// database and unbounded growth toward the 500 MB Free / 10 GB Paid ceiling.
// It runs every 6 hours, unattended, for years. Nobody watches it.
//
// Questions this answers by EXECUTION, not by reading:
//   1. Does every pruner actually delete what it claims?
//   2. If ONE pruner throws, do the others still run? (ctx.waitUntil takes
//      independent promises — but an unhandled rejection inside a scheduled
//      handler can mark the whole invocation as failed, and on Cloudflare a
//      failed scheduled invocation is simply... not retried. Silent.)
//   3. Is a failure VISIBLE to anyone, or does the table just quietly grow?
//   4. Does UNREVIEWED conflict data survive, as the retention rule promises?
//
// Wrangler exposes the real scheduled handler at /cdn-cgi/handler/scheduled.
const { execSync } = require('child_process');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function d1(sql) {
  // Collapse newlines: the SQL is passed as a single shell argument and a
  // literal newline inside it is escaped by JSON.stringify as \n, which
  // SQLite then reads as a stray backslash token ("unrecognized token").
  // My own bug, hit on the first run.
  sql = String(sql).replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute pharmaridge-db --local --json --command ${JSON.stringify(sql)}`,
    { cwd: __dirname + '/../..', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start));
}
const rows = (sql) => d1(sql)[0].results;
const count = (sql) => Number(rows(sql)[0].n);

async function runCron() {
  // `wrangler dev` intermittently drops its ProxyController under repeated
  // scheduled invocations. That is a LOCAL TOOLING flake, not an application
  // failure, and it must never be reported as one — retry, then fail loudly
  // and distinctly if the server is genuinely gone.
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
      return { status: r.status, body: await r.text() };
    } catch (e) {
      if (i === 2) {
        console.error('\n!! DEV SERVER GONE — wrangler dev ProxyController flake, NOT an app');
        console.error('!! failure. Restart with: bash test/devserver.sh 9001, then re-run.');
        process.exit(3);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

(async () => {
  // Re-runnable: clear anything a previous (possibly aborted) run left behind.
  // A probe that only works on a virgin database is a probe nobody re-runs.
  d1(`DELETE FROM sync_change_log WHERE id LIKE 'cron-%'`);
  d1(`DELETE FROM login_attempts WHERE id LIKE 'la-%'`);
  d1(`DELETE FROM sync_conflicts WHERE id LIKE 'cf-%'`);
  d1(`DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'cron-idem-%'`);

  console.log('\n=== A. EVERY PRUNER ACTUALLY PRUNES ===');

  // Seed one OLD row in each pruned table plus one RECENT row that must survive.
  // Real branch id: sync_change_log.branch_id carries a FOREIGN KEY, and the
  // first run of this probe was correctly refused by it — the schema doing its
  // job, not a defect.
  const seedBranch = rows(`SELECT id FROM branches LIMIT 1`)[0].id;
  d1(`INSERT INTO sync_change_log (id,branch_id,device_id,direction,table_name,row_count,status,synced_at)
      VALUES ('cron-old','${seedBranch}','d','HEARTBEAT',NULL,0,'SUCCESS',datetime('now','-100 days')),
             ('cron-new','${seedBranch}','d','HEARTBEAT',NULL,0,'SUCCESS',datetime('now','-1 days'))`);
  // Real column is `succeeded`, not `successful` — read from PRAGMA
  // table_info rather than guessed. (I guessed first, and was refused.)
  d1(`INSERT INTO login_attempts (id,username,ip_address,succeeded,attempted_at)
      VALUES ('la-old','ghost','1.1.1.1',0,datetime('now','-100 days')),
             ('la-new','ghost','1.1.1.1',0,datetime('now','-1 days'))`);

  const before = {
    scl: count(`SELECT COUNT(*) n FROM sync_change_log WHERE id IN ('cron-old','cron-new')`),
    la: count(`SELECT COUNT(*) n FROM login_attempts WHERE id IN ('la-old','la-new')`),
  };
  check('seeded rows are present', before.scl === 2 && before.la === 2, JSON.stringify(before));

  const r1 = await runCron();
  check('the scheduled handler is reachable and returns 200', r1.status === 200, `status=${r1.status} body=${r1.body.slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, 1200));

  check('sync_change_log: the 100-day row is gone',
    count(`SELECT COUNT(*) n FROM sync_change_log WHERE id='cron-old'`) === 0);
  check('sync_change_log: the 1-day row SURVIVES',
    count(`SELECT COUNT(*) n FROM sync_change_log WHERE id='cron-new'`) === 1);
  check('login_attempts: the 100-day row is gone',
    count(`SELECT COUNT(*) n FROM login_attempts WHERE id='la-old'`) === 0);
  check('login_attempts: the 1-day row SURVIVES',
    count(`SELECT COUNT(*) n FROM login_attempts WHERE id='la-new'`) === 1);

  console.log('\n=== B. THE ASYMMETRIC CONFLICT RULE IS REAL ===');
  // An UNREVIEWED conflict is an unanswered question and must never be pruned,
  // at ANY age. A reviewed one goes after 180 days.
  const bid = seedBranch;
  d1(`INSERT INTO sync_conflicts (id,table_name,row_id,branch_id,device_id,losing_version_json,winning_version_json,detected_at,reviewed_at)
      VALUES ('cf-unrev-ancient','customers','x','${bid}','d','{}','{}',datetime('now','-3650 days'),NULL),
             ('cf-rev-old','customers','y','${bid}','d','{}','{}',datetime('now','-400 days'),datetime('now','-200 days')),
             ('cf-rev-recent','customers','z','${bid}','d','{}','{}',datetime('now','-30 days'),datetime('now','-10 days'))`);
  await runCron();
  await new Promise((r) => setTimeout(r, 1200));

  check('a TEN-YEAR-OLD unreviewed conflict is still there (never pruned)',
    count(`SELECT COUNT(*) n FROM sync_conflicts WHERE id='cf-unrev-ancient'`) === 1,
    'an unanswered question about a customer record must outlive any retention window');
  check('a reviewed conflict older than 180 days is pruned',
    count(`SELECT COUNT(*) n FROM sync_conflicts WHERE id='cf-rev-old'`) === 0);
  check('a recently reviewed conflict is kept',
    count(`SELECT COUNT(*) n FROM sync_conflicts WHERE id='cf-rev-recent'`) === 1);

  console.log('\n=== C. IDEMPOTENCY KEYS ARE PRUNED ===');
  // idempotency_keys has NO `id` column: the key itself is the identity.
  // user_id carries a FOREIGN KEY — use a real one.
  const seedUser = rows(`SELECT id FROM users LIMIT 1`)[0].id;
  d1(`INSERT INTO idempotency_keys (idempotency_key,user_id,method,path,request_hash,response_status,response_body,status,created_at)
      VALUES ('cron-idem-old','${seedUser}','POST','/api/sales','h',201,'{}','COMPLETED',datetime('now','-100 days')),
             ('cron-idem-new','${seedUser}','POST','/api/sales','h',201,'{}','COMPLETED',datetime('now','-1 days'))`);
  check('seeded a 100-day-old idempotency key',
    count(`SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='cron-idem-old'`) === 1);
  await runCron();
  await new Promise((r) => setTimeout(r, 1200));
  check('...and the cron pruned it',
    count(`SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='cron-idem-old'`) === 0);
  check('...while a fresh key survives (replay protection intact)',
    count(`SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='cron-idem-new'`) === 1);

  console.log('\n=== D. ONE FAILING PRUNER MUST NOT SILENCE THE OTHERS ===');
  // This is the durability question that matters. On Cloudflare a scheduled
  // invocation that throws is NOT retried; the next one is 6 hours later. If a
  // single failing statement aborts the handler, the tables it never reached
  // grow for the life of the deployment with nobody the wiser.
  //
  // Simulated by dropping a table one pruner depends on, then confirming the
  // OTHER tables were still pruned in the same invocation.
  d1(`INSERT INTO sync_change_log (id,branch_id,device_id,direction,table_name,row_count,status,synced_at)
      VALUES ('cron-old-2','${seedBranch}','d','HEARTBEAT',NULL,0,'SUCCESS',datetime('now','-100 days'))`);
  d1(`INSERT INTO login_attempts (id,username,ip_address,succeeded,attempted_at)
      VALUES ('la-old-2','ghost','1.1.1.1',0,datetime('now','-100 days'))`);
  d1(`ALTER TABLE idempotency_keys RENAME TO idempotency_keys_hidden`);

  const r2 = await runCron();
  await new Promise((r) => setTimeout(r, 1500));

  const sclGone = count(`SELECT COUNT(*) n FROM sync_change_log WHERE id='cron-old-2'`) === 0;
  const laGone = count(`SELECT COUNT(*) n FROM login_attempts WHERE id='la-old-2'`) === 0;
  console.log(`     (handler returned ${r2.status})`);
  check('a broken pruner does not stop sync_change_log being pruned', sclGone,
    'housekeeping is all-or-nothing — one failure and other tables grow unbounded');
  check('a broken pruner does not stop login_attempts being pruned', laGone);

  d1(`ALTER TABLE idempotency_keys_hidden RENAME TO idempotency_keys`);

  console.log('\n' + '='.repeat(62));
  console.log(`CRON PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
