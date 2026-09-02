import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * TDD guards for the two Alibaba free-quota UI integration bugs found on
 * 2026-09-01 (personal/stable):
 *
 * 1. Model test prefix bug — the provider detail page sends the display alias
 *    (`ali/qwen3.8-max`) to runSingleModelTest, which re-prefixed it to
 *    `alibaba/ali/qwen3.8-max` because it only recognized its own provider id
 *    and the compatible-node prefix. Requests then failed with
 *    "Model 'ali/qwen3.8-max' is not available in the active live catalog".
 *
 * 2. Quota section endpoint contract — GET /api/providers/[id]/quota/
 *    alibaba-free-tier is addressed by PROVIDER id (e.g. "alibaba") from the
 *    page, but the handler looked up a CONNECTION by that id, which never
 *    exists, so the section silently hid itself (404 path).
 */

// ─── Bug 1: alias-aware model-id normalization ──────────────────────────────

test("modelTestRunner: strips a leading provider alias before re-prefixing", async () => {
  const { resolveAliasPrefixedModelId } =
    await import("../../src/lib/api/modelTestIdResolution.ts");

  assert.equal(resolveAliasPrefixedModelId("alibaba", "ali/qwen3.8-max"), "qwen3.8-max");
  assert.equal(resolveAliasPrefixedModelId("alibaba", "alibaba/qwen3.8-max"), "qwen3.8-max");
  // idempotent for a bare leaf id
  assert.equal(resolveAliasPrefixedModelId("alibaba", "qwen3.8-max"), "qwen3.8-max");
  // other providers' aliases resolve through the same helper
  assert.equal(resolveAliasPrefixedModelId("zai", "zai/glm-5.2"), "glm-5.2");
  // unrelated leading segment that is NOT the provider id/alias is preserved
  assert.equal(resolveAliasPrefixedModelId("alibaba", "other/qwen3.8-max"), "other/qwen3.8-max");
});

test("modelTestRunner: buildInternalChatRequest-style leaf derivation ignores alias prefix", async () => {
  const { getModelLeafId } = await import("../../src/lib/api/modelTestIdResolution.ts");
  assert.equal(getModelLeafId("ali/qwen3.8-max"), "qwen3.8-max");
  assert.equal(getModelLeafId("alibaba/ali/qwen3.8-max"), "qwen3.8-max");
  assert.equal(getModelLeafId("qwen3.8-max"), "qwen3.8-max");
});

// ─── Bug 2: quota endpoint aggregation contract ──────────────────────────────

test("alibaba free-tier quota route helper: aggregates per-connection views under a provider id", async () => {
  const { aggregateAlibabaQuotaViews } = await import("../../src/shared/utils/alibabaQuotaView.ts");

  const view = aggregateAlibabaQuotaViews([
    {
      connectionId: "conn-1",
      billingMode: "free",
      consoleAuth: true,
      lastSyncAt: "2026-09-01T02:00:00.000Z",
      live: true,
      entries: [
        {
          model: "qwen3.8-max",
          freeTierOnly: true,
          quotaStatus: "active",
          quotaTotalPercentage: 50,
        },
      ],
    },
    {
      connectionId: "conn-2",
      billingMode: "paid",
      consoleAuth: false,
      lastSyncAt: null,
      live: false,
      entries: [],
    },
  ]);

  assert.equal(view.billingMode, "free"); // any free connection wins
  assert.equal(view.consoleAuth, true);
  assert.equal(view.live, true);
  assert.equal(view.entries.length, 1);
  assert.equal(view.summary.totalModels, 1);
  // connection attribution kept so the UI can show which connection serves what
  assert.equal(view.entries[0].connectionId, "conn-1");
});

test("alibaba free-tier quota route helper: empty connection list yields empty non-live view", async () => {
  const { aggregateAlibabaQuotaViews } = await import("../../src/shared/utils/alibabaQuotaView.ts");

  const view = aggregateAlibabaQuotaViews([]);
  assert.equal(view.consoleAuth, false);
  assert.equal(view.live, false);
  assert.equal(view.entries.length, 0);
  assert.equal(view.summary.totalModels, 0);
});
