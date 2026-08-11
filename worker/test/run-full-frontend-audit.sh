#!/usr/bin/env bash
# Browser-side two-way audit. Each browser probe gets a fresh scenario database:
# controls and dropdowns are exercised in the real DOM, then the associated API
# and role/branch outcome is re-read instead of trusting a click or a toast.
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

fresh_scenario() {
  stop_server
  rm -rf .wrangler
  npx --no-install wrangler d1 migrations apply pharmaridge-db --local >/dev/null
  node generate-seed.js >/dev/null
  npx --no-install wrangler d1 execute pharmaridge-db --local --file=./seed.sql >/dev/null
  setsid npx --no-install wrangler dev --assets ../public --port "${PORT}" \
    > /tmp/pharmaridge-frontend-audit-wrangler.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    if curl -fsS "${BASE}/api/health" >/dev/null; then break; fi
    sleep 1
  done
  WORKER_BASE="${BASE}" node test/tools/seed-scenarios.js >/dev/null
}

run_one() {
  local script="$1"
  echo
  echo "===== Fresh scenario frontend audit: ${script} ====="
  fresh_scenario
  if WORKER_BASE="${BASE}" node "${script}"; then return 0; fi
  # Browser contexts can occasionally lose a local Wrangler bridge during a
  # long geometry sweep. Retry once from a completely new D1 + browser world;
  # a repeat failure remains a real audit failure and stops the suite.
  echo "----- transient browser retry: ${script} -----"
  fresh_scenario
  WORKER_BASE="${BASE}" node "${script}"
}

# Controls, role-gated triggers, dropdowns, form alignment, touch targets and
# responsive states. These probes re-read live backend state after UI actions.
run_one test/tools/probe-role-triggers.js
run_one test/tools/probe-data-management-ui.js
run_one test/tools/probe-password-reveal.js
run_one test/tools/probe-promotion-dropdown.js
run_one test/tools/probe-pos-checkout-lifecycle.js
run_one test/tools/probe-input-guidance.js
run_one test/audit.responsive.js
run_one test/tools/probe-topbar.js
run_one test/tools/probe-formbaseline.js
run_one test/tools/probe-overlap.js
run_one test/tools/probe-ux-sweep.js
run_one test/tools/probe-login-lifecycle.js

echo
echo "Full frontend audit suite passed: controls, triggers, dropdowns, role gates, responsive geometry and login lifecycle."
