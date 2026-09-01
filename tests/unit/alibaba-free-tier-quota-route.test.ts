/**
 * tests/unit/alibaba-free-tier-quota-route.test.ts
 *
 * Source-level assertions for GET /api/providers/[id]/quota/alibaba-free-tier
 * (same technique as tests/unit/quota-groups-route.test.ts — runs on the Node
 * native test runner without a Next.js/DOM setup).
 *
 * Coverage:
 *   - Auth guard (requireManagementAuth before any data access)
 *   - Provider gate (isAlibabaModelStudioProvider, 400 for others)
 *   - 404 on missing connection
 *   - refresh=1 path: 409 without console auth, live pull + DB persist +
 *     sibling propagation when authed, graceful fallthrough to persisted data
 *   - Error sanitization (buildErrorBody/sanitizeErrorMessage, no raw stacks)
 *   - force-dynamic export
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROUTE_PATH = join(ROOT, "src/app/api/providers/[id]/quota/alibaba-free-tier/route.ts");

const src = readFileSync(ROUTE_PATH, "utf8");

function getHandlerBody(name: "GET"): string {
  const idx = src.indexOf(`export async function ${name}`);
  assert.ok(idx >= 0, `${name} handler must exist`);
  return src.slice(idx);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

test("route: imports requireManagementAuth", () => {
  assert.ok(src.includes("requireManagementAuth"), "route must use management auth");
});

test("route: GET calls requireManagementAuth before any data access", () => {
  const getBody = getHandlerBody("GET");
  const authIdx = getBody.indexOf("requireManagementAuth(request)");
  const dataIdx = getBody.indexOf("getCachedProviderConnectionById(id)");
  assert.ok(authIdx >= 0, "auth call must be present in GET");
  assert.ok(dataIdx >= 0, "data access must be present in GET");
  assert.ok(authIdx < dataIdx, "auth check must come before data access");
});

test("route: GET returns authError early (401 without auth)", () => {
  const getBody = getHandlerBody("GET");
  assert.ok(
    getBody.includes("if (authError) return authError"),
    "GET must return authError immediately"
  );
});

// ── Provider + 404 gates ─────────────────────────────────────────────────────

test("route: returns 404 when connection is missing", () => {
  const getBody = getHandlerBody("GET");
  const notFoundIdx = getBody.indexOf('buildErrorBody("Connection not found")');
  assert.ok(notFoundIdx >= 0, "must return a sanitized 404 body");
  assert.ok(getBody.includes("{ status: 404 }"), "404 status must accompany the not-found body");
});

test("route: rejects non-Alibaba Model Studio connections with 400", () => {
  const getBody = getHandlerBody("GET");
  const gateIdx = getBody.indexOf("isAlibabaModelStudioProvider(connection.provider)");
  const quotaViewIdx = getBody.indexOf("buildQuotaView(psd)");
  assert.ok(gateIdx >= 0, "provider gate must be checked");
  assert.ok(gateIdx < quotaViewIdx, "provider gate must run before any quota data is built");
  assert.ok(/status:\s*400/.test(getBody), "400 status for non-alibaba providers");
});

// ── refresh=1 path ───────────────────────────────────────────────────────────

test("route: refresh path rejects 409 when console auth is missing", () => {
  const getBody = getHandlerBody("GET");
  const refreshIdx = getBody.indexOf('searchParams.get("refresh") === "1"');
  const authCheckIdx = getBody.indexOf("hasAlibabaConsoleFreeTierAuth(psd)");
  assert.ok(refreshIdx >= 0, "refresh query param must be parsed");
  assert.ok(authCheckIdx >= 0, "console auth must be checked for refresh");
  assert.ok(refreshIdx < authCheckIdx, "auth check follows refresh intent");
  assert.ok(getBody.includes("{ status: 409 }"), "409 when console auth is absent");
});

test("route: refresh path persists merged psd and propagates to siblings", () => {
  const getBody = getHandlerBody("GET");
  const refreshIdx = getBody.indexOf("refreshAlibabaFreeTierQuotaClassification(");
  const persistIdx = getBody.indexOf(
    "updateProviderConnection(id, { providerSpecificData: merged })"
  );
  const propagateIdx = getBody.indexOf("propagateAlibabaFreeTierEligibilityToSiblings(");
  assert.ok(refreshIdx >= 0, "live refresh must call the shared fetcher");
  assert.ok(persistIdx >= 0, "merged psd must be persisted");
  assert.ok(propagateIdx >= 0, "eligibility must propagate to sibling connections");
  assert.ok(
    refreshIdx < persistIdx && persistIdx < propagateIdx,
    "refresh → persist → propagate order"
  );
});

test("route: refresh failure falls back to persisted snapshot (no throw)", () => {
  const getBody = getHandlerBody("GET");
  const catchIdx = getBody.indexOf(".catch(() => null)");
  const fallthroughIdx = getBody.indexOf("refreshed: false, ...buildQuotaView(psd)");
  assert.ok(catchIdx >= 0, "refresh errors must be swallowed to null");
  assert.ok(fallthroughIdx >= 0, "must fall through to the persisted view");
  assert.ok(catchIdx < fallthroughIdx, "fallback must follow the refresh attempt");
});

// ── Error sanitization + caching ─────────────────────────────────────────────

test("route: 500 handler routes through buildErrorBody + sanitizeErrorMessage", () => {
  const getBody = getHandlerBody("GET");
  assert.ok(getBody.includes("buildErrorBody(sanitizeErrorMessage("), "500 body must be sanitized");
  assert.ok(!getBody.includes("err.stack"), "no raw stack in responses");
});

test("route: exports force-dynamic", () => {
  assert.ok(src.includes('export const dynamic = "force-dynamic"'), "must be force-dynamic");
});

// ── View shape ───────────────────────────────────────────────────────────────

test("route: view exposes per-model quota fields + lastSyncAt liveness", () => {
  assert.ok(src.includes("alibabaFreeTierQuotaEntries"), "must read persisted entries");
  assert.ok(src.includes("getAlibabaFreeTierQuotaLastSyncAt"), "must expose lastSyncAt");
  assert.ok(src.includes("isAlibabaLiveQuotaSyncAt"), "must distinguish live vs builtin fallback");
  assert.ok(src.includes("quotaInitTotal"), "summary must aggregate init totals");
  assert.ok(src.includes("quotaTotalPercentage"), "summary must consider remaining percentage");
  assert.ok(src.includes("freeTierOnly"), "summary must count freeTierOnly models");
});
