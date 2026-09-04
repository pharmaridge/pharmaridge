#!/usr/bin/env bash
# Fresh local D1 production-readiness checks for simultaneous counter sales and
# plan downgrades. Never points at a remote Worker or D1 database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
cd "${ROOT}"
if [ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]; then echo 'Node.js 22+ is required.' >&2; exit 1; fi
if [ ! -f .dev.vars ]; then printf 'JWT_SECRET=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" > .dev.vars; fi
SERVER_PID=""
stop() { if [ -n "${SERVER_PID}" ]; then kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true; sleep .3; kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true; fi; }
trap stop EXIT
run_one() {
  local file="$1"
  rm -rf .wrangler
  npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
  node generate-seed.js >/dev/null
  npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" >/tmp/pharmaridge-capacity-readiness.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do curl -fsS "${BASE}/api/health" >/dev/null && break; sleep 1; done
  WORKER_BASE="${BASE}" node "${file}"
  stop; SERVER_PID=""
}
run_one test/audit.concurrent-pos-sales.js
run_one test/audit.plan-downgrade.js
printf '\nCapacity/concurrency readiness audit passed.\n'
