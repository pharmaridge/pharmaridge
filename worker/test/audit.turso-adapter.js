// TURSO ADAPTER AUDIT — Stage 1 migration seam.
//
// This validates D1-shaped result/statement semantics without switching any
// route away from D1. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN only in a
// disposable terminal session to include the read-only live compatibility
// probe; neither value is written by this file.
const { createTursoDatabase, getDatabase, providerFrom } = require('../src/lib/databaseAdapter');

let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }

function result({ rows = [], rowsAffected = 0, lastInsertRowid, rowsRead = 0, rowsWritten = 0, queryDurationMs = 0 } = {}) {
  return { rows, rowsAffected, lastInsertRowid, rowsRead, rowsWritten, queryDurationMs };
}

(async () => {
  console.log('=== TURSO DATABASE ADAPTER AUDIT ===');
  check('D1 remains the default provider', providerFrom({}) === 'D1');
  check('provider names are normalized', providerFrom({ DATABASE_PROVIDER: ' turso ' }) === 'TURSO');

  const d1 = { prepare: () => 'native-d1' };
  check('D1 path returns the native binding unchanged', getDatabase({ DB: d1 }) === d1);

  const calls = [];
  const fakeClient = {
    async execute(statement) {
      calls.push({ kind: 'execute', statement });
      if (/^UPDATE/i.test(statement.sql)) return result({ rowsAffected: 1, rowsRead: 2, rowsWritten: 1, queryDurationMs: 3 });
      return result({ rows: [{ value: statement.args[0], answer: 42 }], rowsRead: 1, queryDurationMs: 2 });
    },
    async batch(statements, mode) {
      calls.push({ kind: 'batch', statements, mode });
      return statements.map((statement, index) => result({ rows: [{ value: statement.args[0], sequence: index + 1 }], rowsAffected: 1, lastInsertRowid: BigInt(index + 10), rowsRead: 1, rowsWritten: 1 }));
    },
  };
  const db = createTursoDatabase({ TURSO_DATABASE_URL: 'turso://unit-test.example', TURSO_AUTH_TOKEN: 'unit-test-token' }, () => fakeClient);
  const first = await db.prepare('SELECT ? AS value, 42 AS answer').bind('bound value').first();
  check('prepare/bind/first returns the first row', first && first.value === 'bound value' && first.answer === 42, JSON.stringify(first));
  const firstColumn = await db.prepare('SELECT ? AS value').bind('first column').first('value');
  check('first(column) preserves D1 shorthand', firstColumn === 'first column', String(firstColumn));
  const list = await db.prepare('SELECT ? AS value').bind('list value').all();
  check('all returns the D1 results envelope', list.success === true && list.results[0].value === 'list value' && list.meta.rows_read === 1, JSON.stringify(list));
  const written = await db.prepare('UPDATE pilot SET checked = 1').bind().run();
  check('run exposes D1-compatible meta.changes', written.success === true && written.meta.changes === 1 && written.meta.rows_written === 1, JSON.stringify(written));
  const batch = await db.batch([
    db.prepare('SELECT ? AS value').bind('one'),
    db.prepare('SELECT ? AS value').bind('two'),
  ]);
  check('batch maps every statement and explicitly requests an atomic write transaction', batch.length === 2 && batch[1].results[0].value === 'two' && calls.find((call) => call.kind === 'batch').mode === 'write', JSON.stringify(batch));
  let mixedRejected = false;
  try { await db.batch([d1.prepare('SELECT 1')]); } catch (_) { mixedRejected = true; }
  check('mixed native-D1/Turso batches are rejected', mixedRejected);
  let unsupportedRejected = false;
  try { getDatabase({ DATABASE_PROVIDER: 'POSTGRES' }); } catch (_) { unsupportedRejected = true; }
  check('an unknown provider fails closed', unsupportedRejected);

  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    const remote = createTursoDatabase({
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    });
    const remoteFirst = await remote.prepare("SELECT 'adapter-read-only' AS label, sqlite_version() AS sqlite_version").first();
    check('live Turso read-only prepared query succeeds', remoteFirst && remoteFirst.label === 'adapter-read-only' && !!remoteFirst.sqlite_version, JSON.stringify(remoteFirst));
    const remoteBatch = await remote.batch([
      remote.prepare("SELECT 'first' AS label"),
      remote.prepare("SELECT 'second' AS label"),
    ]);
    check('live Turso read-only batch succeeds through the adapter', remoteBatch.length === 2 && remoteBatch[0].results[0].label === 'first' && remoteBatch[1].results[0].label === 'second', JSON.stringify(remoteBatch));
  } else {
    console.log('  SKIP live Turso probe — no terminal-only Turso credentials supplied.');
  }

  console.log(`\nTURSO ADAPTER AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
