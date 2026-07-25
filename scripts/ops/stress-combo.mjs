#!/usr/bin/env node
/**
 * @file stress-combo.mjs
 * @description Lightweight concurrent stress test for OmniRoute combo routing.
 *
 * @changes
 * - [2026-07-24] [Composer] - Initial paid-premium combo stress runner
 */
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    requests: { type: "string", short: "n", default: "30" },
    concurrency: { type: "string", short: "c", default: "15" },
    model: { type: "string", short: "m", default: "paid-premium" },
    base: { type: "string", short: "b", default: "http://localhost:20128" },
    "max-tokens": { type: "string", default: "8" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`Usage: node scripts/ops/stress-combo.mjs [options]

Options:
  -n, --requests <N>       Total requests (default: 30)
  -c, --concurrency <N>    In-flight at once (default: 15)
  -m, --model <name>       Combo/model name (default: paid-premium)
  -b, --base <url>         OmniRoute base URL (default: http://localhost:20128)
  --max-tokens <N>         max_tokens per request (default: 8)
  -h, --help               Show this help

Examples:
  node scripts/ops/stress-combo.mjs -n 40 -c 20
  node scripts/ops/stress-combo.mjs -m paid-premium -n 50 -c 25
`);
  process.exit(0);
}

const total = Math.max(1, Number(values.requests) || 30);
const concurrency = Math.max(1, Number(values.concurrency) || 15);
const model = values.model || positionals[0] || "paid-premium";
const base = (values.base || "http://localhost:20128").replace(/\/$/, "");
const maxTokens = Math.max(1, Number(values["max-tokens"]) || 8);
const endpoint = `${base}/v1/chat/completions`;

const apiKey = process.env.OMNIROUTE_API_KEY || process.env.OPENAI_API_KEY || "";

function buildBody(index) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: `Stress probe #${index}: reply with exactly one short word.`,
      },
    ],
    max_tokens: maxTokens,
    stream: false,
  };
}

async function sendRequest(index) {
  const started = performance.now();
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(index)),
    });
    const elapsed = Math.round(performance.now() - started);
    let provider = "";
    let routedModel = "";
    let snippet = "";
    try {
      const body = await response.json();
      routedModel = body?.model || body?.choices?.[0]?.model || "";
      snippet = String(body?.choices?.[0]?.message?.content || body?.error?.message || "")
        .replace(/\s+/g, " ")
        .slice(0, 60);
      provider = response.headers.get("x-omniroute-provider") || "";
    } catch {
      snippet = "(non-json body)";
    }
    return {
      index,
      ok: response.ok,
      status: response.status,
      elapsed,
      provider,
      routedModel,
      snippet,
    };
  } catch (error) {
    return {
      index,
      ok: false,
      status: 0,
      elapsed: Math.round(performance.now() - started),
      provider: "",
      routedModel: "",
      snippet: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPool() {
  const results = [];
  let next = 1;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const current = next;
      next += 1;
      if (current > total) break;
      results.push(await sendRequest(current));
      process.stdout.write(
        `\r  progress: ${results.length}/${total} (${results.filter((r) => r.ok).length} ok)`
      );
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results.sort((a, b) => a.index - b.index);
}

console.log("=== OmniRoute Combo Stress Test ===");
console.log(`Endpoint : ${endpoint}`);
console.log(`Model    : ${model}`);
console.log(`Requests : ${total} (concurrency ${concurrency})`);
console.log(`Auth     : ${apiKey ? "Bearer key set" : "none (REQUIRE_API_KEY=false)"}`);
console.log("");

const startedAt = Date.now();
const results = await runPool();
const wallMs = Date.now() - startedAt;

const byStatus = new Map();
const latencies = [];
let okCount = 0;
for (const row of results) {
  byStatus.set(row.status, (byStatus.get(row.status) || 0) + 1);
  latencies.push(row.elapsed);
  if (row.ok) okCount += 1;
}
latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

console.log("--- Summary ---");
console.log(`Wall time : ${(wallMs / 1000).toFixed(1)}s`);
console.log(`Success   : ${okCount}/${total} (${((okCount / total) * 100).toFixed(1)}%)`);
console.log(
  `Latency   : p50=${p50}ms p95=${p95}ms min=${latencies[0]}ms max=${latencies.at(-1)}ms`
);
console.log("Status histogram:");
for (const [status, count] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${status}: ${count}`);
}

const failures = results.filter((r) => !r.ok).slice(0, 8);
if (failures.length > 0) {
  console.log("\n--- Sample failures ---");
  for (const row of failures) {
    console.log(`  #${row.index} status=${row.status} ${row.elapsed}ms — ${row.snippet}`);
  }
}

const successes = results.filter((r) => r.ok).slice(0, 8);
if (successes.length > 0) {
  console.log("\n--- Sample successes ---");
  for (const row of successes) {
    const route = row.routedModel || row.provider || "?";
    console.log(`  #${row.index} ${row.status} ${row.elapsed}ms → ${route} — ${row.snippet}`);
  }
}

process.exit(okCount === total ? 0 : 1);
