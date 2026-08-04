#!/usr/bin/env bash
# @file setup.sh
# @description One-shot Memrize setup for OmniRoute: build CLI/MCP, bootstrap DB, seed facts.
#
# @changes
# - [2026-07-27] [Composer] - Initial OmniRoute Memrize environment bootstrap

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

MEMRIZE_SRC="${MEMRIZE_SRC:-$HOME/projects/memrize}"
BOOTSTRAP="$MEMRIZE_SRC/scripts/bootstrap-project.sh"

echo "==> Memrize setup for OmniRoute"
echo "    repo:  $MEMRIZE_REPO_ROOT"
echo "    project DB: $MEMRIZE_DB_PATH"
echo "    global DB:  $MEMRIZE_GLOBAL_DB"

# Build debug binaries (FTS forget fix; release catches up when PR #80 merges)
if [ -d "$MEMRIZE_SRC" ]; then
  echo "==> Building memrize-cli + memrize-mcp (debug)..."
  (cd "$MEMRIZE_SRC" && cargo build -p memrize-cli -p memrize-mcp -q)
else
  echo "WARN: memrize source not found at $MEMRIZE_SRC" >&2
fi

if [ ! -x "$MEMRIZE_CLI" ] || [ ! -x "$MEMRIZE_MCP" ]; then
  echo "ERROR: memrize binaries missing. Clone/build: $MEMRIZE_SRC" >&2
  exit 1
fi

# Global hub
if [ ! -f "$MEMRIZE_GLOBAL_DB" ]; then
  echo "==> Initializing global hub..."
  "$MEMRIZE_CLI" init --path "$MEMRIZE_GLOBAL_DB"
fi

# Project bootstrap
if [ -x "$BOOTSTRAP" ]; then
  MEMRIZE_CLI="$MEMRIZE_CLI" "$BOOTSTRAP" "$MEMRIZE_REPO_ROOT" --name OmniRoute
else
  mkdir -p "$(dirname "$MEMRIZE_DB_PATH")"
  if [ ! -f "$MEMRIZE_DB_PATH" ]; then
    "$MEMRIZE_CLI" init --path "$MEMRIZE_DB_PATH"
  fi
fi

# Remove stray cwd memrize.db (default CLI trap)
if [ -f "$MEMRIZE_REPO_ROOT/memrize.db" ]; then
  echo "==> Removing stray $MEMRIZE_REPO_ROOT/memrize.db (use .memrize/memrize.db)"
  rm -f "$MEMRIZE_REPO_ROOT/memrize.db" \
    "$MEMRIZE_REPO_ROOT/memrize.db-wal" \
    "$MEMRIZE_REPO_ROOT/memrize.db-shm"
fi

# Seed OmniRoute project facts (remember upserts active versions)
echo "==> Seeding OmniRoute project memory..."
seed() {
  local key="$1" value="$2" category="${3:-architecture}"
  "$MEMRIZE_CLI" --db "$MEMRIZE_DB_PATH" remember "$key" "$value" --category "$category" >/dev/null
  echo "    + $key"
}

seed "project_name" "OmniRoute — unified AI proxy/router (Next.js 16 + open-sse streaming engine)"
seed "default_port" "20128 — API + dashboard on same port"
seed "db_layer" "All persistence via src/lib/db/ domain modules — never raw SQL in routes; never add logic to localDb.ts"
seed "streaming_engine" "open-sse/ — handlers, executors, translators, combo routing (18 strategies)"
seed "test_runners" "Both required in CI: npm run test:unit (node:test) AND npm run test:vitest — non-overlapping suites"
seed "worktree_rule" "Never develop on shared main checkout — use .claude/worktrees/<task> per parallel session (Hard Rule #19)"
seed "memrize_integration" "Active 2026-07-27: project DB .memrize/memrize.db, global ~/.memrize/global.db, Cursor MCP via scripts/memrize/mcp-*.sh"
seed "quality_gates" "~48 check scripts in scripts/check/ — npm run check before PR; coverage ratchet in quality-baseline.json"
seed "resilience_layers" "3 mechanisms: provider circuit breaker, connection cooldown, model lockout — see docs/architecture/RESILIENCE_GUIDE.md"

# Pin project-specific invariant (Tier 0)
if ! "$MEMRIZE_CLI" --db "$MEMRIZE_DB_PATH" stats 2>/dev/null | grep -q "Rules (Tier 0): 0"; then
  :
else
  "$MEMRIZE_CLI" --db "$MEMRIZE_DB_PATH" pin \
    "When changing OmniRoute production code (src/, open-sse/, bin/), add or update tests in the same change — both test runners if touching overlapping surfaces." \
    >/dev/null 2>&1 || true
  echo "    + pinned rule (tests with prod changes)"
fi

chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true

echo ""
echo "==> Verify"
"$MEMRIZE_CLI" --db "$MEMRIZE_DB_PATH" stats 2>/dev/null | head -6
echo ""
"$MEMRIZE_CLI" --db "$MEMRIZE_GLOBAL_DB" health 2>/dev/null | head -8
echo ""
echo "Done. Next steps:"
echo "  1. Reload Cursor window (Cmd+Shift+P → Developer: Reload Window) to pick up .cursor/mcp.json"
echo "  2. Enable MCP servers: memrize-omniroute + memrize-global"
echo "  3. Session context: $SCRIPT_DIR/context.sh"
echo "  4. Report bugs:     $SCRIPT_DIR/report-error.sh <type> \"<title>\""
