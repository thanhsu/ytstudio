import { readFile } from "node:fs/promises";
import type { BgmPlan, VisualPromptCue } from "./types.ts";

export type HyperframesCompositionInput = {
  compositionId: string;
  width: number;
  height: number;
  durationSeconds: number;
  sourceHash: string;
  hyperframesVersion?: string | null;
  narrationRelativePath: string;
  cues: VisualPromptCue[];
  imagesBySceneId: Map<string, string>;
  bgmTracks: BgmPlan["tracks"];
  sfxEvents: BgmPlan["events"];
};

export type HyperframesComposition = {
  html: string;
  frame: string;
  manifest: HyperframesCompositionManifest;
};

export type HyperframesCompositionManifest = {
  version: 1;
  engine: "hyperframes";
  hyperframesVersion: string | null;
  compositionId: string;
  sourceHash: string;
  width: number;
  height: number;
  durationSeconds: number;
  cues: Array<{
    sceneId: string;
    startSeconds: number;
    endSeconds: number;
    mood: string;
    motion: string;
    imagePath: string | null;
  }>;
};

export async function detectHyperframesVersion(packageJsonPath = "node_modules/hyperframes/package.json"): Promise<string | null> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : null;
  } catch {
    return null;
  }
}

export function buildHyperframesComposition(input: HyperframesCompositionInput): HyperframesComposition {
  const stageId = escapeAttribute(input.compositionId);
  const body = [
    `  <div class="background"></div>`,
    ...input.cues.flatMap((cue, index) => sceneLayers(cue, index, input.imagesBySceneId.get(cue.sceneId))),
    narrationLayer(input.narrationRelativePath, input.durationSeconds),
    ...input.bgmTracks.map((track, index) => audioLayer(track.path, track.startSeconds, input.durationSeconds, 20 + index, track.volumeDb)),
    ...input.sfxEvents.map((event, index) => audioLayer(event.path, event.atSeconds, input.durationSeconds - event.atSeconds, 40 + index, event.volumeDb)),
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.compositionId)}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #080b12; overflow: hidden; }
    #stage { position: relative; width: ${input.width}px; height: ${input.height}px; background: #080b12; color: #f8fafc; font-family: Inter, Arial, sans-serif; overflow: hidden; }
    .background { position: absolute; inset: 0; background: radial-gradient(circle at 50% 35%, #1f2937 0, #080b12 62%); }
    .scene-clip { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .scene-fallback { position: absolute; inset: 0; background: linear-gradient(135deg, #0b1020, #111827); }
    .overlay { position: absolute; left: 7%; right: 7%; bottom: 9%; font-size: 64px; line-height: 1.05; font-weight: 800; text-shadow: 0 8px 28px rgba(0,0,0,.65); }
    .caption { position: absolute; left: 8%; right: 8%; bottom: 4%; font-size: 34px; line-height: 1.25; color: #e5e7eb; text-shadow: 0 4px 18px rgba(0,0,0,.7); }
    .motion-slow-push { transform: scale(1.08); }
    .motion-slow-pull { transform: scale(1.0); }
    .motion-drift-left { transform: translateX(-2%) scale(1.04); }
    .motion-drift-right { transform: translateX(2%) scale(1.04); }
    .motion-hold { transform: scale(1.02); }
  </style>
</head>
<body>
<div id="stage" data-composition-id="${stageId}" data-start="0" data-width="${input.width}" data-height="${input.height}" data-duration="${input.durationSeconds}">
${body}
</div>
</body>
</html>
`;

  return {
    html,
    frame: buildFrameNotes(input),
    manifest: {
      version: 1,
      engine: "hyperframes",
      hyperframesVersion: input.hyperframesVersion ?? null,
      compositionId: input.compositionId,
      sourceHash: input.sourceHash,
      width: input.width,
      height: input.height,
      durationSeconds: input.durationSeconds,
      cues: input.cues.map((cue) => ({
        sceneId: cue.sceneId,
        startSeconds: cue.startSeconds,
        endSeconds: cue.endSeconds,
        mood: cue.mood,
        motion: cue.motion,
        imagePath: input.imagesBySceneId.get(cue.sceneId) ?? null,
      })),
    },
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sceneLayers(cue: VisualPromptCue, index: number, imagePath?: string): string[] {
  const duration = Math.max(0, cue.endSeconds - cue.startSeconds);
  const track = index * 3;
  const visual = imagePath
    ? `  <img class="clip scene-clip motion-${escapeAttribute(cue.motion)}" data-start="${cue.startSeconds}" data-duration="${duration}" data-track-index="${track}" src="${escapeAttribute(imagePath)}" alt="">`
    : `  <div class="clip scene-fallback motion-${escapeAttribute(cue.motion)}" data-start="${cue.startSeconds}" data-duration="${duration}" data-track-index="${track}"></div>`;
  return [
    visual,
    `  <div class="clip overlay mood-${escapeAttribute(cue.mood)}" data-start="${cue.startSeconds}" data-duration="${duration}" data-track-index="${track + 1}">${escapeHtml(cue.overlayText)}</div>`,
    `  <div class="clip caption" data-start="${cue.startSeconds}" data-duration="${duration}" data-track-index="${track + 2}">${escapeHtml(cue.narrationExcerpt)}</div>`,
  ];
}

function narrationLayer(path: string, durationSeconds: number): string {
  return `  <audio data-start="0" data-duration="${durationSeconds}" data-track-index="10" src="${escapeAttribute(path)}"></audio>`;
}

function audioLayer(path: string, startSeconds: number, durationSeconds: number, trackIndex: number, volumeDb: number): string {
  const volume = Math.max(0, Math.min(1, Math.pow(10, volumeDb / 20)));
  return `  <audio data-start="${startSeconds}" data-duration="${Math.max(0, durationSeconds)}" data-track-index="${trackIndex}" data-volume="${volume.toFixed(3)}" src="${escapeAttribute(path)}"></audio>`;
}

function buildFrameNotes(input: HyperframesCompositionInput): string {
  const moods = [...new Set(input.cues.map((cue) => cue.mood))].join(", ") || "calm";
  return [
    "# Story Frame",
    "",
    `- Composition: ${input.compositionId}`,
    `- Size: ${input.width}x${input.height}`,
    `- Duration: ${input.durationSeconds}s`,
    `- Moods: ${moods}`,
    "- Source: approved Story Factory narration, scene, image, and timing artifacts.",
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("\n", " ");
}
