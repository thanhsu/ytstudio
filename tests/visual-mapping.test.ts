import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNarrationScenes, generateVisualMapping, loadVisualMapping, saveVisualMapping, validateVisualMapping } from "../src/visual-mapping.ts";
import { DEFAULT_SEGMENT_EFFECTS, isEligibleWatermarkAsset, patchSegmentEffects, validateSegmentEffects } from "../src/visual-effects.ts";
import { buildSegmentEffectFilter } from "../src/effects-render.ts";
import { buildShortsRenderArgs, type RenderVisualSegment } from "../src/render.ts";
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

test("patch rejects non-finite numbers, an unsupported version, and unknown enum values", () => {
  assert.throws(() => patchSegmentEffects(undefined, { speed: Number.POSITIVE_INFINITY }), /speed/);
  assert.throws(() => patchSegmentEffects(undefined, { color: { saturation: Number.NEGATIVE_INFINITY } }), /saturation/);
  assert.throws(() => patchSegmentEffects(undefined, { version: 2 }), /version/);
  assert.throws(() => patchSegmentEffects(undefined, { transitionIn: "wipe" }), /transitionIn/);
  assert.throws(() => patchSegmentEffects(undefined, { transitionOut: "wipe" }), /transitionOut/);
  assert.throws(
    () => patchSegmentEffects(undefined, { watermark: { assetId: "logo-1", position: "center", scale: 0.1, opacity: 0.1 } }),
    /watermark\.position/,
  );
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

test("a legacy mapping segment without effects normalizes to neutral defaults, renders a null filter, and leaves render args unchanged", async () => {
  await withTempCwd(async () => {
    const legacyMapping = {
      version: 1,
      status: "draft",
      generatedAt: "2026-08-21T00:00:00.000Z",
      inputFingerprint: "legacy-chain",
      segments: [
        {
          id: "scene-001",
          startSeconds: 0,
          endSeconds: 5,
          narration: "Qin Mu enters the village.",
          keywords: [],
          intent: "hook",
          assetId: null,
          mediaType: "image",
          confidence: 0,
          reason: "No eligible asset exceeded the match threshold.",
          fitMode: "cover",
          sourceStartSeconds: 0,
          sourceDurationSeconds: 5,
          muteSourceAudio: true,
          selectionMode: "automatic",
          fallback: "generated-background",
          // no `effects` field at all: pre-effects mapping shape.
        },
      ],
    };
    await mkdir(join("projects", "sample-project", "workspace", "editing"), { recursive: true });
    await writeFile(join("projects", "sample-project", "workspace", "editing", "visual-mapping.json"), JSON.stringify(legacyMapping), "utf8");

    const reloaded = await loadVisualMapping("sample-project");
    const effects = reloaded?.segments[0].effects;
    assert.deepEqual(effects, DEFAULT_SEGMENT_EFFECTS);

    // Neutral effects always collapse to a bare passthrough filter.
    assert.equal(
      buildSegmentEffectFilter("[v0]", "[v1]", effects!, { width: 1080, height: 1920 }, 5, "image"),
      "[v0]null[v1]",
    );

    // A render args build using the normalized default effects must be identical, in filter
    // terms, to one where the segment simply omits `effects` (the actual legacy shape).
    const baseSegment: RenderVisualSegment = {
      sceneId: "scene-001",
      startSeconds: 0,
      endSeconds: 5,
      assetPath: "projects/sample-project/assets/images/card.png",
      mediaType: "image",
      fitMode: "cover",
      sourceStartSeconds: 0,
      sourceDurationSeconds: 5,
      muteSourceAudio: true,
    };
    const renderInput = {
      projectId: "sample-project",
      title: "Why Qin Mu feels different",
      durationSeconds: 5,
      voicePath: "projects/sample-project/workspace/voice/draft.wav",
      captionsPath: "projects/sample-project/workspace/captions/draft.srt",
      outputPath: "projects/sample-project/workspace/renders/draft.mp4",
      assetPaths: [],
    };
    const argsWithNormalizedEffects = buildShortsRenderArgs({ ...renderInput, visualSegments: [{ ...baseSegment, effects }] });
    const argsWithNoEffectsField = buildShortsRenderArgs({ ...renderInput, visualSegments: [baseSegment] });
    assert.deepEqual(argsWithNormalizedEffects, argsWithNoEffectsField);
  });
});

const loopVideoAsset: AssetRecord = {
  id: "loop-1", filename: "ambience.mp4", relativePath: "assets/clips/ambience.mp4", mediaType: "video",
  mimeType: "video/mp4", sizeBytes: 2048, rightsConfirmed: true, usagePurpose: "looping background",
  createdAt: "2026-08-25T00:00:00.000Z", analysisStatus: "ready", durationSeconds: 300,
};

function mappingWithLoop(backgroundLoop: unknown) {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  return { ...mapping, backgroundLoop } as Parameters<typeof validateVisualMapping>[0];
}

test("a mapping written before an effect field existed still loads", async () => {
  await withTempCwd(async () => {
    // The on-disk shape from before `flip` was added: every other field is
    // present and valid. Adding a field must not strand mappings already saved.
    const legacyEffects = {
      version: 1,
      speed: 1,
      zoom: "none",
      transitionIn: "cut",
      transitionOut: "cut",
      color: { brightness: 0, contrast: 1, saturation: 1, grayscale: 0 },
      blur: 0,
    };
    const dir = join("projects", "legacy-project", "workspace", "editing");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "visual-mapping.json"),
      JSON.stringify({
        version: 1,
        status: "approved",
        generatedAt: "2026-08-24T00:00:00.000Z",
        inputFingerprint: "abc",
        segments: [{
          id: "scene-001", startSeconds: 0, endSeconds: 5, narration: "n", keywords: [], intent: "hook",
          assetId: null, confidence: 0, reason: "", fitMode: "cover", sourceStartSeconds: 0,
          sourceDurationSeconds: 5, muteSourceAudio: true, selectionMode: "automatic",
          fallback: "generated-background", effects: legacyEffects,
        }],
      }),
      "utf8",
    );

    const loaded = await loadVisualMapping("legacy-project");

    assert.equal(loaded?.segments[0].effects?.flip, "none");
  });
});

test("effects carrying a genuinely invalid value are still rejected on load", async () => {
  await withTempCwd(async () => {
    const dir = join("projects", "bad-project", "workspace", "editing");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "visual-mapping.json"),
      JSON.stringify({
        version: 1, status: "draft", generatedAt: "2026-08-24T00:00:00.000Z", inputFingerprint: "abc",
        segments: [{
          id: "scene-001", startSeconds: 0, endSeconds: 5, narration: "n", keywords: [], intent: "hook",
          assetId: null, confidence: 0, reason: "", fitMode: "cover", sourceStartSeconds: 0,
          sourceDurationSeconds: 5, muteSourceAudio: true, selectionMode: "automatic",
          fallback: "generated-background",
          effects: { version: 1, speed: 99, zoom: "none", flip: "none", transitionIn: "cut", transitionOut: "cut", color: { brightness: 0, contrast: 1, saturation: 1, grayscale: 0 }, blur: 0 },
        }],
      }),
      "utf8",
    );

    await assert.rejects(() => loadVisualMapping("bad-project"), /speed/);
  });
});

test("accepts a background loop on a rights-confirmed video asset", () => {
  const result = validateVisualMapping(
    mappingWithLoop({ assetId: "loop-1", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS }),
    [loopVideoAsset],
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("rejects a background loop that points at an image asset", () => {
  const result = validateVisualMapping(
    mappingWithLoop({ assetId: "still-1", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS }),
    [{ ...loopVideoAsset, id: "still-1", mediaType: "image", filename: "cover.png" }],
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /video/i.test(error)), result.errors.join(" "));
});

test("rejects a background loop whose asset is missing", () => {
  const result = validateVisualMapping(mappingWithLoop({ assetId: "ghost", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS }), [loopVideoAsset]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /missing/i.test(error)), result.errors.join(" "));
});

test("rejects a background loop whose asset has no rights confirmation", () => {
  const result = validateVisualMapping(
    mappingWithLoop({ assetId: "loop-1", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS }),
    [{ ...loopVideoAsset, rightsConfirmed: false }],
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /rights/i.test(error)), result.errors.join(" "));
});

test("a background loop is exempt from the five-second excerpt rule", () => {
  // The 5s cap and the adjacent-reuse rule guard fair-use clipping in the
  // review workflow. A background loop is not a segment, so it must not be
  // measured against them -- otherwise looping any clip is impossible.
  const result = validateVisualMapping(
    mappingWithLoop({ assetId: "loop-1", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS }),
    [loopVideoAsset],
  );
  assert.equal(result.valid, true, result.errors.join(" "));
});
