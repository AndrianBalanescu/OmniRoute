/**
 * Alibaba Token Plan 5-hour rollover cap is never treated as quota-exhausted.
 *
 * The upstream (ali-tok / token-plan.*.maas.aliyuncs.com) returns 429 with:
 *   "Your token-plan 5-hour quota has been exhausted. The quota will reset at
 *    08-04 04:11:00 UTC."
 *
 * Mirrors the already-fixed Ollama weekly/session gaps (#3709/#7071): ali-tok is
 * an apikey-category provider, so the oauth-only `shouldUseQuotaSignal` gate in
 * checkFallbackError skips the generic subscription-text branch (#2321), and
 * none of the weekly/session/subscription classifiers recognize
 * "token-plan ... quota". Without a dedicated UNGATED check the plan fell
 * through to the generic ~1-2s 429 backoff and combo routing hammered the
 * exhausted plan every few seconds for the whole 5h window (prod: ~900 req/24h,
 * hundreds of repeat 429s against a plan that reports it cannot reset before
 * the stamped time).
 *
 * This test proves: (1) the token-plan text is classified QUOTA_EXHAUSTED with
 * a long cooldown for both apikey and oauth categories, (2) the embedded
 * "MM-DD HH:MM:SS UTC" reset is honored exactly when parseable, and (3)
 * unrelated quota/rate-limit wording is unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");
const {
  isAlibabaTokenPlanQuotaText,
  buildAlibabaTokenPlanQuotaFallback,
  parseAlibabaTokenPlanResetMs,
} = await import("../../open-sse/services/quotaTextCooldowns.ts");
const { RateLimitReason, BACKOFF_CONFIG } = await import("../../open-sse/config/constants.ts");
const { BACKOFF_CONFIG: ERROR_BACKOFF_CONFIG } =
  await import("../../open-sse/config/errorConfig.ts");

const ALIBABA_BODY =
  "Your token-plan 5-hour quota has been exhausted. The quota will reset at 08-04 04:11:00 UTC.";
const ALIBABA_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 hours

test("alibaba-token-plan isAlibabaTokenPlanQuotaText matches the 429 body", () => {
  assert.equal(isAlibabaTokenPlanQuotaText(ALIBABA_BODY.toLowerCase()), true);
  // shorter variant with no reset time still matches
  assert.equal(
    isAlibabaTokenPlanQuotaText("your token-plan quota has been exhausted".toLowerCase()),
    true
  );
  // unrelated wording must not false-positive
  assert.equal(isAlibabaTokenPlanQuotaText("rate_limit_exceeded: too many requests"), false);
  assert.equal(isAlibabaTokenPlanQuotaText("monthly quota exceeded"), false);
  assert.equal(isAlibabaTokenPlanQuotaText("quota will reset at 08-04 04:11:00 UTC"), false); // no token-plan
});

test("alibaba-token-plan parseAlibabaTokenPlanResetMs honors the MM-DD UTC reset", () => {
  // Deterministic: fixed "now" BEFORE the stamped reset (2026-08-04 04:11:00 UTC).
  const nowMs = Date.UTC(2026, 7, 4, 1, 26, 0); // 2026-08-04 01:26:00 UTC
  const resetMs = Date.UTC(2026, 7, 4, 4, 11, 0); // 08-04 04:11:00 UTC
  const expectedWaitMs = resetMs - nowMs;
  const waitMs = parseAlibabaTokenPlanResetMs(ALIBABA_BODY, nowMs);
  assert.equal(waitMs, expectedWaitMs, "should honor the exact stamped reset, not the 5h default");
  assert.ok(waitMs !== null && waitMs > 0 && waitMs < ALIBABA_COOLDOWN_MS);
});

test("alibaba-token-plan parseAlibabaTokenPlanResetMs returns null for a stale (already-past) reset", () => {
  const nowMs = Date.UTC(2026, 7, 4, 5, 0, 0); // after 08-04 04:11 UTC
  assert.equal(parseAlibabaTokenPlanResetMs(ALIBABA_BODY, nowMs), null);
});

test("alibaba-token-plan buildAlibabaTokenPlanQuotaFallback returns QUOTA_EXHAUSTED above the generic backoff cap", () => {
  const result = buildAlibabaTokenPlanQuotaFallback(ALIBABA_BODY);
  assert.ok(result, "expected a non-null fallback for token-plan text");
  assert.equal(result!.reason, RateLimitReason.QUOTA_EXHAUSTED);
  assert.ok(result!.cooldownMs > (ERROR_BACKOFF_CONFIG.max ?? BACKOFF_CONFIG.max));
  assert.ok(result!.cooldownMs <= ALIBABA_COOLDOWN_MS);
});

test("alibaba-token-plan buildAlibabaTokenPlanQuotaFallback returns null for unrelated text", () => {
  assert.equal(buildAlibabaTokenPlanQuotaFallback("rate_limit_exceeded: too many requests"), null);
  assert.equal(
    buildAlibabaTokenPlanQuotaFallback("monthly quota exceeded, upgrade your plan"),
    null
  );
});

test("alibaba-token-plan BUG: checkFallbackError now classifies the ali-tok 429 as QUOTA_EXHAUSTED (long cooldown), not generic RATE_LIMIT_EXCEEDED", () => {
  const out = checkFallbackError(
    429,
    ALIBABA_BODY,
    0,
    null,
    "openai-compatible-chat-92eda49a-2f72-4fd5-8b06-86fb00af1846",
    null,
    null,
    null
  );
  assert.equal(out.shouldFallback, true);
  assert.equal(
    out.reason,
    RateLimitReason.QUOTA_EXHAUSTED,
    `expected QUOTA_EXHAUSTED for token-plan text, got reason=${out.reason} cooldownMs=${out.cooldownMs}`
  );
  assert.ok(out.cooldownMs > (ERROR_BACKOFF_CONFIG.max ?? BACKOFF_CONFIG.max));
});

test("alibaba-token-plan checkFallbackError: oauth-category provider with the same text also gets QUOTA_EXHAUSTED", () => {
  const out = checkFallbackError(429, ALIBABA_BODY, 0, null, "claude", null, null, null);
  assert.equal(out.reason, RateLimitReason.QUOTA_EXHAUSTED);
});

test("alibaba-token-plan checkFallbackError: generic rate-limit body is unaffected (no false positive)", () => {
  const out = checkFallbackError(
    429,
    "rate_limit_exceeded: too many requests",
    0,
    null,
    "openai-compatible-chat-92eda49a-2f72-4fd5-8b06-86fb00af1846",
    null,
    null,
    null
  );
  assert.equal(out.reason, RateLimitReason.RATE_LIMIT_EXCEEDED);
  assert.ok(
    out.cooldownMs <= 2 * 60 * 1000,
    "generic rate limit text must keep the normal short backoff"
  );
});
