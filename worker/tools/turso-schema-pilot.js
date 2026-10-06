// TURSO SCHEMA PILOT — applies and verifies the two-migration PharmaRidge
// baseline on an EMPTY Turso database only.
//
// This is intentionally separate from the D1 migration workflow. It never
// touches Cloudflare D1, never exports/imports Client data, and refuses a
// Turso target that has any non-internal application object already present.
//
// Apply once to an approved empty pilot:
//   PHARMARIDGE_CONFIRM_TURSO_SCHEMA_PILOT=APPLY_EMPTY_TURSO_SCHEMA \
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
//   node tools/turso-schema-pilot.js --apply
//
// Re-run only the comparison later:
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
//   node tools/turso-schema-pilot.js --verify
//
// Credentials are terminal environment variables only. Never store them in
// .dev.vars, source, Git, generated SQL, this report, or deployment config.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createClient } = require('@tursodatabase/serverless/compat');

const ROOT = path.join(__dirname, '..');
const MIGRATION_DIR = path.join(ROOT, 'migrations');
const MIGRATIONS = ['0001_initial_schema.sql', '0002_nafdac_catalog.sql'];
const TURSO_MANIFEST = '_pharmaridge_schema_migrations';
const isInternalTursoObject = (name) => String(name || '').startsWith('__turso_internal_') || name === TURSO_MANIFEST;

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required in this terminal session.`);
  return value;
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function migrationDetails() {
  return MIGRATIONS.map((filename) => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, filename), 'utf8');
    return {
      filename,
      sql,
      sha256: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });
}

function schemaObjectsFromSqlite(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
       AND type IN ('table', 'index', 'trigger', 'view')
     ORDER BY type, name
  `).all();
  const tableNames = objects.filter((entry) => entry.type === 'table').map((entry) => entry.name);
  const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const tableShape = Object.fromEntries(tableNames.map((name) => [name, {
    columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all(),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all(),
  }]));
  return { objects, tableShape };
}

function localBaseline() {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrationDetails()) db.exec(migration.sql);
    return schemaObjectsFromSqlite(db);
  } finally {
    db.close();
  }
}

async function remoteSchema(client) {
  const listed = await client.execute(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
       AND type IN ('table', 'index', 'trigger', 'view')
     ORDER BY type, name
  `);
  const objects = listed.rows;
  const tableNames = objects.filter((entry) => entry.type === 'table').map((entry) => entry.name);
  const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const tableShape = {};
  for (const name of tableNames) {
    const columns = await client.execute(`PRAGMA table_info(${quoteIdentifier(name)})`);
    const foreignKeys = await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`);
    tableShape[name] = { columns: columns.rows, foreignKeys: foreignKeys.rows };
  }
  return { objects, tableShape };
}

// SQLite may pretty-print stored DDL differently after Turso executes it
// (for example `lower(hex(...))` becomes `lower (hex (...))`). Compare SQL
// tokens, not formatting, while preserving quoted string content exactly.
function canonicalSql(sql) {
  const source = String(sql || '');
  let output = '';
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === quote) {
        if (quote === "'" && source[index + 1] === "'") output += source[++index];
        else quote = null;
      }
      continue;
    }
    if (char === '-' && source[index + 1] === '-') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
    } else if (!/\s/.test(char)) {
      output += char.toLowerCase();
    }
  }
  // SQLite normalises a few syntactic aliases in sqlite_schema. These are
  // equivalent operators/join spellings, not a changed business rule.
  return output.replaceAll('<>', '!=').replaceAll('leftouterjoin', 'leftjoin');
}

function stripOuterParentheses(expression) {
  let value = canonicalSql(expression);
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let wrapsEntireExpression = true;
    let quote = null;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (quote) {
        if (char === quote) {
          if (quote === "'" && value[index + 1] === "'") index++;
          else quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')') {
        depth--;
        if (depth === 0 && index !== value.length - 1) { wrapsEntireExpression = false; break; }
      }
    }
    if (!wrapsEntireExpression || depth !== 0) break;
    value = value.slice(1, -1);
  }
  return value;
}

function normaliseObject(object) {
  return {
    type: object.type,
    name: object.name,
    tbl_name: object.tbl_name,
    sql: canonicalSql(object.sql),
  };
}

function normaliseShape(shape) {
  // Turso's Row exposes named columns as properties but only numeric indices
  // are enumerable. Pick the pragma fields explicitly instead of relying on
  // Object.entries(), which would otherwise compare local object rows with
  // remote array-like rows and report every table as different.
  const pick = (row, keys) => Object.fromEntries(keys.map((key) => {
    let value = typeof row[key] === 'bigint' ? Number(row[key]) : row[key];
    if (key === 'dflt_value' && value != null) value = stripOuterParentheses(value);
    return [key, value];
  }));
  return {
    columns: (shape.columns || []).map((row) => pick(row, ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'])),
    foreignKeys: (shape.foreignKeys || []).map((row) => pick(row, ['id', 'seq', 'table', 'from', 'to', 'on_update', 'on_delete', 'match'])),
  };
}

function comparison(baseline, remote) {
  const expectedObjects = baseline.objects.filter((object) => !isInternalTursoObject(object.name)).map(normaliseObject);
  const actualObjects = remote.objects.filter((object) => !isInternalTursoObject(object.name)).map(normaliseObject);
  const expectedByName = new Map(expectedObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const actualByName = new Map(actualObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const missingObjects = [...expectedByName.keys()].filter((key) => !actualByName.has(key));
  const extraObjects = [...actualByName.keys()].filter((key) => !expectedByName.has(key));
  const changedObjects = [...expectedByName.keys()].filter((key) => {
    if (!actualByName.has(key)) return false;
    // SQLite rewrites table SQL when ALTER TABLE adds a column and can reorder
    // DEFAULT/CHECK clauses while keeping the exact same constraints. For
    // tables, compare identity plus pragma-derived columns/FKs below; named
    // indexes, triggers and views still require SQL-token equality here.
    if (expectedByName.get(key).type === 'table') return false;
    return JSON.stringify(expectedByName.get(key)) !== JSON.stringify(actualByName.get(key));
  });

  const expectedTables = Object.keys(baseline.tableShape).filter((name) => !isInternalTursoObject(name));
  const changedTableShape = expectedTables.filter((name) => {
    const expected = normaliseShape(baseline.tableShape[name]);
    const actual = normaliseShape(remote.tableShape[name] || {});
    return JSON.stringify(expected) !== JSON.stringify(actual);
  });
  return { missingObjects, extraObjects, changedObjects, changedTableShape };
}

async function apply(client) {
  const existing = await remoteSchema(client);
  const unexpected = existing.objects.filter((object) => !isInternalTursoObject(object.name));
  if (unexpected.length) {
    throw new Error(`Refusing to apply to a non-empty Turso target. Found: ${unexpected.map((object) => `${object.type}:${object.name}`).join(', ')}`);
  }
  const manifestExists = existing.objects.some((object) => object.name === TURSO_MANIFEST);
  if (manifestExists) throw new Error(`Refusing to apply: ${TURSO_MANIFEST} already exists. Use --verify or inspect the previous pilot run first.`);

  await client.executeMultiple(`
    BEGIN IMMEDIATE;
    CREATE TABLE ${TURSO_MANIFEST} (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    COMMIT;
  `);

  for (const migration of migrationDetails()) {
    // executeMultiple delegates SQL parsing to SQLite, so trigger bodies and
    // semicolons inside them remain intact; a JavaScript `split(';')` would
    // silently corrupt those accounting controls.
    await client.executeMultiple(`
      BEGIN IMMEDIATE;
      ${migration.sql}
      INSERT INTO ${TURSO_MANIFEST} (filename, sha256) VALUES (${sqlQuote(migration.filename)}, ${sqlQuote(migration.sha256)});
      COMMIT;
    `);
  }
}

async function verify(client) {
  const baseline = localBaseline();
  const remote = await remoteSchema(client);
  const diff = comparison(baseline, remote);
  const counts = {};
  for (const table of ['nafdac_catalog', 'gl_accounts', 'wht_rates', 'client_settings']) {
    const row = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = Number(row.rows[0] && row.rows[0].count);
  }
  const barcodeIndexes = await client.execute(`
    SELECT COUNT(*) AS count
      FROM pragma_index_list('product_barcodes') AS idx
     WHERE idx.[unique] = 1
       AND EXISTS (SELECT 1 FROM pragma_index_info(idx.name) AS col WHERE col.name = 'barcode')
  `);
  const manifest = await client.execute(`SELECT filename, sha256 FROM ${TURSO_MANIFEST} ORDER BY filename`);
  return {
    objects_expected: baseline.objects.length,
    objects_remote: remote.objects.length,
    comparison: diff,
    seed_counts: counts,
    barcode_unique_indexes: Number(barcodeIndexes.rows[0] && barcodeIndexes.rows[0].count),
    manifest: manifest.rows.map((row) => ({ filename: row.filename, sha256: row.sha256 })),
  };
}

(async () => {
  const mode = process.argv[2] || '--verify';
  if (!['--apply', '--verify'].includes(mode)) throw new Error('Use --apply or --verify.');
  const url = requiredEnvironment('TURSO_DATABASE_URL');
  const authToken = requiredEnvironment('TURSO_AUTH_TOKEN');
  const client = createClient({ url, authToken });
  // Unlike D1, Turso starts this connection with FK enforcement disabled.
  // Turn it on before applying/verifying so the pilot reflects the integrity
  // guarantee that every active D1 request already has.
  await client.execute('PRAGMA foreign_keys = ON');
  const foreignKeyPragma = await client.execute('PRAGMA foreign_keys');
  const foreignKeysEnforced = Number(foreignKeyPragma.rows[0] && foreignKeyPragma.rows[0].foreign_keys) === 1;

  if (mode === '--apply') {
    if (process.env.PHARMARIDGE_CONFIRM_TURSO_SCHEMA_PILOT !== 'APPLY_EMPTY_TURSO_SCHEMA') {
      throw new Error('Refusing schema write. Set PHARMARIDGE_CONFIRM_TURSO_SCHEMA_PILOT=APPLY_EMPTY_TURSO_SCHEMA for this terminal session.');
    }
    await apply(client);
  }
  const report = await verify(client);
  const clean = !report.comparison.missingObjects.length
    && !report.comparison.extraObjects.length
    && !report.comparison.changedObjects.length
    && !report.comparison.changedTableShape.length
    && report.seed_counts.nafdac_catalog === 6801
    && report.barcode_unique_indexes === 1
    && report.manifest.length === 2
    && foreignKeysEnforced;
  console.log(JSON.stringify({ mode, clean, foreign_keys_enforced: foreignKeysEnforced, ...report }, null, 2));
  if (!clean) process.exitCode = 1;
})().catch((error) => {
  console.error(`Turso schema pilot failed: ${error.message}`);
  process.exit(1);
});
