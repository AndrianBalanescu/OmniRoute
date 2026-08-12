import test from "node:test";
import assert from "node:assert/strict";
import { getAudioDurationSeconds } from "../../open-sse/utils/audioDuration.ts";

function makeWav({ sampleRate = 16000, channels = 1, bits = 16, seconds = 3 }): Blob {
  const bytesPerSecond = sampleRate * channels * (bits / 8);
  const dataBytes = Math.floor(bytesPerSecond * seconds);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(bytesPerSecond, 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return new Blob([buf], { type: "audio/wav" });
}

test("WAV duration is exact from fmt/data chunks", async () => {
  const blob = makeWav({ sampleRate: 16000, channels: 1, bits: 16, seconds: 3 });
  const seconds = await getAudioDurationSeconds(blob);
  assert.ok(seconds !== null);
  assert.ok(Math.abs(seconds - 3) < 0.01, `expected ~3s, got ${seconds}`);
});

test("WAV 48kHz stereo gives the same elapsed time", async () => {
  const blob = makeWav({ sampleRate: 48000, channels: 2, bits: 16, seconds: 5 });
  const seconds = await getAudioDurationSeconds(blob);
  assert.ok(seconds !== null);
  assert.ok(Math.abs(seconds - 5) < 0.01, `expected ~5s, got ${seconds}`);
});

test("non-audio bytes return null (untrackable)", async () => {
  const blob = new Blob([Buffer.alloc(100, 7)], { type: "application/octet-stream" });
  assert.equal(await getAudioDurationSeconds(blob), null);
});

test("too-short buffer returns null", async () => {
  const blob = new Blob([Buffer.alloc(10)], { type: "audio/wav" });
  assert.equal(await getAudioDurationSeconds(blob), null);
});

test("WAV with missing fmt/data returns null", async () => {
  // RIFF/WAVE header but no data chunk content
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.write("WAVE", 8);
  const blob = new Blob([buf], { type: "audio/wav" });
  const seconds = await getAudioDurationSeconds(blob);
  // dataBytes stays 0 → null (not a bogus 0s)
  assert.equal(seconds, null);
});
