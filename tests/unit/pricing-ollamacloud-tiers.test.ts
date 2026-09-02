import test from "node:test";
import assert from "node:assert/strict";

import { getPricingForModel } from "../../src/shared/constants/pricing.ts";

// OllamaCloud (provider id `ollama-cloud`, alias `ollamacloud`) is a consumer
// subscription gateway. Before 2026-08-11 it had NO pricing block in
// DEFAULT_PRICING, so `getPricingForModel("ollamacloud", model)` returned null
// and usage / logs / analytics silently reported $0 cost for every ollama model
// even though input+output tokens were tracked. These rows mirror the model
// makes' list prices (same tiers as their canonical providers: deepseek, glm,
// minimax); open-weight hosts (gpt-oss) are $0 per modern practice.
// `db/settings/pricing.ts` resolves the `ollama-cloud` id → `ollamacloud` alias,
// so keying under `ollamacloud` covers both the id and the alias spellings.

const CASES: Array<{
  modelId: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cache_creation: number;
}> = [
  {
    modelId: "deepseek-v4-flash",
    input: 0.07,
    output: 0.28,
    cached: 0.014,
    reasoning: 0.28,
    cache_creation: 0.07,
  },
  {
    modelId: "deepseek-v4-pro",
    input: 0.435,
    output: 0.87,
    cached: 0.0036,
    reasoning: 0.87,
    cache_creation: 0.435,
  },
  {
    modelId: "glm-5.1",
    input: 0.98,
    output: 3.08,
    cached: 0.2275,
    reasoning: 3.08,
    cache_creation: 0.98,
  },
  {
    modelId: "minimax-m3",
    input: 0.5,
    output: 2.0,
    cached: 0.05,
    reasoning: 2.0,
    cache_creation: 0.5,
  },
];

for (const expected of CASES) {
  test(`ollamacloud/${expected.modelId} has a market-price row (was silently $0)`, () => {
    const p = getPricingForModel("ollamacloud", expected.modelId);
    assert.ok(p, `expected pricing for ollamacloud/${expected.modelId}`);
    assert.equal(p.input, expected.input);
    assert.equal(p.output, expected.output);
    assert.equal(p.cached, expected.cached);
    assert.equal(p.reasoning, expected.reasoning);
    assert.equal(p.cache_creation, expected.cache_creation);
  });
}

// Open-weight hosts are priced at $0 (free / self-host-equivalent), but must
// still have a present row so cost accounting treats them as 0 rather than
// "unknown" (which also resolved to 0, but keep the intent explicit).
for (const modelId of ["gpt-oss:120b", "gpt-oss:20b"] as const) {
  test(`ollamacloud/${modelId} has an explicit $0 row`, () => {
    const p = getPricingForModel("ollamacloud", modelId);
    assert.ok(p, `expected pricing for ollamacloud/${modelId}`);
    assert.equal(p.input, 0);
    assert.equal(p.output, 0);
  });
}
