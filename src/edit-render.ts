import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keptSegments, outputTimeline, validateEditManifest, type EditManifest } from "./edit-manifest.ts";
import { runProcess } from "./process.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import { renderArtifactRelativePath, type RenderArtifact } from "./render.ts";

export type EditRenderInput = {
  manifest: EditManifest;
  sourceVideoPath: string;
  outputPath: string;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
};

/**
 * Cuts the source once through a single filter graph. Reading the file per
 * segment would decode the same footage repeatedly and leave the joins to a
 * second pass, where audio and video drift apart.
 */
export function buildEditRenderArgs(input: EditRenderInput): string[] {
  const { manifest } = input;
  if (manifest.cutMode === "stream-copy") {
    throw new Error(
      "Cannot render a stream-copy manifest: subtitle boundaries rarely land on a keyframe, so every join would carry seconds of unwanted footage. Set cutMode to reencode.",
    );
  }

  const validation = validateEditManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Edit manifest is not renderable: ${validation.errors.join(" ")}`);
  }

  const kept = keptSegments(manifest);
  const filters: string[] = [];
  const concatInputs: string[] = [];
  for (const [index, segment] of kept.entries()) {
    const range = `start=${segment.sourceStartSeconds}:end=${segment.sourceEndSeconds}`;
    filters.push(`[0:v]trim=${range},setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[0:a]atrim=${range},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${concatInputs.join("")}concat=n=${kept.length}:v=1:a=1[v][a]`);

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

export async function renderEditedCut(input: EditRenderInput, signal?: AbortSignal): Promise<RenderArtifact> {
  const args = buildEditRenderArgs(input);
  await mkdir(dirname(input.outputPath), { recursive: true });
  const ffmpeg = input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  await runProcess(ffmpeg, [...(input.ffmpegPrefixArgs ?? []), ...args], { signal });

  const timeline = outputTimeline(input.manifest);
  const artifact: RenderArtifact = {
    kind: "render",
    // Keyed to the editorial decisions, so toggling a single segment makes the
    // existing render stale instead of passing as current.
    sourceHash: sha256(
      JSON.stringify({
        sourceHash: input.manifest.sourceHash,
        cutMode: input.manifest.cutMode,
        kept: timeline.map((segment) => [segment.id, segment.sourceStartSeconds, segment.sourceEndSeconds]),
      }),
    ),
    relativePath: renderArtifactRelativePath(input.manifest.projectId, input.outputPath),
    createdAt: new Date().toISOString(),
    metadata: {
      durationSeconds: timeline.at(-1)?.outputEndSeconds ?? 0,
      keptSegments: timeline.length,
      droppedSegments: input.manifest.segments.length - timeline.length,
      cutMode: input.manifest.cutMode,
    },
  };
  await setArtifact(input.manifest.projectId, artifact);
  return artifact;
}
