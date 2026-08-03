#!/usr/bin/env bash
# Execute the restored high-value API audits against a fresh local D1 database.
# Each script gets its own reset because it deliberately mutates cash, stock,
# journals, users and sync records. A test's result must not depend on the
# order in which another test happened to run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"

if ! command -v node >/dev/null; then
  echo "Node.js is required." >&2
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node.js 22+ is required; found $(node --version)." >&2
  exit 1
fi

cd "${ROOT}"
if [ ! -f .dev.vars ]; then
  SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
  printf 'JWT_SECRET=%s\n' "${SECRET}" > .dev.vars
  echo "Created a gitignored local .dev.vars with a random development JWT secret."
fi

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
    sleep 0.3
    kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    unset SERVER_PID
  fi
}
trap stop_server EXIT

fresh_database() {
  stop_server
  rm -rf .wrangler
  npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
  node generate-seed.js >/dev/null
  npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null
}

start_server() {
  : > /tmp/pharmaridge-wrangler.log
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" --local \
    > /tmp/pharmaridge-wrangler.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then return 0; fi
    sleep 1
  done
  echo "Local Worker did not become healthy. Last logs:" >&2
  tail -80 /tmp/pharmaridge-wrangler.log >&2 || true
  return 1
}

run_one() {
  local script="$1"
  echo
  echo "===== Fresh local D1: ${script} ====="
  fresh_database
  start_server
  WORKER_BASE="${BASE}" node "${script}"
}

run_one test/audit.money.js
run_one test/audit.wht.js
run_one test/audit.workflows.js
run_one test/audit.sync.js

echo
printf 'Core live audit suite passed: cash/till, WHT/GL, procurement/transfers, and offline sync.\n'
