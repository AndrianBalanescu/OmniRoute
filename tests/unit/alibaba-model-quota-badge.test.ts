/**
 * @file alibaba-model-quota-badge.test.ts
 * @description Unit tests for the ModelRow free-tier quota badge derivation
 * (formatting + status classes) used by the Alibaba Model Studio UI.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveAlibabaModelQuotaBadge,
  formatQuotaTokens,
} from "../../src/shared/utils/alibabaModelQuotaBadge.ts";

test("formatQuotaTokens formats millions, thousands, zero and unparsable", () => {
  assert.equal(formatQuotaTokens(1_000_000), "1M");
  assert.equal(formatQuotaTokens(1_500_000), "1.5M");
  assert.equal(formatQuotaTokens(450_000), "450k");
  assert.equal(formatQuotaTokens(999), "999");
  assert.equal(formatQuotaTokens(0), "0");
  assert.equal(formatQuotaTokens(-5), "0");
  assert.equal(formatQuotaTokens(Number.NaN), "0");
});

test("deriveAlibabaModelQuotaBadge: null entry -> no badge", () => {
  assert.equal(deriveAlibabaModelQuotaBadge(null), null);
  assert.equal(deriveAlibabaModelQuotaBadge(undefined), null);
});

test("deriveAlibabaModelQuotaBadge: VALID with remaining tokens", () => {
  const badge = deriveAlibabaModelQuotaBadge({
    model: "qwen-plus",
    freeTierOnly: true,
    quotaStatus: "VALID",
    quotaTotal: 800_000,
    quotaInitTotal: 1_000_000,
    quotaTotalPercentage: 80,
  });
  assert.ok(badge);
  assert.equal(badge.status, "available");
  assert.match(badge.label, /Free 800k/);
  assert.match(badge.label, /\(80%\)/);
  assert.equal(badge.remainingTokens, 800_000);
});

test("deriveAlibabaModelQuotaBadge: VALID with zero remaining = drained", () => {
  const badge = deriveAlibabaModelQuotaBadge({
    model: "qwen-plus",
    freeTierOnly: true,
    quotaStatus: "VALID",
    quotaTotal: 0,
    quotaInitTotal: 1_000_000,
  });
  assert.ok(badge);
  assert.equal(badge.status, "drained");
  assert.equal(badge.label, "Free 0");
});

test("deriveAlibabaModelQuotaBadge: validity period in the past -> expired", () => {
  const badge = deriveAlibabaModelQuotaBadge(
    {
      model: "qwen-plus",
      freeTierOnly: true,
      quotaStatus: "VALID",
      quotaTotal: 500_000,
      quotaValidityPeriod: 1000,
    },
    2000
  );
  assert.ok(badge);
  assert.equal(badge.label, "Expired");
});

test("deriveAlibabaModelQuotaBadge: UNKNOWN status -> capable marker without total", () => {
  const badge = deriveAlibabaModelQuotaBadge({
    model: "qwen-max",
    freeTierOnly: true,
    quotaStatus: "UNKNOWN",
  });
  assert.ok(badge);
  assert.equal(badge.status, "unknown");
  assert.equal(badge.label, "Free Tier");
});

test("deriveAlibabaModelQuotaBadge: non free-tier entry without totals -> no badge", () => {
  assert.equal(
    deriveAlibabaModelQuotaBadge({
      model: "qwen-commercial",
      freeTierOnly: false,
      quotaStatus: "VALID",
      quotaTotal: undefined,
    }),
    null
  );
});

test("deriveAlibabaModelQuotaBadge: EXPIRED status -> drained", () => {
  const badge = deriveAlibabaModelQuotaBadge({
    model: "qwen-plus",
    freeTierOnly: true,
    quotaStatus: "EXPIRED",
  });
  assert.ok(badge);
  assert.equal(badge.status, "drained");
});