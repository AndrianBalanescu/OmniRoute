---
name: omniroute-ops
description: "OmniRoute operations — debugging, monitoring, log analysis, DB inspection, clean DB"
tags: [omniroute, ops, debug, monitoring, logs, db, semaphore]
related_skills: [omniroute-dev, omniroute-qa]
---

# OmniRoute Operations

## Local Dev Debugging

### Health Check

```bash
./scripts/ops/health-check.sh                    # localhost:20128
./scripts/ops/health-check.sh 2.25.136.222:20128 # VPS
```

Real output:

```
✓ Health endpoint: OK (200)
  /api/health/ping     0.007s
  /api/providers/...   0.008s
```

### Database Inspection

```bash
./scripts/ops/db-inspect.sh                      # default: ~/.omniroute/storage.sqlite
./scripts/ops/db-inspect.sh /path/to/db.sqlite   # custom path
```

Shows: table count, provider connections, exhausted quotas, recent failed
calls, call volume.

### Semaphore Analysis

```bash
./scripts/ops/semaphore-check.sh                 # default: ~/.omniroute/storage.sqlite
```

Shows: semaphore config, bottleneck detection, recent timeouts, recommendations.

### Clean DB (fresh dev start)

```bash
./scripts/ops/clean-db.sh            # preview what will be deleted
./scripts/ops/clean-db.sh --confirm  # actually wipe + kill server
npm run dev                          # recreates fresh DB from source migrations
```

### Log Levels

```bash
DEBUG=omniroute:* npm run dev         # full debug
DEBUG=omniroute:proxy npm run dev     # proxy only
SQLITE_DEBUG=1 npm run dev            # SQL query logging
```

### SQLite Inspection

```bash
sqlite3 ~/.omniroute/storage.sqlite

# Useful queries
.tables
.schema provider_connections
SELECT provider, max_concurrent, is_active FROM provider_connections;
SELECT COUNT(*) FROM quota_snapshots WHERE is_exhausted=1;
SELECT provider, model, status, error_summary, timestamp
  FROM call_logs WHERE status != 200 ORDER BY timestamp DESC LIMIT 20;
```

## Real DB Schema (verified v3.8.49)

Key tables (116+ total):

| Table                  | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `provider_connections` | Provider configs (provider, max_concurrent, is_active)                 |
| `call_logs`            | API call log (provider, model, status, error_summary, tokens)          |
| `quota_snapshots`      | Quota state (provider, window_key, remaining_percentage, is_exhausted) |
| `api_keys`             | API key management                                                     |
| `combos`               | Routing combo strategies                                               |
| `model_intelligence`   | Arena ELO sync data                                                    |
| `audit_log`            | Compliance audit trail                                                 |
| `plugins`              | Plugin registry                                                        |
| `memory_fts`           | Full-text search index                                                 |

PITFALL: Table names use plural form: `call_logs` not `call_log`,
`quota_snapshots` not `quota_snapshot`.

## VPS Operations (2.25.136.222)

### Process Management

```bash
ss -tlnp | grep 20128               # what's on port
systemctl status omniroute           # service status
systemctl restart omniroute          # restart
journalctl -u omniroute -f           # follow logs
```

### Log Analysis on VPS

```bash
tail -f /root/.omniroute/server.log
grep "Semaphore timeout" /root/.omniroute/server.log | tail -20
grep "quota\|exhausted" /root/.omniroute/server.log | tail -20
```

### VPS Database

```bash
sqlite3 /root/.omniroute/storage.sqlite <<EOF
SELECT provider, max_concurrent, is_active FROM provider_connections;
SELECT COUNT(*) FROM quota_snapshots WHERE is_exhausted=1;
SELECT provider, model, error_summary, timestamp
  FROM call_logs WHERE error_summary LIKE '%Semaphore%'
  ORDER BY timestamp DESC LIMIT 10;
EOF
```

## Common Issues

### Semaphore Timeout Cascade

When one provider's quota exhausts, it blocks the shared semaphore → all
models on the same connection timeout after 30s.

Fix:

```bash
# Identify exhausted providers
sqlite3 ~/.omniroute/storage.sqlite \
  "SELECT provider, window_key FROM quota_snapshots WHERE is_exhausted=1;"

# Increase max_concurrent (or set to NULL for unlimited)
sqlite3 ~/.omniroute/storage.sqlite \
  "UPDATE provider_connections SET max_concurrent=10 WHERE provider='antigravity';"
```

### Port Conflict

```bash
lsof -ti:20128 | xargs kill -9
```

### Stale DB from Binary Install

If you previously ran the globally-installed `omniroute` binary, the DB at
`~/.omniroute/` has stale data from that version. For clean dev:

```bash
./scripts/ops/clean-db.sh --confirm
npm run dev   # creates fresh DB with migrations from your source
```

## Monitoring Scripts

| Script               | What it does                                         |
| -------------------- | ---------------------------------------------------- |
| `health-check.sh`    | Probes `/api/health/ping`, reports status + latency  |
| `db-inspect.sh`      | DB health: connections, quotas, failed calls, volume |
| `semaphore-check.sh` | Semaphore config, bottlenecks, timeout history       |
| `clean-db.sh`        | Wipes `~/.omniroute/` for fresh dev start            |
| `validate-env.sh`    | Checks Node, npm, deps, .env, port, sqlite3          |
| `log-tail.sh`        | Color-coded log tailing                              |
