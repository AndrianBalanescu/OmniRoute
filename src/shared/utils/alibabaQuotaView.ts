/**
 * Aggregation helper for the Alibaba free-tier quota views. The provider
 * detail page addresses the quota endpoint by PROVIDER id, while snapshots
 * live per CONNECTION — the route resolves every Model Studio connection and
 * merges their views with this helper.
 */

export interface AlibabaQuotaViewInput {
  connectionId: string;
  billingMode: string;
  consoleAuth: boolean;
  lastSyncAt: string | null;
  live: boolean;
  entries: Array<Record<string, unknown> & { model?: string }>;
}

export interface AggregatedAlibabaQuotaView {
  billingMode: string;
  consoleAuth: boolean;
  lastSyncAt: string | null;
  live: boolean;
  entries: Array<Record<string, unknown> & { model?: string; connectionId?: string }>;
  summary: {
    totalModels: number;
    freeTierOnly: number;
    drained: number;
    totalQuotaInit: number;
    avgRemainingPct: number;
  };
}

/**
 * Merge per-connection quota views into one provider-level view. A "free"
 * billing mode wins over "paid" (free-tier quota is what the section shows);
 * the freshest live sync timestamp wins; entries keep their connection id so
 * the UI can attribute quota to a connection.
 */
export function aggregateAlibabaQuotaViews(
  views: AlibabaQuotaViewInput[]
): AggregatedAlibabaQuotaView {
  const entries: AggregatedAlibabaQuotaView["entries"] = [];
  let consoleAuth = false;
  let live = false;
  let billingMode = "paid";
  let lastSyncAt: string | null = null;
  let newestMs = 0;

  for (const view of views) {
    if (view.consoleAuth) consoleAuth = true;
    if (view.billingMode === "free") billingMode = "free";
    if (view.lastSyncAt) {
      const ms = Date.parse(view.lastSyncAt);
      if (Number.isFinite(ms) && ms > newestMs) {
        newestMs = ms;
        lastSyncAt = view.lastSyncAt;
      }
    }
    if (view.live) live = true;
    for (const entry of view.entries) {
      entries.push({ ...entry, connectionId: view.connectionId });
    }
  }

  const freeTierOnly = entries.filter((e) => e.freeTierOnly === true).length;
  const drained = entries.filter(
    (e) => typeof e.quotaTotalPercentage === "number" && (e.quotaTotalPercentage as number) <= 0
  ).length;
  const totalQuotaInit = entries.reduce(
    (sum, e) => sum + (typeof e.quotaInitTotal === "number" ? (e.quotaInitTotal as number) : 0),
    0
  );
  const pctSum = entries.reduce(
    (sum, e) =>
      sum + (typeof e.quotaTotalPercentage === "number" ? (e.quotaTotalPercentage as number) : 0),
    0
  );

  return {
    billingMode,
    consoleAuth,
    lastSyncAt,
    live,
    entries,
    summary: {
      totalModels: entries.length,
      freeTierOnly,
      drained,
      totalQuotaInit,
      avgRemainingPct: entries.length ? pctSum / entries.length : 0,
    },
  };
}
