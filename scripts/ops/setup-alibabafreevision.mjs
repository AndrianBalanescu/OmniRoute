/**
 * @file setup-alibabafreevision.mjs
 * @description Seed vision Alibaba free-tier quota and create alibabafreevision combo.
 *
 * @changes
 * - [2026-07-25] [Composer] - Initial alibabafreevision combo and quota seed script
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  classifyAlibabaVisionFreeTierQuotaEntries,
  mergeAlibabaFreeTierQuotaClassification,
  parseAlibabaFreeTierQuotaEntries,
  propagateAlibabaFreeTierEligibilityToSiblings,
} from "../../open-sse/services/alibabaFreeTierQuotaFetcher.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { getProviderConnections, updateProviderConnection } from "../../src/lib/db/providers.ts";

const MAIN_CONNECTION_ID = "3ba4489d-0e15-4b4c-b8b3-d9a106a1c296";
const MAIN2_CONNECTION_ID = "5e6315b9-c7a2-46d3-9ef8-b1756dd23a97";

const defaultPayloadPath = new URL("./alibabafreevision-quota.sample.json", import.meta.url);

async function main() {
  const payloadPath = process.argv[2] || defaultPayloadPath.pathname;
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));

  const visionEntries = parseAlibabaFreeTierQuotaEntries(payload);
  const vision = classifyAlibabaVisionFreeTierQuotaEntries(visionEntries);
  const snapshot = {
    text: { capableModels: [], noFreeTierModels: [], drainedModels: [], entries: [] },
    vision,
    multimodal: { capableModels: [], noFreeTierModels: [], drainedModels: [], entries: [] },
    audio: { capableModels: [], noFreeTierModels: [], drainedModels: [], entries: [] },
    entries: vision.entries,
  };

  const connections = await getProviderConnections({ provider: "alibaba" });
  const main = connections.find((c) => c.id === MAIN_CONNECTION_ID);
  if (!main) {
    throw new Error(`Alibaba main connection ${MAIN_CONNECTION_ID} not found`);
  }

  const mergedPsd = mergeAlibabaFreeTierQuotaClassification(
    { ...(main.providerSpecificData || {}), alibabaBillingMode: "free" },
    snapshot
  );

  await updateProviderConnection(MAIN_CONNECTION_ID, {
    providerSpecificData: mergedPsd,
  });
  await propagateAlibabaFreeTierEligibilityToSiblings("alibaba", MAIN_CONNECTION_ID, mergedPsd);

  const comboId = randomUUID();
  const now = new Date().toISOString();
  const combo = await createCombo({
    id: comboId,
    name: "alibabafreevision",
    strategy: "round-robin",
    sortOrder: 9,
    config: {
      maxRetries: 1,
      retryDelayMs: 2000,
      handoffThreshold: 0.85,
      handoffModel: "",
      maxMessagesForSummary: 30,
      trackMetrics: true,
      reasoningTokenBufferEnabled: true,
      zeroLatencyOptimizationsEnabled: false,
    },
    models: [
      {
        id: `alibabafreevision-wildcard-1-alibaba-${MAIN_CONNECTION_ID}`,
        kind: "provider-wildcard",
        providerId: "alibaba",
        modelPattern: "*",
        connectionId: MAIN_CONNECTION_ID,
        weight: 0,
        label: "main",
      },
      {
        id: `alibabafreevision-wildcard-2-alibaba-${MAIN2_CONNECTION_ID}`,
        kind: "provider-wildcard",
        providerId: "alibaba",
        modelPattern: "*",
        connectionId: MAIN2_CONNECTION_ID,
        weight: 0,
        label: "main-2",
      },
    ],
    isHidden: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });

  console.log(
    JSON.stringify(
      {
        comboId: combo.id,
        comboName: combo.name,
        visionCapableCount: vision.capableModels.length,
        visionDrainedCount: vision.drainedModels.length,
        sampleModels: vision.capableModels.slice(0, 5),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
