---
name: omniroute-troubleshooting
description: "Troubleshoot OmniRoute AI Gateway issues: routing failures, semaphore concurrency timeouts, combo fallbacks, database structure, and process management."
tags: [omniroute, gateway, debug, route, rate-limit, semaphore]
related_skills: [ibrowse-llm-architecture, agent-llm-timeout-debug]
---

# OmniRoute Troubleshooting & Debugging

This skill covers diagnosing and fixing common operational issues within the OmniRoute AI Gateway (both local and VPS deployments).

## 1. Concurrency Semaphore Timeout

### Symptom

Requests from downstream agents fail with:
`Error: Semaphore timeout after 30000ms for <provider>:<connection-id>`

### Root Cause

OmniRoute limits concurrent calls per provider connection using a flat connection cap (`max_concurrent` in `provider_connections` table).

- In multi-model/single-connection combos (like `ide`), all models share the same connection semaphore.
- If a model's quota is exhausted and calls to it hang, retry, or fail slowly, it consumes all available concurrency slots (e.g. `max_concurrent=3`).
- Other models in the same combo WITH quota queue up behind the blocked semaphore and time out after OmniRoute's 30s limit (`DEFAULT_TIMEOUT_MS = 30000` in `accountSemaphore.ts`).

### Quick Diagnosis

Query the local or VPS OmniRoute SQLite database `storage.sqlite`:

```sql
-- Check max_concurrent settings
SELECT id, provider, max_concurrent, is_active FROM provider_connections;

-- Check if models are exhausted
SELECT window_key, remaining_percentage, is_exhausted FROM quota_snapshots;
```

### Fix / Workaround

Set `max_concurrent = 0` (or a high limit to disable concurrency gating) for the saturated provider:

```sql
UPDATE provider_connections SET max_concurrent = 0 WHERE provider = 'antigravity';
```

---

## 2. Process Crash Loops (e.g., ERR_MODULE_NOT_FOUND)

### Symptom

`systemctl status omniroute` shows constant restarts:
`omniroute.service: Main process exited, code=exited, status=1/FAILURE`

Stderr logs show missing files:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/main-server-timeouts.mjs'`

### Fix

Typically happens due to a broken installation or files left behind in a bad npm/pnpm refresh. Re-build or re-install the package using clean paths, or verify the PM2/systemd target is pointed at the correct node executable and directory.

Note: If a process is already listening on `20128` (check with `lsof -i :20128`), systemd's attempts to bind will repeatedly fail with the port already in use. Clean up orphaned node processes:

```bash
kill -9 $(lsof -t -i:20128)
```
