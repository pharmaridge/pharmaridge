#!/usr/bin/env bash
# Build the role-based onboarding PDF from a fresh local D1 database and real
# desktop/mobile application captures. The PDF is an evidence-backed document,
# not a hand-made mock-up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKER_PORT:-9001}"
BASE="${WORKER_BASE:-http://127.0.0.1:${PORT}}"
SHOT_DIR="${SHOT_DIR:-/tmp/pharmaridge-manual-shots}"
OUT_PDF="${OUT_PDF:-${ROOT}/../docs/PharmaRidge-Onboarding-Guide.pdf}"
cd "${ROOT}"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node.js 22+ is required; found $(node --version)." >&2
  exit 1
fi
if [ ! -f .dev.vars ]; then
  printf 'JWT_SECRET=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" > .dev.vars
fi

rm -rf .wrangler "${SHOT_DIR}"
mkdir -p "${SHOT_DIR}" "$(dirname "${OUT_PDF}")"
npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
node generate-seed.js >/dev/null
npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null

setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" --local \
  > /tmp/pharmaridge-guide-wrangler.log 2>&1 &
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
  echo "Local Worker did not become healthy:" >&2
  tail -80 /tmp/pharmaridge-guide-wrangler.log >&2 || true
  exit 1
fi

WORKER_BASE="${BASE}" node test/tools/seed-scenarios.js
WORKER_BASE="${BASE}" SHOT_DIR="${SHOT_DIR}" node test/tools/shots-manual.js
WORKER_BASE="${BASE}" SHOT_DIR="${SHOT_DIR}" node test/tools/shots-artefacts.js

# The PDF is built from local captures only; stop the server before Chromium
# prints it so no local runtime remains after a successful document build.
stop_server
OUT_PDF="${OUT_PDF}" SHOT_DIR="${SHOT_DIR}" node test/tools/build-manual.js

echo "Onboarding PDF ready: ${OUT_PDF}"
