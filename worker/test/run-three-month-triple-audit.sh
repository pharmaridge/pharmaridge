#!/usr/bin/env bash
# Three independent 90-day simulations. Each child runner creates a fresh local
# D1 database, exercises real Worker routes, then re-reads financial/stock data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for run in 1 2 3; do
  echo "
===== Independent three-month continuity probe ${run}/3 ====="
  WORKER_PORT="${WORKER_PORT:-9001}" bash "${ROOT}/test/run-three-month-simulation-audit.sh"
done
echo "
Triple three-month audit passed: three separate fresh 90-day histories validated."
