#!/usr/bin/env bash
# OmniRoute semaphore state analyzer
# Usage: ./semaphore-check.sh [db-path]

set -euo pipefail

DB_PATH="${1:-${OMNIROUTE_DB:-~/.omniroute/storage.sqlite}}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH"
  exit 1
fi

echo "=== OmniRoute Semaphore Analysis ==="
echo "Database: ${DB_PATH}"
echo ""

# Semaphore configuration
echo "--- Semaphore Configuration ---"
sqlite3 -header -column "$DB_PATH" <<EOF
SELECT
  provider,
  max_concurrent,
  is_active,
  CASE
    WHEN max_concurrent IS NULL THEN 'UNLIMITED'
    ELSE CAST(max_concurrent AS TEXT)
  END as limit_type
FROM provider_connections
WHERE is_active = 1
ORDER BY provider;
EOF
echo ""

# Check for potential bottlenecks
echo "--- Potential Bottlenecks ---"
sqlite3 -header -column "$DB_PATH" <<EOF
SELECT
  pc.provider,
  pc.max_concurrent,
  COUNT(DISTINCT cl.model) as models_sharing,
  CASE
    WHEN pc.max_concurrent IS NULL THEN 'NO LIMIT'
    WHEN COUNT(DISTINCT cl.model) > pc.max_concurrent THEN 'RISK: More models than slots'
    ELSE 'OK'
  END as status
FROM provider_connections pc
LEFT JOIN call_logs cl ON cl.provider = pc.provider
  AND cl.timestamp > datetime('now', '-1 hour')
WHERE pc.is_active = 1
GROUP BY pc.provider
HAVING models_sharing > 0
ORDER BY models_sharing DESC;
EOF
echo ""

# Recent semaphore timeouts
echo "--- Recent Semaphore Timeouts (last 24h) ---"
TIMEOUTS=$(sqlite3 "$DB_PATH" <<EOF
SELECT COUNT(*)
FROM call_logs
WHERE error_summary LIKE '%Semaphore timeout%'
  AND timestamp > datetime('now', '-24 hours');
EOF
)

echo "Timeout count: ${TIMEOUTS}"

if [[ "$TIMEOUTS" -gt 0 ]]; then
  echo ""
  sqlite3 -header -column "$DB_PATH" <<EOF
SELECT
  provider,
  model,
  error_summary,
  timestamp
FROM call_logs
WHERE error_summary LIKE '%Semaphore timeout%'
  AND timestamp > datetime('now', '-24 hours')
ORDER BY timestamp DESC
LIMIT 10;
EOF
fi
echo ""

# Recommendations
echo "--- Recommendations ---"
sqlite3 "$DB_PATH" <<EOF
SELECT
  CASE
    WHEN max_concurrent < 5 THEN 'Provider "' || provider || '": Consider increasing max_concurrent (currently ' || max_concurrent || ')'
    ELSE NULL
  END as recommendation
FROM provider_connections
WHERE is_active = 1 AND max_concurrent IS NOT NULL AND max_concurrent < 5;
EOF

echo ""
echo "✓ Semaphore analysis complete"