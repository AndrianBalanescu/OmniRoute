/**
 * @file alibabaModelQuotaBadge.ts
 * @description Helper functions to render free-tier quota badges on ModelRow
 * items for Alibaba Model Studio providers (1M free tokens/model).
 */

export interface AlibabaModelQuotaBadgeInfo {
  status: "available" | "drained" | "unknown" | "not_free";
  label: string;
  tooltip: string;
  className: string;
  remainingTokens?: number;
  percentage?: number;
}

export interface AlibabaFreeTierQuotaEntryLike {
  model: string;
  freeTierOnly?: boolean;
  quotaStatus?: string;
  quotaTotal?: number;
  quotaInitTotal?: number;
  quotaTotalPercentage?: number;
  quotaValidityPeriod?: number;
}

/** Short token formatter: 1_000_000 -> "1M", 450_000 -> "450k", 0 -> "0". */
export function formatQuotaTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    return val % 1 === 0 ? `${val}M` : `${val.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000;
    return val % 1 === 0 ? `${val}k` : `${val.toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Derive badge state + copy from an entry snapshot.
 * Safe against missing/partial entries.
 */
export function deriveAlibabaModelQuotaBadge(
  entry: AlibabaFreeTierQuotaEntryLike | null | undefined,
  nowMs: number = Date.now()
): AlibabaModelQuotaBadgeInfo | null {
  if (!entry) return null;

  // Validity expired?
  if (
    typeof entry.quotaValidityPeriod === "number" &&
    Number.isFinite(entry.quotaValidityPeriod) &&
    entry.quotaValidityPeriod < nowMs
  ) {
    return {
      status: "not_free",
      label: "Expired",
      tooltip: "Free-tier quota validity period has expired",
      className: "border-red-500/40 bg-red-500/10 text-red-400",
    };
  }

  // Not a free-tier-only model (paid / no free grant)
  if (entry.freeTierOnly === false && !entry.quotaTotal && !entry.quotaInitTotal) {
    return null;
  }

  const quotaStatus = (entry.quotaStatus || "UNKNOWN").toUpperCase();

  // Explicit VALID status with numeric totals
  if (quotaStatus === "VALID") {
    const total = typeof entry.quotaTotal === "number" ? entry.quotaTotal : null;
    const initTotal = typeof entry.quotaInitTotal === "number" ? entry.quotaInitTotal : null;
    const pct =
      typeof entry.quotaTotalPercentage === "number"
        ? Math.round(entry.quotaTotalPercentage)
        : total !== null && initTotal !== null && initTotal > 0
          ? Math.round((total / initTotal) * 100)
          : undefined;

    if (total !== null && total <= 0) {
      return {
        status: "drained",
        label: "Free 0",
        tooltip: "Free-tier quota drained (0 tokens remaining)",
        className: "border-amber-500/50 bg-amber-500/15 text-amber-300 font-medium",
        remainingTokens: 0,
        percentage: 0,
      };
    }

    const label =
      total !== null
        ? `Free ${formatQuotaTokens(total)}${pct !== undefined ? ` (${pct}%)` : ""}`
        : "Free Tier";

    return {
      status: "available",
      label,
      tooltip:
        total !== null
          ? `${total.toLocaleString()} tokens remaining of free tier grant`
          : "Free tier active",
      className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 font-medium",
      remainingTokens: total ?? undefined,
      percentage: pct,
    };
  }

  if (quotaStatus === "EXPIRED" || quotaStatus === "INVALID") {
    return {
      status: "drained",
      label: "Free 0",
      tooltip: `Free-tier quota status: ${quotaStatus}`,
      className: "border-amber-500/50 bg-amber-500/15 text-amber-300 font-medium",
      remainingTokens: 0,
      percentage: 0,
    };
  }

  // UNKNOWN / missing details: capable model marker
  return {
    status: "unknown",
    label: "Free Tier",
    tooltip: "Free tier capable model",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400/90",
  };
}