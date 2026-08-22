import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAssetAsrCommand, extractAssetKeywords, normalizeProbeResult, recoverInterruptedAnalysis, selectSubtitleStream } from "../src/asset-analysis.ts";

test("normalizes ffprobe video metadata", () => {
  const result = normalizeProbeResult({
    format: { duration: "42.8" },
    streams: [
      { index: 0, codec_type: "video", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio" },
      { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
    ],
  });

  assert.equal(result.durationSeconds, 42.8);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.hasAudio, true);
  assert.equal(result.subtitleStreams.length, 1);
});

test("selects project-language text subtitles before English", () => {
  const streams = [
    { index: 2, codecName: "subrip", language: "eng" },
    { index: 3, codecName: "ass", language: "vie" },
  ];
  assert.equal(selectSubtitleStream(streams, "vi")?.index, 3);
  assert.equal(selectSubtitleStream(streams, "de")?.index, 2);
});

test("extracts deterministic keywords without common filler", () => {
  const keywords = extractAssetKeywords("Qin Mu trains in the village. Qin Mu questions the village elders.");
  assert.deepEqual(keywords.slice(0, 3), ["qin", "mu", "village"]);
});

test("builds a local whisper.cpp command for asset fallback transcription", () => {
  const command = buildAssetAsrCommand({
    provider: "whisper-cpp", executablePath: "whisper-cli", model: "small", modelPath: "model.bin", language: "zh",
  }, "audio.wav", "context/asset-1");
  assert.equal(command.executable, "whisper-cli");
  assert.deepEqual(command.args, ["-m", "model.bin", "-f", "audio.wav", "-l", "zh", "-osrt", "-of", "context/asset-1"]);
});

async function withProjectManifest<T>(assets: unknown[], fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-asset-analysis-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project", "assets"), { recursive: true });
    await writeFile(
      join("projects", "sample-project", "assets", "asset-manifest.json"),
      JSON.stringify({ version: 1, assets }),
      "utf8",
    );
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function runningAsset(id: string) {
  return {
    id, filename: `${id}.mp4`, relativePath: `assets/clips/${id}.mp4`, mediaType: "video",
    mimeType: "video/mp4", sizeBytes: 10, rightsConfirmed: true, usagePurpose: "review context",
    createdAt: "2026-08-21T00:00:00.000Z", analysisStatus: "running",
  };
}

test("analysis interrupted by a restart is reported as failed so it can be retried", async () => {
  await withProjectManifest([runningAsset("asset-1")], async () => {
    const manifest = await recoverInterruptedAnalysis("sample-project");

    assert.equal(manifest.assets[0].analysisStatus, "failed");
    assert.match(String(manifest.assets[0].analysisError), /interrupted/i);
  });
});

test("analysis still owned by a running job is left untouched", async () => {
  await withProjectManifest([runningAsset("asset-1")], async () => {
    const manifest = await recoverInterruptedAnalysis("sample-project", ["asset-1"]);

    assert.equal(manifest.assets[0].analysisStatus, "running");
  });
});
