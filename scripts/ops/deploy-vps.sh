#!/usr/bin/env bash
# @file deploy-vps.sh
# @description Fast or full OmniRoute backend deploy to the operator VPS.
#
# @changes
# - [2026-07-25] [Composer] - Initial fast/full VPS deploy helper
#
# ─── OmniRoute VPS Deploy — fast backend-only sync ───────────────────────────
# Syncs local source + dist to the VPS (HyperStack 2.25.136.222) and restarts
# the systemd-backed gateway WITHOUT killing the local Next.js dev server.
#
# Modes:
#   --fast  (default)  rsync workspace (excl .build/node_modules/.git) → VPS,
#                       rebuild better-sqlite3, install -g, systemctl restart.
#                       ~25 s. Only works when the VPS `.build/next/BUILD_ID`
#                       matches yours (i.e. dashboard unchanged).
#
#   --full            clone workspace into temp dir → run npm run build:release
#                       → rsync the resulting dist + .build → VPS → restart.
#                       ~6 min. Use when Next.js UI / dashboard changed.
#
#   --wipe            stop gateway, delete remote dist + .build, then deploy
#                       fresh. Forces a clean state regardless of cache.
#
# Env vars honoured:  OMNIROUTE_BUILD_MEMORY=8192  (default: 8192 MB)
#                     VPS_HOST=2.25.136.222         (default)
set -euo pipefail

VPS="${VPS_HOST:-2.25.136.222}"
VPS_ROOT="/root/projects/OmniRoute"
VPS_NPM_GLOBAL="/usr/local/lib/node_modules/omniroute"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8"
RSYNC="rsync -avz --delete"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MEM="${OMNIROUTE_BUILD_MEMORY:-8192}"

MODE="fast"

# ── arg parse ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --fast) MODE="fast" ;;
    --full) MODE="full" ;;
    --wipe) MODE="wipe" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────────────────
ensure_port_free() {
  echo "→ Stopping VPS gateway & freeing port 20128…"
  $SSH "root@$VPS" 'systemctl stop omniroute 2>/dev/null || true; fuser -k 20128/tcp 2>/dev/null || true'
  sleep 1
}

verify_started() {
  echo "→ Verifying gateway health…"
  for i in $(seq 1 10); do
    if curl -s --max-time 2 "http://$VPS:20128/v1/models" >/dev/null 2>&1; then
      echo "✅ VPS gateway healthy (http://$VPS:20128/v1/models)"
      return 0
    fi
    sleep 2
  done
  echo "❌ VPS gateway did NOT become healthy — check journalctl."
  return 1
}

# ── fast sync ────────────────────────────────────────────────────────────────
fast_deploy() {
  echo "[fast] Syncing workspace (dist + backend source only)…"
  # rsync everything EXCEPT the huge .build/next (unchanged dashboard) and
  # node_modules / .git which are not needed on the VPS.
  $RSYNC \
    --exclude='.build/next' \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='logs' \
    --exclude='.tmp' \
    "$PROJECT_ROOT/" "root@$VPS:$VPS_ROOT/"

  echo "[fast] Rebuilding native addon + installing global + restarting…"
  $SSH "root@$VPS" "
    cd $VPS_ROOT/dist && npm rebuild better-sqlite3 && cd $VPS_ROOT || exit 1
    npm install -g . || exit 1
    systemctl start omniroute
  "
}

# ── full build-in-temp ───────────────────────────────────────────────────────
full_deploy() {
  echo "[full] Preparing isolated build workspace…"
  TEMP=$(mktemp -d)
  trap "rm -rf '$TEMP'" EXIT
  # rsync all project files INTO temp dir quickly (without node_modules)
  rsync -a --exclude='node_modules' --exclude='.git' --exclude='.build' \
    "$PROJECT_ROOT/" "$TEMP/"

  echo "[full] Initializing temporary git repo for build SHA..."
  cd "$TEMP"
  git init -q
  git config user.name "deploy"
  git config user.email "deploy@local"
  git add -A
  git commit -m "temp build" -q

  echo "[full] Installing dependencies…"
  npm ci --ignore-scripts 2>&1 | tail -3

  echo "[full] Running full build (next + cli) with NODE_OPTIONS=--max-old-space-size=$MEM"
  NODE_OPTIONS="--max-old-space-size=$MEM" npm run build:release

  echo "[full] Syncing compiled assets to VPS…"
  $RSYNC "$TEMP/dist/" "root@$VPS:$VPS_ROOT/dist/"
  $RSYNC "$TEMP/.build/next/" "root@$VPS:$VPS_ROOT/.build/next/"

  echo "[full] Installing global + restarting…"
  $SSH "root@$VPS" "
    cd $VPS_ROOT/dist && npm rebuild better-sqlite3 && cd $VPS_ROOT || exit 1
    npm install -g . || exit 1
    systemctl start omniroute
  "
}

wipe_deploy() {
  echo "[wipe] Removing remote dist + .build for clean deploy…"
  $SSH "root@$VPS" "rm -rf $VPS_ROOT/dist $VPS_ROOT/.build/next"
  # after wipe, run the full build flow
  full_deploy
}

# ── main ─────────────────────────────────────────────────────────────────────
cd "$PROJECT_ROOT"

if [[ "$MODE" == "fast" ]]; then
  # Pre-flight: verify that local and VPS BUILD_IDs match
  if [[ -f .build/next/BUILD_ID ]]; then
    LOCAL_BUILD=$(cat .build/next/BUILD_ID)
    REMOTE_BUILD=$($SSH "root@$VPS" "cat $VPS_ROOT/.build/next/BUILD_ID 2>/dev/null" || true)
    if [[ "$LOCAL_BUILD" != "$REMOTE_BUILD" ]]; then
      echo "⚠️  BUILD_ID mismatch (local=$LOCAL_BUILD vs VPS=$REMOTE_BUILD)"
      echo "   Dashboard assets differ — falling back to --full."
      full_deploy
      verify_started
      exit 0
    fi
  fi

  ensure_port_free
  fast_deploy
  verify_started

elif [[ "$MODE" == "full" ]]; then
  ensure_port_free
  full_deploy
  verify_started

elif [[ "$MODE" == "wipe" ]]; then
  ensure_port_free
  wipe_deploy
  verify_started
fi