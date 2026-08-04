#!/usr/bin/env bash
# Fresh-D1 browser/PWA regression probe (theme, contrast, drawer, print frame,
# and phone-width layout). Kept separate from the fast core API suite because
# Chromium startup is materially slower.
#
# Wrangler's local ProxyController can die under rapid browser context churn.
# audit.pwa.js exits 3 for that specific infrastructure failure; retrying the
# complete isolated run is correct, while any assertion failure remains a fail.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
MAX_ATTEMPTS="${PWA_TEST_ATTEMPTS:-3}"
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

for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  echo "===== Browser/PWA attempt ${attempt}/${MAX_ATTEMPTS} ====="
  stop_server
  rm -rf .wrangler
  npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
  node generate-seed.js >/dev/null
  npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null

  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" --local \
    > /tmp/pharmaridge-wrangler.log 2>&1 &
  SERVER_PID=$!
  healthy=0
  for _ in $(seq 1 45); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then healthy=1; break; fi
    sleep 1
  done
  if [ "${healthy}" -ne 1 ]; then
    echo "Worker did not become healthy:" >&2
    tail -80 /tmp/pharmaridge-wrangler.log >&2 || true
    exit 1
  fi

  set +e
  WORKER_BASE="${BASE}" node test/audit.pwa.js
  status=$?
  if [ "${status}" -eq 0 ]; then
    # Delays branding deliberately so the pre-login/PWA splash is observable;
    # verifies the real transparent carrier and mobile theme glyph rather than
    # trusting the source assets alone.
    WORKER_BASE="${BASE}" node test/tools/probe-splash-transparency.js
    status=$?
  fi
  set -e
  if [ "${status}" -eq 0 ]; then
    echo "Browser/PWA audit passed on attempt ${attempt}."
    exit 0
  fi
  if [ "${status}" -ne 3 ]; then
    echo "Browser/PWA audit failed with assertion/runtime status ${status}; not retrying." >&2
    exit "${status}"
  fi
  echo "Wrangler local ProxyController ended during browser churn; retrying a fresh isolated run."
done

echo "Browser/PWA audit could not complete after ${MAX_ATTEMPTS} Wrangler-local attempts." >&2
exit 3
