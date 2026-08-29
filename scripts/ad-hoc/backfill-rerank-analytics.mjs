import Database from "better-sqlite3";

const dbPath = process.env.SQLITE_PATH || "/home/ubuntu/.omniroute/storage.sqlite";
console.log(`Opening database at ${dbPath}...`);
const db = new Database(dbPath);

// 1. Update vram pricing in key_value
const vramRow = db
  .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = 'vram'")
  .get();
let vramPricing = {};
if (vramRow && vramRow.value) {
  try {
    vramPricing = JSON.parse(vramRow.value);
  } catch (e) {
    console.error("Failed to parse vram pricing JSON:", e);
  }
}

const rerankModels = [
  "BAAI/bge-reranker-v2-m3",
  "vram/BAAI/bge-reranker-v2-m3",
  "bge-reranker-v2-m3",
];

for (const m of rerankModels) {
  vramPricing[m] = {
    search_unit_cost: 0.00005,
    input_cost_per_query: 0.00005,
    input: 0.02,
    output: 0,
  };
}

db.prepare(
  "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', 'vram', ?)"
).run(JSON.stringify(vramPricing));
console.log("Updated vram pricing with reranker models:", Object.keys(vramPricing));

// Also check infinity pricing
const infRow = db
  .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = 'infinity'")
  .get();
let infPricing = {};
if (infRow && infRow.value) {
  try {
    infPricing = JSON.parse(infRow.value);
  } catch (e) {
    console.error("Failed to parse infinity pricing JSON:", e);
  }
}
for (const m of rerankModels) {
  if (!infPricing[m]) {
    infPricing[m] = {
      search_unit_cost: 0.00005,
      input_cost_per_query: 0.00005,
      input: 0.02,
      output: 0,
    };
  }
}
db.prepare(
  "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', 'infinity', ?)"
).run(JSON.stringify(infPricing));
console.log("Updated infinity pricing with reranker models.");

// 2. Backfill rerank calls from call_logs to usage_history
const rerankLogs = db.prepare("SELECT * FROM call_logs WHERE path LIKE '%rerank%'").all();
console.log(`Found ${rerankLogs.length} rerank call logs.`);

let insertedCount = 0;
let skippedCount = 0;

const insertUsage = db.prepare(`
  INSERT INTO usage_history (
    provider,
    model,
    connection_id,
    api_key_id,
    api_key_name,
    tokens_input,
    tokens_output,
    tokens_cache_read,
    tokens_cache_creation,
    tokens_reasoning,
    service_tier,
    status,
    success,
    latency_ms,
    ttft_ms,
    error_code,
    timestamp,
    combo_strategy,
    endpoint,
    account_key,
    account_label,
    account_label_priority,
    duration_seconds,
    input_characters
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const checkExisting = db.prepare(`
  SELECT id FROM usage_history
  WHERE timestamp = ?
    AND COALESCE(provider, '') = COALESCE(?, '')
    AND COALESCE(model, '') = COALESCE(?, '')
    AND endpoint = '/v1/rerank'
`);

const getConn = db.prepare("SELECT id, provider, name FROM provider_connections WHERE id = ?");

const backfillTx = db.transaction(() => {
  for (const log of rerankLogs) {
    const existing = checkExisting.get(log.timestamp, log.provider, log.model);
    if (existing) {
      skippedCount++;
      continue;
    }

    const conn = log.connection_id ? getConn.get(log.connection_id) : null;
    const accountKey = log.connection_id
      ? JSON.stringify(["connection", log.provider || "unknown", log.connection_id])
      : JSON.stringify(["connection", log.provider || "unknown", "unknown"]);
    const accountLabel = conn?.name || log.account || "unknown";

    insertUsage.run(
      log.provider || "vram",
      log.model || "vram/BAAI/bge-reranker-v2-m3",
      log.connection_id || null,
      log.api_key_id || null,
      log.api_key_name || null,
      log.tokens_in || 0,
      log.tokens_out || 0,
      log.tokens_cache_read || 0,
      log.tokens_cache_creation || 0,
      log.tokens_reasoning || 0,
      "standard",
      String(log.status || 200),
      log.status >= 200 && log.status < 400 ? 1 : 0,
      log.duration || 0,
      log.duration || 0,
      null,
      log.timestamp || new Date().toISOString(),
      "direct",
      "/v1/rerank",
      accountKey,
      accountLabel,
      0,
      0,
      0
    );
    insertedCount++;
  }
});

backfillTx();

console.log(`Backfill complete: ${insertedCount} inserted, ${skippedCount} skipped.`);
db.close();
