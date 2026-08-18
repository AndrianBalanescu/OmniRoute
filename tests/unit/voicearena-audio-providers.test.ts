import test from "node:test";
import assert from "node:assert/strict";

const {
  AUDIO_TRANSCRIPTION_PROVIDERS,
  AUDIO_SPEECH_PROVIDERS,
  parseTranscriptionModel,
  parseSpeechModel,
} = await import("../../open-sse/config/audioRegistry.ts");
const { handleAudioSpeech } = await import("../../open-sse/handlers/audioSpeech.ts");
const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");

// ── Registry presence ────────────────────────────────────────────────

test("whisper transcription provider is registered", () => {
  const provider = AUDIO_TRANSCRIPTION_PROVIDERS["whisper"];
  assert.ok(provider, "whisper should be in AUDIO_TRANSCRIPTION_PROVIDERS");
  assert.equal(provider.authType, "none");
  assert.equal(provider.format, "voicearena-whisper");
  assert.ok(provider.baseUrl.includes("/v1/transcribe"));
});

test("kokoro speech provider is registered", () => {
  const provider = AUDIO_SPEECH_PROVIDERS["kokoro"];
  assert.ok(provider);
  assert.equal(provider.authType, "none");
  assert.equal(provider.format, "voicearena-tts");
  assert.ok(provider.baseUrl.includes("/v1/tts"));
});

test("piper speech provider is registered", () => {
  const provider = AUDIO_SPEECH_PROVIDERS["piper"];
  assert.ok(provider);
  assert.equal(provider.authType, "none");
  assert.equal(provider.format, "voicearena-tts");
});

test("inflect speech provider is registered with micro and nano models", () => {
  const provider = AUDIO_SPEECH_PROVIDERS["inflect"];
  assert.ok(provider);
  assert.equal(provider.authType, "none");
  assert.equal(provider.format, "voicearena-tts");
  const modelIds = provider.models.map((m) => m.id);
  assert.ok(modelIds.includes("micro"));
  assert.ok(modelIds.includes("nano"));
});

// ── Model parsing ────────────────────────────────────────────────────

test("parseTranscriptionModel resolves whisper/whisper", () => {
  const result = parseTranscriptionModel("whisper/whisper");
  assert.deepEqual(result, { provider: "whisper", model: "whisper" });
});

test("parseSpeechModel resolves kokoro/kokoro", () => {
  const result = parseSpeechModel("kokoro/kokoro");
  assert.deepEqual(result, { provider: "kokoro", model: "kokoro" });
});

test("parseSpeechModel resolves piper/piper", () => {
  const result = parseSpeechModel("piper/piper");
  assert.deepEqual(result, { provider: "piper", model: "piper" });
});

test("parseSpeechModel resolves inflect/micro", () => {
  const result = parseSpeechModel("inflect/micro");
  assert.deepEqual(result, { provider: "inflect", model: "micro" });
});

// ── VoiceArena TTS handler sends correct body shape ──────────────────

test("voicearena-tts handler sends JSON { text } to upstream", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; body: string; headers: Record<string, string> } | null = null;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      body: String(init?.body || ""),
      headers: (init?.headers || {}) as Record<string, string>,
    };
    return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };

  try {
    const response = await handleAudioSpeech({
      body: { model: "kokoro/kokoro", input: "hello" },
      credentials: {},
    });
    assert.equal(response.status, 200);
    assert.ok(captured, "fetch should have been called");
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.text, "hello");
    assert.equal(captured.headers["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voicearena-tts handler passes voice as reference_id when provided", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { body: string } | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    captured = { body: String(init?.body || "") };
    return new Response(new Uint8Array([0x52, 0x49]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };

  try {
    const response = await handleAudioSpeech({
      body: { model: "kokoro/kokoro", input: "hi", voice: "af_heart" },
      credentials: {},
    });
    assert.equal(response.status, 200);
    assert.ok(captured);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.reference_id, "af_heart");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inflect handler sends model field in body", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { body: string } | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    captured = { body: String(init?.body || "") };
    return new Response(new Uint8Array([0x52]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };

  try {
    const response = await handleAudioSpeech({
      body: { model: "inflect/micro", input: "test", speed: 1.2 },
      credentials: {},
    });
    assert.equal(response.status, 200);
    assert.ok(captured);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.model, "micro");
    assert.equal(parsed.speed, 1.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── VoiceArena Whisper handler sends multipart with "audio" field ─────

test("voicearena-whisper handler uses 'audio' as multipart field name", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Uint8Array | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = new Uint8Array(
      init?.body instanceof ArrayBuffer
        ? init.body
        : await new Response(init?.body as BodyInit).arrayBuffer()
    );
    return new Response(JSON.stringify({ text: "hello world" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const file = new File([new Uint8Array([1, 2, 3])], "test.wav", {
      type: "audio/wav",
    });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("model", "whisper/whisper");

    const response = await handleAudioTranscription({
      formData,
      credentials: {},
    });
    assert.equal(response.status, 200);
    assert.ok(capturedBody);
    // The multipart body must contain `name="audio"`, NOT `name="file"`.
    const bodyText = new TextDecoder().decode(capturedBody);
    assert.ok(
      bodyText.includes('name="audio"'),
      `Multipart field should be "audio" but got: ${bodyText.slice(0, 300)}`
    );
    assert.ok(!bodyText.includes('name="file"'), "Should not contain field named 'file'");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
