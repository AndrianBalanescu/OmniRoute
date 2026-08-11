/**
 * quotaExhaustionSnapshot.ts — persist a quota-exhausted 429's reset stamp so the
 * combo pre-screen can skip the provider:connection proactively instead of only
 * reacting after the next dispatch incurs another 429.
 *
 * Background: providers like the custom `openai-compatible-chat-*` ali-tok node
 * have NO live quota fetcher (they're not in USAGE_FETCHER_PROVIDERS) and no
 * periodic quota snapshot. The reactive classifier (buildAlibabaTokenPlanQuotaFallback,
 * parseRetryFromErrorText) already parses the exact reset from the 429 body, but
 * nothing persisted it — so routing kept selecting the node and re-paying the 429
 * every request for the whole window (observed: 337×429 in 24h from `paid-premium`
 * → ali-tok). This module funnels that already-parsed reset into `quota_snapshots`,
 * which the preflight cutoff read-side (`resolveQuotaExhaustionCutoffForTarget`'s
 * snapshot-backed fetcher) then consumes to block the node until reset.
 *
 * Fail-open by design: any failure to read/write the snapshot is swallowed — it must
 * never break the combo routing hot path. This is a write-once-per-window idempotent
 * insert on an already-erroring path.
 */
import {
  getLatestQuotaSnapshotsForConnection,
  saveQuotaSnapshot,
} from "@/lib/db/quotaSnapshots";
import {
  isAlibabaTokenPlanQuotaText,
  parseAlibabaTokenPlanResetMs,
} from "./quotaTextCooldowns.ts";
import { classifyErrorText, parseRetryFromErrorText } from "./accountFallback.ts";
import { RateLimitReason } from "../config/constants.ts";

export const ALIBABA_TOKEN_PLAN_WINDOW_KEY = "token-plan-5h";
const ALIBABA_TOKEN_PLAN_WINDOW_MS = 5 * 60 * 60 * 1000; // 5h

/**
 * Persist a quota-exhausted snapshot (is_exhausted=1, next_reset_at=reset) for a
 * provider:connection when the upstream 429 body carries a parseable future reset
 * stamp. Self-gating on the error text so callers can invoke it unconditionally on
 * the combo exhaustion path without worrying about provider category / per-model-quota.
 *
 * Returns true when a snapshot was written (or already known), false when the error
 * is not a recoverable exhausted-quota window.
 */
export function persistQuotaExhaustionSnapshot(
  provider: string | null | undefined,
  connectionId: string | null | undefined,
  errorText: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!provider || !connectionId || provider === "unknown" || !errorText) return false;

  const lower = errorText.toLowerCase();

  // Alibaba token-plan 5h rollover is the distinctive case; generic ISO "reset at"
  // QUOTA_EXHAUSTED covers the rest. Parse a future reset stamp; if none, there's no
  // deterministic window to honor — leave the reactive cooldown in charge.
  const alibabaResetMs = isAlibabaTokenPlanQuotaText(lower)
    ? parseAlibabaTokenPlanResetMs(errorText, nowMs)
    : null;
  const genericResetMs =
    alibabaResetMs === null && classifyErrorText(lower) === RateLimitReason.QUOTA_EXHAUSTED
      ? parseRetryFromErrorText(errorText)
      : null;
  const resetMs = alibabaResetMs ?? genericResetMs;
  if (resetMs === null || resetMs <= 0) return false;

  const windowKey =
    alibabaResetMs !== null ? ALIBABA_TOKEN_PLAN_WINDOW_KEY : "session";
  const resetAt = new Date(nowMs + resetMs).toISOString();

  try {
    // Idempotence: skip when this window already has a known future-exhausted snapshot —
    // otherwise every 429 in the window would append a duplicate row.
    const existing = getLatestQuotaSnapshotsForConnection(connectionId);
    for (const row of existing) {
      if (!row.is_exhausted || row.window_key !== windowKey || !row.next_reset_at) continue;
      const rowReset = Date.parse(row.next_reset_at);
      if (Number.isFinite(rowReset) && rowReset > nowMs) return true; // already known
    }

    saveQuotaSnapshot({
      provider,
      connection_id: connectionId,
      window_key: windowKey,
      remaining_percentage: 0,
      is_exhausted: 1,
      next_reset_at: resetAt,
      window_duration_ms: alibabaResetMs !== null ? ALIBABA_TOKEN_PLAN_WINDOW_MS : null,
      raw_data: errorText.slice(0, 500),
    });
    return true;
  } catch {
    // Fail-open: never break combo routing because a snapshot write threw.
    return false;
  }
}
