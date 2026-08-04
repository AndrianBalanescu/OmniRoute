#!/usr/bin/env bash
# Host-side OmniRoute dev server alongside stable Docker.
# Uses :20228 + ~/.omniroute-dev so it never shares SQLite with Docker (:20128).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DEV_DATA="${OMNIROUTE_DEV_DATA_DIR:-/home/ubuntu/.omniroute-dev}"
mkdir -p "$DEV_DATA"/{call_logs,logs,cache,runtime,log_archives}

if ss -tlnp 2>/dev/null | grep -q ':20228 '; then
  echo "ERROR: port 20228 already in use." >&2
  exit 1
fi

export HOST=0.0.0.0
export API_HOST=0.0.0.0
export OMNIROUTE_SERVER_HOST=0.0.0.0
export PORT=20228
export DASHBOARD_PORT=20228
export API_PORT=20229
export LIVE_WS_PORT=20232
export LIVE_WS_HOST=127.0.0.1
export DATA_DIR="$DEV_DATA"
export BASE_URL="${OMNIROUTE_DEV_BASE_URL:-http://100.70.158.21:20228}"
export NEXT_PUBLIC_BASE_URL="$BASE_URL"
export LIVE_WS_ALLOWED_HOSTS=homelab,homelab.taild8b2e2.ts.net,100.70.158.21,192.168.1.205,localhost,127.0.0.1
export LIVE_WS_ALLOWED_ORIGINS="http://homelab:20228,http://100.70.158.21:20228,http://192.168.1.205:20228,http://localhost:20228,http://127.0.0.1:20228"

mkdir -p logs
echo "OmniRoute DEV → $BASE_URL"
echo "DATA_DIR=$DATA_DIR (sandbox; Docker keeps ~/.omniroute)"
echo "Tip: copy DB once with:  cp ~/.omniroute/storage.sqlite \"$DEV_DATA/\"  (stop writers first)"

exec npm run dev
