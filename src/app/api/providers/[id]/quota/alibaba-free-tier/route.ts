import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { getRawProviderConnections, updateProviderConnection } from "@/lib/db/providers";
import { parseProviderSpecificData } from "@/lib/db/webSessionDedup";
import {
  refreshAlibabaFreeTierQuotaClassification,
  hasAlibabaConsoleFreeTierAuth,
  scheduleAlibabaFreeTierQuotaRefresh,
  propagateAlibabaFreeTierEligibilityToSiblings,
} from "@omniroute/open-sse/services/alibabaFreeTierQuotaFetcher.ts";
import {
  getAlibabaBillingMode,
  isAlibabaModelStudioProvider,
} from "@omniroute/open-sse/services/alibabaFreeTier.ts";
import {
  getAlibabaFreeTierQuotaLastSyncAt,
  isAlibabaLiveQuotaSyncAt,
  type AlibabaFreeTierQuotaEntry,
} from "@omniroute/open-sse/services/alibabaFreeTierQuotaTypes.ts";
import { aggregateAlibabaQuotaViews } from "@/shared/utils/alibabaQuotaView";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export const dynamic = "force-dynamic";

/**
 * The provider detail page addresses this endpoint by PROVIDER id (e.g.
 * "alibaba"), while quota snapshots live per CONNECTION. When the id does not
 * resolve to a connection, aggregate every active Model Studio connection's
 * view instead of 404-ing (the section silently hid itself before —
 * 2026-09-01 incident).
 */
async function resolveQuotaViews(id: string) {
  const byId = await getCachedProviderConnectionById(id);
  if (byId) return { connections: [byId], addressedAsConnection: true };
  if (!isAlibabaModelStudioProvider(id)) return { connections: [], addressedAsConnection: false };
  const connections = await getRawProviderConnections(
    { provider: id, isActive: true },
    undefined,
    undefined,
    ["id", "provider", "provider_specific_data"]
  );
  return { connections, addressedAsConnection: false };
}

function asPsdRecord(psd: unknown): Record<string, unknown> {
  return psd && typeof psd === "object" && !Array.isArray(psd)
    ? (psd as Record<string, unknown>)
    : {};
}

function summarizeEntries(entries: AlibabaFreeTierQuotaEntry[]) {
  return {
    totalModels: entries.length,
    freeTierOnly: entries.filter((e) => e.freeTierOnly).length,
    drained: entries.filter(
      (e) => typeof e.quotaTotalPercentage === "number" && e.quotaTotalPercentage <= 0
    ).length,
    totalQuotaInit: entries.reduce((sum, e) => sum + (e.quotaInitTotal ?? 0), 0),
    avgRemainingPct: entries.length
      ? entries.reduce(
          (sum, e) =>
            sum + (typeof e.quotaTotalPercentage === "number" ? e.quotaTotalPercentage : 0),
          0
        ) / entries.length
      : 0,
  };
}

function buildQuotaView(psd: Record<string, unknown>) {
  const entries = Array.isArray(psd.alibabaFreeTierQuotaEntries)
    ? (psd.alibabaFreeTierQuotaEntries as AlibabaFreeTierQuotaEntry[])
    : [];
  const lastSyncAt = getAlibabaFreeTierQuotaLastSyncAt(psd);
  return {
    billingMode: getAlibabaBillingMode(psd),
    consoleAuth: hasAlibabaConsoleFreeTierAuth(psd),
    lastSyncAt,
    live: isAlibabaLiveQuotaSyncAt(lastSyncAt),
    entries,
    summary: summarizeEntries(entries),
  };
}

/**
 * GET /api/providers/[id]/quota/alibaba-free-tier
 *
 * Returns the persisted per-model free-tier quota snapshot for an Alibaba Model
 * Studio connection. Data is stored on the connection by the console quota
 * refresher (providerSpecificData.alibabaFreeTierQuotaEntries, key format from
 * the bailian freeTrial console API: quotaInitTotal / quotaTotalPercentage /
 * quotaValidityPeriod).
 *
 * Query params:
 * - refresh=1 — force a live console pull before answering (requires console
 *   cookie auth). Falls back to the persisted snapshot if the console is
 *   unreachable; responds 409 when the connection has no console auth at all.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const { connections, addressedAsConnection } = await resolveQuotaViews(id);
    const connection = connections[0];

    if (!connection && !addressedAsConnection) {
      return NextResponse.json(buildErrorBody("Connection not found"), { status: 404 });
    }

    if (connection && !isAlibabaModelStudioProvider(connection.provider)) {
      return NextResponse.json(buildErrorBody("Not an Alibaba Model Studio connection"), {
        status: 400,
      });
    }

    const wantsRefresh = new URL(request.url).searchParams.get("refresh") === "1";

    // Provider-addressed aggregate view: merge every active connection.
    if (!addressedAsConnection) {
      const views = connections.map((row) => {
        const psd = parseProviderSpecificData(
          (row as { provider_specific_data?: unknown }).provider_specific_data
        );
        return { connectionId: row.id as string, ...buildQuotaView(psd ?? {}) };
      });
      const aggregated = aggregateAlibabaQuotaViews(views);
      return NextResponse.json({ providerId: id, refreshed: false, ...aggregated });
    }

    const psd = asPsdRecord(connection?.providerSpecificData);

    if (wantsRefresh) {
      if (!hasAlibabaConsoleFreeTierAuth(psd)) {
        return NextResponse.json(
          buildErrorBody("Connection lacks Alibaba console cookie auth for live quota refresh"),
          { status: 409 }
        );
      }

      const merged = await refreshAlibabaFreeTierQuotaClassification(
        connection.provider,
        psd
      ).catch(() => null);

      if (merged) {
        await updateProviderConnection(id, { providerSpecificData: merged });
        await propagateAlibabaFreeTierEligibilityToSiblings(connection.provider, id, merged);
        scheduleAlibabaFreeTierQuotaRefresh(connection.provider, {
          id,
          providerSpecificData: merged,
        });
        return NextResponse.json({ connectionId: id, refreshed: true, ...buildQuotaView(merged) });
      }
      // Console unreachable — fall through to the persisted snapshot below.
    }

    return NextResponse.json({ connectionId: id, refreshed: false, ...buildQuotaView(psd) });
  } catch (error) {
    console.log("Error building alibaba free-tier quota view:", error);
    return NextResponse.json(
      buildErrorBody(sanitizeErrorMessage(error, "Failed to build free-tier quota view")),
      { status: 500 }
    );
  }
}
