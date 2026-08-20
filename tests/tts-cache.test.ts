import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCachedVoice, saveTtsArtifact, ttsCacheKey } from "../src/tts/cache.ts";
import { sampleTtsRequest } from "./helpers.ts";

test("TTS cache keys change with paid request settings", () => {
  const base = sampleTtsRequest();

  assert.notEqual(ttsCacheKey(base), ttsCacheKey({ ...base, voice: "cedar" }));
  assert.notEqual(ttsCacheKey(base), ttsCacheKey({ ...base, text: `${base.text}!` }));
});

test("TTS cache returns only records with existing audio files", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const request = sampleTtsRequest();
    const key = ttsCacheKey(request);
    await mkdir(join("projects", request.projectId, "workspace", "voice"), { recursive: true });
    await writeFile(join("projects", request.projectId, "workspace", "voice", `${key}.wav`), "audio", "utf8");

    await saveTtsArtifact(request.projectId, {
      provider: "piper",
      cacheKey: key,
      relativePath: `workspace/voice/${key}.wav`,
      durationSeconds: 1.5,
      createdAt: "2026-08-20T00:00:00.000Z",
      metadata: { voice: "default" },
    });

    assert.equal((await findCachedVoice(request.projectId, key))?.cacheKey, key);
    assert.equal(await findCachedVoice(request.projectId, "missing"), null);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
