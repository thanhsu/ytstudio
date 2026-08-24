import assert from "node:assert/strict";
import test from "node:test";
import { buildNarrationScenes, generateVisualMapping, validateVisualMapping } from "../src/visual-mapping.ts";
import { DEFAULT_SEGMENT_EFFECTS, isEligibleWatermarkAsset, patchSegmentEffects, validateSegmentEffects } from "../src/visual-effects.ts";
import type { AssetRecord } from "../src/assets.ts";

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

test("scenes without a relevant asset fall back to a generated background", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), [
    {
      id: "image-1", filename: "logo.png", relativePath: "assets/images/logo.png", mediaType: "image",
      mimeType: "image/png", sizeBytes: 10, rightsConfirmed: true, usagePurpose: "channel branding",
      createdAt: "2026-08-21T00:00:00.000Z", analysisStatus: "ready",
      keywords: ["logo", "branding"], contextSummary: "channel logo plate",
    },
  ]);

  assert.equal(mapping.segments[0].assetId, null);
  assert.equal(mapping.segments[0].confidence, 0);
  assert.equal(mapping.segments[0].fallback, "generated-background");
});

test("normalizes a legacy visual-mapping segment to neutral effects", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  assert.deepEqual(mapping.segments[0].effects, DEFAULT_SEGMENT_EFFECTS);
});

test("patches nested color and watermark fields without losing defaults", () => {
  const effects = patchSegmentEffects(undefined, {
    speed: 1.25,
    color: { contrast: 1.2 },
  });
  assert.equal(effects.speed, 1.25);
  assert.equal(effects.color.contrast, 1.2);
  assert.equal(effects.color.saturation, 1);
  assert.equal(effects.transitionIn, "cut");
});

test("patch rejects invalid values instead of clamping them", () => {
  assert.throws(() => patchSegmentEffects(undefined, { speed: 99 }), /speed/);
  assert.throws(() => patchSegmentEffects(undefined, { zoom: "spin" }), /zoom/);
  assert.throws(() => patchSegmentEffects(undefined, { blur: Number.NaN }), /blur/);
});

test("patch clears a watermark when explicitly set to null", () => {
  const withWatermark = patchSegmentEffects(undefined, {
    watermark: { assetId: "logo-1", position: "top-left", scale: 0.2, opacity: 0.3 },
  });
  assert.ok(withWatermark.watermark);

  const cleared = patchSegmentEffects(withWatermark, { watermark: null });
  assert.equal(cleared.watermark, undefined);
});

test("accepts only eligible logo assets for persistent watermarks", () => {
  assert.equal(isEligibleWatermarkAsset({ role: "logo", rightsStatus: "licensed" } as AssetRecord), true);
  assert.equal(isEligibleWatermarkAsset({ role: "source-clip", rightsStatus: "licensed" } as unknown as AssetRecord), false);
  assert.equal(isEligibleWatermarkAsset({ role: "logo", rightsStatus: "user-confirmed" } as AssetRecord), false);
});

test("validateSegmentEffects rejects a watermark referencing a missing or ineligible asset", () => {
  const logoAsset: AssetRecord = {
    id: "logo-1", filename: "logo.png", relativePath: "assets/images/logo.png", mediaType: "image",
    mimeType: "image/png", sizeBytes: 10, rightsConfirmed: true, usagePurpose: "channel logo",
    createdAt: "2026-08-21T00:00:00.000Z", role: "logo", rightsStatus: "owned",
  };
  const sourceClip: AssetRecord = { ...logoAsset, id: "clip-1", role: undefined, rightsStatus: "licensed" };

  const watermarked = patchSegmentEffects(undefined, {
    watermark: { assetId: "logo-1", position: "bottom-right", scale: 0.2, opacity: 0.3 },
  });

  assert.equal(validateSegmentEffects(watermarked, [logoAsset]).valid, true);

  const missingAsset = validateSegmentEffects(watermarked, [sourceClip]);
  assert.equal(missingAsset.valid, false);
  assert.match(missingAsset.errors.join(" "), /missing asset/);

  const ineligible = validateSegmentEffects({ ...watermarked, watermark: { ...watermarked.watermark, assetId: "clip-1" } }, [sourceClip]);
  assert.equal(ineligible.valid, false);
  assert.match(ineligible.errors.join(" "), /eligible logo asset/);
});
