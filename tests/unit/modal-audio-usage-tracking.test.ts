import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test.beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-modal-audio-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.SQLITE_FILE = path.join(tmpDir, "test.sqlite");
});

test("computeCostFromPricing calculates STT audio cost when durationSeconds is provided", async () => {
  const { computeCostFromPricing } = await import("@/lib/usage/costCalculator");

  const pricing = {
    input_cost_per_second: 0.006 / 60, // $0.006 per minute = $0.0001 per second (Whisper pricing)
  };

  // 30 seconds of audio, 0 tokens
  const cost = computeCostFromPricing(pricing, {
    prompt_tokens: 0,
    completion_tokens: 0,
    durationSeconds: 30,
  });

  assert.equal(cost, 30 * (0.006 / 60));
});

test("computeCostFromPricing calculates TTS audio cost when inputCharacters is provided", async () => {
  const { computeCostFromPricing } = await import("@/lib/usage/costCalculator");

  const pricing = {
    input_cost_per_character: 0.000015, // $15 per 1M characters
  };

  // 1000 characters of text to speech, 0 tokens
  const cost = computeCostFromPricing(pricing, {
    prompt_tokens: 0,
    completion_tokens: 0,
    inputCharacters: 1000,
  });

  assert.equal(cost, 0.015);
});

test("saveRequestUsage persists duration_seconds and input_characters to usage_history", async () => {
  const { resetDbInstance, getDbInstance } = await import("@/lib/db/core");
  resetDbInstance();

  const { saveRequestUsage } = await import("@/lib/usage/usageHistory");

  await saveRequestUsage({
    provider: "whisper-local",
    model: "whisper-local/whisper-large-v3",
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    durationSeconds: 45.5,
    status: "200",
    success: true,
    latencyMs: 1200,
    endpoint: "/v1/audio/transcriptions",
  });

  await saveRequestUsage({
    provider: "openai",
    model: "openai/tts-1",
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    inputCharacters: 500,
    status: "200",
    success: true,
    latencyMs: 800,
    endpoint: "/v1/audio/speech",
  });

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT provider, model, tokens_input, tokens_output, duration_seconds, input_characters FROM usage_history ORDER BY id ASC"
    )
    .all() as Array<{
    provider: string;
    model: string;
    tokens_input: number;
    tokens_output: number;
    duration_seconds: number;
    input_characters: number;
  }>;

  assert.equal(rows.length, 2);

  // STT row
  assert.equal(rows[0].provider, "whisper-local");
  assert.equal(rows[0].duration_seconds, 45.5);
  assert.equal(rows[0].input_characters, 0);

  // TTS row
  assert.equal(rows[1].provider, "openai");
  assert.equal(rows[1].duration_seconds, 0);
  assert.equal(rows[1].input_characters, 500);

  resetDbInstance();
});

test("usageAnalytics aggregates duration_seconds and input_characters and computes non-zero costs", async () => {
  const { resetDbInstance } = await import("@/lib/db/core");
  resetDbInstance();

  const { saveRequestUsage } = await import("@/lib/usage/usageHistory");
  const { buildUnifiedSource, getModelUsageRows, getDailyCostRows } =
    await import("@/lib/db/usageAnalytics");
  const { computeCostFromPricing } = await import("@/lib/usage/costCalculator");

  // Insert 3 STT requests of 20 seconds each
  for (let i = 0; i < 3; i++) {
    await saveRequestUsage({
      provider: "whisper",
      model: "whisper/whisper-1",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      durationSeconds: 20,
      status: "200",
      success: true,
      latencyMs: 500,
      endpoint: "/v1/audio/transcriptions",
    });
  }

  // Insert 2 TTS requests of 300 characters each
  for (let i = 0; i < 2; i++) {
    await saveRequestUsage({
      provider: "openai",
      model: "openai/tts-1",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      inputCharacters: 300,
      status: "200",
      success: true,
      latencyMs: 400,
      endpoint: "/v1/audio/speech",
    });
  }

  const { source, params } = buildUnifiedSource();
  const modelRows = getModelUsageRows(source, params);

  // Whisper model row
  const whisperRow = modelRows.find((r) => r.model.includes("whisper-1"));
  assert.ok(whisperRow, "whisper-1 row should be found");
  assert.equal(whisperRow.requests, 3);
  assert.equal(whisperRow.durationSeconds, 60);
  assert.equal(whisperRow.inputCharacters, 0);

  // Whisper pricing: $0.006 / min = $0.0001 / sec
  const whisperPricing = { input_cost_per_second: 0.006 / 60 };
  const whisperCost = computeCostFromPricing(whisperPricing, {
    prompt_tokens: whisperRow.promptTokens,
    completion_tokens: whisperRow.completionTokens,
    durationSeconds: whisperRow.durationSeconds,
    inputCharacters: whisperRow.inputCharacters,
  });
  assert.equal(whisperCost, 60 * (0.006 / 60)); // Exactly $0.006

  // TTS model row
  const ttsRow = modelRows.find((r) => r.model.includes("tts-1"));
  assert.ok(ttsRow, "tts-1 row should be found");
  assert.equal(ttsRow.requests, 2);
  assert.equal(ttsRow.durationSeconds, 0);
  assert.equal(ttsRow.inputCharacters, 600);

  // TTS pricing: $0.000015 / character
  const ttsPricing = { input_cost_per_character: 0.000015 };
  const ttsCost = computeCostFromPricing(ttsPricing, {
    prompt_tokens: ttsRow.promptTokens,
    completion_tokens: ttsRow.completionTokens,
    durationSeconds: ttsRow.durationSeconds,
    inputCharacters: ttsRow.inputCharacters,
  });
  assert.equal(ttsCost, 600 * 0.000015); // Exactly $0.009

  // Verify daily cost aggregation
  const dailyRows = getDailyCostRows(source, params);
  assert.ok(dailyRows.length >= 2);
  const dailyWhisper = dailyRows.find((r) => r.model.includes("whisper-1"));
  assert.ok(dailyWhisper);
  assert.equal(dailyWhisper.durationSeconds, 60);

  resetDbInstance();
});
