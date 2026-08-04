#!/usr/bin/env bash
# @file report-error.sh
# @description Record OmniRoute failures into project Memrize DB for Achiles self-healing.
#
# @changes
# - [2026-07-27] [Composer] - OmniRoute wrapper for memrize failure reporting

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

export MEMRIZE_CLI MEMRIZE_PROJECT_DIR

REPORT_SCRIPT="$HOME/projects/memrize/scripts/report-error.sh"
if [ -x "$REPORT_SCRIPT" ]; then
  exec "$REPORT_SCRIPT" "$@"
fi

echo "report-error: memrize scripts not found at $REPORT_SCRIPT" >&2
exit 1
