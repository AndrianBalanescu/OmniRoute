#!/usr/bin/env bash
# @file mcp-project.sh
# @description Cursor MCP entrypoint — OmniRoute project memory (.memrize/memrize.db).
#
# @changes
# - [2026-07-27] [Composer] - Initial project-scoped Memrize MCP wrapper for Cursor

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

if [ ! -x "$MEMRIZE_MCP" ]; then
  echo "[memrize-mcp] Binary missing — run: $MEMRIZE_REPO_ROOT/scripts/memrize/setup.sh" >&2
  exit 1
fi

export MEMRIZE_DB_PATH
export MEMRIZE_AGENT_ID
exec "$MEMRIZE_MCP"
