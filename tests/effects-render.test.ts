import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFadeFilter,
  buildSegmentEffectFilter,
  buildVisualEffectFilter,
  buildWatermarkOverlayFilter,
} from "../src/effects-render.ts";
import { DEFAULT_SEGMENT_EFFECTS, type SegmentEffects, type WatermarkPosition } from "../src/visual-effects.ts";
import type { AssetRecord } from "../src/assets.ts";

const DIMENSIONS = { width: 1080, height: 1920 };

function effects(overrides: Partial<SegmentEffects>): SegmentEffects {
  return { ...DEFAULT_SEGMENT_EFFECTS, ...overrides };
}

function eligibleLogoAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "logo-1",
    filename: "logo.png",
    relativePath: "assets/images/logo-1.png",
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 1024,
    rightsConfirmed: true,
    usagePurpose: "brand watermark",
    createdAt: "2026-08-24T00:00:00.000Z",
    role: "logo",
    rightsStatus: "owned",
    ...overrides,
  };
}

// --- Brief Step 1 tests (verbatim from task-4-brief.md) ---

test("neutral effects produce a null filter", () => {
  assert.equal(
    buildSegmentEffectFilter("[v0]", "[v1]", DEFAULT_SEGMENT_EFFECTS, { width: 1080, height: 1920 }, 8, "image"),
    "[v0]null[v1]",
  );
});

test("grayscale multiplies saturation and supplies one effective saturation control", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    {
      ...DEFAULT_SEGMENT_EFFECTS,
      color: { brightness: 0.1, contrast: 1.2, saturation: 0.8, grayscale: 0.4 },
    },
    { width: 1080, height: 1920 },
    8,
    "image",
  );
  assert.match(filter, /hue=s=0\.48/);
  assert.doesNotMatch(filter, /hue=s=0\.6/);
  assert.equal((filter.match(/hue=/g) ?? []).length, 1);
});

test("fade edges are inside the segment and capped at half its duration", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    { ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "fade", transitionOut: "fade" },
    { width: 1080, height: 1920 },
    0.6,
    "image",
  );
  assert.match(filter, /fade=t=in:st=0:d=0\.3/);
  assert.match(filter, /fade=t=out:st=0\.3:d=0\.3/);
});

// --- Additional coverage for buildSegmentEffectFilter ---

test("fade duration is capped at the fixed 0.5s constant for longer segments", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    { ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "fade", transitionOut: "cut" },
    DIMENSIONS,
    8,
    "image",
  );
  assert.equal(filter, "[v0]fade=t=in:st=0:d=0.5[v1]");
});

test("cut transitions emit no fade filter", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    { ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "cut", transitionOut: "cut" },
    DIMENSIONS,
    8,
    "image",
  );
  assert.equal(filter, "[v0]null[v1]");
});

test("brightness and contrast are emitted via eq only for non-default values", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    effects({ color: { brightness: 0.25, contrast: 1, saturation: 1, grayscale: 0 } }),
    DIMENSIONS,
    8,
    "image",
  );
  assert.match(filter, /eq=brightness=0\.25/);
  assert.doesNotMatch(filter, /contrast=/);
  assert.doesNotMatch(filter, /hue=/);
});

test("blur emits boxblur only when greater than zero", () => {
  const withBlur = buildSegmentEffectFilter("[v0]", "[v1]", effects({ blur: 12 }), DIMENSIONS, 8, "image");
  assert.match(withBlur, /boxblur=12/);

  const withoutBlur = buildSegmentEffectFilter("[v0]", "[v1]", effects({ blur: 0 }), DIMENSIONS, 8, "image");
  assert.doesNotMatch(withoutBlur, /boxblur/);
});

test("speed adjusts video pts but is a no-op for images", () => {
  const videoFilter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ speed: 1.5 }), DIMENSIONS, 8, "video");
  assert.match(videoFilter, /setpts=PTS\/1\.5/);

  const imageFilter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ speed: 1.5 }), DIMENSIONS, 8, "image");
  assert.equal(imageFilter, "[v0]null[v1]");
});

test("speed is a no-op at the default value of 1", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ speed: 1 }), DIMENSIONS, 8, "video");
  assert.doesNotMatch(filter, /setpts/);
});

test("zoom slow-in preserves output dimensions for images via zoompan", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ zoom: "slow-in" }), DIMENSIONS, 8, "image");
  assert.match(filter, /zoompan=/);
  assert.match(filter, /s=1080x1920/);
});

test("zoom slow-out uses bounded scale/crop motion for video and preserves dimensions", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ zoom: "slow-out" }), DIMENSIONS, 8, "video");
  assert.doesNotMatch(filter, /zoompan/);
  assert.match(filter, /crop=1080:1920/);
});

test("zoom none emits no zoom filter", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", effects({ zoom: "none" }), DIMENSIONS, 8, "image");
  assert.equal(filter, "[v0]null[v1]");
});

test("chain applies filters in speed, zoom, color, blur, fade order", () => {
  const filter = buildSegmentEffectFilter(
    "[v0]",
    "[v1]",
    {
      ...DEFAULT_SEGMENT_EFFECTS,
      speed: 1.2,
      zoom: "slow-in",
      color: { brightness: 0.1, contrast: 1, saturation: 1, grayscale: 0 },
      blur: 5,
      transitionIn: "fade",
      transitionOut: "cut",
    },
    DIMENSIONS,
    8,
    "video",
  );
  const setptsIndex = filter.indexOf("setpts=PTS/1.2");
  const zoomIndex = filter.indexOf("scale=w=");
  const eqIndex = filter.indexOf("eq=brightness");
  const blurIndex = filter.indexOf("boxblur=5");
  const fadeIndex = filter.indexOf("fade=t=in");

  assert.ok(setptsIndex >= 0, "expected setpts in chain");
  assert.ok(zoomIndex >= 0, "expected scale-based zoom in chain");
  assert.ok(eqIndex >= 0, "expected eq in chain");
  assert.ok(blurIndex >= 0, "expected boxblur in chain");
  assert.ok(fadeIndex >= 0, "expected fade in chain");
  assert.ok(setptsIndex < zoomIndex && zoomIndex < eqIndex && eqIndex < blurIndex && blurIndex < fadeIndex, "filters out of order");
});

test("invalid effects throw before generating any filter", () => {
  assert.throws(() => {
    buildSegmentEffectFilter(
      "[v0]",
      "[v1]",
      { ...DEFAULT_SEGMENT_EFFECTS, speed: 99 },
      DIMENSIONS,
      8,
      "image",
    );
  }, /speed/);
});

test("buildSegmentEffectFilter refuses to silently drop a configured watermark", () => {
  const eligible = eligibleLogoAsset();
  assert.throws(() => {
    buildSegmentEffectFilter(
      "[v0]",
      "[v1]",
      { ...DEFAULT_SEGMENT_EFFECTS, watermark: { assetId: eligible.id, position: "top-left", scale: 0.12, opacity: 0.2 } },
      DIMENSIONS,
      8,
      "image",
    );
  }, /watermark/i);
});

// --- buildVisualEffectFilter (speed+zoom+color+blur only, for watermark composition) ---

test("buildVisualEffectFilter excludes fade handling", () => {
  const filter = buildVisualEffectFilter(
    "[v0]",
    "[v1]",
    { ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "fade", transitionOut: "fade", blur: 3 },
    DIMENSIONS,
    8,
    "image",
  );
  assert.doesNotMatch(filter, /fade=/);
  assert.match(filter, /boxblur=3/);
});

// --- buildFadeFilter (fade edges only) ---

test("buildFadeFilter isolates the fade edge handling", () => {
  const filter = buildFadeFilter("[v0]", "[v1]", { ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "fade", transitionOut: "fade" }, 0.6);
  assert.equal(filter, "[v0]fade=t=in:st=0:d=0.3,fade=t=out:st=0.3:d=0.3[v1]");
});

test("buildFadeFilter returns a null passthrough for cut/cut", () => {
  const filter = buildFadeFilter("[v0]", "[v1]", DEFAULT_SEGMENT_EFFECTS, 8);
  assert.equal(filter, "[v0]null[v1]");
});

// --- buildWatermarkOverlayFilter ---

test("watermark overlay scales relative to width, adjusts opacity, and overlays with a 24px margin", () => {
  const asset = eligibleLogoAsset();
  const result = buildWatermarkOverlayFilter(
    "[v0]",
    "[v1]",
    { assetId: "logo-1", position: "top-right", scale: 0.2, opacity: 0.5 },
    "sample-project",
    [asset],
    DIMENSIONS,
    8,
    3,
  );
  assert.match(result.filter, /scale=216:-1/);
  assert.match(result.filter, /colorchannelmixer=aa=0\.5/);
  assert.match(result.filter, /overlay=W-w-24:24/);
  assert.match(result.filter, /\[v0\]/);
  assert.match(result.filter, /\[v1\]/);
  assert.equal(result.nextInputIndex, 4);
});

test("watermark overlay positions map to the correct fixed 24px margins", () => {
  const asset = eligibleLogoAsset();
  const positions: Array<[WatermarkPosition, RegExp]> = [
    ["top-left", /overlay=24:24/],
    ["top-right", /overlay=W-w-24:24/],
    ["bottom-left", /overlay=24:H-h-24/],
    ["bottom-right", /overlay=W-w-24:H-h-24/],
  ];
  for (const [position, expected] of positions) {
    const result = buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "logo-1", position, scale: 0.1, opacity: 0.2 },
      "sample-project",
      [asset],
      DIMENSIONS,
      8,
      2,
    );
    assert.match(result.filter, expected);
  }
});

test("watermark overlay throws before generating a filter when scale is out of range", () => {
  const asset = eligibleLogoAsset();
  assert.throws(() => {
    buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "logo-1", position: "top-left", scale: 50, opacity: 0.2 },
      "sample-project",
      [asset],
      DIMENSIONS,
      8,
      2,
    );
  }, /watermark\.scale/);
});

test("watermark overlay throws before generating a filter when opacity is out of range", () => {
  const asset = eligibleLogoAsset();
  assert.throws(() => {
    buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "logo-1", position: "top-left", scale: 0.1, opacity: -3 },
      "sample-project",
      [asset],
      DIMENSIONS,
      8,
      2,
    );
  }, /watermark\.opacity/);
});

test("watermark overlay throws when the referenced asset is missing", () => {
  assert.throws(() => {
    buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "missing", position: "top-left", scale: 0.1, opacity: 0.2 },
      "sample-project",
      [],
      DIMENSIONS,
      8,
      2,
    );
  }, /missing asset/);
});

test("watermark overlay throws when the asset is not an eligible logo", () => {
  const ineligible = eligibleLogoAsset({ role: undefined });
  assert.throws(() => {
    buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "logo-1", position: "top-left", scale: 0.1, opacity: 0.2 },
      "sample-project",
      [ineligible],
      DIMENSIONS,
      8,
      2,
    );
  }, /not an eligible logo asset/);
});

test("watermark overlay throws when rights status is user-confirmed only", () => {
  const ineligible = eligibleLogoAsset({ rightsStatus: "user-confirmed" });
  assert.throws(() => {
    buildWatermarkOverlayFilter(
      "[v0]",
      "[v1]",
      { assetId: "logo-1", position: "top-left", scale: 0.1, opacity: 0.2 },
      "sample-project",
      [ineligible],
      DIMENSIONS,
      8,
      2,
    );
  }, /not an eligible logo asset/);
});

test("watermark overlay allocates unique labels across successive calls", () => {
  const asset = eligibleLogoAsset();
  const first = buildWatermarkOverlayFilter(
    "[v0]",
    "[v1]",
    { assetId: "logo-1", position: "top-left", scale: 0.1, opacity: 0.2 },
    "sample-project",
    [asset],
    DIMENSIONS,
    8,
    2,
  );
  const second = buildWatermarkOverlayFilter(
    "[v0]",
    "[v1]",
    { assetId: "logo-1", position: "top-left", scale: 0.1, opacity: 0.2 },
    "sample-project",
    [asset],
    DIMENSIONS,
    8,
    first.nextInputIndex,
  );
  assert.equal(first.nextInputIndex, 3);
  assert.equal(second.nextInputIndex, 4);
  assert.notEqual(first.filter, second.filter);
});
