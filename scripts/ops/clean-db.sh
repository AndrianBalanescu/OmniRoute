#!/usr/bin/env bash
# OmniRoute clean database — wipes all runtime data for a fresh dev start
# Usage: ./clean-db.sh [--confirm]

set -euo pipefail

CONFIRM=false
if [[ "${1:-}" == "--confirm" ]]; then
  CONFIRM=true
fi

DATA_DIR="${OMNIROUTE_DATA_DIR:-$HOME/.omniroute}"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "Data dir not found: $DATA_DIR"
  exit 0
fi

echo "=== OmniRoute Clean Database ==="
echo "Data dir: ${DATA_DIR}"
echo ""

# Show what will be deleted
echo "Will remove:"
du -sh "$DATA_DIR"/storage.sqlite* 2>/dev/null || true
du -sh "$DATA_DIR"/db_backups 2>/dev/null || true
du -sh "$DATA_DIR"/call_logs 2>/dev/null || true
du -sh "$DATA_DIR"/logs 2>/dev/null || true
du -sh "$DATA_DIR"/log_archives 2>/dev/null || true
du -sh "$DATA_DIR"/server 2>/dev/null || true
echo ""

if ! $CONFIRM; then
  echo "Add --confirm to actually delete."
  echo "WARNING: This kills the dev server and deletes ALL data."
  exit 0
fi

# Kill dev server if running
if lsof -ti:20128 &>/dev/null; then
  echo "Killing dev server on port 20128..."
  lsof -ti:20128 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Wipe everything
echo "Wiping..."
rm -rf "$DATA_DIR"/storage.sqlite* \
       "$DATA_DIR"/db_backups \
       "$DATA_DIR"/call_logs \
       "$DATA_DIR"/logs \
       "$DATA_DIR"/log_archives \
       "$DATA_DIR"/server \
       "$DATA_DIR"/server.env \
       "$DATA_DIR"/.env

echo ""
echo "✓ Wiped. Start fresh with:"
echo "  cd /Users/flowmaster/OmniRoute && npm run dev"
echo ""
echo "The dev server will auto-generate new secrets and create a fresh DB"
echo "with migrations from the current source code."