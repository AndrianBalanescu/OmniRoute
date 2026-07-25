#!/usr/bin/env bash
# @file omniroute-monitor.sh
# @description OmniRoute VPS health monitor for routing, quota, and error checks.
#
# @changes
# - [2026-07-25] [Composer] - Initial VPS monitor script for Alibaba combo ops
#
# Usage: bash scripts/ops/omniroute-monitor.sh
set -euo pipefail

VPS="root@2.25.136.222"
DB="/root/.omniroute/storage.sqlite"
ISSUES=0

echo "=== OmniRoute VPS Monitor $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Health check
echo -n "1. Health: "
HEALTH=$(ssh "$VPS" 'curl -s http://localhost:20128/api/health/ping' 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok"'; then
  echo "OK"
else
  echo "FAIL — $HEALTH"
  ISSUES=$((ISSUES + 1))
fi

# 2. Check for 503 "all upstream accounts inactive" in last 15 min
echo -n "2. 503 errors (15min): "
COUNT_503=$(ssh "$VPS" "sqlite3 $DB \"SELECT COUNT(*) FROM call_logs WHERE status=503 AND timestamp > strftime('%Y-%m-%dT%H:%M:%S.000Z','now','-15 minutes');\"" 2>/dev/null)
if [ "$COUNT_503" -gt 0 ] 2>/dev/null; then
  echo "FAIL — $COUNT_503 errors"
  ISSUES=$((ISSUES + 1))
else
  echo "OK (0)"
fi

# 3. Check antigravity connections are active
echo -n "3. Antigravity connections: "
AG_ACTIVE=$(ssh "$VPS" "sqlite3 $DB \"SELECT COUNT(*) FROM provider_connections WHERE provider='antigravity' AND is_active=1;\"" 2>/dev/null)
if [ "$AG_ACTIVE" -ge 1 ] 2>/dev/null; then
  echo "OK ($AG_ACTIVE active)"
else
  echo "FAIL — 0 active"
  ISSUES=$((ISSUES + 1))
fi

# 4. Check featherless connection is active
echo -n "4. Featherless connection: "
FL_ACTIVE=$(ssh "$VPS" "sqlite3 $DB \"SELECT COUNT(*) FROM provider_connections WHERE provider='featherless-ai' AND is_active=1;\"" 2>/dev/null)
if [ "$FL_ACTIVE" -ge 1 ] 2>/dev/null; then
  echo "OK ($FL_ACTIVE active)"
else
  echo "FAIL — 0 active"
  ISSUES=$((ISSUES + 1))
fi

# 5. Check for tokens_out=0 on non-test calls in last 15 min
echo -n "5. Empty responses (15min): "
EMPTY=$(ssh "$VPS" "sqlite3 $DB \"SELECT COUNT(*) FROM call_logs WHERE tokens_out=0 AND status=200 AND model NOT LIKE '%test%' AND model NOT LIKE '%connection-test%' AND timestamp > strftime('%Y-%m-%dT%H:%M:%S.000Z','now','-15 minutes');\"" 2>/dev/null)
if [ "$EMPTY" -gt 0 ] 2>/dev/null; then
  echo "WARN — $EMPTY empty responses"
else
  echo "OK (0)"
fi

# 6. Check antigravity quota exhaustion in logs
echo -n "6. Antigravity quota: "
QUOTA_LOG=$(ssh "$VPS" 'tail -100 /root/.omniroute/server.log 2>/dev/null | grep "quota-aware" | tail -1' 2>/dev/null)
if [ -z "$QUOTA_LOG" ]; then
  echo "No recent quota messages"
else
  EXHAUSTED=$(echo "$QUOTA_LOG" | grep -c "skipping.*exhausted" || true)
  if [ "$EXHAUSTED" -gt 0 ]; then
    echo "WARN — some accounts exhausted"
  else
    echo "OK"
  fi
fi

# 7. Check combo connectionId integrity
echo -n "7. Combo connectionId check: "
BAD_COMBOS=$(ssh "$VPS" "python3 -c \"
import json, sqlite3
conn = sqlite3.connect('$DB')
cur = conn.cursor()
cur.execute('SELECT name, data FROM combos')
bad = 0
for name, data in cur.fetchall():
    combo = json.loads(data)
    for m in combo.get('models', []):
        if 'connectionId' not in m and m.get('kind') == 'model':
            print('  MISSING: %s → %s' % (name, m.get('model','?')))
            bad += 1
conn.close()
print('BAD=%d' % bad)
\"" 2>/dev/null | grep "BAD=" | cut -d= -f2)
if [ "$BAD_COMBOS" -eq 0 ] 2>/dev/null; then
  echo "OK — all models have connectionId"
else
  echo "FAIL — $BAD_COMBOS models missing connectionId"
  ISSUES=$((ISSUES + 1))
fi

# 8. Check backoff_level on connections
echo -n "8. Connections in backoff: "
BACKOFF=$(ssh "$VPS" "sqlite3 $DB \"SELECT COUNT(*) FROM provider_connections WHERE backoff_level > 0;\"" 2>/dev/null)
if [ "$BACKOFF" -gt 0 ] 2>/dev/null; then
  echo "WARN — $BACKOFF in backoff"
else
  echo "OK (0)"
fi

echo ""
if [ "$ISSUES" -gt 0 ]; then
  echo "RESULT: $ISSUES ISSUE(S) FOUND"
  exit 1
else
  echo "RESULT: ALL CHECKS PASSED"
  exit 0
fi