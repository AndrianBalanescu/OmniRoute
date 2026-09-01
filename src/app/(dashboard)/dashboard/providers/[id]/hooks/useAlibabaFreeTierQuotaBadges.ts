"use client";

/**
 * @file useAlibabaFreeTierQuotaBadges.ts
 * @description Loads the persisted Alibaba Model Studio free-tier quota
 * snapshot (GET /api/providers/[id]/quota/alibaba-free-tier) and exposes a
 * modelId -> badge-info map plus an optional manual refresh.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deriveAlibabaModelQuotaBadge,
  type AlibabaFreeTierQuotaEntryLike,
  type AlibabaModelQuotaBadgeInfo,
} from "@/shared/utils/alibabaModelQuotaBadge";

export type AlibabaQuotaBadgeMap = Record<string, AlibabaModelQuotaBadgeInfo>;

interface QuotaViewResponse {
  billingMode?: string;
  consoleAuth?: boolean;
  entries?: AlibabaFreeTierQuotaEntryLike[];
  live?: boolean;
  lastSyncAt?: string | null;
}

export interface UseAlibabaQuotaBadgesResult {
  badges: AlibabaQuotaBadgeMap;
  lastSyncAt: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches the free-tier snapshot for one Model Studio provider connection and
 * derives per-model badge info. No-op (empty map) for other providers, when
 * there is no console auth, or when the snapshot has no entries.
 */
export function useAlibabaFreeTierQuotaBadges(
  providerId: string,
  options: { enabled?: boolean; connectionId?: string | null } = {}
): UseAlibabaQuotaBadgesResult {
  const { enabled = true, connectionId = null } = options;
  const [badges, setBadges] = useState<AlibabaQuotaBadgeMap>({});
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!enabled || !providerId) return;
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams();
        if (connectionId) params.set("connectionId", connectionId);
        if (refresh) params.set("refresh", "1");
        const qs = params.toString();
        const res = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}/quota/alibaba-free-tier${qs ? `?${qs}` : ""}`
        );
        if (!res.ok) {
          if (mountedRef.current) {
            setBadges({});
            setLastSyncAt(null);
          }
          return;
        }
        const data = (await res.json()) as QuotaViewResponse;
        if (!mountedRef.current) return;
        setLastSyncAt(data.lastSyncAt ?? null);
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const next: AlibabaQuotaBadgeMap = {};
        for (const entry of entries) {
          if (!entry || typeof entry.model !== "string") continue;
          const badge = deriveAlibabaModelQuotaBadge(entry);
          if (badge) next[entry.model] = badge;
        }
        setBadges(next);
      } catch {
        if (mountedRef.current) {
          setBadges({});
          setLastSyncAt(null);
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [enabled, providerId, connectionId]
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  return { badges, lastSyncAt, loading, refreshing, refresh };
}