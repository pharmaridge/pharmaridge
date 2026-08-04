#!/usr/bin/env bash
# Fresh-D1 browser regression for the login spinner/logout lifecycle.
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

rm -rf .wrangler
npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
node generate-seed.js >/dev/null
npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null
setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" > /tmp/pharmaridge-login-lifecycle.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
  sleep 0.3
  kill -KILL -- "-${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 45); do
  if curl -fsS "${BASE}/api/health" >/dev/null; then break; fi
  sleep 1
done
WORKER_BASE="${BASE}" node test/tools/probe-login-lifecycle.js
