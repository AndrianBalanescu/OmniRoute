# OmniRoute vs GoFlow — Competitive Position & Performance Analysis

## Executive Summary

OmniRoute has a **built-in, production feature** called Reasoning Replay Cache (introduced v3.8.40, June 2026) that handles the DeepSeek/Kimi/Xiaomi 400 error for thinking-mode models. GoFlow is a **future spec only** — a multimodal VRAM orchestrator with zero-DB routing and JIT GPU memory management, not yet built.

## Feature Comparison Matrix

| Dimension                      | OmniRoute                                                                                                                                                  | GoFlow (Spec)                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Status**                     | ✅ Production feature (v3.8.40+)                                                                                                                           | ⚠️ Future spec only                                             |
| **What it solves**             | Reasoning_content replay for thinking-mode models (DeepSeek V4, Kimi K2, Qwen-Thinking, MiMo)                                                              | Dynamic VRAM allocation for local+cloud multimodal agent stacks |
| **Primary provider**           | OmniRoute (207+ providers, 15 combo strategies)                                                                                                            | GoFlow (future)                                                 |
| **Core engine**                | open-sse/handlers/chatCore.ts (write), open-sse/translator/index.ts (read)                                                                                 | /v1/chat/completions + 4 multimodal routes (future)             |
| **Storage**                    | Hybrid: in-memory Map (2000 max) + SQLite (`src/lib/db/reasoningCache.ts`, migration 033)                                                                  | Zero-DB hot-path router (future)                                |
| **Persistence**                | Process crash recovery; dashboard visibility; TTL 2h, `expires_at` index                                                                                   | Process crash recovery implied; JIT eviction                    |
| **Detection logic**            | `requiresReasoningReplay()` in `open-sse/services/reasoningCache.ts` — 10 providers + 10 model patterns                                                    | VRAM service manifest + priority LRU eviction                   |
| **Providers requiring replay** | 10 providers: deepseek, opencode-go, siliconflow, nebius, deepinfra, sambanova, fireworks, together, kimi-coding, kimi-coding-apikey, xiaomi-mimo          | Future; likely all LLM providers with thinking mode             |
| **REST API**                   | Yes — introspection endpoint at `src/app/api/monitoring/health/route.ts` (per REASONING_REPLAY.md §REST API)                                               | No (future)                                                     |
| **Test suite**                 | `tests/unit/service-reasoning-cache.test.ts` + `chatCore-reasoning-cache-guard.test.ts` + `reasoning-cache.test.ts` + `reasoning-cache-truncation.test.ts` | N/A (not built)                                                 |
| **Issue trace**                | #1628                                                                                                                                                      | Not yet assigned                                                |
| **Key technical challenges**   | DB dependency per request; reasoning injection on every turn                                                                                               | GPU resource coordination; Docker lifecycle; NVML monitoring    |
| **Deployment**                 | Always-on :20128                                                                                                                                           | TBD                                                             |
| **Architecture**               | Combo routing + RTK/Caveman compression + circuit breakers                                                                                                 | VRAM orchestrator + priority LRU + idle reaper                  |
| **Competitive alternatives**   | LiteLLM (routing), OpenRouter (aggregation)                                                                                                                | None yet (GoFlow is the only contender in this spec)            |

## Performance Bottlenecks (OmniRoute)

### 1. Combo Resolution Overhead

- 19 public strategies (priority, weighted, fill-first, round-robin, etc.)
- Each target calls `handleSingleModel()` wrapped with circuit breaker checks
- Fusion strategy fans out to a panel of models in parallel then a judge synthesizes
- **Impact**: 15-factor scoring + per-target error handling adds latency on multi-provider paths

### 2. Compression Pipeline Depth

- RTK (rate-based token compression) + Caveman (length-based) + hardBudget-change-detection
- `jsonSha256` streams exact JSON bytes into crypto hash — no string materialization
- `codexResponses` uses `countCodexTokensForBody()` which avoids stringify for `MAX_EXACT_TOKEN_COUNT_CHARS`
- **Impact**: Token accounting overhead on every request

### 3. Database Dependency Per Request

- Every request goes through `src/lib/db/` domain modules
- Reasoning cache DB write on every DeepSeek V4 turn: `INSERT OR REPLACE` into `reasoning_cache` table
- Translation, executor, and cache all touch DB layers
- **Impact**: Slower than pure-combo path; potential deadlock on concurrent reads/writes

## Reasoning Replay — Detailed Analysis

### How It Works

```
Turn N (assistant generates):
  → response contains reasoning_content + tool_calls
  → if requiresReasoningReplay(provider, model): cacheReasoningFromAssistantMessage()
      writes (memory + DB), keyed by every tool_call.id
  → forward response to client

Turn N+1 (client sends follow-up):
  → translator detects: requiresReasoningReplay(provider, model) === true
  → for each assistant message with tool_calls and no reasoning_content:
      lookupReasoning(toolCalls[0].id) → memory → DB
      hit  → msg.reasoning_content = cached; recordReplay()
      miss → msg.reasoning_content = "" (legacy fallback)
  → upstream sees consistent history → no 400
```

### Key Files

| File                                                       | Role                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db/reasoningCache.ts`                             | SQLite domain module for persistence                                                                                  |
| `open-sse/services/reasoningCache.ts`                      | Service layer: `requiresReasoningReplay()`, `cacheReasoning()`, `cacheReasoningFromAssistantMessage()`, in-memory Map |
| `open-sse/handlers/chatCore.ts`                            | Write path — lines ~5073 and ~5598 inject cache capture                                                               |
| `src/lib/db/reasoningCache.ts`                             | DB layer with `setReasoningCache()`, `getReasoningCache()`, `lookupReasoning()`, `cleanupExpiredReasoning()`          |
| `src/lib/db/migrations/033_create_reasoning_cache.sql`     | Table schema                                                                                                          |
| `tests/unit/service-reasoning-cache.test.ts`               | Test coverage                                                                                                         |
| `tests/unit/chatCore-reasoning-cache-guard.test.ts`        | Guardrail test                                                                                                        |
| `tests/unit/reasoning-cache.test.ts`                       | In-memory cache tests                                                                                                 |
| `tests/unit/reasoning-cache-truncation.test.ts`            | TTL truncation tests                                                                                                  |
| `src/lib/streamingPiiTransform.ts:215`                     | SSE delta reasoning_content handling                                                                                  |
| `src/lib/guardrails/visionBridgeHelpers.ts:537-586`        | VisionBridge reasoning aggregation                                                                                    |
| `src/open-sse/transformer/responsesTransformer.ts:124-140` | ReasoningTokenDetails extraction                                                                                      |

### Why It Exists

Several thinking-mode providers reject a follow-up turn unless the **previous assistant message includes the original `reasoning_content`**. Clients (Cursor, Cline, Roo Code) strip it from history. OmniRoute restores it from a server-side cache so the upstream sees consistent history.

### Storage Architecture

- **Hot path**: In-memory `Map` (LRU-by-creation), 2000 max entries, 2h TTL, oldest-first eviction
- **Cold path**: SQLite table `reasoning_cache` with `expires_at`, `provider`, `model`, `created_at`, `char_count` indexes
- Writes go to both; reads consult memory first, fall back to DB (DB hits promoted back into memory)
- DB failures are non-fatal — in-memory cache continues to serve hot path

### Provider/Model Detection

**10 explicit providers**: deepseek, opencode-go, siliconflow, nebius, deepinfra, sambanova, fireworks, together, kimi-coding, kimi-coding-apikey, xiaomi-mimo

**10 model patterns**: deepseek-r1, deepseek-reasoner, deepseek-chat, deepseek-v4 variants, zen/deepseek-v4, kimi-kN, qwen.*think, glm.*think, ^mimo[-.]?v\d

**Special case**: DeepSeek V4 with `thinkingEnabled: true` → auto-detects via `isDeepSeekReasoningModel()`

### Key Design Decisions

1. **Non-critical error handling**: Cache capture is wrapped in `try/catch` — never blocks the response
2. **Legacy fallback**: When lookup misses, returns empty string instead of throwing
3. **`x-omniroute-strip-reasoning` header**: Unconditionally drops `reasoning_content` from final JSON for Firecrawl AI SDK clients
4. **REST API**: Exposes introspection endpoint for monitoring dashboards

## Comparison with GoFlow

### OmniRoute's Advantages

1. **Production feature** vs. GoFlow spec-only
2. **Shorter time-to-market** — 207+ providers, 15 strategies, circuit breakers, MCP/A2A integration all built-in
3. **Real-world deployment** — running on :20128 with actual client traffic
4. **More mature**: RTK/Caveman compression, reasoning replay, vision bridge, agent protocols, cloud agents

### GoFlow's Potential Differentiators (Once Built)

1. **Zero-DB hot-path router** — eliminates DB dependency on every request path (key perf win)
2. **Priority LRU eviction** — JIT GPU memory management for local+cloud multimodal stacks
3. **Idle reaper watchdog** — background ticker (15s) reclaims VRAM for burst traffic
4. **NVML/nvidia-smi** — native GPU VRAM monitoring
5. **Docker/process lifecycle** — mount/unmount/pause for service management
6. **Multimodal unified endpoint** — single gateway for chat + audio + embeddings + STT + TTS

### GoFlow's Limitations

1. **No reasoning replay** — not yet in spec
2. **No combo strategies** — no 15-factor auto-routing
3. **No circuit breakers** — no resilience layer
4. **No MCP/A2A** — not specified
5. **No compression pipeline** — token accounting not covered
6. **No memory system** — FTS5 + Qdrant not specified
7. **No guardrails/vision bridge** — not specified
8. **No dashboard** — no observability layer

## Recommendations

1. **Prioritize reasoning replay** as a known production feature, not speculation
2. **Consider GoFlow's zero-DB routing** as a future optimization if built
3. **Monitor the reasoning cache** for TTL expiration and DB write failures
4. **Evaluate `x-omniroute-strip-reasoning`** as a potential opt-in header for strict clients
5. **Document the reasoning replay contract** more thoroughly in the README

## Sources

- `docs/routing/REASONING_REPLAY.md`
- `src/lib/db/reasoningCache.ts`
- `open-sse/services/reasoningCache.ts`
- `open-sse/handlers/chatCore.ts` (lines ~5073, ~5598)
- `tests/unit/service-reasoning-cache.test.ts`
- `_tasks/superpowers/specs/2026-09-01-goflow-vram-multimodal-spec.md`
- `src/lib/db/migrations/033_create_reasoning_cache.sql`
