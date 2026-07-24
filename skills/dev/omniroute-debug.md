---
name: omniroute-debug
description: "Diagnose OmniRoute gateway issues: semaphore timeouts, provider quota exhaustion, crash loops, port conflicts, module-not-found errors. Covers the VPS at 2.25.136.222:20128."
tags: [loadeta, debug, omniroute, semaphore, timeout, provider]
related_skills: [loadeta-vps-ops-daily, agent-llm-timeout-debug]
---

# OmniRoute Debugging

## Trigger

Any of these error patterns from Hermes or agent logs:

- `Semaphore timeout after 30000ms for antigravity:KEY`
- `Semaphore timeout after 30000ms for PROVIDER:KEY`
- Provider calls hanging or timing out
- OmniRoute systemd crash loop (restart counter climbing)

## Where OmniRoute Lives

- **VPS**: 2.25.136.222
- **Port**: 20128
- **Source**: /root/OmniRoute/
- **Installed binary**: /usr/local/lib/node_modules/omniroute/
- **Runtime data**: /root/.omniroute/
- **Server log**: /root/.omniroute/server.log
- **Database**: /root/.omniroute/storage.sqlite
- **Env file**: /root/.omniroute/server.env
- **Systemd unit**: omniroute.service (ExecStart: /usr/local/bin/omniroute serve --port 20128)

**PITFALL**: Systemd often shows crash loops (restart counter climbing) but the actual server runs from a separate node process (not the systemd one). This is a port conflict — the first instance grabs port 20128, systemd's instance fails. Check with `ss -tlnp | grep 20128`.

## Semaphore Timeout Diagnosis

The error `Semaphore timeout after 30000ms for PROVIDER:KEY` comes from OmniRoute's internal rate limiter: `open-sse/services/accountSemaphore.ts`.

**Mechanism**:

- Key format: `provider:api_key_prefix` (e.g., `antigravity:35ce249c-...`)
- DEFAULT_TIMEOUT_MS = 30_000 (30 seconds)
- DEFAULT_MAX_QUEUE_SIZE = 20
- When all concurrency slots are taken, requests queue in FIFO. After 30s with no slot, the queue entry times out.
- If `max_concurrent` is NULL or 0 on the provider connection, the semaphore is bypassed (timeout comes from the upstream provider, not OmniRoute's queue).

**Diagnostic steps (in order)**:

```bash
# 1. Check server log for quota exhaustion patterns
ssh root@2.25.136.222 "grep -i 'quota-aware\|skipping.*exhausted\|semaphore' /root/.omniroute/server.log | tail -20"

# 2. Check provider connections in DB
ssh root@2.25.136.222 "sqlite3 /root/.omniroute/storage.sqlite \"SELECT id, name, is_active, max_concurrent, backoff_level, last_error, consecutive_use_count FROM provider_connections WHERE provider='antigravity';\""

# 3. Check if any connections have max_concurrent set
ssh root@2.25.136.222 "sqlite3 /root/.omniroute/storage.sqlite \"SELECT provider, name, max_concurrent FROM provider_connections WHERE max_concurrent IS NOT NULL AND max_concurrent > 0;\""

# 4. Count provider connections by status
ssh root@2.25.136.222 "sqlite3 /root/.omniroute/storage.sqlite \"SELECT provider, COUNT(*) as cnt, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) as active FROM provider_connections GROUP BY provider;\""

# 5. Check actual quota on Antigravity accounts
ssh root@2.25.136.222 "grep 'antigravity.*quota-aware' /root/.omniroute/server.log | tail -10"
```

**Common root causes**:

1. **Quota exhaustion**: Antigravity accounts show "1 with quota, skipping 2 exhausted" — most accounts have hit their Antigravity API quota. All traffic funnels through the remaining account(s), saturating them.
2. **No max_concurrent set**: If `max_concurrent` is NULL, OmniRoute bypasses its internal semaphore. The bottleneck shifts to Antigravity's own rate limiting, and OmniRoute's queue backs up waiting for responses that never come.
3. **Backoff active**: If `backoff_level > 0` on connections, they're temporarily excluded from selection.

**Fixes**:

1. Set `max_concurrent` on busy provider connections so OmniRoute gates traffic before hitting upstream limits.
2. Add more Antigravity accounts with quota.
3. Route traffic away from exhausted providers — use combos that fall back to `ollama-cloud` or other providers.

## Crash Loop Diagnosis

```bash
# Check systemd status and crash count
ssh root@2.25.136.222 "systemctl status omniroute | head -10"

# Check what's actually listening
ssh root@2.25.136.222 "ss -tlnp | grep 20128"

# Check crash reason in journal
ssh root@2.25.136.222 "journalctl -u omniroute --no-pager -n 30 | grep -v 'systemd\|Scheduled\|Consumed\|Started'"
```

**PITFALL**: If port 20128 is already in use, systemd's instance will crash on startup every 5 seconds (RestartSec=5s). The fix is to either stop the existing process or change the port.

## Module Not Found Errors

If logs show `ERR_MODULE_NOT_FOUND: Cannot find module '...omniroute/dist/main-server-timeouts.mjs'`:

The installed binary at /usr/local/lib/node_modules/omniroute/ is missing files. The source lives at /root/OmniRoute/. Rebuild with:

```bash
ssh root@2.25.136.222 "cd /root/OmniRoute && npm run build && npm link"
```

## DB Schema Quick Reference

Key tables for debugging:

- `provider_connections` — provider accounts (id, provider, name, is_active, max_concurrent, backoff_level, last_error, api_key)
- `provider_nodes` — provider endpoint configs (id, name, prefix, base_url)
- `quota_pools` — per-connection quota pools (id, connection_id, name)
- `quota_allocations` — pool → api_key assignments (pool_id, api_key_id, weight, cap_value, policy)

Full schema reference: see `references/db-schema.md`.
