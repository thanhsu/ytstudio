import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProcess } from "./process.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import type { ArtifactRecord, VideoFormat } from "./types.ts";

export type RenderGateInput = {
  briefFormat: VideoFormat;
  scriptApprovalCurrent: boolean;
  assetsApprovalCurrent: boolean;
  copyrightApprovalCurrent: boolean;
  voiceReady: boolean;
  captionsReady: boolean;
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
};

export type RenderArtifact = ArtifactRecord & {
  kind: "render";
};

export function evaluateRenderGate(input: RenderGateInput): RenderGateResult {
  const reasons: string[] = [];

  if (input.briefFormat !== "shorts") reasons.push("longform-not-supported");
  if (!input.scriptApprovalCurrent) reasons.push("script-approval-stale");
  if (!input.assetsApprovalCurrent) reasons.push("assets-approval-stale");
  if (!input.copyrightApprovalCurrent) reasons.push("copyright-approval-stale");
  if (!input.voiceReady) reasons.push("voice-missing");
  if (!input.captionsReady) reasons.push("captions-missing");

  return {
    allowed: reasons.length === 0,
    reasons,
  };
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
  for (const [index, segment] of (input.visualSegments ?? []).entries()) {
    const sceneDuration = Math.max(0, segment.endSeconds - segment.startSeconds);
    if (!segment.assetPath || !segment.mediaType) {
      filters.push(`color=c=#111827:s=${width}x${height}:d=${sceneDuration}[scene${index}]`);
      visualLabels.push(`[scene${index}]`);
      continue;
    }
    const inputIndex = index + 2;
    if (segment.mediaType === "image") {
      args.push("-loop", "1", "-t", String(sceneDuration), "-i", segment.assetPath);
      filters.push(`${visualFilter(inputIndex, width, height, segment.fitMode)},trim=duration=${sceneDuration},setpts=PTS-STARTPTS[scene${index}]`);
      visualLabels.push(`[scene${index}]`);
      continue;
    }
    const clipDuration = Math.min(5, sceneDuration, segment.sourceDurationSeconds);
    args.push("-ss", String(segment.sourceStartSeconds), "-t", String(clipDuration), "-an", "-i", segment.assetPath);
    filters.push(`${visualFilter(inputIndex, width, height, segment.fitMode)},trim=duration=${clipDuration},setpts=PTS-STARTPTS[clip${index}]`);
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
    args.push("-i", input.backgroundVideoPath);
    filters.push(`[2:v]trim=duration=${input.durationSeconds},setpts=PTS-STARTPTS[bg]`);
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
    await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), ...buildSegmentArgs(segment, segmentPath, width, height)], { signal });
  }
  const concatPath = join(temporaryDirectory, "concat.txt");
  await writeFile(concatPath, segmentPaths.map((_path, index) => `file 'segment-${String(index).padStart(3, "0")}.mp4'`).join("\n") + "\n", "utf8");
  const timelinePath = join(temporaryDirectory, "timeline.mp4");
  await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", timelinePath], { signal });
  return { temporaryDirectory, timelinePath };
}

function buildSegmentArgs(segment: RenderVisualSegment, outputPath: string, width: number, height: number): string[] {
  const duration = Math.max(0.04, segment.endSeconds - segment.startSeconds);
  const encoding = ["-map", "[v]", "-an", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", outputPath];
  if (!segment.assetPath || !segment.mediaType) {
    return ["-y", "-f", "lavfi", "-i", `color=c=#111827:s=${width}x${height}:r=30:d=${duration}`, "-filter_complex", "[0:v]null[v]", ...encoding];
  }
  if (segment.mediaType === "image") {
    return ["-y", "-loop", "1", "-t", String(duration), "-i", segment.assetPath, "-filter_complex_threads", "1", "-filter_complex", `${visualFilter(0, width, height, segment.fitMode)},fps=30,trim=duration=${duration},setpts=PTS-STARTPTS[v]`, ...encoding];
  }
  const clipDuration = Math.min(5, duration, segment.sourceDurationSeconds);
  const remaining = Math.max(0, duration - clipDuration);
  const filters = [`${visualFilter(0, width, height, segment.fitMode)},fps=30,trim=duration=${clipDuration},setpts=PTS-STARTPTS[clip]`];
  if (remaining > 0) {
    filters.push(`color=c=#111827:s=${width}x${height}:r=30:d=${remaining}[fill]`, "[clip][fill]concat=n=2:v=1:a=0[v]");
  } else filters.push("[clip]null[v]");
  return ["-y", "-ss", String(segment.sourceStartSeconds), "-t", String(clipDuration), "-an", "-i", segment.assetPath, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), ...encoding];
}

function visualFilter(inputIndex: number, width: number, height: number, fitMode: "cover" | "contain"): string {
  if (fitMode === "contain") {
    return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#111827,setsar=1`;
  }
  return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

export function renderArtifactRelativePath(projectId: string, outputPath: string): string {
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

function escapeDrawText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function defaultFontFilePath(): string {
  return process.platform === "win32" ? "C:/Windows/Fonts/arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

function defaultFontName(): string {
  return process.platform === "win32" ? "Arial" : "DejaVu Sans";
}
