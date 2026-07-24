---
name: omniroute-qa
description: "OmniRoute QA — testing patterns, test commands, coverage, validation"
tags: [omniroute, qa, testing, test, coverage, validation]
related_skills: [omniroute-dev, omniroute-ops]
---

# OmniRoute QA

## Test Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode (re-run on file changes)
npm run test:watch

# Run specific test file
npx vitest src/shared/providers/__tests__/openai.test.ts

# Run tests matching pattern
npx vitest -t "should handle streaming"

# Run tests for specific provider
npx vitest src/shared/providers/__tests__/anthropic.test.ts
```

## Test Structure

Tests live alongside source code in `__tests__/` directories:

```
src/shared/providers/
  ├── openai.ts
  ├── anthropic.ts
  └── __tests__/
      ├── openai.test.ts
      └── anthropic.test.ts
```

## Writing Tests

### Provider Test Pattern

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../openai";

describe("OpenAIProvider", () => {
  it("should handle chat completions", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const response = await provider.chat({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(response.choices[0].message.content).toBeDefined();
  });

  it("should handle streaming responses", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const stream = await provider.chatStream({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});
```

### Database Test Pattern

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { getProviders, createProvider } from "@/lib/db/providers";
import { resetDatabase } from "@/lib/db/core";

describe("providers", () => {
  beforeEach(async () => {
    await resetDatabase(); // clean state for each test
  });

  it("should create and retrieve provider", async () => {
    await createProvider({
      name: "test-provider",
      apiKey: "test-key",
      active: true,
    });
    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("test-provider");
  });
});
```

## Coverage Requirements

- Minimum 80% coverage for `src/shared/providers/`
- Minimum 70% coverage for `src/lib/db/`
- Critical paths (proxy, auth) require 90%+

View coverage report:

```bash
npm run test:coverage
open coverage/index.html
```

## Integration Testing

### Local Provider Testing

```bash
# Test a specific provider end-to-end
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Load Testing

```bash
# Using scripts/qa/load-test.sh
./scripts/qa/load-test.sh --requests 100 --concurrency 10

# Using hey (if installed)
hey -n 100 -c 10 http://localhost:20128/health
```

## Common Test Failures

### "Cannot find module '@/...'"

Path aliases not resolved. Fix:

```bash
# Ensure tsconfig.json has paths configured
# Re-run with tsx
npx tsx --test src/...
```

### SQLite Lock Errors in Tests

Tests running in parallel hitting the same DB. Fix:

```typescript
// Use unique DB per test
beforeEach(() => {
  process.env.DATA_DIR = `/tmp/omniroute-test-${Date.now()}`;
});
```

### Provider API Rate Limits

Tests hitting real APIs and getting rate-limited. Fix:

```typescript
// Mock the HTTP client
vi.mock("@/lib/http", () => ({
  post: vi.fn().mockResolvedValue({ data: {/* mock response */} }),
}));
```

## Validation Checklist

Before committing:

- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run test:coverage` shows no regression
- [ ] Manual test: start dev server, hit `/health`
- [ ] Manual test: proxy a request through to a provider
- [ ] Check database migrations (if any): `npm run db:migrate`

## CI Pipeline

Tests run automatically on PR via GitHub Actions:

- `.github/workflows/test.yml` — unit tests
- `.github/workflows/lint.yml` — linting
- `.github/workflows/e2e.yml` — end-to-end tests

View results: `gh pr checks <number>`
