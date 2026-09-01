"use client";

/**
 * ProviderAlibabaFreeTierQuotaSection — read-only per-model free-tier quota
 * visibility for Alibaba Model Studio connections.
 *
 * Renders a card on the provider detail page showing the persisted console
 * quota snapshot (entries written by alibabaFreeTierQuotaFetcher.ts), with a
 * manual "refresh" button hitting ?refresh=1 for a live console pull.
 * Hidden entirely for non-Alibaba providers (the API answers 400 for them).
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";

interface ProviderAlibabaFreeTierQuotaSectionProps {
  providerId: string;
}

interface FreeTierQuotaEntry {
  model: string;
  freeTierOnly: boolean;
  quotaStatus: string;
  quotaTotal?: number;
  quotaInitTotal?: number;
  quotaTotalPercentage?: number;
  quotaValidityPeriod?: number;
}

interface QuotaView {
  billingMode: string;
  consoleAuth: boolean;
  lastSyncAt: string | null;
  live: boolean;
  refreshed: boolean;
  entries: FreeTierQuotaEntry[];
  summary: {
    totalModels: number;
    freeTierOnly: number;
    drained: number;
    totalQuotaInit: number;
    avgRemainingPct: number;
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchQuotaView(
  providerId: string,
  refresh: boolean
): Promise<{ ok: boolean; view?: QuotaView; status?: number; error?: string }> {
  try {
    const res = await fetch(
      `/api/providers/${providerId}/quota/alibaba-free-tier${refresh ? "?refresh=1" : ""}`
    );
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const message =
        typeof errData?.error === "string"
          ? errData.error
          : typeof errData?.error?.message === "string"
            ? errData.error.message
            : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: message };
    }
    const data = await res.json();
    const view = data as Partial<QuotaView>;
    return {
      ok: true,
      view: {
        billingMode: view.billingMode ?? "unknown",
        consoleAuth: view.consoleAuth === true,
        lastSyncAt: view.lastSyncAt ?? null,
        live: view.live === true,
        refreshed: view.refreshed === true,
        entries: Array.isArray(view.entries) ? view.entries : [],
        summary: {
          totalModels: view.summary?.totalModels ?? 0,
          freeTierOnly: view.summary?.freeTierOnly ?? 0,
          drained: view.summary?.drained ?? 0,
          totalQuotaInit: view.summary?.totalQuotaInit ?? 0,
          avgRemainingPct: view.summary?.avgRemainingPct ?? 0,
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatRemainingPct(entry: FreeTierQuotaEntry): string {
  if (typeof entry.quotaTotalPercentage !== "number") return "—";
  return `${entry.quotaTotalPercentage.toFixed(1)}%`;
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function formatValidity(
  entry: FreeTierQuotaEntry,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (typeof entry.quotaValidityPeriod !== "number") return "—";
  const expiresMs = entry.quotaValidityPeriod * 1000;
  const days = Math.round((expiresMs - Date.now()) / 86_400_000);
  return days > 0 ? t("alibabaQuotaDaysLeft", { days }) : t("alibabaQuotaExpired");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProviderAlibabaFreeTierQuotaSection({
  providerId,
}: ProviderAlibabaFreeTierQuotaSectionProps) {
  const t = useTranslations("providers");
  const notify = useNotificationStore();
  const [view, setView] = useState<QuotaView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof fetchQuotaView>>, refresh: boolean) => {
      if (result.status === 400 || result.status === 404) {
        // Not an Alibaba connection (or deleted) — hide the card entirely.
        setHidden(true);
        return;
      }
      if (!result.ok) {
        if (refresh) {
          notify.addNotification({
            type: "error",
            message: t("alibabaQuotaRefreshError", { error: result.error ?? "unknown" }),
          });
        }
      } else if (result.view) {
        setView(result.view);
        if (refresh && result.view.refreshed) {
          notify.addNotification({ type: "success", message: t("alibabaQuotaRefreshSuccess") });
        }
      }
    },
    [notify, t]
  );

  const load = useCallback(
    async (refresh: boolean) => {
      setRefreshing(true);
      const result = await fetchQuotaView(providerId, refresh);
      applyResult(result, refresh);
      setLoading(false);
      setRefreshing(false);
    },
    [providerId, applyResult]
  );

  useEffect(() => {
    const run = async () => {
      const result = await fetchQuotaView(providerId, false);
      applyResult(result, false);
      setLoading(false);
    };
    void run();
  }, [providerId, applyResult]);

  if (hidden) return null;

  const summary = view?.summary;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t("alibabaQuotaSectionTitle")}
            {view?.live ? (
              <span className="ml-2 text-xs font-normal text-success">
                {t("alibabaQuotaLive")} ·{" "}
                {view.lastSyncAt ? new Date(view.lastSyncAt).toLocaleString() : ""}
              </span>
            ) : (
              <span className="ml-2 text-xs font-normal text-muted">
                {t("alibabaQuotaBuiltinEstimate")}
              </span>
            )}
          </h3>
          {summary && (
            <p className="mt-0.5 text-xs text-muted">
              {summary.totalModels} {t("alibabaQuotaModels")} · {summary.freeTierOnly}{" "}
              {t("alibabaQuotaFreeOnly")} · {summary.drained} {t("alibabaQuotaDrained")} · ~
              {formatCount(summary.totalQuotaInit)} {t("alibabaQuotaTokensTotal")}
            </p>
          )}
        </div>
        <button
          type="button"
          className="rounded border border-border px-3 py-1 text-xs font-medium hover:bg-surface-strong disabled:opacity-50"
          disabled={refreshing || loading}
          onClick={() => void load(true)}
        >
          {refreshing ? t("alibabaQuotaRefreshing") : t("alibabaQuotaRefresh")}
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-muted">{t("alibabaQuotaLoading")}</p>
      ) : !view || view.entries.length === 0 ? (
        <p className="text-xs text-muted">
          {view?.consoleAuth ? t("alibabaQuotaNoSnapshot") : t("alibabaQuotaNoConsoleAuth")}
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3">{t("alibabaQuotaModel")}</th>
                <th className="py-1 pr-3">{t("alibabaQuotaRemaining")}</th>
                <th className="py-1 pr-3">{t("alibabaQuotaInitQuota")}</th>
                <th className="py-1 pr-3">{t("alibabaQuotaValidity")}</th>
                <th className="py-1 pr-3">{t("alibabaQuotaStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {view.entries.map((entry) => (
                <tr key={entry.model} className="border-t border-border">
                  <td className="py-1 pr-3 font-mono">{entry.model}</td>
                  <td className="py-1 pr-3">{formatRemainingPct(entry)}</td>
                  <td className="py-1 pr-3">{formatCount(entry.quotaInitTotal)}</td>
                  <td className="py-1 pr-3">{formatValidity(entry, t)}</td>
                  <td className="py-1 pr-3">
                    {entry.freeTierOnly ? t("alibabaQuotaFreeOnlyTag") : entry.quotaStatus || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
