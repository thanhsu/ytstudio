import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { loadStudioConfig } from "./config.ts";
import { runProcess } from "./process.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import { resolveProjectPath } from "./project-paths.ts";

export type MediaArtifact = {
  projectId: string;
  relativePath: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
};

export type AudioArtifact = {
  projectId: string;
  relativePath: string;
  createdAt: string;
};

const ALLOWED_MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

export async function importMedia(projectId: string, sourcePath: string): Promise<MediaArtifact> {
  const extension = extname(sourcePath).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported media extension: ${extension || "(none)"}.`);
  }

  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error("Media source must be a file.");
  }

  const workspaceDir = resolveProjectPath(projectId, join("workspace", "media"));
  await mkdir(workspaceDir, { recursive: true });
  const targetRelativePath = join("workspace", "media", `source${extension}`);
  const targetPath = resolveProjectPath(projectId, targetRelativePath);
  await copyFile(sourcePath, targetPath);

  const artifact: MediaArtifact = {
    projectId,
    relativePath: targetRelativePath,
    originalName: basename(sourcePath),
    sizeBytes: sourceStats.size,
    createdAt: new Date().toISOString(),
  };
  await setArtifact(projectId, {
    kind: "media",
    sourceHash: sha256(`${sourcePath}:${sourceStats.size}:${sourceStats.mtimeMs}`),
    relativePath: artifact.relativePath,
    createdAt: artifact.createdAt,
    metadata: {
      originalName: artifact.originalName,
      sizeBytes: artifact.sizeBytes,
    },
  });
  return artifact;
}

export async function extractAudioForAsr(
  projectId: string,
  mediaRelativePath = join("workspace", "media", "source.mp4"),
  options: { ffmpegPath?: string; prefixArgs?: string[] } = {},
): Promise<AudioArtifact> {
  const config = await loadStudioConfig();
  const mediaPath = resolveProjectPath(projectId, mediaRelativePath);
  const outputRelativePath = join("workspace", "media", "asr-audio.wav");
  const outputPath = resolveProjectPath(projectId, outputRelativePath);
  await mkdir(resolveProjectPath(projectId, join("workspace", "media")), { recursive: true });

  const ffmpeg = (options.ffmpegPath ?? config.render.ffmpegPath) || process.env.FFMPEG_PATH || "ffmpeg";
  await runProcess(ffmpeg, [
    ...(options.prefixArgs ?? []),
    "-y",
    "-i",
    mediaPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);

  const createdAt = new Date().toISOString();
  await setArtifact(projectId, {
    kind: "audio",
    sourceHash: sha256(`${mediaRelativePath}:${createdAt}`),
    relativePath: outputRelativePath,
    createdAt,
    metadata: {
      purpose: "asr",
    },
  });
  return { projectId, relativePath: outputRelativePath, createdAt };
}
