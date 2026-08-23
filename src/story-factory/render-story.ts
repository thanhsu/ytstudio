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

export function buildStorySegmentArgs(
  segment: StorySegment,
  index: number,
  outputPath: string,
  dimensions: StoryRenderDimensions,
): string[] {
  const duration = Math.max(1, segment.durationSeconds);
  const { width, height } = dimensions;
  const frames = Math.max(2, Math.round(duration * 30));
  const fadeOutStart = Math.max(0, duration - FADE_SECONDS);
  const fades = `fade=t=in:st=0:d=${FADE_SECONDS},fade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}`;
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
      `[0:v]${fades},setsar=1[v]`,
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
    `trim=duration=${duration},setpts=PTS-STARTPTS,${fades},setsar=1[v]`;
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
};

export async function renderStoryVideo(options: RenderStoryOptions): Promise<void> {
  if (options.segments.length === 0) {
    throw new Error("A story render needs at least one scene segment.");
  }
  const dimensions = { width: options.width ?? 1920, height: options.height ?? 1080 };
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const prefix = options.ffmpegPrefixArgs ?? [];
  await mkdir(dirname(options.outputPath), { recursive: true });
  const temporaryDirectory = join(dirname(options.outputPath), `.story-${Date.now()}`);
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    const names: string[] = [];
    for (const [index, segment] of options.segments.entries()) {
      const name = `segment-${String(index).padStart(3, "0")}.mp4`;
      names.push(name);
      await runProcess(
        ffmpeg,
        [...prefix, ...buildStorySegmentArgs(segment, index, join(temporaryDirectory, name), dimensions)],
        { signal: options.signal },
      );
      await options.update?.(index + 1, options.segments.length);
    }
    const concatPath = join(temporaryDirectory, "concat.txt");
    // Relative names in the list sidestep Windows drive-letter quoting entirely.
    await writeFile(concatPath, `${names.map((name) => `file '${name}'`).join("\n")}\n`, "utf8");
    const timelinePath = join(temporaryDirectory, "timeline.mp4");
    await runProcess(
      ffmpeg,
      [...prefix, "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", timelinePath],
      { signal: options.signal },
    );
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
