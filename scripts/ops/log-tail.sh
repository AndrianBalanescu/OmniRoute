#!/usr/bin/env bash
# OmniRoute log tailer with error highlighting
# Usage: ./log-tail.sh [log-file]

set -euo pipefail

LOG_FILE="${1:-${OMNIROUTE_LOG:-~/.omniroute/server.log}}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Log file not found: $LOG_FILE"
  exit 1
fi

echo "=== OmniRoute Log Tail ==="
echo "File: ${LOG_FILE}"
echo "Highlighting: ERROR (red), WARN (yellow), INFO (green)"
echo ""

# Tail with color highlighting
tail -f "$LOG_FILE" | while read -r line; do
  if echo "$line" | grep -qi "error\|fatal\|crash"; then
    echo -e "\033[31m${line}\033[0m"  # red
  elif echo "$line" | grep -qi "warn"; then
    echo -e "\033[33m${line}\033[0m"  # yellow
  elif echo "$line" | grep -qi "info"; then
    echo -e "\033[32m${line}\033[0m"  # green
  else
    echo "$line"
  fi
done
