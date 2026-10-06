#!/usr/bin/env bash
# Runs a disposable, end-to-end Worker rehearsal against a dedicated Turso
# database. The caller supplies TURSO_DATABASE_URL and TURSO_AUTH_TOKEN only
# in the current terminal session; this script never writes them to a file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9002}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
: "${TURSO_DATABASE_URL:?TURSO_DATABASE_URL is required}"
: "${TURSO_AUTH_TOKEN:?TURSO_AUTH_TOKEN is required}"
cd "${ROOT}"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node.js 22+ is required; found $(node --version)." >&2
  exit 1
fi

SUFFIX="$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")"
export REHEARSAL_ADMIN_USERNAME="turso.rehearsal.${SUFFIX}"
export REHEARSAL_ADMIN_PIN="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
export REHEARSAL_OWNER_PIN="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
export REHEARSAL_STAFF_PIN="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")"

# Create one temporary support-style Admin directly in the isolated rehearsal
# database. It is random, never printed, never committed, and exists only so
# the test can exercise the real Admin → Owner → Staff permission flow.
node - <<'NODE'
(async () => {
  const { createClient } = require('@tursodatabase/serverless/compat');
  const { hashPin, uuid } = require('./src/lib/crypto');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await db.execute('PRAGMA foreign_keys = ON');
  const hash = await hashPin(process.env.REHEARSAL_ADMIN_PIN);
  await db.execute({
    sql: 'INSERT INTO users (id, full_name, username, pin_hash, role, job_title) VALUES (?,?,?,?,?,?)',
    args: [uuid(), 'Turso Rehearsal Administrator', process.env.REHEARSAL_ADMIN_USERNAME, hash, 'ADMIN', 'Temporary migration rehearsal'],
  });
})().catch((error) => { console.error(error); process.exit(1); });
NODE

setsid npx --no-install wrangler dev --local --ip 127.0.0.1 --port "${PORT}" \
  --var 'DATABASE_PROVIDER:TURSO' \
  --var "TURSO_DATABASE_URL:${TURSO_DATABASE_URL}" \
  --var "TURSO_AUTH_TOKEN:${TURSO_AUTH_TOKEN}" \
  --var "JWT_SECRET:${JWT_SECRET}" \
  --var 'ENVIRONMENT:test' > /tmp/pharmaridge-turso-canary-wrangler.log 2>&1 &
SERVER_PID=$!
stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
    sleep 0.3
    kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT

for _ in $(seq 1 60); do
  if curl -fsS "${BASE}/api/health" >/dev/null; then break; fi
  sleep 1
done
if ! curl -fsS "${BASE}/api/health" >/dev/null; then
  echo "Turso Worker did not become healthy:" >&2
  tail -80 /tmp/pharmaridge-turso-canary-wrangler.log >&2 || true
  exit 1
fi

WORKER_BASE="${BASE}" node test/audit.turso-provider-canary.js
