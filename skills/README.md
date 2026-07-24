# OmniRoute Development & QA Skills

This folder contains skills and scripts for developing, testing, and operating OmniRoute.

## Structure

```
skills/
├── dev/          # Development patterns, architecture, common tasks
│   └── SKILL.md
├── ops/          # Operations, debugging, monitoring, VPS ops
│   └── SKILL.md
└── qa/           # Testing, validation, coverage
    └── SKILL.md

scripts/
├── ops/          # Operational scripts
│   ├── health-check.sh       # Probe health endpoints
│   ├── log-tail.sh           # Smart log tailing with color
│   ├── db-inspect.sh         # Database health summary
│   ├── semaphore-check.sh    # Semaphore state analysis
│   └── validate-env.sh       # Environment validator
└── qa/           # QA scripts
    └── load-test.sh          # HTTP load testing
```

## Quick Start

### 1. Validate Environment

```bash
./scripts/ops/validate-env.sh
```

### 2. Start Dev Server

```bash
npm run dev
```

Server starts on http://localhost:20128

### 3. Check Health

```bash
./scripts/ops/health-check.sh
```

## Skills Overview

### dev (Development)

- Architecture overview
- Common commands (dev, build, test, lint)
- Code patterns (adding providers, DB queries, SSE)
- Debugging techniques
- Common issues and fixes

### ops (Operations)

- Local debugging (log levels, request tracing)
- VPS operations (process management, log analysis)
- Database inspection
- Semaphore troubleshooting
- Monitoring scripts

### qa (Quality Assurance)

- Test commands and patterns
- Writing tests (providers, database)
- Coverage requirements
- Integration testing
- Load testing

## Scripts

### health-check.sh

Probes health endpoints and reports status.

```bash
./scripts/ops/health-check.sh [host:port]
# Default: localhost:20128
```

### log-tail.sh

Tails logs with color-coded error highlighting.

```bash
./scripts/ops/log-tail.sh [log-file]
# Default: /root/.omniroute/server.log (VPS)
```

### db-inspect.sh

Shows database health: tables, connections, quotas, recent errors.

```bash
./scripts/ops/db-inspect.sh [db-path]
# Default: /root/.omniroute/storage.sqlite (VPS)
```

### semaphore-check.sh

Analyzes semaphore configuration and identifies bottlenecks.

```bash
./scripts/ops/semaphore-check.sh [db-path]
```

### validate-env.sh

Validates all prerequisites for running OmniRoute.

```bash
./scripts/ops/validate-env.sh          # Local
./scripts/ops/validate-env.sh --vps    # VPS
```

### load-test.sh

Runs HTTP load tests using `hey`.

```bash
./scripts/qa/load-test.sh \
  --requests 100 \
  --concurrency 10 \
  --endpoint http://localhost:20128/health
```

## Common Workflows

### Debug a Provider Issue

1. Enable debug logging: `DEBUG=omniroute:providers npm run dev`
2. Make the request that fails
3. Check logs for provider-specific errors
4. Inspect database: `./scripts/ops/db-inspect.sh data/storage.sqlite`

### Check Semaphore Timeouts

```bash
./scripts/ops/semaphore-check.sh data/storage.sqlite
```

### VPS Health Check

```bash
# From local machine
ssh root@2.25.136.222 './scripts/ops/health-check.sh'
ssh root@2.25.136.222 './scripts/ops/db-inspect.sh'
ssh root@2.25.136.222 './scripts/ops/semaphore-check.sh'
```

### Run Tests Before Commit

```bash
npm run lint
npm test
npm run test:coverage
./scripts/ops/health-check.sh
```

## Next Steps

- Read `skills/dev/SKILL.md` for development patterns
- Read `skills/ops/SKILL.md` for operations guide
- Read `skills/qa/SKILL.md` for testing patterns
- Check `AGENTS.md` for full project guidelines
