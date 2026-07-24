---
name: omniroute-dev
description: "OmniRoute development patterns — dev server, build, DB, code paths, startup sequence"
tags: [omniroute, dev, development, nextjs, typescript]
related_skills: [omniroute-qa, omniroute-ops]
---

# OmniRoute Development

## Quick Start

```bash
cd /Users/flowmaster/OmniRoute
npm ci                    # install deps
npm run dev               # start Next.js dev server on port 20128
```

Server starts on http://localhost:20128

## Architecture (verified from source + startup logs)

- **Runtime**: Next.js 15 (turbopack) + TypeScript + Node 22-24
- **Database**: SQLite (better-sqlite3) at `~/.omniroute/storage.sqlite`
- **Data dir**: `~/.omniroute/` (created on first run, not `./data/`)
- **Entry**: `scripts/dev/run-next.mjs` → Next.js app in `src/`
- **Port**: 20128 (main), 20131 (EmbedWsProxy), 20132 (LiveWS dashboard)

### Key source paths

```
src/
├── proxy.ts                    # main proxy handler
├── server-init.ts              # server bootstrap
├── app/                        # Next.js app router (API routes, pages)
├── shared/providers/           # provider implementations
├── lib/db/                     # database layer (SQLite, 116+ tables)
│   ├── core.ts                 # DB connection + migrations
│   ├── adapters/               # driver factory (better-sqlite3 / sql.js)
│   ├── providers.ts            # provider CRUD
│   ├── combos.ts               # combo/routing strategies
│   └── call_logs.ts            # call logging
├── sse/                        # Server-Sent Events
├── server/                     # auth, cors, websocket
├── middleware/                 # request middleware
└── store/                      # state management

open-sse/                       # workspace package for SSE utilities
```

### Startup sequence (from real logs)

1. Bootstrap: auto-generates JWT_SECRET, API_KEY_SECRET, STORAGE_ENCRYPTION_KEY
2. MDX compilation
3. DB migrations (numbered: 002_mcp_a2a_tables, 003_provider_node_custom_paths, etc.)
4. Guardrail registry, quota cache, provider limits sync
5. Batch processor, credential health checker
6. Model catalog cache warm
7. WebSocket daemons (EmbedWsProxy :20131, LiveWS :20132)
8. Next.js dev server on :20128

### Environment

- `.env` auto-generated from `.env.example` on `npm ci`
- Runtime secrets persisted to `~/.omniroute/server.env`
- `INITIAL_PASSWORD` defaults to `CHANGEME` — change in Settings after first login

### Clean DB wipe

```bash
./scripts/ops/clean-db.sh --confirm   # kills server, wipes ~/.omniroute/
npm run dev                           # recreates fresh DB with migrations from source
```

## Common Commands

```bash
# Development
npm run dev                    # dev server with hot reload (turbopack)
npm run build                  # production build
npm run start                  # run production build

# Code quality
npm run lint                   # ESLint
npm run lint:md                # markdown lint

# Testing
npm test                       # run all tests
npm run test:coverage          # coverage report

# Health check
./scripts/ops/health-check.sh  # probe /api/health/ping
./scripts/ops/db-inspect.sh    # DB health summary
```

## Known Dev Warnings

### sql.js module not found

```
⚠ ./src/lib/db/adapters/sqljsAdapter.ts:40:26
Module not found: Can't resolve 'sql.js/package.json'
```

This is a non-fatal Turbopack warning. The adapter tries to resolve `sql.js`
for WASM-mode SQLite, but the dev server uses `better-sqlite3` (native). The
warning appears on every API route compilation but does not affect
functionality.

### ECONNREFUSED on startup

```
[ProxyFetch] Undici dispatcher failed, falling back to native fetch
...
connect ECONNREFUSED 127.0.0.1:20128
```

This is the dev server probing itself during boot — it fires before the HTTP
listener is ready. Self-corrects once the server is up.

### Auto pools returning empty

```
[AUTO] auto/glm matched no connected models; returning an empty pool.
```

Normal on fresh DB — no provider connections configured yet. Add providers
via the dashboard at http://localhost:20128.

## Dashboard

Web UI at http://localhost:20128/dashboard

First login: password is `CHANGEME` (unless `INITIAL_PASSWORD` is set in `.env`).

## Adding a Provider

Via dashboard: Settings → Providers → Add Connection

Via API:

```bash
curl -X POST http://localhost:20128/api/providers \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","apiKey":"sk-...","name":"My OpenAI"}'
```
