#!/usr/bin/env bash
# @file mcp-global.sh
# @description Cursor MCP entrypoint — global user memory (~/.memrize/global.db).
#
# @changes
# - [2026-07-27] [Composer] - Initial global Memrize MCP wrapper for Cursor

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

if [ ! -x "$MEMRIZE_MCP" ]; then
  echo "[memrize-mcp] Binary missing — run: $MEMRIZE_REPO_ROOT/scripts/memrize/setup.sh" >&2
  exit 1
fi

export MEMRIZE_DB_PATH="$MEMRIZE_GLOBAL_DB"
export MEMRIZE_AGENT_ID="${MEMRIZE_AGENT_ID}-global"
exec "$MEMRIZE_MCP"
