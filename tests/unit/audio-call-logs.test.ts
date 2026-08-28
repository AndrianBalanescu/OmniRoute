import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-audio-call-logs-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { createProviderNode } = await import("../../src/lib/db/providers.ts");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const transcriptionRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
const speechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function makeWav(): Blob {
  const dataLen = 1600;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  return new Blob([b], { type: "audio/wav" });
}

test("audio transcriptions route logs calls to call_logs", async () => {
  await createProviderNode({
    id: "whisper-local-node",
    type: "openai-compatible",
    name: "Local Whisper",
    prefix: "whisperlocal",
    apiType: "audio-transcriptions",
    baseUrl: "http://localhost:8005/v1",
  } as Parameters<typeof createProviderNode>[0]);

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ text: "Hello from local whisper" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const fd = new FormData();
  fd.append("model", "whisperlocal/whisper-large-v3-turbo");
  fd.append("file", makeWav(), "audio.wav");

  const req = new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    body: fd,
  });

  const res = await transcriptionRoute.POST(req);
  assert.equal(res.status, 200);

  // Give asynchronous saveCallLog time to write
  await new Promise((r) => setTimeout(r, 100));

  const logs = await getCallLogs({ limit: 10 });
  const transcriptionLog = logs.find((l) => l.path === "/v1/audio/transcriptions");
  assert.ok(transcriptionLog, "Should persist transcription call log");
  assert.equal(transcriptionLog.status, 200);
  assert.equal(transcriptionLog.provider, "whisperlocal");
  assert.ok(transcriptionLog.model.includes("whisper-large-v3-turbo"));
});

test("audio speech route logs calls to call_logs", async () => {
  await createProviderNode({
    id: "kokoro-local-node",
    type: "openai-compatible",
    name: "Local Kokoro",
    prefix: "kokorolocal",
    apiType: "audio-speech",
    baseUrl: "http://localhost:8006/v1",
  } as Parameters<typeof createProviderNode>[0]);

  globalThis.fetch = async () => {
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };

  const req = new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "kokorolocal/kokoro-v1",
      input: "Testing local audio speech call logging",
      voice: "af_heart",
    }),
  });

  const res = await speechRoute.POST(req);
  assert.equal(res.status, 200);

  // Give asynchronous saveCallLog time to write
  await new Promise((r) => setTimeout(r, 100));

  const logs = await getCallLogs({ limit: 10 });
  const speechLog = logs.find((l) => l.path === "/v1/audio/speech");
  assert.ok(speechLog, "Should persist speech call log");
  assert.equal(speechLog.status, 200);
  assert.equal(speechLog.provider, "kokorolocal");
  assert.ok(speechLog.model.includes("kokoro-v1"));
});
