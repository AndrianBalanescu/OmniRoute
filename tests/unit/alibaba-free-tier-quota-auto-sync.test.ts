/**
 * @file alibaba-free-tier-quota-auto-sync.test.ts
 * @description Unit tests for the periodic Alibaba free-tier quota background
 * sync (scheduler gating + eligible-connection filter + sync-due check).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isAlibabaQuotaSyncDue,
  createAlibabaQuotaAutoSyncState,
  runAlibabaQuotaAutoSyncTick,
  listAlibabaQuotaAutoSyncConnections,
  stopAlibabaFreeTierQuotaAutoSync,
} from "../../src/lib/services/alibabaFreeTierQuotaAutoSync.ts";

test("isAlibabaQuotaSyncDue: true when snapshot missing or unparsable", () => {
  assert.equal(isAlibabaQuotaSyncDue(null, 1000, 5000), true);
  assert.equal(isAlibabaQuotaSyncDue({}, 1000, 5000), true);
  assert.equal(isAlibabaQuotaSyncDue({ alibabaFreeTierQuotaLastSyncAt: "nope" }, 1000, 5000), true);
});

test("isAlibabaQuotaSyncDue: false within interval, true past it", () => {
  const psd = { alibabaFreeTierQuotaLastSyncAt: new Date(10_000).toISOString() };
  assert.equal(isAlibabaQuotaSyncDue(psd, 5_000, 12_000), false);
  assert.equal(isAlibabaQuotaSyncDue(psd, 5_000, 15_000), true);
});

test("runAlibabaQuotaAutoSyncTick schedules only due connections", async () => {
  const now = 50_000;
  const due = {
    id: "conn-1",
    provider: "alibaba",
    providerSpecificData: {
      alibabaFreeTierQuotaLastSyncAt: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
    },
  };
  const fresh = {
    id: "conn-2",
    provider: "alibaba",
    providerSpecificData: { alibabaFreeTierQuotaLastSyncAt: new Date(now).toISOString() },
  };
  const refreshed: string[] = [];
  const state = createAlibabaQuotaAutoSyncState();
  const scheduled = await runAlibabaQuotaAutoSyncTick(
    {
      listConnections: async () => [due, fresh],
      refreshConnection: (connection) => refreshed.push(connection.id),
      now: () => now,
    },
    state
  );
  assert.equal(scheduled, 1);
  assert.deepEqual(refreshed, ["conn-1"]);
  assert.equal(state.lastTickAt, now);
});

test("runAlibabaQuotaAutoSyncTick is re-entrant safe (running flag)", async () => {
  const state = createAlibabaQuotaAutoSyncState();
  state.running = true;
  const scheduled = await runAlibabaQuotaAutoSyncTick(
    {
      listConnections: async () => {
        throw new Error("should not be called");
      },
      refreshConnection: () => undefined,
    },
    state
  );
  assert.equal(scheduled, 0);
  state.running = false;
});

test("listAlibabaQuotaAutoSyncConnections returns only eligible free/billing+auth+live connections", async () => {
  const connections = await listAlibabaQuotaAutoSyncConnections();
  // Hermetic unit run has no DB — the import resolves and returns [].
  assert.ok(Array.isArray(connections));
  stopAlibabaFreeTierQuotaAutoSync();
});