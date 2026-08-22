import assert from "node:assert/strict";
import test from "node:test";
import { buildNarrationScenes, generateVisualMapping, validateVisualMapping } from "../src/visual-mapping.ts";

const captions = `1\n00:00:00,000 --> 00:00:03,000\nQin Mu enters the village.\n\n2\n00:00:03,000 --> 00:00:07,000\nHis training makes him different.\n\n3\n00:00:07,000 --> 00:00:12,000\nCuriosity drives every decision.\n`;

test("groups captions into deterministic narration scenes", () => {
  const scenes = buildNarrationScenes(captions);
  assert.deepEqual(scenes.map((scene) => [scene.startSeconds, scene.endSeconds]), [[0, 7], [7, 12]]);
  assert.match(scenes[0].narration, /Qin Mu.*training/);
});

test("maps matching approved assets and prevents adjacent video reuse", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), [
    {
      id: "video-1", filename: "training.mp4", relativePath: "assets/clips/training.mp4", mediaType: "video",
      mimeType: "video/mp4", sizeBytes: 10, rightsConfirmed: true, usagePurpose: "training analysis",
      createdAt: "2026-08-21T00:00:00.000Z", analysisStatus: "ready", durationSeconds: 30,
      keywords: ["qin", "mu", "training", "village"], contextSummary: "Qin Mu training in the village",
    },
  ]);

  assert.equal(mapping.segments[0].assetId, "video-1");
  assert.equal(mapping.segments[0].sourceDurationSeconds, 5);
  assert.equal(mapping.segments[0].muteSourceAudio, true);
  assert.equal(mapping.segments[1].assetId, null);
  assert.equal(mapping.segments[1].fallback, "generated-background");
});

test("rejects video excerpts over five seconds", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  mapping.segments[0].assetId = "video-1";
  mapping.segments[0].mediaType = "video";
  mapping.segments[0].sourceDurationSeconds = 6;
  assert.ok(validateVisualMapping(mapping, []).errors.includes("scene-001 exceeds the five-second video limit."));
});
