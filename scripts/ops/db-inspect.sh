#!/usr/bin/env bash
# OmniRoute database inspector
# Usage: ./db-inspect.sh [db-path]

set -euo pipefail

DB_PATH="${1:-${OMNIROUTE_DB:-~/.omniroute/storage.sqlite}}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH"
  exit 1
fi

echo "=== OmniRoute Database Inspector ==="
echo "Database: ${DB_PATH}"
echo ""

# Database size
SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "Size: ${SIZE}"
echo ""

# Tables count
TABLE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")
echo "Tables: ${TABLE_COUNT}"
echo ""

# Provider connections
echo "--- Provider Connections ---"
sqlite3 -header -column "$DB_PATH" <<EOF
SELECT provider, max_concurrent, is_active
FROM provider_connections
ORDER BY provider
LIMIT 20;
EOF
echo ""

# Quota status
echo "--- Exhausted Quotas ---"
EXHAUSTED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM quota_snapshots WHERE is_exhausted=1;" 2>/dev/null || echo "N/A")
echo "Exhausted: ${EXHAUSTED}"

if [[ "$EXHAUSTED" != "N/A" && "$EXHAUSTED" -gt 0 ]]; then
  sqlite3 -header -column "$DB_PATH" <<EOF
SELECT provider, window_key, remaining_percentage, next_reset_at
FROM quota_snapshots
WHERE is_exhausted=1
LIMIT 10;
EOF
fi
echo ""

# Recent errors
echo "--- Recent Failed Calls (last 10) ---"
sqlite3 -header -column "$DB_PATH" <<EOF
SELECT provider, model, status, error_summary, timestamp
FROM call_logs
WHERE status != 200
ORDER BY timestamp DESC
LIMIT 10;
EOF
echo ""

# Call volume (last hour)
echo "--- Call Volume (last hour) ---"
sqlite3 "$DB_PATH" <<EOF
SELECT
  COUNT(*) as total_calls,
  SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) as failed
FROM call_logs
WHERE timestamp > datetime('now', '-1 hour');
EOF

echo ""
echo "✓ Database inspection complete"