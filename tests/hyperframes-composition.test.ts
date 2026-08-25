import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHyperframesComposition,
  detectHyperframesVersion,
  escapeHtml,
  type HyperframesCompositionInput,
} from "../src/story-factory/hyperframes-composition.ts";

test("composition writes root timing, scene clips, narration, and escaped text", () => {
  const result = buildHyperframesComposition(baseInput({
    cues: [{
      sceneId: "SC-001",
      startSeconds: 0,
      endSeconds: 12,
      narrationExcerpt: "<script>alert(1)</script>",
      visualPrompt: "mysterious hallway",
      mood: "mysterious",
      captionEmphasis: ["hallway"],
      motion: "slow-push",
      overlayText: "<hello>",
    }],
  }));

  assert.match(result.html, /data-composition-id="story"/);
  assert.match(result.html, /data-width="1920"/);
  assert.match(result.html, /class="clip scene-clip motion-slow-push"/);
  assert.match(result.html, /src="assets\/narration\.m4a"/);
  assert.ok(!result.html.includes("<script>alert"));
  assert.match(result.html, /&lt;hello&gt;/);
});

test("manifest records engine, source hash, and Hyperframes version", () => {
  const result = buildHyperframesComposition(baseInput({ sourceHash: "hash-1", hyperframesVersion: "0.8.13" }));

  assert.equal(result.manifest.engine, "hyperframes");
  assert.equal(result.manifest.sourceHash, "hash-1");
  assert.equal(result.manifest.hyperframesVersion, "0.8.13");
});

test("escapeHtml covers text and attribute delimiters", () => {
  assert.equal(escapeHtml(`Tom & "Sue" <go>`), "Tom &amp; &quot;Sue&quot; &lt;go&gt;");
});

test("detectHyperframesVersion reads package metadata when available", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-version-"));
  try {
    const packagePath = join(root, "package.json");
    await writeFile(packagePath, JSON.stringify({ version: "0.8.13" }), "utf8");
    assert.equal(await detectHyperframesVersion(packagePath), "0.8.13");
    assert.equal(await detectHyperframesVersion(join(root, "missing.json")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baseInput(overrides: Partial<HyperframesCompositionInput> = {}): HyperframesCompositionInput {
  return {
    compositionId: "story",
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    sourceHash: "hash",
    hyperframesVersion: null,
    narrationRelativePath: "assets/narration.m4a",
    cues: [{
      sceneId: "SC-001",
      startSeconds: 0,
      endSeconds: 12,
      narrationExcerpt: "The hallway whispered.",
      visualPrompt: "mysterious hallway",
      mood: "mysterious",
      captionEmphasis: ["hallway"],
      motion: "slow-push",
      overlayText: "hallway whispered",
    }],
    imagesBySceneId: new Map([["SC-001", "assets/image-000.png"]]),
    bgmTracks: [],
    sfxEvents: [],
    ...overrides,
  };
}
