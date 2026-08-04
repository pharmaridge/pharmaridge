#!/usr/bin/env bash
# Role-focused intra-domain and inter-domain security/authority audit.
#
# Each probe runs against a fresh local D1 state. The probes create branches,
# users, sales and transfers; isolation prevents one role's exercise from
# becoming another role's fixture or false failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
cd "${ROOT}"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node.js 22+ is required; found $(node --version)." >&2
  exit 1
fi
if [ ! -f .dev.vars ]; then
  printf 'JWT_SECRET=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" > .dev.vars
fi

SERVER_PID=""
stop_server() {
  if [ -n "${SERVER_PID}" ]; then
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
    sleep 0.3
    kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
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
  : > /tmp/pharmaridge-role-audit-wrangler.log
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" --local \
    > /tmp/pharmaridge-role-audit-wrangler.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then return 0; fi
    sleep 1
  done
  echo "Local Worker did not become healthy. Last logs:" >&2
  tail -80 /tmp/pharmaridge-role-audit-wrangler.log >&2 || true
  return 1
}

run_one() {
  local script="$1"
  echo
  echo "===== Fresh local D1 role/domain audit: ${script} ====="
  fresh_database
  start_server
  WORKER_BASE="${BASE}" node "${script}"
}

# Intra-domain authority boundaries.
run_one test/audit.vendorseat.js
run_one test/audit.owner.js
run_one test/audit.manager.js
run_one test/audit.staff.js

# Inter-domain boundaries: a person changing role/branch and cross-domain
# accounting/branch actions must retain their own branch and authority fence.
run_one test/audit.rolelifecycle.js
run_one test/tools/probe-crossdomain.js

# Device/session boundary: one person may not hold two live devices under one
# accountable username, while distinct people stay independently active.
run_one test/audit.single-session.js

echo
echo "Role/domain audit suite passed: admin, owner, manager, staff, lifecycle, cross-domain and single-session boundaries."
