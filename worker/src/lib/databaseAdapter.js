// Database-provider seam for the staged D1 → Turso migration.
//
// IMPORTANT: Nothing in the live application is switched by this module yet.
// D1 remains the only active provider until every route and service has moved
// from c.env.DB to this seam and the compatibility/reconciliation gates pass.
// The Turso adapter deliberately mirrors the small D1 surface PharmaRidge
// already uses: prepare().bind().first()/all()/run() plus atomic batch().

const { createClient } = require('@tursodatabase/serverless/compat');

function providerFrom(env) {
  return String((env && env.DATABASE_PROVIDER) || 'D1').trim().toUpperCase();
}

function d1Result(result) {
  return {
    success: true,
    results: result.rows || [],
    meta: {
      changes: Number(result.rowsAffected || 0),
      last_row_id: result.lastInsertRowid == null ? null : String(result.lastInsertRowid),
      // These are useful diagnostic fields on Turso. Existing D1 callers only
      // rely on `changes`, so retaining them here is additive and harmless.
      rows_read: result.rowsRead == null ? null : Number(result.rowsRead),
      rows_written: result.rowsWritten == null ? null : Number(result.rowsWritten),
      duration: result.queryDurationMs == null ? null : Number(result.queryDurationMs),
    },
  };
}

class TursoPreparedStatement {
  constructor(client, sql, args = []) {
    this.client = client;
    this.sql = String(sql);
    this.args = args;
  }

  // D1's bind() returns a prepared statement. Return a new immutable wrapper
  // so one statement template cannot accidentally leak bound values into a
  // later request.
  bind(...args) {
    return new TursoPreparedStatement(this.client, this.sql, args);
  }

  asStatement() {
    return { sql: this.sql, args: this.args };
  }

  async first(columnName) {
    const result = await this.client.execute(this.asStatement());
    const row = (result.rows || [])[0] || null;
    return columnName && row ? row[columnName] : row;
  }

  async all() {
    return d1Result(await this.client.execute(this.asStatement()));
  }

  async run() {
    return d1Result(await this.client.execute(this.asStatement()));
  }
}

class TursoDatabaseAdapter {
  constructor(client) {
    this.client = client;
    this.provider = 'TURSO';
  }

  prepare(sql) {
    return new TursoPreparedStatement(this.client, sql);
  }

  // D1 batch() is atomic. Turso's compat client accepts the explicit `write`
  // transaction mode, which makes the all-or-nothing intent equally explicit.
  // Refuse foreign statement objects rather than silently mixing a D1 and a
  // Turso database in one operation.
  async batch(statements) {
    if (!Array.isArray(statements) || statements.some((statement) => !(statement instanceof TursoPreparedStatement))) {
      throw new TypeError('Turso batch accepts only statements prepared by the Turso adapter.');
    }
    const results = await this.client.batch(statements.map((statement) => statement.asStatement()), 'write');
    return results.map(d1Result);
  }
}

function createTursoDatabase(env, clientFactory = createClient) {
  const url = env && env.TURSO_DATABASE_URL;
  const authToken = env && env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error('Turso requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN Worker secrets.');
  }
  return new TursoDatabaseAdapter(clientFactory({ url, authToken }));
}

function getDatabase(env, clientFactory) {
  const provider = providerFrom(env);
  if (provider === 'D1') {
    if (!env || !env.DB) throw new Error('D1 provider requires the DB binding.');
    return env.DB;
  }
  if (provider === 'TURSO') return createTursoDatabase(env, clientFactory);
  throw new Error(`Unsupported DATABASE_PROVIDER: ${provider}. Use D1 or TURSO.`);
}

module.exports = {
  TursoDatabaseAdapter,
  TursoPreparedStatement,
  createTursoDatabase,
  getDatabase,
  providerFrom,
};
