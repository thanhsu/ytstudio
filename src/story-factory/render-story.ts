import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProcess } from "../process.ts";
import type { BgmPlan } from "./types.ts";

/**
 * Story rendering: one slow zoom/pan segment per scene image, encoded
 * separately and stitched with the concat demuxer (the two-pass pattern from
 * render.ts — a 30-minute filtergraph in one process is where renders go to
 * die), then muxed with the narration and a low ambience bed.
 */

export type StorySegment = {
  /** Absolute path to the scene image; a missing image renders as a dark frame, visibly. */
  imagePath?: string;
  durationSeconds: number;
};

export type StoryRenderDimensions = { width: number; height: number };

const FALLBACK_COLOR = "#0b0f19";
const FADE_SECONDS = 0.5;
/** Total Ken Burns travel over a segment, as a zoom factor delta. */
const ZOOM_TRAVEL = 0.13;

/**
 * Which per-segment fades to bake in. Fade-stitch mode wants both on every
 * segment (the concat demuxer just glues cuts together); xfade mode wants
 * fades only at the very start/end of the whole video — the seams in between
 * are handled by the xfade filter itself, so a segment-level fade there would
 * fight it and produce a double dip.
 */
export type SegmentFadeOptions = { fadeIn: boolean; fadeOut: boolean };

const DEFAULT_SEGMENT_FADES: SegmentFadeOptions = { fadeIn: true, fadeOut: true };

export function buildStorySegmentArgs(
  segment: StorySegment,
  index: number,
  outputPath: string,
  dimensions: StoryRenderDimensions,
  fades: SegmentFadeOptions = DEFAULT_SEGMENT_FADES,
): string[] {
  const duration = Math.max(1, segment.durationSeconds);
  const { width, height } = dimensions;
  const frames = Math.max(2, Math.round(duration * 30));
  const fadeOutStart = Math.max(0, duration - FADE_SECONDS);
  const fadeParts: string[] = [];
  if (fades.fadeIn) fadeParts.push(`fade=t=in:st=0:d=${FADE_SECONDS}`);
  if (fades.fadeOut) fadeParts.push(`fade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}`);
  // A trailing comma only when there is something to chain in front of setsar.
  const fadeChain = fadeParts.length > 0 ? `${fadeParts.join(",")},` : "";
  const encode = [
    "-map",
    "[v]",
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];

  if (!segment.imagePath) {
    return [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${FALLBACK_COLOR}:s=${width}x${height}:r=30:d=${duration}`,
      "-filter_complex",
      `[0:v]${fadeChain}setsar=1[v]`,
      ...encode,
    ];
  }

  // Alternating in/out zoom keeps a long slideshow from feeling mechanical.
  // The image is pre-upscaled so zoompan's subpixel sampling does not jitter.
  const zoom =
    index % 2 === 0
      ? `min(1+${ZOOM_TRAVEL}*on/${frames},1.5)`
      : `max(1+${ZOOM_TRAVEL}-${ZOOM_TRAVEL}*on/${frames},1)`;
  const filter =
    `[0:v]scale=7680:-2,` +
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
    `trim=duration=${duration},setpts=PTS-STARTPTS,${fadeChain}setsar=1[v]`;
  return [
    "-y",
    "-loop",
    "1",
    "-t",
    String(duration),
    "-i",
    segment.imagePath,
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filter,
    ...encode,
  ];
}

/**
 * Chains pairwise `xfade` filters across pre-encoded segment files into one
 * re-encode pass, so the crossfade seams are real dissolves instead of hard
 * cuts. `segmentDurations` are the segments' actual encoded durations (already
 * including the caller's +transitionSeconds padding on every segment but the
 * last), which is what keeps the offsets — and the final video's total
 * duration — correct. A single segment has nothing to cross-fade with, so it
 * degenerates to a plain stream copy.
 */
export function buildXfadeTimelineArgs(
  segmentNames: string[],
  segmentDurations: number[],
  transitionSeconds: number,
  outputName: string,
): string[] {
  const inputs = segmentNames.flatMap((name) => ["-i", name]);
  if (segmentNames.length <= 1) {
    return ["-y", ...inputs, "-c", "copy", outputName];
  }
  const filters: string[] = [];
  let offset = segmentDurations[0] - transitionSeconds;
  let previousLabel = "0:v";
  for (let index = 1; index < segmentNames.length; index += 1) {
    const label = `x${index}`;
    filters.push(
      `[${previousLabel}][${index}:v]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset}[${label}]`,
    );
    previousLabel = label;
    if (index < segmentNames.length - 1) {
      offset = offset + segmentDurations[index] - transitionSeconds;
    }
  }
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[${previousLabel}]`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    outputName,
  ];
}

export type StoryMuxInput = {
  timelinePath: string;
  narrationPath: string;
  bgm: BgmPlan;
  outputPath: string;
  durationSeconds: number;
};

export function buildStoryMuxArgs(input: StoryMuxInput): string[] {
  const args = ["-y", "-i", input.timelinePath, "-i", input.narrationPath];
  const track = input.bgm.tracks[0];
  const events = input.bgm.events ?? [];

  if (events.length === 0) {
    // No SFX events: kept byte-identical to Phase 1, bed or no bed.
    if (track) {
      if (track.loop) {
        args.push("-stream_loop", "-1");
      }
      args.push("-i", track.path);
      args.push(
        "-filter_complex",
        // Narration always dominant: the bed is pulled down before the mix, and
        // duration=first ends the mix with the narration, not the loop.
        `[2:a]volume=${track.volumeDb}dB[bed];[1:a][bed]amix=inputs=2:duration=first:dropout_transition=3[a]`,
        "-map",
        "0:v",
        "-map",
        "[a]",
      );
    } else {
      args.push("-map", "0:v", "-map", "1:a");
    }
    return finishStoryMuxArgs(args, input);
  }

  // At least one SFX event: narration [+ bed] + one input per event, mixed
  // together with normalize=0 so ffmpeg does not quietly rescale narration
  // level just because more inputs joined the mix.
  const mixLabels: string[] = ["[1:a]"];
  const filterParts: string[] = [];
  let inputIndex = 2;
  if (track) {
    if (track.loop) {
      args.push("-stream_loop", "-1");
    }
    args.push("-i", track.path);
    filterParts.push(`[${inputIndex}:a]volume=${track.volumeDb}dB[bed]`);
    mixLabels.push("[bed]");
    inputIndex += 1;
  }
  events.forEach((event, index) => {
    args.push("-i", event.path);
    const delayMs = Math.round(event.atSeconds * 1000);
    filterParts.push(`[${inputIndex}:a]adelay=${delayMs}:all=1,volume=${event.volumeDb}dB[s${index}]`);
    mixLabels.push(`[s${index}]`);
    inputIndex += 1;
  });
  filterParts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0[a]`);
  args.push("-filter_complex", filterParts.join(";"), "-map", "0:v", "-map", "[a]");
  return finishStoryMuxArgs(args, input);
}

function finishStoryMuxArgs(args: string[], input: StoryMuxInput): string[] {
  return [
    ...args,
    "-t",
    String(input.durationSeconds),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-shortest",
    input.outputPath,
  ];
}

export type RenderStoryOptions = {
  segments: StorySegment[];
  narrationPath: string;
  bgm: BgmPlan;
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  signal?: AbortSignal;
  update?: (completedSegments: number, totalSegments: number) => Promise<void>;
  /** Defaults to a plain 0.5s fade-stitch — the original, unchanged behavior. */
  transition?: { kind: "fade" | "xfade"; seconds: number };
};

export async function renderStoryVideo(options: RenderStoryOptions): Promise<void> {
  if (options.segments.length === 0) {
    throw new Error("A story render needs at least one scene segment.");
  }
  const dimensions = { width: options.width ?? 1920, height: options.height ?? 1080 };
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const prefix = options.ffmpegPrefixArgs ?? [];
  const transition = options.transition ?? { kind: "fade" as const, seconds: FADE_SECONDS };
  const useXfade = transition.kind === "xfade";
  await mkdir(dirname(options.outputPath), { recursive: true });
  const temporaryDirectory = join(dirname(options.outputPath), `.story-${Date.now()}`);
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    const names: string[] = [];
    const encodedDurations: number[] = [];
    for (const [index, segment] of options.segments.entries()) {
      const name = `segment-${String(index).padStart(3, "0")}.mp4`;
      names.push(name);
      const isLast = index === options.segments.length - 1;
      // In xfade mode the crossfade eats into the overlap, so every segment
      // but the last is encoded transitionSeconds longer than its scene
      // duration — that overlap is what the xfade filter consumes, keeping
      // the final stitched video the same length as the narration.
      const encodedSegment = useXfade && !isLast
        ? { ...segment, durationSeconds: segment.durationSeconds + transition.seconds }
        : segment;
      const fades: SegmentFadeOptions = useXfade
        ? { fadeIn: index === 0, fadeOut: isLast }
        : DEFAULT_SEGMENT_FADES;
      encodedDurations.push(Math.max(1, encodedSegment.durationSeconds));
      await runProcess(
        ffmpeg,
        [...prefix, ...buildStorySegmentArgs(encodedSegment, index, join(temporaryDirectory, name), dimensions, fades)],
        { signal: options.signal },
      );
      await options.update?.(index + 1, options.segments.length);
    }
    const timelinePath = join(temporaryDirectory, "timeline.mp4");
    if (useXfade) {
      await runProcess(
        ffmpeg,
        [...prefix, ...buildXfadeTimelineArgs(names, encodedDurations, transition.seconds, "timeline.mp4")],
        { signal: options.signal, cwd: temporaryDirectory },
      );
    } else {
      const concatPath = join(temporaryDirectory, "concat.txt");
      // Relative names in the list sidestep Windows drive-letter quoting entirely.
      await writeFile(concatPath, `${names.map((name) => `file '${name}'`).join("\n")}\n`, "utf8");
      await runProcess(
        ffmpeg,
        [...prefix, "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", timelinePath],
        { signal: options.signal },
      );
    }
    await runProcess(
      ffmpeg,
      [
        ...prefix,
        ...buildStoryMuxArgs({
          timelinePath,
          narrationPath: options.narrationPath,
          bgm: options.bgm,
          outputPath: options.outputPath,
          durationSeconds: options.durationSeconds,
        }),
      ],
      { signal: options.signal },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Scenes plus generated images → render segments, in scene order. */
export function buildStorySegments(
  scenes: Array<{ sceneId: string; startSeconds: number; endSeconds: number }>,
  imagePathsBySceneId: Map<string, string>,
): StorySegment[] {
  return scenes.map((scene) => ({
    imagePath: imagePathsBySceneId.get(scene.sceneId),
    durationSeconds: Math.max(1, scene.endSeconds - scene.startSeconds),
  }));
}
