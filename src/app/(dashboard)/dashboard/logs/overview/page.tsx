"use client";

// Compact combined Logs + Timeline overview (#4).
// Puts the request timeline canvas on top of the logs table plus a slim
// top widget with compute + LLM stats — reusing the existing RequestTimeline,
// RequestLoggerV2 and the health/telemetry endpoints instead of duplicating
// them. Clicking a timeline row selects the matching log entry via the shared
// ?id= deep-link both components already honor.

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import RequestTimeline from "@/shared/components/RequestTimeline";
import { RequestLoggerV2 } from "@/shared/components";

type Telemetry = {
  totalRequests?: number;
  errorRate?: number;
  successRate?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  uptime?: number;
  memoryUsage?: { heapUsed?: number; heapTotal?: number; rss?: number };
  activeConnections?: number;
  quotaMonitor?: { exhausted?: number; alerting?: number; healthy?: number };
};

// Slim read-only strip of compute + LLM stat tiles on top of the page.
function StatsStrip() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [tRes, hRes] = await Promise.all([
          fetch("/api/telemetry/summary"),
          fetch("/api/monitoring/health"),
        ]);
        const [t, h] = (await Promise.all([tRes.json(), hRes.json()])) as [
          Telemetry,
          Record<string, unknown>,
        ];
        if (cancelled) return;
        setTelemetry(t);
        setHealth(h);
      } catch {
        /* transient — strip can stay empty */
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const memMb = telemetry?.memoryUsage?.rss
    ? Math.round(telemetry.memoryUsage.rss / 1048576)
    : null;
  const heapMb = telemetry?.memoryUsage?.heapUsed
    ? Math.round(telemetry.memoryUsage.heapUsed / 1048576)
    : null;
  const uptimeDays = telemetry?.uptime ? Math.floor(telemetry.uptime / 86400) : null;
  const exposed = health; // keep for future provider-breaker tiles

  const tiles: Array<{ label: string; value: string | null }> = [
    {
      label: "Requests",
      value: telemetry?.totalRequests != null ? String(telemetry.totalRequests) : null,
    },
    {
      label: "Err %",
      value: telemetry?.errorRate != null ? `${telemetry.errorRate.toFixed(1)}%` : null,
    },
    {
      label: "Success %",
      value: telemetry?.successRate != null ? `${telemetry.successRate.toFixed(1)}%` : null,
    },
    {
      label: "p50 (ms)",
      value: telemetry?.latencyP50Ms != null ? String(Math.round(telemetry.latencyP50Ms)) : null,
    },
    { label: "RSS (MB)", value: memMb != null ? String(memMb) : null },
    { label: "Heap (MB)", value: heapMb != null ? String(heapMb) : null },
    {
      label: "Active conns",
      value: telemetry?.activeConnections != null ? String(telemetry.activeConnections) : null,
    },
    { label: "Uptime", value: uptimeDays != null ? `${uptimeDays}d` : null },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-8 gap-2">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-lg border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted,#888)]">
            {tile.label}
          </div>
          <div className="text-sm font-semibold text-[var(--text-primary,#eee)]">
            {tile.value ?? "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

function LogsOverviewContent() {
  const searchParams = useSearchParams();
  const [initialId] = useState(() => searchParams.get("id"));

  return (
    <div className="flex flex-col gap-4">
      <StatsStrip />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-main">Request Timeline + Logs</h2>
      </div>
      {/* Timeline canvas — clicking selects a log via ?id= deep-link */}
      <div className="rounded-lg border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] p-2 min-h-0">
        <RequestTimeline initialSelectedId={initialId} />
      </div>
      {/* Logs table — same data, filters/search intact */}
      <div className="min-h-0">
        <RequestLoggerV2 initialSelectedId={initialId} />
      </div>
    </div>
  );
}

export default function LogsOverviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12 text-text-muted text-sm">
          Loading overview...
        </div>
      }
    >
      <LogsOverviewContent />
    </Suspense>
  );
}
