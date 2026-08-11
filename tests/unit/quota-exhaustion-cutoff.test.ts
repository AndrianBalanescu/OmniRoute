/**
 * Reader side of the proactive quota-exhaustion skip: given a persisted exhausted
 * snapshot with a FUTURE reset, the combo pre-screen (resolveQuotaExhaustionCutoffForTarget)
 * must return blocked for an openai-compatible node that has NO live quota fetcher —
 * that is the whole point: skip node until reset instead of re-paying the 429 for the
 * window. A stale (already-past) reset must NOT block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-cutoff-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const { resolveQuotaExhaustionCutoffForTarget } = await import(
  "../../open-sse/services/combo/quotaExhaustionCutoff.ts"
);
const { resolveResetWindowConfig } = await import(
  "../../open-sse/services/combo/quotaScoring.ts"
);

async function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const PROVIDER = "openai-compatible-chat-92eda49a-2f72-4fd5-8b06-86fb00af1846"; // ali-tok
const CONNECTION = "conn-ali-tok";

const enabled = {
  quotaPreflight: { enabled: true, defaultThresholdPercent: 2, warnThresholdPercent: 20, providerWindowDefaults: {} },
} as never;

function seedExhausted(resetAtIso: string) {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: PROVIDER,
    connection_id: CONNECTION,
    window_key: "token-plan-5h",
    remaining_percentage: 0,
    is_exhausted: 1,
    next_reset_at: resetAtIso,
    window_duration_ms: 5 * 60 * 60 * 1000,
    raw_data: null,
  });
}

test("blocks an openai-compatible node known-exhausted until a future reset", async () => {
  seedExhausted(new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString()); // reset in the future

  const result = await resolveQuotaExhaustionCutoffForTarget(
    PROVIDER,
    CONNECTION,
    enabled,
    resolveResetWindowConfig(null),
    "paid-premium",
    {}
  );
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /quota/);
});

test("does not block a stale snapshot whose reset has already passed", async () => {
  seedExhausted(new Date(Date.now() - 60_000).toISOString()); // reset in the past → re-check live

  const result = await resolveQuotaExhaustionCutoffForTarget(
    PROVIDER,
    CONNECTION,
    enabled,
    resolveResetWindowConfig(null),
    "paid-premium",
    {}
  );
  assert.equal(result.blocked, false);
});

test("does not block when no exhausted snapshot exists for the connection", async () => {
  const result = await resolveQuotaExhaustionCutoffForTarget(
    PROVIDER,
    CONNECTION,
    enabled,
    resolveResetWindowConfig(null),
    "paid-premium",
    {}
  );
  assert.equal(result.blocked, false);
});

test("never blocks when quotaPreflight is disabled", async () => {
  seedExhausted(new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString());
  const disabled = { quotaPreflight: { enabled: false } } as never;
  const result = await resolveQuotaExhaustionCutoffForTarget(
    PROVIDER,
    CONNECTION,
    disabled,
    resolveResetWindowConfig(null),
    "paid-premium",
    {}
  );
  assert.equal(result.blocked, false);
});
