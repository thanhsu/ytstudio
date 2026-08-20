import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
  ffmpegPath?: string;
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
  const escapedCaptionsPath = input.captionsPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const filter = [
    `color=c=#111827:s=1080x1920:d=${input.durationSeconds}[bg]`,
    `[bg]drawtext=text='${escapeDrawText(input.title)}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=180:box=1:boxcolor=black@0.35:boxborderw=24[v0]`,
    `[v0]subtitles='${escapedCaptionsPath}':force_style='Fontsize=18,Alignment=2'[v]`,
  ].join(";");

  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-i",
    input.voicePath,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-t",
    String(input.durationSeconds),
    "-s",
    "1080x1920",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    input.outputPath,
  ];
}

export async function renderDraft(input: RenderInput, signal?: AbortSignal): Promise<RenderArtifact> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await runProcess(input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", buildShortsRenderArgs(input), { signal });

  const sourceHash = sha256(
    JSON.stringify({
      title: input.title,
      durationSeconds: input.durationSeconds,
      voicePath: input.voicePath,
      captionsPath: input.captionsPath,
      assetPaths: input.assetPaths,
    }),
  );
  const artifact: RenderArtifact = {
    kind: "render",
    sourceHash,
    relativePath: input.outputPath.replace(/^projects\/[^/]+\//, ""),
    createdAt: new Date().toISOString(),
    metadata: {
      durationSeconds: input.durationSeconds,
      width: 1080,
      height: 1920,
    },
  };
  await setArtifact(input.projectId, artifact);
  return artifact;
}

function escapeDrawText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}
