/**
 * quotaExhaustionSnapshot — the combo pre-screen's data writer.
 *
 * When an upstream 429 reports a quota-exhausted window with a future reset stamp
 * (e.g. Alibaba token-plan 5h: "Your token-plan 5-hour quota has been exhausted.
 * The quota will reset at 08-04 04:11:00 UTC."), we persist is_exhausted=1 +
 * next_reset_at into `quota_snapshots` so the pre-route cutoff
 * (resolveQuotaExhaustionCutoffForTarget's snapshot-backed fetcher) can skip the
 * node until reset instead of re-paying the 429 every request for the window.
 *
 * Rules under test:
 *  1. A parseable future Alibaba token-plan reset writes an exhausted snapshot.
 *  2. Unrelated rate-limit / quota text writes nothing (no false positives).
 *  3. Write is idempotent — repeat 429s in the same window append no duplicate row.
 *  4. A stale (already-past) reset stamp is NOT written (the reactive cooldown stays
 *     in charge; a stale stamp must never yield a bogus future lockout).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-exhaustion-snapshot-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const { persistQuotaExhaustionSnapshot } = await import(
  "../../open-sse/services/quotaExhaustionSnapshot.ts"
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
const ALIBABA_BODY =
  "Your token-plan 5-hour quota has been exhausted. The quota will reset at 08-04 04:11:00 UTC.";
// Fixed "now" BEFORE the stamped reset so the test is deterministic-by-date.
const NOW_MS = Date.UTC(2026, 7, 4, 1, 26, 0); // 2026-08-04 01:26 UTC
const RESET_MS = Date.UTC(2026, 7, 4, 4, 11, 0); // 08-04 04:11 UTC

function latestRows() {
  return quotaSnapshotsDb.getLatestQuotaSnapshotsForConnection(CONNECTION);
}

test("writes an exhausted token-plan snapshot honoring the stamped reset", () => {
  const wrote = persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, ALIBABA_BODY, NOW_MS);
  assert.equal(wrote, true);

  const rows = latestRows();
  assert.equal(rows.length, 1);
  const row = rows[0] as unknown as Record<string, unknown>;
  assert.equal(row.provider, PROVIDER);
  assert.equal(row.connectionId, CONNECTION);
  assert.equal(row.windowKey, "token-plan-5h");
  assert.equal(row.isExhausted, 1);
  assert.equal(row.remainingPercentage, 0);
  assert.equal(row.nextResetAt, new Date(RESET_MS).toISOString());
});

test("is idempotent — repeat 429s in the same window append no duplicate row", () => {
  assert.equal(persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, ALIBABA_BODY, NOW_MS), true);
  assert.equal(persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, ALIBABA_BODY, NOW_MS + 5000), true);
  assert.equal(persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, ALIBABA_BODY, NOW_MS + 60_000), true);
  assert.equal(latestRows().length, 1);
});

test("writes nothing for unrelated rate-limit / non-quota text", () => {
  assert.equal(
    persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, "rate_limit_exceeded: too many requests", NOW_MS),
    false
  );
  assert.equal(
    persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, "monthly quota exceeded, upgrade your plan", NOW_MS),
    false
  );
  assert.equal(latestRows().length, 0);
});

test("does not write a stale (already-past) reset stamp", () => {
  // now is AFTER 08-04 04:11 UTC → the stamped reset is in the past → no future lockout.
  const afterReset = Date.UTC(2026, 7, 4, 5, 0, 0);
  const wrote = persistQuotaExhaustionSnapshot(PROVIDER, CONNECTION, ALIBABA_BODY, afterReset);
  assert.equal(wrote, false);
  assert.equal(latestRows().length, 0);
});

test("no-ops when connectionId or provider is missing", () => {
  assert.equal(persistQuotaExhaustionSnapshot(PROVIDER, undefined, ALIBABA_BODY, NOW_MS), false);
  assert.equal(persistQuotaExhaustionSnapshot(null, CONNECTION, ALIBABA_BODY, NOW_MS), false);
  assert.equal(persistQuotaExhaustionSnapshot("unknown", CONNECTION, ALIBABA_BODY, NOW_MS), false);
  assert.equal(latestRows().length, 0);
});
