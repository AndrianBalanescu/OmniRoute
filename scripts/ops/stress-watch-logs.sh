#!/usr/bin/env bash
# @file stress-watch-logs.sh
# @description Tail OmniRoute app logs filtered for combo routing / errors during stress tests.
#
# @changes
# - [2026-07-24] [Composer] - Initial combo stress log watcher
#
# Usage: bash scripts/ops/stress-watch-logs.sh [seconds]

set -euo pipefail

DURATION="${1:-120}"
LOG_FILE="${OMNIROUTE_LOG:-$HOME/.omniroute/logs/application/app.log}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Log file not found: $LOG_FILE"
  exit 1
fi

echo "=== Watching combo routing logs (${DURATION}s) ==="
echo "File: $LOG_FILE"
echo "Filter: COMBO|Skipping|concurrency|paid-premium|error|warn"
echo ""

timeout "${DURATION}" tail -n 0 -f "$LOG_FILE" 2>/dev/null | rg --line-buffered -i \
  "COMBO|Skipping|concurrency cap|paid-premium|error|warn|Trying model|succeeded|failed" || true

echo ""
echo "Done."
