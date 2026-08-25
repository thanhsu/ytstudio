import type { AssetRecord } from "./assets.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { escapeFilterPath } from "./render.ts";
import {
  isEligibleWatermarkAsset,
  validateSegmentEffects,
  WATERMARK_OPACITY_RANGE,
  WATERMARK_SCALE_RANGE,
  type SegmentColorEffects,
  type FlipEffect,
  type SegmentEffects,
  type SegmentWatermarkEffect,
  type TransitionEffect,
  type WatermarkPosition,
  type ZoomEffect,
} from "./visual-effects.ts";

export type MediaType = "image" | "video";

export type EffectDimensions = {
  width: number;
  height: number;
};

export type WatermarkOverlayResult = {
  /** Extra ffmpeg command-line arguments the caller must append (empty: the
   *  watermark is loaded through the `movie` filter, not a separate `-i`). */
  args: string[];
  /** Filter-graph fragment(s), semicolon-joined, consuming `inputLabel` and
   *  producing `outputLabel`. */
  filter: string;
  /** Next free counter value; pass it back in on the following call so
   *  repeated watermark overlays in one shared `-filter_complex` never reuse
   *  a label. */
  nextInputIndex: number;
};

// The renderer's other paths (buildShortsRenderArgs / buildSegmentArgs) fix
// the output frame rate at 30fps, so zoompan's per-frame math uses the same
// constant to stay deterministic and consistent with the rest of the chain.
const ZOOM_FPS = 30;
const IMAGE_ZOOM_DELTA = 0.1;
const VIDEO_ZOOM_DELTA = 0.04;
const FADE_CONSTANT_SECONDS = 0.5;

/**
 * Builds the full per-segment visual effect chain in spec order: flip -> speed
 * (video only) -> zoom motion -> color -> blur -> fade edges. Watermarking is
 * intentionally excluded here because it requires allocating an extra ffmpeg
 * input; compose it with `buildVisualEffectFilter` + `buildWatermarkOverlayFilter`
 * + `buildFadeFilter` instead (see those functions' docs) when a segment has
 * a configured watermark.
 *
 * Applied between fit/crop and trim/concat prep. Throws before generating any
 * filter if `effects` fails `validateSegmentEffects`.
 *
 * Throws if `effects.watermark` is set: this entry point has no way to
 * allocate the extra ffmpeg input a watermark overlay needs, so silently
 * dropping the watermark would be a footgun. Callers with a configured
 * watermark must compose `buildVisualEffectFilter` + `buildWatermarkOverlayFilter`
 * + `buildFadeFilter` instead.
 */
export function buildSegmentEffectFilter(
  inputLabel: string,
  outputLabel: string,
  effects: SegmentEffects,
  dimensions: EffectDimensions,
  duration: number,
  mediaType: MediaType,
): string {
  assertValidEffects(effects);
  if (effects.watermark) {
    throw new Error(
      "buildSegmentEffectFilter cannot render a watermark; compose buildVisualEffectFilter + buildWatermarkOverlayFilter + buildFadeFilter instead.",
    );
  }
  const steps = [
    ...visualEffectSteps(effects, dimensions, duration, mediaType),
    ...fadeSteps(effects.transitionIn, effects.transitionOut, duration),
  ];
  return wrapSteps(inputLabel, outputLabel, steps);
}

/**
 * Flip + speed + zoom + color + blur only (chain order: flip -> speed -> zoom ->
 * color -> blur), stopping before the watermark/fade stages. Use this together with
 * `buildWatermarkOverlayFilter` and `buildFadeFilter` to splice a watermark
 * into the correct position in the chain: blur -> watermark -> fade.
 */
export function buildVisualEffectFilter(
  inputLabel: string,
  outputLabel: string,
  effects: SegmentEffects,
  dimensions: EffectDimensions,
  duration: number,
  mediaType: MediaType,
): string {
  assertValidEffects(effects);
  return wrapSteps(inputLabel, outputLabel, visualEffectSteps(effects, dimensions, duration, mediaType));
}

/**
 * Fade edge handling only. `cut` emits nothing; `fade` fades from/to black
 * within the segment's existing duration. The fade constant is fixed at 0.5s,
 * capped at half of `duration` so both edges never overlap on a short segment.
 */
export function buildFadeFilter(
  inputLabel: string,
  outputLabel: string,
  effects: Pick<SegmentEffects, "transitionIn" | "transitionOut">,
  duration: number,
): string {
  return wrapSteps(inputLabel, outputLabel, fadeSteps(effects.transitionIn, effects.transitionOut, duration));
}

/**
 * Resolves `watermark.assetId` against the project's asset manifest, requires
 * `isEligibleWatermarkAsset`, and builds a filter-graph fragment that loads
 * the logo (via the `movie` filter, so the path can be safely escaped for
 * filter-graph syntax with `escapeFilterPath` rather than passed as a raw
 * `-i` argument), scales it relative to video width, applies opacity via an
 * alpha adjustment, and overlays it with a fixed 24px margin from the
 * configured edge.
 *
 * `nextInputIndex` is a caller-maintained counter (mirroring the one already
 * used by `buildShortsRenderArgs`) that guarantees unique filter labels when
 * multiple segments' watermark overlays are concatenated into one shared
 * `-filter_complex` string.
 */
export function buildWatermarkOverlayFilter(
  inputLabel: string,
  outputLabel: string,
  watermark: SegmentWatermarkEffect,
  projectId: string,
  assets: AssetRecord[],
  dimensions: EffectDimensions,
  duration: number,
  nextInputIndex: number,
): WatermarkOverlayResult {
  const asset = assets.find((candidate) => candidate.id === watermark.assetId);
  if (!asset) {
    throw new Error(`watermark.assetId references a missing asset: ${watermark.assetId}.`);
  }
  if (!isEligibleWatermarkAsset(asset)) {
    throw new Error(`watermark.assetId ${watermark.assetId} is not an eligible logo asset for watermarking.`);
  }
  assertInRange("watermark.scale", watermark.scale, WATERMARK_SCALE_RANGE);
  assertInRange("watermark.opacity", watermark.opacity, WATERMARK_OPACITY_RANGE);

  const logoIndex = nextInputIndex;
  const logoLabel = `[wm${logoIndex}]`;
  const escapedPath = escapeFilterPath(resolveProjectPath(projectId, asset.relativePath));
  const scaledWidth = Math.max(1, Math.round(watermark.scale * dimensions.width));

  const load =
    asset.mediaType === "image"
      ? `movie='${escapedPath}':loop=0,setpts=N/(${ZOOM_FPS}*TB)`
      : `movie='${escapedPath}'`;

  const filter = [
    `${load},trim=duration=${formatNumber(duration)},setpts=PTS-STARTPTS,scale=${scaledWidth}:-1,format=rgba,colorchannelmixer=aa=${formatNumber(watermark.opacity)}${logoLabel}`,
    `${inputLabel}${logoLabel}overlay=${watermarkOverlayPosition(watermark.position)}${outputLabel}`,
  ].join(";");

  return { args: [], filter, nextInputIndex: logoIndex + 1 };
}

function assertValidEffects(effects: SegmentEffects): void {
  const validation = validateSegmentEffects(effects);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }
}

function assertInRange(field: string, value: number, [min, max]: readonly [number, number]): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
}

function visualEffectSteps(
  effects: SegmentEffects,
  dimensions: EffectDimensions,
  duration: number,
  mediaType: MediaType,
): string[] {
  const steps: string[] = [];
  // Flip leads the chain: it mirrors the source geometry, so zoompan's crop
  // window and every later filter see the frame the operator actually picked.
  const flip = buildFlipFilter(effects.flip);
  if (flip) steps.push(flip);
  const speed = buildSpeedFilter(effects.speed, mediaType);
  if (speed) steps.push(speed);
  const zoom = buildZoomFilter(effects.zoom, mediaType, dimensions, duration);
  if (zoom) steps.push(zoom);
  const color = buildColorFilter(effects.color);
  if (color) steps.push(color);
  const blur = buildBlurFilter(effects.blur);
  if (blur) steps.push(blur);
  return steps;
}

function fadeSteps(transitionIn: TransitionEffect, transitionOut: TransitionEffect, duration: number): string[] {
  const steps: string[] = [];
  const fadeDuration = Math.min(FADE_CONSTANT_SECONDS, duration / 2);
  if (transitionIn === "fade") {
    steps.push(`fade=t=in:st=0:d=${formatNumber(fadeDuration)}`);
  }
  if (transitionOut === "fade") {
    steps.push(`fade=t=out:st=${formatNumber(duration - fadeDuration)}:d=${formatNumber(fadeDuration)}`);
  }
  return steps;
}

function wrapSteps(inputLabel: string, outputLabel: string, steps: string[]): string {
  if (steps.length === 0) {
    return `${inputLabel}null${outputLabel}`;
  }
  return `${inputLabel}${steps.join(",")}${outputLabel}`;
}

function buildFlipFilter(flip: FlipEffect): string | undefined {
  if (flip === "horizontal") return "hflip";
  if (flip === "vertical") return "vflip";
  return undefined;
}

function buildSpeedFilter(speed: number, mediaType: MediaType): string | undefined {
  // setpts cannot change the duration of a looped still image, so speed is a
  // no-op for images by design (the 5s source-slice interaction that speed
  // otherwise implies for video is handled by the render path in Task 5).
  if (mediaType === "image") return undefined;
  if (speed === 1) return undefined;
  return `setpts=PTS/${formatNumber(speed)}`;
}

function buildColorFilter(color: SegmentColorEffects): string | undefined {
  const parts: string[] = [];
  const eqParams: string[] = [];
  if (color.brightness !== 0) eqParams.push(`brightness=${formatNumber(color.brightness)}`);
  if (color.contrast !== 1) eqParams.push(`contrast=${formatNumber(color.contrast)}`);
  if (eqParams.length > 0) parts.push(`eq=${eqParams.join(":")}`);

  const effectiveSaturation = Number(formatNumber(color.saturation * (1 - color.grayscale)));
  if (effectiveSaturation !== 1) parts.push(`hue=s=${formatNumber(effectiveSaturation)}`);

  return parts.length > 0 ? parts.join(",") : undefined;
}

function buildBlurFilter(blur: number): string | undefined {
  if (blur <= 0) return undefined;
  return `boxblur=${formatNumber(blur)}`;
}

function buildZoomFilter(zoom: ZoomEffect, mediaType: MediaType, dimensions: EffectDimensions, duration: number): string | undefined {
  if (zoom === "none") return undefined;
  return mediaType === "image"
    ? buildImageZoomFilter(zoom, dimensions, duration)
    : buildVideoZoomFilter(zoom, dimensions, duration);
}

function buildImageZoomFilter(zoom: ZoomEffect, dimensions: EffectDimensions, duration: number): string {
  const frames = Math.max(1, Math.round(duration * ZOOM_FPS));
  const denominator = Math.max(frames - 1, 1);
  const start = zoom === "slow-in" ? 1 : 1 + IMAGE_ZOOM_DELTA;
  const sign = zoom === "slow-in" ? "+" : "-";
  const expression = `${formatNumber(start)}${sign}${formatNumber(IMAGE_ZOOM_DELTA)}*on/${denominator}`;
  return `zoompan=z='${expression}':d=${frames}:s=${dimensions.width}x${dimensions.height}:fps=${ZOOM_FPS}`;
}

// A plain `scale=`/`crop=` expression driven by the `t` frame variable requires
// `eval=frame` to be re-evaluated every frame; without it modern ffmpeg
// evaluates the size expression once at init and fails outright ("frame
// variables not valid in init eval_mode"), which used to kill the whole
// render whenever slow-in/slow-out zoom was applied to a VIDEO segment.
// zoompan sidesteps the issue entirely (its `z` expression is always
// evaluated per output frame), so video zoom mirrors the image zoompan idiom
// below with `d=1` -- each real input frame is emitted once (no looping of a
// single still frame) at the deterministic `ZOOM_FPS` the rest of the
// pipeline already assumes.
function buildVideoZoomFilter(zoom: ZoomEffect, dimensions: EffectDimensions, duration: number): string {
  const frames = Math.max(1, Math.round(duration * ZOOM_FPS));
  const denominator = Math.max(frames - 1, 1);
  const start = zoom === "slow-in" ? 1 : 1 + VIDEO_ZOOM_DELTA;
  const sign = zoom === "slow-in" ? "+" : "-";
  const expression = `${formatNumber(start)}${sign}${formatNumber(VIDEO_ZOOM_DELTA)}*on/${denominator}`;
  return `zoompan=z='${expression}':d=1:s=${dimensions.width}x${dimensions.height}:fps=${ZOOM_FPS}`;
}

function watermarkOverlayPosition(position: WatermarkPosition): string {
  switch (position) {
    case "top-left":
      return "24:24";
    case "top-right":
      return "W-w-24:24";
    case "bottom-left":
      return "24:H-h-24";
    case "bottom-right":
      return "W-w-24:H-h-24";
    default:
      throw new Error(`Unsupported watermark position: ${position as string}`);
  }
}

function formatNumber(value: number, precision = 6): string {
  return String(Number(value.toFixed(precision)));
}
