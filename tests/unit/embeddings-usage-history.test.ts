import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #2 — embedding success traffic must land in `usage_history` (usage analytics,
// per-api-key counter), not just `call_logs`. Regression guard: an embedding
// request to a provider_node / local provider used to be invisible to
// /dashboard/usage because `handleEmbedding` never called `saveRequestUsage`.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embed-usage-"));

const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");
const core = await import("../../src/lib/db/core.ts");
const { saveRequestUsage } = await import("../../src/lib/usageDb.ts");

test.after(() => {
  core.resetDbInstance();
});

test("handleEmbedding success writes a usage_history row (not just call_logs)", async () => {
  core.resetDbInstance();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 42, total_tokens: 42 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    const result = await handleEmbedding({
      body: { model: "infinity/BAAI/bge-m3", input: "some text" },
      credentials: null,
      connectionId: "conn-local-embed",
      apiKeyId: "key-embed-1",
      log: null,
      resolvedProvider: {
        id: "infinity",
        baseUrl: "http://127.0.0.1:7997/v1/embeddings",
        authType: "none",
        authHeader: "none",
        models: [],
      },
      resolvedModel: "BAAI/bge-m3",
    });
    assert.equal(result.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Persistence is fire-and-forget (.catch); give the write a beat to land.
  await new Promise((r) => setTimeout(r, 50));

  const rows = core
    .getDbInstance()
    .prepare("SELECT * FROM usage_history WHERE model = ?")
    .all("infinity/BAAI/bge-m3") as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 1, "expected a usage_history row for the embedding request");
  const row = rows[0];
  assert.equal(row.provider, "infinity");
  assert.equal(row.tokens_input, 42);
  assert.equal(row.tokens_output, 0);
  assert.equal(row.success, 1);
  assert.equal(row.endpoint, "/v1/embeddings");
});

test("saveRequestUsage accepts an embeddings-shaped entry", async () => {
  core.resetDbInstance();
  await saveRequestUsage({
    provider: "infinity",
    model: "infinity/BAAI/bge-m3",
    tokens: { prompt_tokens: 7, completion_tokens: 0 },
    status: "200",
    success: true,
    latencyMs: 5,
    apiKeyName: "local",
    connectionId: "conn-local-embed",
    endpoint: "/v1/embeddings",
  });
  await new Promise((r) => setTimeout(r, 30));
  const row = core
    .getDbInstance()
    .prepare(
      "SELECT tokens_input, tokens_output, endpoint FROM usage_history ORDER BY id DESC LIMIT 1"
    )
    .get() as Record<string, unknown> | undefined;
  assert.ok(row, "expected a usage_history row");
  assert.equal(row.tokens_input, 7);
  assert.equal(row.tokens_output, 0);
});
