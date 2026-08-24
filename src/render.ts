import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AssetRecord } from "./assets.ts";
import { buildFadeFilter, buildSegmentEffectFilter, buildVisualEffectFilter, buildWatermarkOverlayFilter, type EffectDimensions, type MediaType } from "./effects-render.ts";
import { runProcess } from "./process.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { setArtifact, sha256, type PipelineStageStatus } from "./project-state.ts";
import type { ArtifactRecord, VideoFormat } from "./types.ts";
import { DEFAULT_SEGMENT_EFFECTS, type SegmentEffects } from "./visual-effects.ts";

export type RenderGateStageStatus = PipelineStageStatus | "not-required";

export type RenderGateInput = {
  script: RenderGateStageStatus;
  assets: RenderGateStageStatus;
  copyright: RenderGateStageStatus;
  voice: RenderGateStageStatus;
  captions: RenderGateStageStatus;
  visualMapping: RenderGateStageStatus;
};

export type RenderGateResult = {
  allowed: boolean;
  reasons: string[];
};

export type RenderInput = {
  projectId: string;
  title: string;
  durationSeconds: number;
  voicePath: string;
  captionsPath: string;
  outputPath: string;
  assetPaths: string[];
  visualSegments?: RenderVisualSegment[];
  backgroundVideoPath?: string;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  fontFilePath?: string;
  fontDirectory?: string;
  fontName?: string;
  width?: number;
  height?: number;
};

export type RenderVisualSegment = {
  sceneId: string;
  startSeconds: number;
  endSeconds: number;
  assetPath?: string;
  mediaType?: "image" | "video";
  fitMode: "cover" | "contain";
  sourceStartSeconds: number;
  sourceDurationSeconds: number;
  muteSourceAudio: boolean;
  /** Complete normalized effects for this segment. Absent (legacy mapping) is
   *  treated as `DEFAULT_SEGMENT_EFFECTS` at every use site. */
  effects?: SegmentEffects;
  /** The logo asset resolved from the project asset manifest for
   *  `effects.watermark.assetId`, if a watermark is configured. Resolved by the
   *  workflow adapter (after validation) because the renderer's pure builders
   *  don't load the asset manifest themselves. */
  watermarkAsset?: AssetRecord;
};

export type RenderArtifact = ArtifactRecord & {
  kind: "render";
};

export function evaluateRenderGate(input: RenderGateInput): RenderGateResult {
  const reasons = [
    ...gateReason(input.script, "script-approval"),
    ...gateReason(input.assets, "assets-approval"),
    ...gateReason(input.copyright, "copyright-approval"),
    ...gateReason(input.voice, "voice"),
    ...gateReason(input.captions, "captions"),
    ...gateReason(input.visualMapping, "visual-mapping", "not-approved"),
  ];

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

/**
 * A blocked stage is always the consequence of an earlier unmet gate, so it stays
 * silent: reporting it too would bury the reason the operator can actually act on.
 */
function gateReason(status: RenderGateStageStatus, name: string, missingSuffix = "missing"): string[] {
  if (status === "missing") return [`${name}-${missingSuffix}`];
  if (status === "stale") return [`${name}-stale`];
  return [];
}

export function buildShortsRenderArgs(input: RenderInput): string[] {
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;
  const escapedCaptionsPath = escapeFilterPath(input.captionsPath);
  const fontFilePath = escapeFilterPath(input.fontFilePath ?? defaultFontFilePath());
  const fontDirectory = input.fontDirectory ? escapeFilterPath(input.fontDirectory) : undefined;
  const fontName = input.fontName ?? defaultFontName();
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-i",
    input.voicePath,
  ];
  const filters: string[] = [];
  const visualLabels: string[] = [];
  // FFmpeg input 0 is the silent base and input 1 is the voice track, so mapped
  // scenes claim indexes from 2 upward and anything appended later must follow.
  let nextInputIndex = 2;
  for (const [index, segment] of (input.visualSegments ?? []).entries()) {
    const sceneDuration = Math.max(0, segment.endSeconds - segment.startSeconds);
    if (!segment.assetPath || !segment.mediaType) {
      filters.push(`color=c=#111827:s=${width}x${height}:d=${sceneDuration}[scene${index}]`);
      visualLabels.push(`[scene${index}]`);
      continue;
    }
    const inputIndex = nextInputIndex++;
    const effects = segment.effects ?? DEFAULT_SEGMENT_EFFECTS;
    const dimensions: EffectDimensions = { width, height };
    if (segment.mediaType === "image") {
      args.push("-loop", "1", "-t", String(sceneDuration), "-i", segment.assetPath);
      const fitLabel = `[fit${index}]`;
      const preTrimLabel = `[pre${index}]`;
      filters.push(`${visualFilter(inputIndex, width, height, segment.fitMode)}${fitLabel}`);
      const composed = applySegmentEffects(fitLabel, preTrimLabel, effects, dimensions, sceneDuration, "image", input.projectId, segment.watermarkAsset, nextInputIndex, `img${index}`);
      filters.push(...composed.filters);
      nextInputIndex = composed.nextInputIndex;
      filters.push(`${preTrimLabel}trim=duration=${sceneDuration},setpts=PTS-STARTPTS[scene${index}]`);
      visualLabels.push(`[scene${index}]`);
      continue;
    }
    const sourceSliceDuration = Math.min(5, sceneDuration, segment.sourceDurationSeconds);
    const outputSliceDuration = sourceSliceDuration / effects.speed;
    const clipDuration = Math.min(outputSliceDuration, sceneDuration);
    args.push("-ss", String(segment.sourceStartSeconds), "-t", String(sourceSliceDuration), "-an", "-i", segment.assetPath);
    const fitLabel = `[fit${index}]`;
    const preTrimLabel = `[pre${index}]`;
    filters.push(`${visualFilter(inputIndex, width, height, segment.fitMode)}${fitLabel}`);
    const composed = applySegmentEffects(fitLabel, preTrimLabel, effects, dimensions, clipDuration, "video", input.projectId, segment.watermarkAsset, nextInputIndex, `clip${index}`);
    filters.push(...composed.filters);
    nextInputIndex = composed.nextInputIndex;
    filters.push(`${preTrimLabel}trim=duration=${clipDuration},setpts=PTS-STARTPTS[clip${index}]`);
    const remaining = Math.max(0, sceneDuration - clipDuration);
    if (remaining > 0) {
      filters.push(`color=c=#111827:s=${width}x${height}:d=${remaining}[fill${index}]`);
      filters.push(`[clip${index}][fill${index}]concat=n=2:v=1:a=0[scene${index}]`);
    } else {
      filters.push(`[clip${index}]null[scene${index}]`);
    }
    visualLabels.push(`[scene${index}]`);
  }
  if (input.backgroundVideoPath) {
    const backgroundIndex = nextInputIndex++;
    args.push("-i", input.backgroundVideoPath);
    filters.push(`[${backgroundIndex}:v]trim=duration=${input.durationSeconds},setpts=PTS-STARTPTS[bg]`);
  } else if (visualLabels.length > 0) {
    filters.push(`${visualLabels.join("")}concat=n=${visualLabels.length}:v=1:a=0[bg]`);
  } else {
    filters.push(`color=c=#111827:s=${width}x${height}:d=${input.durationSeconds}[bg]`);
  }
  filters.push(`[bg]drawtext=fontfile='${fontFilePath}':text='${escapeDrawText(input.title)}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=180:box=1:boxcolor=black@0.35:boxborderw=24[v0]`);
  const fontDirectoryOption = fontDirectory ? `:fontsdir='${fontDirectory}'` : "";
  filters.push(`[v0]subtitles='${escapedCaptionsPath}'${fontDirectoryOption}:force_style='FontName=${fontName},Fontsize=18,Alignment=2',fps=30[v]`);

  return [...args,
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-t",
    String(input.durationSeconds),
    "-s",
    `${width}x${height}`,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    input.outputPath,
  ];
}

export async function renderDraft(input: RenderInput, signal?: AbortSignal): Promise<RenderArtifact> {
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;
  await mkdir(dirname(input.outputPath), { recursive: true });
  const ffmpeg = input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  let renderInput = input;
  let temporaryDirectory: string | undefined;
  if ((input.visualSegments?.length ?? 0) > 1) {
    const prepared = await prepareVisualTimeline(input, ffmpeg, signal);
    temporaryDirectory = prepared.temporaryDirectory;
    renderInput = { ...input, visualSegments: undefined, backgroundVideoPath: prepared.timelinePath };
  }
  try {
    await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), ...buildShortsRenderArgs(renderInput)], { signal });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const sourceHash = sha256(
    JSON.stringify({
      title: input.title,
      durationSeconds: input.durationSeconds,
      voicePath: input.voicePath,
      captionsPath: input.captionsPath,
      assetPaths: input.assetPaths,
      visualSegments: input.visualSegments,
    }),
  );
  const artifact: RenderArtifact = {
    kind: "render",
    sourceHash,
    relativePath: renderArtifactRelativePath(input.projectId, input.outputPath),
    createdAt: new Date().toISOString(),
    metadata: {
      durationSeconds: input.durationSeconds,
      width,
      height,
    },
  };
  await setArtifact(input.projectId, artifact);
  return artifact;
}

async function prepareVisualTimeline(input: RenderInput, ffmpeg: string, signal?: AbortSignal): Promise<{ temporaryDirectory: string; timelinePath: string }> {
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;
  const temporaryDirectory = join(dirname(input.outputPath), `.visual-${Date.now()}`);
  await mkdir(temporaryDirectory, { recursive: true });
  const segmentPaths: string[] = [];
  for (const [index, segment] of (input.visualSegments ?? []).entries()) {
    const segmentPath = join(temporaryDirectory, `segment-${String(index).padStart(3, "0")}.mp4`);
    segmentPaths.push(segmentPath);
    await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), ...buildSegmentArgs(segment, segmentPath, width, height, input.projectId)], { signal });
  }
  const concatPath = join(temporaryDirectory, "concat.txt");
  await writeFile(concatPath, segmentPaths.map((_path, index) => `file 'segment-${String(index).padStart(3, "0")}.mp4'`).join("\n") + "\n", "utf8");
  const timelinePath = join(temporaryDirectory, "timeline.mp4");
  await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", timelinePath], { signal });
  return { temporaryDirectory, timelinePath };
}

export function buildSegmentArgs(segment: RenderVisualSegment, outputPath: string, width: number, height: number, projectId: string): string[] {
  const duration = Math.max(0.04, segment.endSeconds - segment.startSeconds);
  const encoding = ["-map", "[v]", "-an", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", outputPath];
  if (!segment.assetPath || !segment.mediaType) {
    return ["-y", "-f", "lavfi", "-i", `color=c=#111827:s=${width}x${height}:r=30:d=${duration}`, "-filter_complex", "[0:v]null[v]", ...encoding];
  }
  const effects = segment.effects ?? DEFAULT_SEGMENT_EFFECTS;
  const dimensions: EffectDimensions = { width, height };
  if (segment.mediaType === "image") {
    const fitLabel = "[fit]";
    const preTrimLabel = "[pre]";
    const composed = applySegmentEffects(fitLabel, preTrimLabel, effects, dimensions, duration, "image", projectId, segment.watermarkAsset, 1, "seg");
    const filters = [
      `${visualFilter(0, width, height, segment.fitMode)},fps=30${fitLabel}`,
      ...composed.filters,
      `${preTrimLabel}trim=duration=${duration},setpts=PTS-STARTPTS[v]`,
    ];
    return ["-y", "-loop", "1", "-t", String(duration), "-i", segment.assetPath, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), ...encoding];
  }
  const sourceSliceDuration = Math.min(5, duration, segment.sourceDurationSeconds);
  const outputSliceDuration = sourceSliceDuration / effects.speed;
  const clipDuration = Math.min(outputSliceDuration, duration);
  const remaining = Math.max(0, duration - clipDuration);
  const fitLabel = "[fit]";
  const preTrimLabel = "[pre]";
  const composed = applySegmentEffects(fitLabel, preTrimLabel, effects, dimensions, clipDuration, "video", projectId, segment.watermarkAsset, 1, "seg");
  const filters = [
    `${visualFilter(0, width, height, segment.fitMode)},fps=30${fitLabel}`,
    ...composed.filters,
    `${preTrimLabel}trim=duration=${clipDuration},setpts=PTS-STARTPTS[clip]`,
  ];
  if (remaining > 0) {
    filters.push(`color=c=#111827:s=${width}x${height}:r=30:d=${remaining}[fill]`, "[clip][fill]concat=n=2:v=1:a=0[v]");
  } else filters.push("[clip]null[v]");
  return ["-y", "-ss", String(segment.sourceStartSeconds), "-t", String(sourceSliceDuration), "-an", "-i", segment.assetPath, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), ...encoding];
}

function visualFilter(inputIndex: number, width: number, height: number, fitMode: "cover" | "contain"): string {
  if (fitMode === "contain") {
    return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#111827,setsar=1`;
  }
  return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

/**
 * Composes the effects chain (speed/zoom/color/blur -> watermark -> fade) for
 * one segment, positioned between fit/crop and the segment's own
 * trim/setpts/concat prep. Without a configured watermark this collapses to a
 * single `buildSegmentEffectFilter` call, which resolves to a bare `null`
 * passthrough under neutral defaults (the documented legacy-regression
 * allowance). A configured watermark composes `buildVisualEffectFilter` +
 * `buildWatermarkOverlayFilter` + `buildFadeFilter`, per those functions' docs.
 */
function applySegmentEffects(
  inputLabel: string,
  outputLabel: string,
  effects: SegmentEffects,
  dimensions: EffectDimensions,
  duration: number,
  mediaType: MediaType,
  projectId: string,
  watermarkAsset: AssetRecord | undefined,
  nextInputIndex: number,
  labelPrefix: string,
): { filters: string[]; nextInputIndex: number } {
  if (!effects.watermark) {
    return { filters: [buildSegmentEffectFilter(inputLabel, outputLabel, effects, dimensions, duration, mediaType)], nextInputIndex };
  }
  if (!watermarkAsset) {
    throw new Error(`Segment effects reference watermark asset ${effects.watermark.assetId}, but no resolved watermark asset was supplied to the renderer.`);
  }
  const visualLabel = `[${labelPrefix}fx]`;
  const watermarkLabel = `[${labelPrefix}wm]`;
  const visual = buildVisualEffectFilter(inputLabel, visualLabel, effects, dimensions, duration, mediaType);
  const watermark = buildWatermarkOverlayFilter(visualLabel, watermarkLabel, effects.watermark, projectId, [watermarkAsset], dimensions, duration, nextInputIndex);
  const fade = buildFadeFilter(watermarkLabel, outputLabel, effects, duration);
  return { filters: [visual, watermark.filter, fade], nextInputIndex: watermark.nextInputIndex };
}

export function renderArtifactRelativePath(projectId: string, outputPath: string): string {
  // The configured projects root is authoritative, so derive the relative path
  // from it first. The string markers below stay as a fallback for paths written
  // by another checkout, whose root this process cannot resolve.
  const projectRoot = resolveProjectPath(projectId);
  const inside = relative(projectRoot, resolve(outputPath));
  if (inside && !inside.startsWith("..") && !isAbsolute(inside)) {
    return inside.replace(/\\/g, "/");
  }

  const normalized = outputPath.replace(/\\/g, "/");
  const projectPrefix = `projects/${projectId}/`;
  if (normalized.startsWith(projectPrefix)) {
    return normalized.slice(projectPrefix.length);
  }

  const absoluteProjectMarker = `/${projectPrefix}`;
  const markerIndex = normalized.lastIndexOf(absoluteProjectMarker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + absoluteProjectMarker.length);
  }

  if (normalized.startsWith("workspace/")) {
    return normalized;
  }

  throw new Error(`Render output path is outside project ${projectId}.`);
}

export function escapeDrawText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

export function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function defaultFontFilePath(): string {
  return process.platform === "win32" ? "C:/Windows/Fonts/arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

export function defaultFontName(): string {
  return process.platform === "win32" ? "Arial" : "DejaVu Sans";
}
