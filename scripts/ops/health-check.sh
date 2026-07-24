#!/usr/bin/env bash
# OmniRoute health check — probes local or VPS instance
# Usage: ./health-check.sh [host:port]

set -euo pipefail

TARGET="${1:-localhost:20128}"
URL="http://${TARGET}/api/health/ping"

echo "=== OmniRoute Health Check ==="
echo "Target: ${TARGET}"
echo ""

# Basic health
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${URL}" 2>/dev/null) || HTTP_CODE="000"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✓ Health endpoint: OK (200)"
elif [[ "$HTTP_CODE" == "000" ]]; then
  echo "✗ Health endpoint: UNREACHABLE (no server on ${TARGET})"
  echo "  Start with: cd /Users/flowmaster/OmniRoute && npm run dev"
  exit 1
else
  echo "✗ Health endpoint: FAIL (HTTP ${HTTP_CODE})"
  exit 1
fi

# Detailed health
echo ""
echo "--- Detailed Status ---"
curl -s "http://${TARGET}/api/health/ping" 2>/dev/null | python3 -m json.tool 2>/dev/null || \
  curl -s "http://${TARGET}/api/health/ping" 2>/dev/null || \
  echo "(detailed endpoint not available)"

# Response time
echo ""
echo "--- Response Times ---"
for endpoint in "/api/health/ping" "/api/providers/__readiness_probe__/models"; do
  TIME=$(curl -s -o /dev/null -w "%{time_total}" "http://${TARGET}${endpoint}" 2>/dev/null) || TIME="timeout"
  printf "  %-20s %s\n" "${endpoint}" "${TIME}s"
done

echo ""
echo "✓ All checks passed"
