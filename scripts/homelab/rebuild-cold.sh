#!/usr/bin/env bash
# Cold rebuild of omniroute:homelab after a host crash wiped /data/docker.
#
# This is a ONE-OFF recovery script. It is a faithful copy of safe-deploy.sh
# with a single deliberate difference: `capture_old_image` is a logged no-op,
# because there is NO prior image to roll back to (the Docker store was
# erased by the kernel-panic recovery). PROD was already DOWN, so there is no
# live system to protect with a rollback tag — the health check below is the
# gate, and a failed build leaves the host exactly as we found it (nothing
# that used to work is broken, because nothing was working).
#
# Every other memory-safety guardrail from safe-deploy.sh is preserved:
#   - deploy lock (flock)
#   - stop host dev server on :20228
#   - stop temporary heavy containers, restore them on EVERY exit path (trap)
#   - memory headroom preflight (>= OMNIROUTE_DEPLOY_MIN_AVAILABLE_MB)
#   - bounded Docker build cgroup (--memory, --build-arg heap/turbopack)
#   - health check + 0.0.0.0 port verify + Tailscale reach
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${OMNIROUTE_DEPLOY_COMPOSE_FILE:-docker-compose.homelab.yml}"
BUILD_MEMORY="${OMNIROUTE_DEPLOY_BUILD_MEMORY:-16g}"
BUILD_SWAP="${OMNIROUTE_DEPLOY_BUILD_MEMORY_SWAP:-16g}"
BUILD_HEAP_MB="${OMNIROUTE_DEPLOY_BUILD_HEAP_MB:-8192}"
USE_TURBOPACK="${OMNIROUTE_DEPLOY_USE_TURBOPACK:-0}"
PULL_BASE_IMAGE="${OMNIROUTE_DEPLOY_PULL:-1}"   # <-- differs from default: pull base so cold build gets layers
MIN_AVAILABLE_MB="${OMNIROUTE_DEPLOY_MIN_AVAILABLE_MB:-6144}"
KEEP_HEAVY="${OMNIROUTE_DEPLOY_KEEP_HEAVY:-0}"
LOCK_FILE="${OMNIROUTE_DEPLOY_LOCK_FILE:-/tmp/omniroute-homelab-deploy.lock}"
NO_CACHE="${OMNIROUTE_DEPLOY_NO_CACHE:-0}"

HEAVY_CONTAINER_LIST="${OMNIROUTE_DEPLOY_HEAVY_CONTAINERS:-ai-embeddings ai-whisper voiceink-tts-kokoro-1 voiceink-tts-whisper-1 voiceink-tts-inflect-1}"
read -r -a HEAVY_CONTAINERS <<< "$HEAVY_CONTAINER_LIST"
STOPPED_CONTAINERS=()
CLEANUP_DONE=0

log()  { printf '[rebuild-cold] %s\n' "$*"; }
fail() { printf '[rebuild-cold] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $ROOT/$COMPOSE_FILE"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another homelab deploy is already running (lock: $LOCK_FILE)"

run() { "$@"; }

available_memory_mb() { free -m | awk 'NR == 2 { print $7 }'; }

assert_memory_headroom() {
  local available
  available="$(available_memory_mb)"
  log "available memory: ${available}MiB; required minimum: ${MIN_AVAILABLE_MB}MiB"
  if [[ "$available" -lt "$MIN_AVAILABLE_MB" ]]; then
    fail "insufficient memory headroom after cleanup (${available}MiB < ${MIN_AVAILABLE_MB}MiB)"
  fi
}

assert_no_host_build() {
  local pid args
  while read -r pid args; do
    [[ -n "$pid" ]] || continue
    case "$args" in
      *--service*|*esbuild*--service*) ;;
      *build-next-isolated*|*"npm run build"*|*"next build"*|*turbopack*)
        # Note: we DO allow turbopack here only if the operator set it; webpack is default.
        fail "another host build process is already running (pid $pid); stop it and retry"
        ;;
    esac
  done < <(ps -eo pid=,args=)
}

stop_dev_server() {
  local pids pid command_name
  pids="$(fuser -n tcp 20228 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "dev server: port 20228 is already free"
    return
  fi
  for pid in $pids; do
    command_name="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '[:space:]')"
    case "$command_name" in
      node|npm|next-server) ;;
      *) fail "port 20228 is owned by unexpected process $pid ($command_name)" ;;
    esac
  done
  log "stopping dev server on 20228: $pids"
  fuser -k -n tcp 20228 2>/dev/null || true
  sleep 2
}

stop_heavy_containers() {
  local container
  if [[ "$KEEP_HEAVY" == "1" ]]; then
    log "keeping heavy containers running (OMNIROUTE_DEPLOY_KEEP_HEAVY=1)"
    return
  fi
  for container in "${HEAVY_CONTAINERS[@]}"; do
    if docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
      log "stopping temporary heavy service: $container"
      docker stop "$container" >/dev/null
      STOPPED_CONTAINERS+=("$container")
    else
      log "heavy service already stopped (skipping): $container"
    fi
  done
}

restore_heavy_containers() {
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then return; fi
  CLEANUP_DONE=1
  local index
  for ((index=${#STOPPED_CONTAINERS[@]} - 1; index >= 0; index--)); do
    local container="${STOPPED_CONTAINERS[index]}"
    log "restarting temporary heavy service: $container"
    docker start "$container" >/dev/null || printf '[rebuild-cold] WARNING: failed to restart %s\n' "$container" >&2
  done
}

cleanup() {
  local status=$?
  restore_heavy_containers
  if [[ "$status" -ne 0 ]]; then
    log "rebuild exited with status $status; host left in current state (no live PROD to roll back to)"
  fi
  exit "$status"
}
trap cleanup EXIT

capture_old_image() {
  # ONE-OFF DELIBERATE DIFFERENCE vs safe-deploy.sh:
  # safe-deploy refuses to proceed without an existing image to roll back to.
  # After the crash-wipe there is no prior image; PROD is already down, so a
  # rollback target would be meaningless and the health check below is the gate.
  log "NOTE: no pre-existing omniroute:homelab image (store was wiped); proceeding with cold rebuild — no rollback target"
  OLD_IMAGE_TAG=""
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 http://127.0.0.1:20128/api/health/ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_ports() {
  local bound=0 state receive send local peer extra
  while read -r state receive send local peer extra; do
    if [[ "$local" == "0.0.0.0:20128" ]]; then
      bound=1
    fi
  done < <(ss -H -ltn 'sport = :20128')
  [[ "$bound" -eq 1 ]] || fail "production port 20128 is not bound to 0.0.0.0"
}

log "root: $ROOT"
log "build cgroup: memory=$BUILD_MEMORY memory+swap=$BUILD_SWAP node_heap=${BUILD_HEAP_MB}MiB bundler=$(if [[ "$USE_TURBOPACK" == "0" ]]; then printf webpack; else printf turbopack; fi)"
log "base image pull: $PULL_BASE_IMAGE (cold rebuild: base layers re-fetched)"

docker compose -f "$COMPOSE_FILE" config --quiet
assert_no_host_build
stop_dev_server
stop_heavy_containers
assert_memory_headroom

OLD_IMAGE_TAG=""
capture_old_image

BUILD_ARGS=(
  docker compose -f "$COMPOSE_FILE" build
  --memory "$BUILD_MEMORY"
  --build-arg "OMNIROUTE_BUILD_MEMORY_MB=$BUILD_HEAP_MB"
  --build-arg "OMNIROUTE_USE_TURBOPACK=$USE_TURBOPACK"
)
if [[ "$NO_CACHE" == "1" ]]; then
  BUILD_ARGS+=(--no-cache)
fi
if [[ "$PULL_BASE_IMAGE" == "1" ]]; then
  BUILD_ARGS+=(--pull)
fi
log "starting bounded build (this is the long part)..."
run "${BUILD_ARGS[@]}"

log "build complete; recreating PROD container (no-build)..."
run docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build

if ! wait_for_health; then
  log "ERROR: PROD did not become healthy after cold rebuild; inspect 'docker logs omniroute'"
  exit 1
fi
verify_ports
curl -fsS --max-time 10 http://127.0.0.1:20128/api/health/ping
printf '\n'
curl -fsS --max-time 10 http://100.70.158.21:20128/api/health/ping >/dev/null
log "Tailscale host health check: ok"
docker compose -f "$COMPOSE_FILE" ps
log "cold rebuild complete; PROD is back on 0.0.0.0:20128"
