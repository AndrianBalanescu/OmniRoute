#!/usr/bin/env bash
# @file context.sh
# @description Print layered Memrize context (global + OmniRoute project) for session start.
#
# @changes
# - [2026-07-27] [Composer] - OmniRoute wrapper around memrize-context.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

export MEMRIZE_CLI MEMRIZE_GLOBAL_DB MEMRIZE_PROJECT_DIR MEMRIZE_GLOBAL_TOKENS MEMRIZE_PROJECT_TOKENS

CONTEXT_SCRIPT="$HOME/projects/memrize/scripts/memrize-context.sh"
if [ -x "$CONTEXT_SCRIPT" ]; then
  exec "$CONTEXT_SCRIPT"
fi

if [ -f "$MEMRIZE_GLOBAL_DB" ]; then
  echo "## Memrize — Global"
  "$MEMRIZE_CLI" --db "$MEMRIZE_GLOBAL_DB" context --tokens "$MEMRIZE_GLOBAL_TOKENS" 2>/dev/null || true
  echo
fi

if [ -f "$MEMRIZE_DB_PATH" ]; then
  echo "## Memrize — Project (OmniRoute)"
  "$MEMRIZE_CLI" --db "$MEMRIZE_DB_PATH" context --tokens "$MEMRIZE_PROJECT_TOKENS" 2>/dev/null || true
fi
