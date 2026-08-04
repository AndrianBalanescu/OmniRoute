# @file env.sh
# @description Memrize environment for OmniRoute — source from shell or MCP wrappers.

# Resolve repo root (works when sourced from scripts/memrize/)
if [ -z "${MEMRIZE_REPO_ROOT:-}" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    MEMRIZE_REPO_ROOT="$(git rev-parse --show-toplevel)"
  else
    MEMRIZE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
  fi
fi

export MEMRIZE_REPO_ROOT
export MEMRIZE_PROJECT_DIR="${MEMRIZE_PROJECT_DIR:-$MEMRIZE_REPO_ROOT}"
export MEMRIZE_GLOBAL_DB="${MEMRIZE_GLOBAL_DB:-$HOME/.memrize/global.db}"
export MEMRIZE_DB_PATH="${MEMRIZE_DB_PATH:-$MEMRIZE_REPO_ROOT/.memrize/memrize.db}"
export MEMRIZE_AGENT_ID="${MEMRIZE_AGENT_ID:-omniroute-cursor}"

# Resolve binary paths (check PATH/installed binaries first)
DEFAULT_CLI="$(command -v memrize 2>/dev/null || echo "$HOME/.local/bin/memrize")"
DEFAULT_MCP="$(command -v memrize-mcp 2>/dev/null || echo "$HOME/.local/bin/memrize-mcp")"

if [ ! -x "$DEFAULT_CLI" ] && [ -x "$HOME/projects/memrize/target/debug/memrize" ]; then
  DEFAULT_CLI="$HOME/projects/memrize/target/debug/memrize"
fi

if [ ! -x "$DEFAULT_MCP" ] && [ -x "$HOME/projects/memrize/target/debug/memrize-mcp" ]; then
  DEFAULT_MCP="$HOME/projects/memrize/target/debug/memrize-mcp"
fi

export MEMRIZE_CLI="${MEMRIZE_CLI:-$DEFAULT_CLI}"
export MEMRIZE_MCP="${MEMRIZE_MCP:-$DEFAULT_MCP}"

export MEMRIZE_GLOBAL_TOKENS="${MEMRIZE_GLOBAL_TOKENS:-1200}"
export MEMRIZE_PROJECT_TOKENS="${MEMRIZE_PROJECT_TOKENS:-800}"
