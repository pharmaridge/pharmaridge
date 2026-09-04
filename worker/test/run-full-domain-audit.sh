#!/usr/bin/env bash
# Full two-way domain audit: every script gets a fresh local D1 state so that
# its UI/API inputs, financial effects and role boundaries are measured without
# another script's sales, sessions or plan changes leaking into the result.
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
  : > /tmp/pharmaridge-full-audit-wrangler.log
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" \
    > /tmp/pharmaridge-full-audit-wrangler.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then return 0; fi
    sleep 1
  done
  echo "Local Worker did not become healthy. Last logs:" >&2
  tail -80 /tmp/pharmaridge-full-audit-wrangler.log >&2 || true
  return 1
}

run_one() {
  local script="$1"
  echo
  echo "===== Fresh local D1 full-domain audit: ${script} ====="
  fresh_database
  start_server
  WORKER_BASE="${BASE}" node "${script}"
}

# Sales, payments, till and reconciliation.
run_one test/audit.money.js
run_one test/tools/probe-change-owed.js
run_one test/tools/probe-cashfloor.js
run_one test/tools/probe-safe.js
run_one test/tools/probe-safe-till.js
run_one test/tools/probe-split-cash.js
run_one test/tools/probe-payment-retry.js
run_one test/tools/probe-reversals.js

# VAT, WHT, customers, suppliers, purchase orders, receiving and stock.
run_one test/audit.wht.js
run_one test/tools/probe-wht-sale.js
run_one test/audit.customers.js
run_one test/audit.workflows.js
run_one test/audit.inventory.js
run_one test/tools/probe-receiving.js
run_one test/tools/probe-unit-alignment.js
run_one test/tools/probe-quantity.js

# Offline, sync, idempotency and stale replay.
run_one test/audit.sync.js
run_one test/tools/probe-stale-replay.js
run_one test/tools/probe-sync-gaps.js

# Intra-role and cross-domain authority / lifecycle controls.
run_one test/audit.vendorseat.js
run_one test/audit.owner.js
run_one test/audit.manager.js
run_one test/audit.staff.js
run_one test/audit.rolelifecycle.js
run_one test/audit.promotionauthority.js
run_one test/audit.single-session.js
run_one test/audit.concurrent-pos-sales.js
run_one test/audit.plan-downgrade.js
run_one test/tools/probe-crossdomain.js

# Owner-only data-retention/reset controls use an isolated in-memory D1-shaped
# schema and never point at the local scenario or production sample.
node test/audit.data-management.js

echo
echo "Full domain audit suite passed: sales, VAT/WHT, change, suppliers, customers, till/safe, stock, transfers, sessions, roles and cross-domain controls."
