import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { sha256 } from "./project-state.ts";
import { loadReviewProject, updateEpisodeSource } from "./review-project.ts";
import { parseSubtitleToTranscript } from "./transcript.ts";

const ALLOWED_MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const ALLOWED_SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

export type ImportReviewEpisodeSubtitleInput = {
  seriesId: string;
  reviewProjectId: string;
  episodeNumber: number;
  sourcePath: string;
  language: string;
};

export type ImportReviewEpisodeMediaInput = {
  seriesId: string;
  reviewProjectId: string;
  episodeNumber: number;
  sourcePath: string;
};

export type ImportedReviewEpisodeSubtitle = {
  seriesId: string;
  reviewProjectId: string;
  episodeNumber: number;
  subtitlePath: string;
  transcriptPath: string;
  cueCount: number;
  originalName: string;
};

export type ImportedReviewEpisodeMedia = {
  seriesId: string;
  reviewProjectId: string;
  episodeNumber: number;
  sourceVideoPath: string;
  originalName: string;
  sizeBytes: number;
};

export async function importReviewEpisodeSubtitle(
  input: ImportReviewEpisodeSubtitleInput,
): Promise<ImportedReviewEpisodeSubtitle> {
  await requireEpisode(input.seriesId, input.reviewProjectId, input.episodeNumber);
  const extension = extname(input.sourcePath).toLowerCase();
  if (!ALLOWED_SUBTITLE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported subtitle extension: ${extension || "(none)"}.`);
  }
  const raw = await readFile(input.sourcePath, "utf8");
  const sourceDir = episodeSourceDir(input.seriesId, input.reviewProjectId, input.episodeNumber);
  await mkdir(sourceDir.absolute, { recursive: true });

  const subtitleRelativePath = relativeJoin(sourceDir.relative, `source${extension}`);
  const transcriptRelativePath = relativeJoin(sourceDir.relative, "transcript.json");
  const subtitlePath = join("projects", input.seriesId, subtitleRelativePath);
  const transcriptPath = join("projects", input.seriesId, transcriptRelativePath);
  await writeFile(subtitlePath, raw, "utf8");

  const transcript = parseSubtitleToTranscript({
    episode: input.episodeNumber,
    sourceFile: basename(input.sourcePath),
    language: input.language,
    content: raw,
  });
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

  await updateEpisodeSource(input.seriesId, input.reviewProjectId, input.episodeNumber, {
    subtitlePath: subtitleRelativePath,
    transcriptPath: transcriptRelativePath,
    sourceHash: sha256(raw),
    status: "transcript-ready",
    error: undefined,
  });

  return {
    seriesId: input.seriesId,
    reviewProjectId: input.reviewProjectId,
    episodeNumber: input.episodeNumber,
    subtitlePath: subtitleRelativePath,
    transcriptPath: transcriptRelativePath,
    cueCount: transcript.length,
    originalName: basename(input.sourcePath),
  };
}

export async function importReviewEpisodeMedia(input: ImportReviewEpisodeMediaInput): Promise<ImportedReviewEpisodeMedia> {
  await requireEpisode(input.seriesId, input.reviewProjectId, input.episodeNumber);
  const extension = extname(input.sourcePath).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported media extension: ${extension || "(none)"}.`);
  }
  const sourceStats = await stat(input.sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error("Media source must be a file.");
  }

  const sourceDir = episodeSourceDir(input.seriesId, input.reviewProjectId, input.episodeNumber);
  await mkdir(sourceDir.absolute, { recursive: true });
  const mediaRelativePath = relativeJoin(sourceDir.relative, `source${extension}`);
  const mediaPath = join("projects", input.seriesId, mediaRelativePath);
  await copyFile(input.sourcePath, mediaPath);

  const project = await updateEpisodeSource(input.seriesId, input.reviewProjectId, input.episodeNumber, {
    sourceVideoPath: mediaRelativePath,
    sourceHash: sha256(`${input.sourcePath}:${sourceStats.size}:${sourceStats.mtimeMs}`),
    status: "source-ready",
    error: undefined,
  });
  const current = project.episodes.find((episode) => episode.episodeNumber === input.episodeNumber);
  if (current?.transcriptPath) {
    await updateEpisodeSource(input.seriesId, input.reviewProjectId, input.episodeNumber, {
      status: "transcript-ready",
    });
  }

  return {
    seriesId: input.seriesId,
    reviewProjectId: input.reviewProjectId,
    episodeNumber: input.episodeNumber,
    sourceVideoPath: mediaRelativePath,
    originalName: basename(input.sourcePath),
    sizeBytes: sourceStats.size,
  };
}

async function requireEpisode(seriesId: string, reviewProjectId: string, episodeNumber: number): Promise<void> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  if (!project.episodes.some((episode) => episode.episodeNumber === episodeNumber)) {
    throw new Error(`Episode ${episodeNumber} is not part of review project ${reviewProjectId}.`);
  }
}

function episodeSourceDir(seriesId: string, reviewProjectId: string, episodeNumber: number): { absolute: string; relative: string } {
  const relative = ["review-projects", reviewProjectId, "sources", `ep${String(episodeNumber).padStart(3, "0")}`].join("/");
  return {
    relative,
    absolute: join("projects", seriesId, relative),
  };
}

function relativeJoin(...segments: string[]): string {
  return segments.join("/");
}
