#!/usr/bin/env bash
# Memory-safe build and deploy for the homelab Docker instance.
#
# This is the only supported production update path on homelab. It keeps the
# existing container serving traffic while the image builds in a bounded Docker
# build cgroup, and restores temporary service stops on every exit path.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${OMNIROUTE_DEPLOY_COMPOSE_FILE:-docker-compose.homelab.yml}"
BUILD_MEMORY="${OMNIROUTE_DEPLOY_BUILD_MEMORY:-16g}"
BUILD_SWAP="${OMNIROUTE_DEPLOY_BUILD_MEMORY_SWAP:-16g}"
BUILD_HEAP_MB="${OMNIROUTE_DEPLOY_BUILD_HEAP_MB:-8192}"
USE_TURBOPACK="${OMNIROUTE_DEPLOY_USE_TURBOPACK:-0}"
PULL_BASE_IMAGE="${OMNIROUTE_DEPLOY_PULL:-0}"
MIN_AVAILABLE_MB="${OMNIROUTE_DEPLOY_MIN_AVAILABLE_MB:-6144}"
KEEP_HEAVY="${OMNIROUTE_DEPLOY_KEEP_HEAVY:-0}"
DRY_RUN=0
LOCK_FILE="${OMNIROUTE_DEPLOY_LOCK_FILE:-/tmp/omniroute-homelab-deploy.lock}"

# These are the known high-memory homelab services. Only containers that were
# already running are stopped, and only those are started again in cleanup.
HEAVY_CONTAINER_LIST="${OMNIROUTE_DEPLOY_HEAVY_CONTAINERS:-ai-embeddings ai-whisper voiceink-tts-kokoro-1 voiceink-tts-whisper-1 voiceink-tts-inflect-1}"
read -r -a HEAVY_CONTAINERS <<< "$HEAVY_CONTAINER_LIST"
STOPPED_CONTAINERS=()
CLEANUP_DONE=0

log() {
  printf '[safe-deploy] %s\n' "$*"
}

fail() {
  printf '[safe-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/homelab/safe-deploy.sh [--dry-run] [--keep-heavy]

Builds and deploys omniroute:homelab without running a host-side npm build.

Environment overrides:
  OMNIROUTE_DEPLOY_BUILD_MEMORY=8g
  OMNIROUTE_DEPLOY_BUILD_MEMORY_SWAP=8g
  OMNIROUTE_DEPLOY_BUILD_HEAP_MB=4096
  OMNIROUTE_DEPLOY_USE_TURBOPACK=0
  OMNIROUTE_DEPLOY_PULL=0
  OMNIROUTE_DEPLOY_MIN_AVAILABLE_MB=8192
  OMNIROUTE_DEPLOY_HEAVY_CONTAINERS="ai-embeddings ai-whisper ..."
  OMNIROUTE_DEPLOY_KEEP_HEAVY=1
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --keep-heavy) KEEP_HEAVY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

if [[ ! -f "$COMPOSE_FILE" ]]; then
  fail "compose file not found: $ROOT/$COMPOSE_FILE"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  fail "another homelab deploy is already running (lock: $LOCK_FILE)"
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[safe-deploy] DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

available_memory_mb() {
  free -m | awk 'NR == 2 { print $7 }'
}

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
      *build-next-isolated*|*"npm run build"*|*"npm run build:release"*|*"next build"*|*turbopack*)
        fail "another host build process is already running (pid $pid); stop it and retry"
        ;;
    esac
  done < <(ps -eo pid=,args=)
}

stop_dev_server() {
  local pids pid command_name remaining
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
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "dry-run: would send SIGTERM to verified dev-server processes: $pids"
    return
  fi
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for _ in $(seq 1 30); do
    remaining=0
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining=1
      fi
    done
    [[ "$remaining" -eq 0 ]] && return
    sleep 1
done

  log "dev server did not exit after 30s; sending SIGKILL to the verified processes"
  for pid in $pids; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

stop_heavy_containers() {
  if [[ "$KEEP_HEAVY" == "1" ]]; then
    log "heavy-service stop disabled by --keep-heavy / OMNIROUTE_DEPLOY_KEEP_HEAVY"
    return
  fi

  for container in "${HEAVY_CONTAINERS[@]}"; do
    [[ -n "$container" ]] || continue
    local running
    running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
    if [[ "$running" == "true" ]]; then
      STOPPED_CONTAINERS+=("$container")
      log "stopping temporary heavy service: $container"
      run docker stop --timeout 20 "$container"
    fi
  done
}

restore_heavy_containers() {
  [[ "$CLEANUP_DONE" -eq 0 ]] || return
  CLEANUP_DONE=1

  if [[ "$DRY_RUN" -eq 1 || "$KEEP_HEAVY" == "1" ]]; then
    return
  fi

  for ((index=${#STOPPED_CONTAINERS[@]} - 1; index >= 0; index--)); do
    local container="${STOPPED_CONTAINERS[index]}"
    log "restarting temporary heavy service: $container"
    docker start "$container" >/dev/null ||
      printf '[safe-deploy] WARNING: failed to restart %s\n' "$container" >&2
  done
}

cleanup() {
  local status=$?
  restore_heavy_containers
  if [[ "$status" -ne 0 ]]; then
    log "deploy exited with status $status; production container was not intentionally replaced unless health verification had already started"
  fi
  exit "$status"
}
trap cleanup EXIT

capture_old_image() {
  local image_id backup_tag
  image_id="$(docker image inspect omniroute:homelab -f '{{.Id}}' 2>/dev/null || true)"
  [[ -n "$image_id" ]] || fail "existing omniroute:homelab image not found; refusing deploy without rollback image"
  backup_tag="omniroute:homelab-pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
  log "saving rollback image: $backup_tag ($image_id)"
  run docker tag omniroute:homelab "$backup_tag"
  OLD_IMAGE_TAG="$backup_tag"
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

rollback_and_fail() {
  local backup_tag="$1"
  printf '[safe-deploy] ERROR: production health check failed; rolling back to %s\n' "$backup_tag" >&2
  if [[ "$DRY_RUN" -eq 0 ]]; then
    docker tag "$backup_tag" omniroute:homelab
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build
    wait_for_health || printf '[safe-deploy] ERROR: rollback health check also failed\n' >&2
  fi
  exit 1
}

log "root: $ROOT"
log "build cgroup: memory=$BUILD_MEMORY memory+swap=$BUILD_SWAP node_heap=${BUILD_HEAP_MB}MiB bundler=$(if [[ "$USE_TURBOPACK" == "0" ]]; then printf webpack; else printf turbopack; fi)"
log "base image pull: $PULL_BASE_IMAGE"

if [[ "$DRY_RUN" -eq 0 ]]; then
  docker compose -f "$COMPOSE_FILE" config --quiet
  assert_no_host_build
  stop_dev_server
  stop_heavy_containers
  assert_memory_headroom
else
  log "dry-run: would stop the dev server, temporary heavy containers, build, recreate, health-check, and restore services"
fi

OLD_IMAGE_TAG=""
capture_old_image

BUILD_ARGS=(
  docker compose -f "$COMPOSE_FILE" build
  --memory "$BUILD_MEMORY"
  --build-arg "OMNIROUTE_BUILD_MEMORY_MB=$BUILD_HEAP_MB"
  --build-arg "OMNIROUTE_USE_TURBOPACK=$USE_TURBOPACK"
)
if [[ "$PULL_BASE_IMAGE" == "1" ]]; then
  BUILD_ARGS+=(--pull)
fi
run "${BUILD_ARGS[@]}"

run docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build
if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! wait_for_health; then
    rollback_and_fail "$OLD_IMAGE_TAG"
  fi
  verify_ports
  curl -fsS --max-time 10 http://127.0.0.1:20128/api/health/ping
  printf '\n'
  curl -fsS --max-time 10 http://100.70.158.21:20128/api/health/ping >/dev/null
  log "Tailscale host health check: ok"
  docker compose -f "$COMPOSE_FILE" ps
fi

log "deploy completed; rollback image retained as $OLD_IMAGE_TAG"
