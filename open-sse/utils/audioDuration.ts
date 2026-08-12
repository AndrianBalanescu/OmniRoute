/**
 * Audio duration extraction (zero-dependency).
 *
 * Transcriptions were untrackable in usage logs because the multipart upload
 * carried no duration, so per-second pricing was impossible ("cost 0"). This
 * reads the real duration straight from the container bytes:
 *
 *   - WAV (RIFF/WAVE): exact — from the `fmt ` chunk (sample rate, channels,
 *     bits) and the `data` chunk byte length.
 *   - MP3 (ID3 + MPEG frames): best-effort — from the first MPEG audio frame
 *     header (bitrate + sample rate + frame duration). Pure headers; no frame
 *     scanning across the whole file.
 *   - Everything else: null (caller treats as untrackable).
 *
 * Deliberately NO dependency on ffprobe/music-metadata — WAV header math incl.
 * is trivial and keeps this importable in edge/streaming contexts.
 */

import type { Blob } from "node:buffer";

/** Parse sample rate from an MPEG audio frame header (1-indexed bit of the 32-bit frame header). */
function parseMpegHeader(
  header: number
): { bitrateKbps: number; sampleRate: number; frameDurationMs: number } | null {
  // MPEG-1 Layer III — the overwhelmingly common case for .mp3. Full format
  // tables for MPEG-2/2.5 Layer I/II exist but are out of scope for a best-effort
  // helper; returning null there is safe (no wrong billing).
  const versionBits = (header >> 19) & 0x3; // 0b11 = MPEG-1, 0b10 = MPEG-2, 0b00 = MPEG-2.5
  const layerBits = (header >> 17) & 0x3; // 0b01 = Layer III
  if (versionBits !== 0x3 || layerBits !== 0x1) return null;

  const bitrateIndex = (header >> 12) & 0xf;
  const sampleIndex = (header >> 10) & 0x3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;

  // MPEG-1 Layer III bitrate table (kbps), index 1..14.
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  // MPEG-1 Layer III sample rates (Hz).
  const sampleRates = [44100, 48000, 32000];
  const bitrateKbps = bitrates[bitrateIndex];
  const sampleRate = sampleRates[sampleIndex];
  if (bitrateKbps <= 0 || sampleRate <= 0) return null;

  // MPEG-1 Layer III: 1152 samples per frame → duration = 1152 / samples per second.
  const frameDurationMs = (1152 / sampleRate) * 1000;
  return { bitrateKbps, sampleRate, frameDurationMs };
}

/** Skip an ID3v2 tag if present at the start of the buffer; returns the audio offset. */
function skipId3(buffer: Buffer): number {
  // ID3v2 header: "ID3" + ver(2) + flags(1) + 4×synchsafe size bytes.
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") return 0;
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  // Footer flag (0x10) adds 10 more bytes after the tag.
  const headerSize = 10 + size + (buffer[5] & 0x10 ? 10 : 0);
  return buffer.length >= headerSize ? headerSize : 0;
}

/**
 * Estimate duration in seconds for an audio Blob, or null when the format is
 * unsupported / unparseable (caller keeps the request untracked rather than
 * billing a wrong duration).
 */
export async function getAudioDurationSeconds(audio: Blob): Promise<number | null> {
  const buffer = Buffer.from(await audio.arrayBuffer());
  if (buffer.length < 44) return null;

  const type = audio.type || "";
  const isWav =
    type.includes("wav") ||
    (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE");
  if (isWav) return parseWavDuration(buffer);

  const isMp3 = type.includes("mpeg") || type.includes("mp3");
  if (isMp3) return parseMp3Duration(buffer);

  return null;
}

function parseWavDuration(buffer: Buffer): number | null {
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      sampleRate = buffer.readUInt32LE(offset + 8 + 4); // sampleRate field
      channels = buffer.readUInt16LE(offset + 8 + 2);
      bitsPerSample = buffer.readUInt16LE(offset + 8 + 14);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || dataBytes <= 0) return null;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return dataBytes / bytesPerSecond;
}

function parseMp3Duration(buffer: Buffer): number | null {
  const offset = skipId3(buffer);
  if (offset + 4 > buffer.length) return null;
  const header = buffer.readUInt32BE(offset);
  const parsed = parseMpegHeader(header);
  if (!parsed) return null;

  // Approximate total frames by byte size relative to first-frame bitrate.
  const audioBytes = buffer.length - offset;
  const bytesPerFrame = Math.floor(
    ((parsed.bitrateKbps * 1000) / 8) * (parsed.frameDurationMs / 1000)
  );
  if (bytesPerFrame <= 0) return null;
  const frameCount = Math.max(0, audioBytes / bytesPerFrame);
  return (frameCount * parsed.frameDurationMs) / 1000;
}
