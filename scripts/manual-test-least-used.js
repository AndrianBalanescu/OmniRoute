#!/usr/bin/env node
/**
 * Manual test script for least-used strategy implementation
 * Usage: node scripts/manual-test-least-used.js
 */

const http = require("http");

const API_BASE = "http://localhost:20128";
const COMBO_NAME = "alibaba/qwen3.5-35b-a3b"; // Replace with your combo name
const REQUEST_COUNT = 30;

// Get API key from env or config
const API_KEY = process.env.OMNIROUTE_API_KEY || "sk_test_placeholder";

let requestCount = 0;
let distribution = {};
let errors = [];

async function sendRequest(id) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const req = http.request(
      `${API_BASE}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Connection-Id": `test-${Date.now()}-${id}`,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let body = "";

        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(body);

            if (result.headers?.["x-model-selected"]) {
              const model = result.headers["x-model-selected"];
              distribution[model] = (distribution[model] || 0) + 1;
              console.log(`✅ Request ${id}: ${model} (${Date.now() - startTime}ms)`);
            } else if (result.error) {
              errors.push({ id, error: result.error, response: result });
              console.error(`❌ Request ${id} failed:`, result.error);
            } else {
              errors.push({ id, error: "Unknown error", response: result });
              console.warn(`⚠️  Request ${id}: unexpected response`);
            }

            resolve();
          } catch (e) {
            errors.push({ id, error: e.message });
            console.error(`❌ Request ${id} parse error:`, e.message);
            resolve();
          }
        });
      }
    );

    req.on("error", (e) => {
      errors.push({ id, error: e.message });
      console.error(`❌ Request ${id} network error:`, e.message);
      resolve();
    });

    req.write(
      JSON.stringify({
        model: COMBO_NAME,
        messages: [{ role: "user", content: `Manual test request #${id}` }],
        max_tokens: 10,
        temperature: 0.7,
      })
    );

    req.end();
  });
}

async function runTest() {
  console.log("🧪 Starting Least-Used Strategy Test");
  console.log(`   Combo: ${COMBO_NAME}`);
  console.log(`   Requests: ${REQUEST_COUNT}`);
  console.log(`   Base URL: ${API_BASE}`);
  console.log("=".repeat(60));

  // Send all requests concurrently
  const promises = Array.from({ length: REQUEST_COUNT }, (_, i) => sendRequest(i + 1));
  await Promise.all(promises);

  console.log("\n" + "=".repeat(60));
  console.log("📊 DISTRIBUTION RESULTS:");
  console.log("=".repeat(60));

  const models = Object.keys(distribution).sort();
  models.forEach((model) => {
    const count = distribution[model];
    const percentage = ((count / REQUEST_COUNT) * 100).toFixed(1);
    console.log(`   ${model.padEnd(40)} ${String(count).padStart(3)} (${percentage}%)`);
  });

  console.log(`\nTotal successful: ${REQUEST_COUNT - errors.length}/${REQUEST_COUNT}`);

  if (errors.length > 0) {
    console.log(`\n❌ ERRORS: ${errors.length}`);
    errors.slice(0, 5).forEach((err) => {
      console.log(`   - Request ${err.id}: ${err.error}`);
    });
  }

  // Check if distribution is balanced (±25% variance allowed)
  const counts = models.map((m) => distribution[m]);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const maxVariance = Math.max(...counts.map((c) => Math.abs(c - avg) / avg));

  console.log("\n" + "=".repeat(60));
  if (maxVariance <= 0.25) {
    console.log(
      `✅ PASS: Distribution is balanced (max variance: ${(maxVariance * 100).toFixed(1)}%)`
    );
    console.log("   Strategy appears to be working correctly!");
  } else {
    console.log(
      `❌ FAIL: Distribution too skewed (max variance: ${(maxVariance * 100).toFixed(1)}%)`
    );
    console.log("   Strategy NOT working as expected");
  }
  console.log("=".repeat(60));

  process.exit(maxVariance <= 0.25 ? 0 : 1);
}

runTest().catch(console.error);
