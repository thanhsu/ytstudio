import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EditManifest } from "./edit-manifest.ts";
import { runProcess } from "./process.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import { renderArtifactRelativePath } from "./render.ts";
import { stringifySrt } from "./srt.ts";
import type { ArtifactRecord } from "./types.ts";

/** Its own kind so a cut never displaces the narrated draft in project state. */
export type CutArtifact = ArtifactRecord & { kind: "cut" };

export type CutSegment = {
  cueIndex: number;
  text: string;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  outputStartSeconds: number;
  outputEndSeconds: number;
};

export type EditRenderInput = {
  projectId: string;
  manifest: EditManifest;
  /** Absolute path to the video the manifest cues were timed against. */
  sourceVideoPath: string;
  outputPath: string;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
};

/**
 * Places every kept cue on the timeline the cut will actually have. Derived on
 * each call rather than stored, so it cannot fall out of step with the manifest
 * the operator keeps editing.
 */
export function cutTimeline(manifest: EditManifest): CutSegment[] {
  let cursorMs = 0;
  return manifest.segments
    .filter((segment) => segment.decision === "keep")
    .map((segment) => {
      const startMs = millisFromTimestamp(segment.start);
      const endMs = millisFromTimestamp(segment.end);
      const outputStartMs = cursorMs;
      cursorMs += endMs - startMs;
      return {
        cueIndex: segment.cueIndex,
        text: segment.text,
        sourceStartSeconds: startMs / 1000,
        sourceEndSeconds: endMs / 1000,
        outputStartSeconds: outputStartMs / 1000,
        outputEndSeconds: cursorMs / 1000,
      };
    });
}

/**
 * Subtitles for the cut output. The manifest exporter writes source-timed
 * subtitles, which stay correct against the original video but drift against a
 * cut one the moment a cue is removed.
 */
export function buildCutSrt(manifest: EditManifest): string {
  return stringifySrt(
    cutTimeline(manifest).map((segment, index) => ({
      index: index + 1,
      start: timestampFromSeconds(segment.outputStartSeconds),
      end: timestampFromSeconds(segment.outputEndSeconds),
      text: segment.text,
    })),
  );
}

/**
 * Cuts the source in a single filter graph. Reading the file once per cue would
 * decode the same footage repeatedly and leave the joins to a second pass, where
 * audio and video drift apart.
 */
export function buildEditRenderArgs(input: EditRenderInput): string[] {
  const timeline = cutTimeline(input.manifest);
  assertRenderable(timeline);

  const filters: string[] = [];
  const concatInputs: string[] = [];
  for (const [index, segment] of timeline.entries()) {
    const range = `start=${segment.sourceStartSeconds}:end=${segment.sourceEndSeconds}`;
    filters.push(`[0:v]trim=${range},setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[0:a]atrim=${range},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${concatInputs.join("")}concat=n=${timeline.length}:v=1:a=1[v][a]`);

  return [
    "-y",
    "-i",
    input.sourceVideoPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

export async function renderEditedCut(input: EditRenderInput, signal?: AbortSignal): Promise<CutArtifact> {
  const args = buildEditRenderArgs(input);
  await mkdir(dirname(input.outputPath), { recursive: true });
  const ffmpeg = input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), ...args], { signal });

  const timeline = cutTimeline(input.manifest);
  const artifact: CutArtifact = {
    kind: "cut",
    // Keyed to the editorial decisions, so toggling one cue makes an existing
    // render stale instead of passing as current.
    sourceHash: sha256(
      JSON.stringify({
        sourceHash: input.manifest.sourceHash,
        kept: timeline.map((segment) => [segment.cueIndex, segment.sourceStartSeconds, segment.sourceEndSeconds]),
      }),
    ),
    relativePath: renderArtifactRelativePath(input.projectId, input.outputPath),
    createdAt: new Date().toISOString(),
    metadata: {
      durationSeconds: timeline.at(-1)?.outputEndSeconds ?? 0,
      keptCues: timeline.length,
      removedCues: input.manifest.segments.length - timeline.length,
    },
  };
  await setArtifact(input.projectId, artifact);
  return artifact;
}

function assertRenderable(timeline: CutSegment[]): void {
  if (!timeline.length) {
    throw new Error("Edit manifest keeps no cues, so there is nothing to render.");
  }

  let previous: CutSegment | undefined;
  for (const segment of timeline) {
    if (segment.sourceEndSeconds <= segment.sourceStartSeconds) {
      throw new Error(`Edit manifest cue ${segment.cueIndex} ends before it starts.`);
    }
    if (previous && segment.sourceStartSeconds < previous.sourceEndSeconds) {
      throw new Error(`Edit manifest cue ${segment.cueIndex} starts before cue ${previous.cueIndex} ends.`);
    }
    previous = segment;
  }
}

function millisFromTimestamp(timestamp: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(timestamp);
  if (!match) {
    throw new Error(`Edit manifest has an invalid subtitle timestamp ${timestamp}.`);
  }
  const [, hours, minutes, seconds, fraction] = match.map(Number) as [number, number, number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

function timestampFromSeconds(value: number): string {
  const totalMs = Math.round(value * 1000);
  const fraction = totalMs % 1000;
  const totalSeconds = (totalMs - fraction) / 1000;
  const pad = (input: number, length = 2) => String(input).padStart(length, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)},${pad(fraction, 3)}`;
}
