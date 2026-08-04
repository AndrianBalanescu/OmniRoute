#!/usr/bin/env bash
# Start / rebuild the stable OmniRoute Docker instance (homelab :20128).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ss -tlnp 2>/dev/null | grep -q ':20128 '; then
  if ! docker ps --format '{{.Names}}' | grep -qx omniroute; then
    echo "ERROR: port 20128 is in use by a non-Docker process. Stop host npm run dev first." >&2
    exit 1
  fi
fi

exec docker compose -f docker-compose.homelab.yml up -d --build "$@"
