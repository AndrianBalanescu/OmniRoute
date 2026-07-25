/**
 * @file setup-alibabafree-categories.mjs
 * @description Seed multimodal/audio Alibaba free-tier quota and create category combos.
 *
 * @changes
 * - [2026-07-25] [Composer] - Initial alibabafreemultimodal and alibabafreeaudio setup
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  classifyAlibabaAudioFreeTierQuotaEntries,
  classifyAlibabaMultimodalFreeTierQuotaEntries,
  mergeAlibabaFreeTierQuotaClassification,
  parseAlibabaFreeTierQuotaEntries,
  propagateAlibabaFreeTierEligibilityToSiblings,
} from "../../open-sse/services/alibabaFreeTierQuotaFetcher.ts";
import { createCombo, getComboByName } from "../../src/lib/db/combos.ts";
import { getProviderConnections, updateProviderConnection } from "../../src/lib/db/providers.ts";

const MAIN_CONNECTION_ID = "3ba4489d-0e15-4b4c-b8b3-d9a106a1c296";
const MAIN2_CONNECTION_ID = "5e6315b9-c7a2-46d3-9ef8-b1756dd23a97";

const multimodalPayload = JSON.parse(
  readFileSync(new URL("./alibabafreemultimodal-quota.sample.json", import.meta.url), "utf8")
);
const audioPayload = JSON.parse(
  readFileSync(new URL("./alibabafreeaudio-quota.sample.json", import.meta.url), "utf8")
);

const EMPTY = { capableModels: [], noFreeTierModels: [], drainedModels: [], entries: [] };

async function ensureCombo(name, sortOrder, connectionIds) {
  const existing = await getComboByName(name);
  if (existing) {
    return existing;
  }

  const comboId = randomUUID();
  const now = new Date().toISOString();
  return createCombo({
    id: comboId,
    name,
    strategy: "round-robin",
    sortOrder,
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
    models: connectionIds.map((connectionId, index) => ({
      id: `${name}-wildcard-${index + 1}-alibaba-${connectionId}`,
      kind: "provider-wildcard",
      providerId: "alibaba",
      modelPattern: "*",
      connectionId,
      weight: 0,
      label: index === 0 ? "main" : "main-2",
    })),
    isHidden: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
}

async function main() {
  const multimodal = classifyAlibabaMultimodalFreeTierQuotaEntries(
    parseAlibabaFreeTierQuotaEntries(multimodalPayload)
  );
  const audio = classifyAlibabaAudioFreeTierQuotaEntries(
    parseAlibabaFreeTierQuotaEntries(audioPayload)
  );

  const connections = await getProviderConnections({ provider: "alibaba" });
  const main = connections.find((c) => c.id === MAIN_CONNECTION_ID);
  if (!main) {
    throw new Error(`Alibaba main connection ${MAIN_CONNECTION_ID} not found`);
  }

  const existingPsd = main.providerSpecificData || {};
  const mergedPsd = mergeAlibabaFreeTierQuotaClassification(existingPsd, {
    text: {
      capableModels: Array.isArray(existingPsd.alibabaFreeTierCapableModels)
        ? existingPsd.alibabaFreeTierCapableModels
        : [],
      noFreeTierModels: Array.isArray(existingPsd.alibabaNoFreeTierModels)
        ? existingPsd.alibabaNoFreeTierModels
        : [],
      drainedModels: Array.isArray(existingPsd.alibabaFreeDrainedModels)
        ? existingPsd.alibabaFreeDrainedModels
        : [],
      entries: [],
    },
    vision: {
      capableModels: Array.isArray(existingPsd.alibabaFreeTierVisionCapableModels)
        ? existingPsd.alibabaFreeTierVisionCapableModels
        : [],
      noFreeTierModels: Array.isArray(existingPsd.alibabaNoFreeTierVisionModels)
        ? existingPsd.alibabaNoFreeTierVisionModels
        : [],
      drainedModels: Array.isArray(existingPsd.alibabaFreeTierVisionDrainedModels)
        ? existingPsd.alibabaFreeTierVisionDrainedModels
        : [],
      entries: [],
    },
    multimodal,
    audio,
    entries: [...multimodal.entries, ...audio.entries],
  });

  await updateProviderConnection(MAIN_CONNECTION_ID, {
    providerSpecificData: mergedPsd,
  });
  await propagateAlibabaFreeTierEligibilityToSiblings("alibaba", MAIN_CONNECTION_ID, mergedPsd);

  const multimodalCombo = await ensureCombo("alibabafreemultimodal", 10, [
    MAIN_CONNECTION_ID,
    MAIN2_CONNECTION_ID,
  ]);
  const audioCombo = await ensureCombo("alibabafreeaudio", 11, [
    MAIN_CONNECTION_ID,
    MAIN2_CONNECTION_ID,
  ]);

  console.log(
    JSON.stringify(
      {
        multimodalComboId: multimodalCombo.id,
        audioComboId: audioCombo.id,
        multimodalCapableCount: multimodal.capableModels.length,
        audioCapableCount: audio.capableModels.length,
        multimodalSample: multimodal.capableModels.slice(0, 3),
        audioSample: audio.capableModels.slice(0, 3),
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
