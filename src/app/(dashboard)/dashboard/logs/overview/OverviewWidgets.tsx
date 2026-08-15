"use client";

// Dense overview widgets: micro stat tiles + model breakdown + provider stats.
// Fetches the same endpoints as /dashboard/analytics and /dashboard/provider-stats,
// rendered compact so they fit under the logs table without extra chrome.

import { useState, useEffect } from "react";
import { ModelTable } from "@/shared/components/analytics";

type Summary = {
  totalRequests?: number;
  successRatePct?: number;
  avgLatencyMs?: number;
  totalCost?: number;
  uniqueModels?: number;
  uniqueAccounts?: number;
  uniqueApiKeys?: number;
  totalTokens?: number;
};

type ProviderStat = {
  provider: string;
  totalRequests?: number;
  successfulRequests?: number;
  avgLatencyMs?: number;
  totalTokensIn?: number;
  totalTokensOut?: number;
};

function fmt(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtMs(ms: number | undefined | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtCost(n: number | undefined | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

const TILE_LABEL =
  "text-[9px] uppercase tracking-wide text-[var(--text-muted,#888)] leading-none whitespace-nowrap";
const TILE_VALUE = "text-[11px] font-semibold text-[var(--text-primary,#eee)] leading-tight";

function microTile(label: string, value: string) {
  return (
    <div
      key={label}
      className="flex flex-col justify-center px-1.5 py-0.5 rounded border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] min-w-0"
    >
      <div className={TILE_LABEL}>{label}</div>
      <div className={TILE_VALUE}>{value}</div>
    </div>
  );
}

export function OverviewStats() {
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/usage/analytics?range=30d");
        const data = await res.json();
        if (!cancelled) setS(data?.summary ?? null);
      } catch {
        /* transient */
      }
    };
    load();
    const int = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, []);

  if (!s) return null;

  return (
    <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-1">
      {microTile("Calls", fmt(s.totalRequests))}
      {microTile("Success", s.successRatePct != null ? `${s.successRatePct.toFixed(1)}%` : "—")}
      {microTile("Latency", fmtMs(s.avgLatencyMs))}
      {microTile("Tokens", fmt(s.totalTokens))}
      {microTile("Cost", fmtCost(s.totalCost))}
      {microTile("Models", String(s.uniqueModels ?? "—"))}
      {microTile("Accounts", String(s.uniqueAccounts ?? "—"))}
      {microTile("Keys", String(s.uniqueApiKeys ?? "—"))}
    </div>
  );
}

export function OverviewModelBreakdown() {
  const [range, setRange] = useState<"1d" | "7d" | "30d">("1d");
  const [state, setState] = useState<{ byModel: unknown[]; summary: Summary | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/usage/analytics?range=${range}`);
        const data = await res.json();
        if (!cancelled) setState({ byModel: data?.byModel ?? [], summary: data?.summary ?? null });
      } catch {
        /* transient */
      }
    };
    load();
    const int = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, [range]);

  const RANGES: Array<{ key: "1d" | "7d" | "30d"; label: string }> = [
    { key: "1d", label: "1d" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
  ];

  return (
    <div className="rounded-lg border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/40">
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted,#888)]">
          Model Breakdown
        </span>
        <div className="flex items-center rounded border border-[var(--border,#333)] overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                range === r.key
                  ? "bg-primary text-white"
                  : "bg-transparent text-[var(--text-muted,#888)] hover:text-[var(--text-primary,#eee)]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[300px] overflow-auto">
        {state ? (
          <ModelTable byModel={state.byModel as never} summary={state.summary as never} />
        ) : (
          <div className="p-3 text-xs text-text-muted">Loading…</div>
        )}
      </div>
    </div>
  );
}

export function OverviewProviderStats() {
  const [providers, setProviders] = useState<ProviderStat[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/provider-stats");
        const data = await res.json();
        if (!cancelled) setProviders(Array.isArray(data?.providers) ? data.providers : []);
      } catch {
        /* transient */
      }
    };
    load();
    const int = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, []);

  const ok = (p: ProviderStat): string => {
    if (!p.totalRequests) return "—";
    return `${(((p.successfulRequests ?? 0) / p.totalRequests) * 100).toFixed(1)}%`;
  };

  return (
    <div className="rounded-lg border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] overflow-hidden">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted,#888)] border-b border-border/60">
        Provider Usage
      </div>
      <div className="max-h-[300px] overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-[var(--card-bg,#1e1e2e)]">
            <tr className="text-[9px] uppercase text-[var(--text-muted,#888)]">
              <th className="text-left px-2 py-1">Provider</th>
              <th className="text-right px-2 py-1">Calls</th>
              <th className="text-right px-2 py-1">OK %</th>
              <th className="text-right px-2 py-1">Lat</th>
              <th className="text-right px-2 py-1">In</th>
              <th className="text-right px-2 py-1">Out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {(providers ?? []).map((p) => (
              <tr key={p.provider} className="hover:bg-bg-subtle/60">
                <td className="px-2 py-1 text-[var(--text-primary,#eee)] truncate max-w-[180px]">
                  {p.provider}
                </td>
                <td className="px-2 py-1 text-right font-mono">{fmt(p.totalRequests)}</td>
                <td className="px-2 py-1 text-right font-mono text-emerald-400">{ok(p)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmtMs(p.avgLatencyMs)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(p.totalTokensIn)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(p.totalTokensOut)}</td>
              </tr>
            ))}
            {(providers ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-center text-text-muted">
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
