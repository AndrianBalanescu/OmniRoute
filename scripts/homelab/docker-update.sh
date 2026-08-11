#!/usr/bin/env bash
# Compatibility entrypoint. The memory-safe deploy workflow is authoritative.
# Prefer testing on host-dev (:20228) first, then run this.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/scripts/homelab/safe-deploy.sh" "$@"
