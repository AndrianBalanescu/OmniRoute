"use client";

// Compact combined Logs + Timeline overview (#4).
// Pure canvas-timeline on top + logs table bellow it, no widgets/titles/controls
// in between — everything visible on one screen without scrolling. Clicking a
// timeline row still selects the matching log entry via the shared ?id= deep-link.

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import RequestTimeline from "@/shared/components/RequestTimeline";
import { RequestLoggerV2 } from "@/shared/components";
import { OverviewStats, OverviewModelBreakdown, OverviewProviderStats } from "./OverviewWidgets";

function LogsOverviewContent() {
  const searchParams = useSearchParams();
  const [initialId] = useState(() => searchParams.get("id"));

  return (
    <div className="flex flex-col gap-1">
      {/* Micro stat tiles — dense, no chrome */}
      <OverviewStats />
      {/* Timeline canvas — compact: header/toolbar hidden, just the bars */}
      <div className="rounded-lg border border-[var(--border,#333)] bg-[var(--card-bg,#1e1e2e)] overflow-hidden min-h-0 shrink-0 h-[400px]">
        <RequestTimeline initialSelectedId={initialId} compact />
      </div>
      {/* Logs table — compact: toolbar/filters/hidden, only the rows */}
      <div className="min-h-0 h-[480px] overflow-hidden">
        <RequestLoggerV2 initialSelectedId={initialId} compact />
      </div>
      {/* Bottom dense widgets — model breakdown (70%) + provider usage (30%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-2">
        <OverviewModelBreakdown />
        <OverviewProviderStats />
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
