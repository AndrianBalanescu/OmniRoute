/**
 * @file alibabaFreeTierQuotaAutoSync.ts
 * @description Periodic background sync for Alibaba Model Studio free-tier
 * quota snapshots (alibaba-free-quota-autosync).
 *
 * Every tick scans provider connections for the Model Studio providers
 * (alibaba / alibaba-cn / qwen-cloud) that (a) run in `free` billing mode,
 * (b) have console session auth (alibabaConsoleCookie), and (c) have not been
 * refreshed within ALIBABA_FREE_TIER_QUOTA_SYNC_INTERVAL_MS. For each, the
 * existing `scheduleAlibabaFreeTierQuotaRefresh` fire-and-forget task is
 * kicked, which fetches the console free-tier API, classifies entries and
 * persists + propagates them to sibling connections.
 *
 * Failures are intentionally non-fatal: a failed console pull leaves the
 * persisted snapshot untouched and the next tick retries after the interval.
 */

import { ALIBABA_FREE_TIER_QUOTA_SYNC_INTERVAL_MS } from "@/shared/constants/alibabaFreeTierQuotaAutoSync";

interface AutoSyncConnection {
  id: string;
  provider: string;
  providerSpecificData?: Record<string, unknown> | null;
}

/** Is a connection due for a refresh, given the persisted last-sync stamp? */
export function isAlibabaQuotaSyncDue(
  providerSpecificData: Record<string, unknown> | null | undefined,
  intervalMs: number = ALIBABA_FREE_TIER_QUOTA_SYNC_INTERVAL_MS,
  nowMs: number = Date.now()
): boolean {
  const raw = providerSpecificData?.alibabaFreeTierQuotaLastSyncAt;
  if (typeof raw !== "string" || raw.length === 0) return true;
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return true;
  return nowMs - stamp >= intervalMs;
}

export interface AlibabaQuotaAutoSyncState {
  running: boolean;
  lastTickAt: number | null;
}

export function createAlibabaQuotaAutoSyncState(): AlibabaQuotaAutoSyncState {
  return { running: false, lastTickAt: null };
}

/** Load eligible Alibaba connections for a sync pass. Exported for tests. */
export async function listAlibabaQuotaAutoSyncConnections(): Promise<AutoSyncConnection[]> {
  const [{ getProviderConnections }, alibabaFreeTier, quotaFetcher] = await Promise.all([
    import("@/lib/db/providers"),
    import("@omniroute/open-sse/services/alibabaFreeTier.ts"),
    import("@omniroute/open-sse/services/alibabaFreeTierQuotaFetcher.ts"),
  ]);
  const {
    isAlibabaModelStudioProvider,
    getAlibabaBillingMode,
    shouldUseLiveAlibabaFreeModelDiscovery,
  } = alibabaFreeTier;
  const { hasAlibabaConsoleFreeTierAuth } = quotaFetcher;

  const connections = await getProviderConnections();
  return connections
    .filter((connection) => {
      if (!isAlibabaModelStudioProvider(connection.provider)) return false;
      const psd = (connection.providerSpecificData ?? null) as Record<string, unknown> | null;
      if (getAlibabaBillingMode(psd) !== "free") return false;
      if (!shouldUseLiveAlibabaFreeModelDiscovery(psd)) return false;
      if (!hasAlibabaConsoleFreeTierAuth(psd)) return false;
      return true;
    })
    .map((connection) => ({
      id: String(connection.id),
      provider: String(connection.provider),
      providerSpecificData: (connection.providerSpecificData ?? null) as Record<
        string,
        unknown
      > | null,
    }));
}

/** One scheduler pass. Delegates to the deps (injectable for tests). */
export async function runAlibabaQuotaAutoSyncTick(
  deps: {
    listConnections: () => Promise<AutoSyncConnection[]>;
    refreshConnection: (connection: AutoSyncConnection) => void;
    now?: () => number;
  },
  state: AlibabaQuotaAutoSyncState
): Promise<number> {
  if (state.running) return 0;
  state.running = true;
  try {
    const connections = await deps.listConnections();
    const now = (deps.now ?? Date.now)();
    let scheduled = 0;
    const { scheduleAlibabaFreeTierQuotaRefresh } = await import(
      "@omniroute/open-sse/services/alibabaFreeTierQuotaFetcher.ts"
    );
    for (const connection of connections) {
      if (!isAlibabaQuotaSyncDue(connection.providerSpecificData, undefined, now)) continue;
      scheduleAlibabaFreeTierQuotaRefresh(connection.provider, {
        id: connection.id,
        providerSpecificData: connection.providerSpecificData,
      });
      deps.refreshConnection(connection);
      scheduled += 1;
    }
    state.lastTickAt = now;
    return scheduled;
  } finally {
    state.running = false;
  }
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const schedulerState = createAlibabaQuotaAutoSyncState();

/** Start the in-process scheduler. Idempotent — a second call is a no-op. */
export function startAlibabaFreeTierQuotaAutoSync(): void {
  if (schedulerInterval) return;

  const run = async (): Promise<void> => {
    if (schedulerState.running) return;
    schedulerState.running = true;
    try {
      const connections = await listAlibabaQuotaAutoSyncConnections();
      const { scheduleAlibabaFreeTierQuotaRefresh } = await import(
        "@omniroute/open-sse/services/alibabaFreeTierQuotaFetcher.ts"
      );
      for (const connection of connections) {
        if (!isAlibabaQuotaSyncDue(connection.providerSpecificData)) continue;
        scheduleAlibabaFreeTierQuotaRefresh(connection.provider, {
          id: connection.id,
          providerSpecificData: connection.providerSpecificData,
        });
      }
    } catch {
      // Non-fatal: keep the scheduler alive on transient DB/import errors.
    } finally {
      schedulerState.lastTickAt = Date.now();
      schedulerState.running = false;
    }
  };

  void run();
  schedulerInterval = setInterval(() => {
    void run();
  }, ALIBABA_FREE_TIER_QUOTA_SYNC_INTERVAL_MS);
  schedulerInterval.unref?.();
}

/** Stop the in-process scheduler. Idempotent — a second call is a no-op. */
export function stopAlibabaFreeTierQuotaAutoSync(): void {
  if (!schedulerInterval) return;
  clearInterval(schedulerInterval);
  schedulerInterval = null;
}