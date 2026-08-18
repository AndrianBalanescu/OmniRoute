# OmniRoute — Homelab Operations (personal/stable only)

> **Fork-only document.** This file exists ONLY on the personal fork branch
> (`personal/stable`). It is NOT part of upstream OmniRoute and must never be
> pushed to `diegosouzapw/OmniRoute`. It documents the personal homelab
> dev/prod setup, the deploy flow, and the OOM-safe build guardrails.

## Host & Topology

- **Host**: Ubuntu Tailscale homelab (`homelab` / `100.70.158.21`), 28 GiB RAM.
- **Repo**: `/home/ubuntu/dev/OmniRoute` on branch `personal/stable` (fork
  `AndrianBalanescu/OmniRoute`). Upstream = `origin` (`diegosouzapw/OmniRoute`).
- **Two instances, isolated SQLite**:
  - **PROD**: Docker container `omniroute` (image `omniroute:homelab`) on
    `:20128` (`~/.omniroute`). Compose: `docker-compose.homelab.yml`.
  - **DEV**: Host dev server via `scripts/homelab/start-dev.sh` on `:20228`
    (`~/.omniroute-dev`). NEVER run `npm run dev` directly on `:20128` while
    Docker is running.

## The #1 Rule: NO host-side `npm run build` for production

The homelab has 28 GiB RAM but runs many memory-heavy services alongside
OmniRoute. A host-side `npm run build` is unsafe: Next/Turbopack/esbuild can
allocate several GiB **outside the V8 heap** and trigger a **global Linux OOM**
that takes down SSH, Docker, and unrelated services. This has happened
repeatedly (2026-08-11 incident: `npm run build` OOM-killed the dev server and
froze the host).

**Never** run `npm run build`, `npm run build:release`, or `docker compose build`
ad hoc on the homelab host for production. Use `scripts/homelab/safe-deploy.sh`.

## Deploy Flow (PROD)

```bash
# 1. Verify changes in host-dev sandbox (:20228)
./scripts/homelab/start-dev.sh

# 2. Run unit tests & checks
npm run check

# 3. Memory-safe build + deploy (stops dev server + heavy containers, builds
#    in a bounded cgroup, recreates, health-checks, restores services)
./scripts/homelab/safe-deploy.sh

# Dry-run the exact plan without changing services
./scripts/homelab/safe-deploy.sh --dry-run
```

### What `safe-deploy.sh` does (mandatory guardrails)

1. **Single-instance lock** — prevents concurrent deploys.
2. **Stops the host DEV server** on `:20228` (only verified node/npm/next-server
   processes; refuses to kill anything unexpected).
3. **Temporarily stops high-memory containers** (`ai-embeddings`, `ai-whisper`,
   `voiceink-tts-*`) to reclaim RAM, then **restarts exactly those** on every
   exit path (trap).
4. **Memory preflight gate** — aborts if < 6 GiB host RAM available after
   cleanup.
5. **Bounded Docker build** — `docker compose build --memory 16g` with
   `OMNIROUTE_BUILD_MEMORY_MB=8192` (V8 heap) and `OMNIROUTE_USE_TURBOPACK=0`
   (webpack; Turbopack native/Rust memory is outside the V8 heap limit).
6. **Rollback tag** — retains `omniroute:homelab-pre-deploy-<timestamp>`.
7. **Recreate + health check** — `up -d --force-recreate --no-build`, waits for
   `/api/health/ping`, verifies `0.0.0.0:20128` binding and the Tailscale
   address before reporting success.

### Env overrides

| Var                                  | Default                                   | Meaning                                |
| ------------------------------------ | ----------------------------------------- | -------------------------------------- |
| `OMNIROUTE_DEPLOY_BUILD_MEMORY`      | `16g`                                     | Docker build cgroup memory             |
| `OMNIROUTE_DEPLOY_BUILD_MEMORY_SWAP` | `16g`                                     | memory+swap ceiling                    |
| `OMNIROUTE_DEPLOY_BUILD_HEAP_MB`     | `8192`                                    | Node V8 heap for build                 |
| `OMNIROUTE_DEPLOY_USE_TURBOPACK`     | `0`                                       | webpack (safe) vs turbopack            |
| `OMNIROUTE_DEPLOY_PULL`              | `0`                                       | pull base image (avoid unless needed)  |
| `OMNIROUTE_DEPLOY_MIN_AVAILABLE_MB`  | `6144`                                    | min host RAM before build              |
| `OMNIROUTE_DEPLOY_HEAVY_CONTAINERS`  | `ai-embeddings ai-whisper voiceink-tts-*` | containers paused during build         |
| `OMNIROUTE_DEPLOY_KEEP_HEAVY`        | `0`                                       | set `1` to skip pausing heavy services |

## Dev Flow

```bash
# Start host-dev server on :20228 (isolated ~/.omniroute-dev DB)
./scripts/homelab/start-dev.sh

# Copy PROD DB snapshot into DEV so providers/combos/models match production
cp ~/.omniroute/storage.sqlite ~/.omniroute-dev/storage.sqlite
rm -f ~/.omniroute-dev/storage.sqlite-shm ~/.omniroute-dev/storage.sqlite-wal
```

- DEV uses `~/.omniroute-dev` (never shares SQLite with PROD).
- To test with the same providers/combos as production, copy the PROD DB into
  DEV (above) before starting the dev server.
- Turbopack inotify limit: `sudo sysctl fs.inotify.max_user_watches=524288`.

## VoiceArena Local Audio Providers (STT / TTS)

OmniRoute registers four local audio providers backed by VoiceArena containers on this homelab:

| Provider / Endpoint            | OmniRoute Model                 | Upstream Service    | Container / Port             | Wire Format                 |
| ------------------------------ | ------------------------------- | ------------------- | ---------------------------- | --------------------------- |
| STT `/v1/audio/transcriptions` | `whisper/whisper`               | Whisper STT Wrapper | `whisper:8086/v1/transcribe` | Multipart (field `audio`)   |
| TTS `/v1/audio/speech`         | `kokoro/kokoro`                 | Kokoro ONNX         | `kokoro:8085/v1/tts`         | JSON `{text, reference_id}` |
| TTS `/v1/audio/speech`         | `piper/piper`                   | Piper TTS           | `piper:8089/v1/tts`          | JSON `{text, reference_id}` |
| TTS `/v1/audio/speech`         | `inflect/micro`, `inflect/nano` | Inflect TTS         | `inflect:8091/v1/tts`        | JSON `{text, model, speed}` |

### Networking & Configuration

- **Production (Docker `:20128`)**: OmniRoute connects to the `voiceink-tts_default` network declared as `voicearena` in `docker-compose.homelab.yml`. Upstream URLs use container aliases (`http://whisper:8086/v1/transcribe`, `http://kokoro:8085/v1/tts`, `http://piper:8089/v1/tts`, `http://inflect:8091/v1/tts`).
- **Development (Host `:20228`)**: Defaults to `http://localhost:8086/...` (and ports `8085`, `8089`, `8091`) directly on loopback without extra configuration.
- **Overrides**: Configurable via `OMNIROUTE_VOICEARENA_WHISPER_URL`, `OMNIROUTE_VOICEARENA_KOKORO_URL`, `OMNIROUTE_VOICEARENA_PIPER_URL`, `OMNIROUTE_VOICEARENA_INFLECT_URL`.

## Production runtime limits (current, 2026-08-12)

- `mem_limit: 16g`, `memswap_limit: 18g`, `OMNIROUTE_MEMORY_MB: 4096` in
  `docker-compose.homelab.yml`.
- **Why 16g and not lower**: the `resource_pressure` 503 guard
  (`open-sse/utils/resourcePressure.ts`) counts **cgroup page cache** in its
  ratio, not just real anon memory. At `5g` the 92% trip point (4.6 GiB) was
  reachable purely from page cache on big-context loads, so a barely-used
  instance still shed traffic (`503 resource_pressure`). `docker stats`
  excludes cache and **lies** about the guard's view. Raise the cgroup ceiling
  (16g) instead of fighting cache; the guard stays as a runaway firewall
  (92% of 16g = ~14.7 GiB — practically unreachable).
- Heap: `OMNIROUTE_MEMORY_MB=4096` → V8 `heap_size_limit` ~4.3 GiB →
  auto-calibrated `HEAP_PRESSURE_THRESHOLD_MB` ~3.7 GiB. The running server
  PID's `NODE_OPTIONS` ends with `--max-old-space-size=4096`; a fresh
  `node -e` probe shows the image default (1024) — that is NOT the server heap.
- Do not shrink these without re-reading `resourcePressurePolicy.ts`
  (thresholds are hardcoded defaults: high 0.85 / critical 0.92 / PSI 40).

## Sync / Update Flow (upstream → personal)

When `personal/stable` drifts behind upstream, prefer **cherry-pick onto a
clean worktree** over merge-into-personal (merge produces 25+ conflicts on
AGENTS.md, CLAUDE.md, package-lock.json, deleted files). See
`.agents/skills/omniroute/SKILL.md` → "Fork Sync: Cherry-Pick Workflow".

## Rollback

If a deploy fails health verification, `safe-deploy.sh` auto-rolls back to the
retained `omniroute:homelab-pre-deploy-<timestamp>` tag. Manual rollback:

```bash
docker tag omniroute:homelab-pre-deploy-<timestamp> omniroute:homelab
docker compose -f docker-compose.homelab.yml up -d --force-recreate --no-build
```

## Port binding pitfall

`docker-compose.homelab.yml` port mappings MUST be `0.0.0.0:20128:20128` (etc),
NOT `127.0.0.1:...`. A recreate applies the file; loopback binding silently
drops external/LAN/Tailscale access while localhost `/api/health/ping` still
returns ok. After ANY recreate verify `ss -tlnp | grep :20128` shows `0.0.0.0`
AND `curl http://100.70.158.21:20128/api/health/ping` succeeds.
