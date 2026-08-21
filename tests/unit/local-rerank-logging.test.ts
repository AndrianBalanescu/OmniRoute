import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-local-rerank-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const nodesDb = await import("../../src/lib/db/providers/nodes.ts");
const usageDb = await import("../../src/lib/usageDb.ts");
const rerankRoute = await import("../../src/app/api/v1/rerank/route.ts");

interface RerankSuccessResponse {
  results: { index: number; relevance_score: number }[];
}

interface CallLogRow {
  id: string;
  provider: string;
  model: string;
  status: number;
}

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

test("local rerank saves call_log and returns meta headers", async () => {
  // Create a local provider node
  await nodesDb.createProviderNode({
    id: "vram-node-1",
    type: "openai-compatible",
    name: "VRAM Local",
    prefix: "vram",
    baseUrl: "http://127.0.0.1:7997/v1",
    apiType: "chat",
  });

  // Create a connection for that node
  await providersDb.createProviderConnection({
    id: "vram-node-1",
    provider: "vram-node-1",
    name: "VRAM Conn",
    apiKey: "dummy-key",
    authType: "apikey",
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (urlStr.includes("7997")) {
      return new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.95 },
            { index: 1, relevance_score: 0.42 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const req = new Request("http://localhost:20128/api/v1/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "vram/BAAI/bge-reranker-v2-m3",
      query: "What is deep learning?",
      documents: ["Deep learning is a subset of machine learning.", "The sky is blue."],
    }),
  });

  const res = await rerankRoute.POST(req);
  assert.strictEqual(res.status, 200);

  const json = (await res.json()) as RerankSuccessResponse;
  assert.strictEqual(json.results?.length, 2);
  assert.strictEqual(res.headers.get("x-omniroute-provider"), "vram");
  assert.strictEqual(res.headers.get("x-omniroute-model"), "BAAI/bge-reranker-v2-m3");

  // Wait briefly for background saveCallLog to settle
  await new Promise((r) => setTimeout(r, 100));

  // Verify call_logs in SQLite
  const db = core.getDbInstance();
  const logs = db
    .prepare("SELECT * FROM call_logs WHERE path = '/v1/rerank' ORDER BY id DESC")
    .all() as unknown as CallLogRow[];

  assert.ok(logs.length >= 1, "Expected call_logs to contain at least 1 record");
  const latest = logs[0];
  assert.strictEqual(latest.provider, "vram");
  assert.strictEqual(latest.model, "vram/BAAI/bge-reranker-v2-m3");
  assert.strictEqual(latest.status, 200);
});
