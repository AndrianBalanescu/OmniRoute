#!/usr/bin/env node
/**
 * scripts/sync-openrouter-pricing.mjs
 *
 * Scans all custom models, aliases, and synced provider models in OmniRoute SQLite DB,
 * fetches the latest pricing from OpenRouter API, matches the rates per token,
 * converts to USD/1M tokens, and saves them into the 'pricing' and 'models_dev_pricing' namespaces.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = process.env.OMNIROUTE_DB_PATH || join(homedir(), ".omniroute", "storage.sqlite");

async function getDatabase() {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(DB_PATH);
  }
  const { default: Database } = await import("better-sqlite3");
  return new Database(DB_PATH);
}

async function main() {
  console.log(`Connecting to OmniRoute database at ${DB_PATH}...`);
  const db = await getDatabase();

  console.log("Fetching live catalog from OpenRouter (https://openrouter.ai/api/v1/models)...");
  const resp = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "User-Agent": "OmniRoute/1.0" },
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter API error: ${resp.status} ${resp.statusText}`);
  }

  const { data: orModels } = await resp.json();
  console.log(`Fetched ${orModels.length} models from OpenRouter.`);

  const normalizeName = (s) => {
    let base = s.split("/").pop() || s;
    base = base.replace(/\.(gguf|bin|pt|safetensors)$/i, "");
    base = base.replace(/-Q[0-9]_[A-Z0-9_]+/i, "");
    base = base.split(":")[0];
    return base.toLowerCase().replace(/[^a-z0-9]/g, "");
  };

  const orByFullId = new Map();
  const orByShortName = new Map();
  const orByNorm = new Map();

  for (const m of orModels) {
    const mid = m.id;
    const mname = m.name || "";
    const p = m.pricing || {};

    const promptRate = (parseFloat(p.prompt) || 0) * 1_000_000;
    const completionRate = (parseFloat(p.completion) || 0) * 1_000_000;
    const cacheRead = (parseFloat(p.input_cache_read) || 0) * 1_000_000;
    const cacheCreation = (parseFloat(p.input_cache_write) || 0) * 1_000_000;

    const pricing = {
      input: Number(promptRate.toFixed(6)),
      output: Number(completionRate.toFixed(6)),
    };
    if (cacheRead > 0) pricing.cached = Number(cacheRead.toFixed(6));
    if (cacheCreation > 0) pricing.cache_creation = Number(cacheCreation.toFixed(6));

    orByFullId.set(mid, pricing);
    orByFullId.set(mid.toLowerCase(), pricing);

    const short = mid.split("/").pop() || mid;
    orByShortName.set(short, pricing);
    orByShortName.set(short.toLowerCase(), pricing);
    if (mname) {
      orByShortName.set(mname, pricing);
      orByShortName.set(mname.toLowerCase(), pricing);
    }

    const norm = normalizeName(mid);
    if (!orByNorm.has(norm)) {
      orByNorm.set(norm, pricing);
    }
  }

  const findPricing = (modelId, modelName = "") => {
    const candidates = [
      modelId,
      modelId.toLowerCase(),
      modelName,
      modelName.toLowerCase(),
      modelId.split("/").pop(),
      (modelId.split("/").pop() || "").toLowerCase(),
    ];
    for (const c of candidates) {
      if (c && orByFullId.has(c)) return orByFullId.get(c);
      if (c && orByShortName.has(c)) return orByShortName.get(c);
    }

    for (const c of [modelId, modelName]) {
      if (c) {
        const n = normalizeName(c);
        if (orByNorm.has(n)) return orByNorm.get(n);
        for (const [k, v] of orByNorm.entries()) {
          if (k.length > 5 && (k.includes(n) || n.includes(k))) return v;
        }
      }
    }
    return null;
  };

  // Read existing pricing namespace
  const existingPricing = {};
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const r of rows) {
    try {
      existingPricing[r.key] = JSON.parse(r.value);
    } catch {
      existingPricing[r.key] = {};
    }
  }

  // 1. OpenRouter Provider Pricing Map
  const openrouterDict = existingPricing.openrouter || {};
  for (const m of orModels) {
    const mid = m.id;
    const short = mid.split("/").pop() || mid;
    const p = orByFullId.get(mid);
    openrouterDict[mid] = p;
    openrouterDict[short] = p;
    openrouterDict[mid.toLowerCase()] = p;
    openrouterDict[short.toLowerCase()] = p;
  }
  existingPricing.openrouter = openrouterDict;

  // 2. Custom Models
  const customModelRows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'customModels'")
    .all();
  for (const r of customModelRows) {
    const prov = r.key;
    const provDict = existingPricing[prov] || {};
    try {
      const models = JSON.parse(r.value);
      for (const mod of models) {
        const mid = mod.id || "";
        const mname = mod.name || "";
        const p = findPricing(mid, mname);
        if (p) {
          provDict[mid] = p;
          provDict[mid.toLowerCase()] = p;
          const short = mid.split("/").pop();
          if (short) {
            provDict[short] = p;
            provDict[short.toLowerCase()] = p;
          }
        }
      }
      existingPricing[prov] = provDict;
    } catch {}
  }

  // 3. Synced Available Models
  const syncedRows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels'")
    .all();
  for (const r of syncedRows) {
    const provName = r.key.split(":")[0];
    const provDict = existingPricing[provName] || {};
    try {
      const models = JSON.parse(r.value);
      for (const mod of models) {
        const mid = mod.id || "";
        const mname = mod.name || "";
        const p = findPricing(mid, mname);
        if (p) {
          provDict[mid] = p;
          provDict[mid.toLowerCase()] = p;
          const short = mid.split("/").pop();
          if (short) {
            provDict[short] = p;
            provDict[short.toLowerCase()] = p;
          }
        }
      }
      existingPricing[provName] = provDict;
    } catch {}
  }

  // 4. Custom prefixes for OpenAI-compatible providers
  const pcRows = db
    .prepare(
      "SELECT id, provider, name, provider_specific_data FROM provider_connections WHERE provider LIKE '%openai-compatible%'"
    )
    .all();
  for (const r of pcRows) {
    const provId = r.provider;
    let prefix = "";
    if (r.provider_specific_data) {
      try {
        const psd = JSON.parse(r.provider_specific_data);
        prefix = psd.prefix || "";
      } catch {}
    }
    if (existingPricing[provId] && prefix) {
      existingPricing[prefix] = {
        ...(existingPricing[prefix] || {}),
        ...existingPricing[provId],
      };
    }
  }

  // Save to DB in a transaction
  const insertPricing = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );
  const insertModelsDev = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('models_dev_pricing', 'openrouter', ?)"
  );

  const tx = db.transaction(() => {
    for (const [provKey, pricingMap] of Object.entries(existingPricing)) {
      insertPricing.run(provKey, JSON.stringify(pricingMap));
    }
    insertModelsDev.run(JSON.stringify(openrouterDict));
  });

  tx();

  console.log("Successfully synchronized all custom models and provider pricing with OpenRouter!");
  db.close();
}

main().catch((err) => {
  console.error("Error syncing pricing:", err);
  process.exit(1);
});
