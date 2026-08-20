import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeDuration } from "../src/media.ts";

test("probes WAV duration without ffprobe fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-wav-"));
  try {
    const wavPath = join(root, "sample.wav");
    await writeFile(wavPath, makeSilentWav({ sampleRate: 16000, seconds: 2 }));

    const duration = await probeDuration(wavPath, join(root, "missing-ffprobe.exe"));

    assert.equal(duration, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeSilentWav(options: { sampleRate: number; seconds: number }): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = options.sampleRate * blockAlign;
  const dataSize = options.seconds * byteRate;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(options.sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
