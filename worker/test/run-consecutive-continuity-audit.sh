#!/usr/bin/env bash
# Runs three consecutive 90-day terms and a real Owner cleanup after each term.
# It does this once for accounting-only protection and once for accounting +
# current-stock protection. Every database is local; production is never used.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
cd "${ROOT}"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then echo "Node.js 22+ is required." >&2; exit 1; fi
if [ ! -f .dev.vars ]; then printf 'JWT_SECRET=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" > .dev.vars; fi
SERVER_PID=""
stop_server() {
  if [ -n "${SERVER_PID}" ]; then
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
    sleep 0.4
    kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT
fresh_world() {
  stop_server
  rm -rf .wrangler
  npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
  node generate-seed.js >/dev/null
  npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" > /tmp/pharmaridge-consecutive-continuity-wrangler.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then return 0; fi
    sleep 1
  done
  echo 'Local Worker did not become healthy.' >&2
  tail -100 /tmp/pharmaridge-consecutive-continuity-wrangler.log >&2 || true
  return 1
}
for mode in ACCOUNTING STOCK; do
  printf "\n===== Fresh local world for %s continuity =====\n" "${mode}"
  fresh_world
  CONTINUITY_MODE="${mode}" WORKER_BASE="${BASE}" node test/tools/exercise-consecutive-continuity-terms.js
done
printf "\nConsecutive continuity audit passed: three 90-day terms per protection policy, each followed by a real Owner cleanup and final delete.\n"
