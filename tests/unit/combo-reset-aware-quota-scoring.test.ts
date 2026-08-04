import test from "node:test";
import assert from "node:assert/strict";
import { scoreResetAwareQuota } from "../../open-sse/services/combo/quotaScoring.ts";

test("scoreResetAwareQuota prioritizes imminent reset when remaining quota is high", () => {
  const config = {
    sessionWeight: 0.5,
    weeklyWeight: 0.5,
    exhaustionGuard: 0.05,
    tieBand: 0.02,
    quotaCacheTtlMs: 5000,
    quotaCacheMaxStaleMs: 60000,
  };

  // Account 1: 98% left, reset in 33 minutes
  const acc1Quota = {
    percentUsed: 0.02,
    resetAt: new Date(Date.now() + 33 * 60 * 1000).toISOString(),
    window5h: {
      percentUsed: 0.02,
      resetAt: new Date(Date.now() + 33 * 60 * 1000).toISOString(),
    },
  };

  // Account 2: 100% left, reset in 4.5 hours
  const acc2Quota = {
    percentUsed: 0.0,
    resetAt: new Date(Date.now() + 4.5 * 3600 * 1000).toISOString(),
    window5h: {
      percentUsed: 0.0,
      resetAt: new Date(Date.now() + 4.5 * 3600 * 1000).toISOString(),
    },
  };

  // Account 5: 48% left, reset in 6.3 days
  const acc5Quota = {
    percentUsed: 0.52,
    resetAt: new Date(Date.now() + (6 * 24 + 9) * 3600 * 1000).toISOString(),
    window7d: {
      percentUsed: 0.52,
      resetAt: new Date(Date.now() + (6 * 24 + 9) * 3600 * 1000).toISOString(),
    },
  };

  const score1 = scoreResetAwareQuota(acc1Quota, config).score;
  const score2 = scoreResetAwareQuota(acc2Quota, config).score;
  const score5 = scoreResetAwareQuota(acc5Quota, config).score;

  assert.ok(
    score1 > score2,
    `Account 1 (${score1}) should score higher than Account 2 (${score2})`
  );
  assert.ok(
    score1 > score5,
    `Account 1 (${score1}) should score higher than Account 5 (${score5})`
  );
});
