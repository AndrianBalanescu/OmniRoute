#!/usr/bin/env bash
# Rebuild & recreate stable OmniRoute after a verified update.
# Prefer testing on host-dev (:20228) first, then run this.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> Rebuilding omniroute:homelab (runner-web)…"
docker compose -f docker-compose.homelab.yml build --pull

echo "==> Recreating containers…"
docker compose -f docker-compose.homelab.yml up -d --force-recreate

echo "==> Waiting for health…"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:20128/api/health/ping >/dev/null 2>&1; then
    ok=1
    break
  fi
  # ~2s pause without calling sleep(1)
  read -r -t 2 _ || true
done

if [[ "$ok" -eq 1 ]]; then
  curl -sS http://127.0.0.1:20128/api/health/ping
  echo
  docker compose -f docker-compose.homelab.yml ps
  exit 0
fi

echo "WARN: health ping not ready yet — check: docker compose -f docker-compose.homelab.yml logs --tail=80" >&2
exit 1
