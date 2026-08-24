import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNarrationScenes, generateVisualMapping, loadVisualMapping, saveVisualMapping, validateVisualMapping } from "../src/visual-mapping.ts";
import { DEFAULT_SEGMENT_EFFECTS, isEligibleWatermarkAsset, patchSegmentEffects, validateSegmentEffects } from "../src/visual-effects.ts";
import type { AssetRecord } from "../src/assets.ts";

const captions = `1\n00:00:00,000 --> 00:00:03,000\nQin Mu enters the village.\n\n2\n00:00:03,000 --> 00:00:07,000\nHis training makes him different.\n\n3\n00:00:07,000 --> 00:00:12,000\nCuriosity drives every decision.\n`;

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-visual-mapping-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

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

test("save and reload preserves normalized visual-mapping effects", async () => {
  await withTempCwd(async () => {
    const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
    mapping.segments[0].effects = patchSegmentEffects(mapping.segments[0].effects, { speed: 1.5 });
    await saveVisualMapping("sample-project", mapping);
    const reloaded = await loadVisualMapping("sample-project");
    assert.equal(reloaded?.segments[0].effects?.speed, 1.5);
    assert.equal(reloaded?.segments[0].effects?.color.saturation, 1);
  });
});

test("loadVisualMapping fills legacy segments that predate effects with complete neutral defaults", async () => {
  await withTempCwd(async () => {
    const legacyMapping = {
      version: 1,
      status: "draft",
      generatedAt: "2026-08-21T00:00:00.000Z",
      inputFingerprint: "legacy",
      segments: [
        {
          id: "scene-001",
          startSeconds: 0,
          endSeconds: 5,
          narration: "Qin Mu enters the village.",
          keywords: [],
          intent: "hook",
          assetId: null,
          confidence: 0,
          reason: "No eligible asset exceeded the match threshold.",
          fitMode: "cover",
          sourceStartSeconds: 0,
          sourceDurationSeconds: 5,
          muteSourceAudio: true,
          selectionMode: "automatic",
          fallback: "generated-background",
          // no `effects` field at all: this is what a pre-effects mapping looked like.
        },
      ],
    };
    await mkdir(join("projects", "sample-project", "workspace", "editing"), { recursive: true });
    await writeFile(join("projects", "sample-project", "workspace", "editing", "visual-mapping.json"), JSON.stringify(legacyMapping), "utf8");

    const reloaded = await loadVisualMapping("sample-project");
    assert.deepEqual(reloaded?.segments[0].effects, DEFAULT_SEGMENT_EFFECTS);
  });
});

test("loadVisualMapping rejects invalid persisted effects instead of clamping them", async () => {
  await withTempCwd(async () => {
    const corrupted = {
      version: 1,
      status: "draft",
      generatedAt: "2026-08-21T00:00:00.000Z",
      inputFingerprint: "corrupted",
      segments: [
        {
          id: "scene-001",
          startSeconds: 0,
          endSeconds: 5,
          narration: "Qin Mu enters the village.",
          keywords: [],
          intent: "hook",
          assetId: null,
          confidence: 0,
          reason: "No eligible asset exceeded the match threshold.",
          fitMode: "cover",
          sourceStartSeconds: 0,
          sourceDurationSeconds: 5,
          muteSourceAudio: true,
          selectionMode: "automatic",
          fallback: "generated-background",
          effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 99 },
        },
      ],
    };
    await mkdir(join("projects", "sample-project", "workspace", "editing"), { recursive: true });
    await writeFile(join("projects", "sample-project", "workspace", "editing", "visual-mapping.json"), JSON.stringify(corrupted), "utf8");

    await assert.rejects(() => loadVisualMapping("sample-project"), /speed/);
  });
});

test("saveVisualMapping rejects invalid segment effects instead of persisting them", async () => {
  await withTempCwd(async () => {
    const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
    mapping.segments[0].effects = { ...DEFAULT_SEGMENT_EFFECTS, blur: 999 };
    await assert.rejects(() => saveVisualMapping("sample-project", mapping), /blur/);
  });
});

test("validateVisualMapping reports field-specific errors for invalid segment effects", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  mapping.segments[0].effects = { ...DEFAULT_SEGMENT_EFFECTS, color: { ...DEFAULT_SEGMENT_EFFECTS.color, contrast: 9 } };
  const result = validateVisualMapping(mapping, []);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /contrast/);
});
