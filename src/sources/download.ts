import { readdir, rm } from "node:fs/promises";
import { loadStudioConfig } from "../config.ts";
import { ProcessError, runProcess } from "../process.ts";
import { redact } from "../redact.ts";
import { assertDownloadable, requireCandidate, withCandidateLock } from "./candidates.ts";
import { resolveSourcePath, saveCandidate, validateSourceId, type SourceCandidate } from "./store.ts";
import { requireYtDlpPath } from "./yt-dlp.ts";

export type DownloadOptions = {
  ytDlpPath?: string;
  /** Configuration only — never a request body, where it would be command execution. */
  ytDlpArgs?: string[];
  format?: string;
  subtitleLanguages?: string[];
  /** Absent means subtitles are not converted, not that the download fails. */
  ffmpegPath?: string;
  signal?: AbortSignal;
  update?: (progress: number, message: string) => Promise<void>;
  onCommand?: (executable: string, args: string[]) => void;
};

export type SubtitleChoice = { path: string; language: string };

const CANDIDATE_FILE = "candidate.json";
const SUBTITLE_PATTERN = /^video\.([a-z]{2,3}(?:-[A-Za-z0-9]+)?)(\.auto)?\.(srt|vtt|ass)$/;

export function parseDownloadProgress(line: string): number | null {
  const match = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

/**
 * yt-dlp emits `video.<lang>[.auto].<ext>` and may write several. An
 * author-provided track always beats an auto-generated one, then the configured
 * language order decides. A language nobody configured still beats no subtitle.
 */
export function selectSubtitle(files: string[], languages: string[]): SubtitleChoice | null {
  const parsed = files
    .map((path) => {
      const match = SUBTITLE_PATTERN.exec(path);
      return match ? { path, language: match[1], auto: Boolean(match[2]) } : null;
    })
    .filter((entry): entry is { path: string; language: string; auto: boolean } => entry !== null);

  if (!parsed.length) return null;

  const rank = (entry: { language: string; auto: boolean }): number => {
    const configured = languages.indexOf(entry.language);
    return (entry.auto ? 1000 : 0) + (configured >= 0 ? configured : languages.length + 1);
  };

  const best = parsed.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path))[0];
  return { path: best.path, language: best.language };
}

/**
 * Downloads a declared candidate. Cleanup runs in `finally` and the status write
 * follows it regardless: a full disk that also defeats cleanup must still leave
 * `failed` on record rather than a candidate frozen in `downloading`.
 */
export async function downloadCandidate(id: string, options: DownloadOptions): Promise<SourceCandidate> {
  const safeId = validateSourceId(id);
  const candidate = await requireCandidate(safeId);
  assertDownloadable(candidate);

  const config = await loadStudioConfig().catch(() => null);
  const executable = requireYtDlpPath(options.ytDlpPath ?? config?.sources.ytDlpPath ?? "");
  const format = options.format ?? config?.sources.format ?? "bv*+ba/b";
  const languages = options.subtitleLanguages ?? config?.sources.subtitleLanguages ?? ["en"];
  const ffmpegPath = options.ffmpegPath ?? config?.render.ffmpegPath ?? "";
  const directory = resolveSourcePath(safeId);

  // A retry must not inherit half of an earlier attempt.
  await clearDownloadedFiles(safeId);
  await patchCandidate(safeId, (current) => ({ ...current, status: "downloading", error: undefined, media: undefined }));

  const args = [
    ...(options.ytDlpArgs ?? config?.sources.ytDlpArgs ?? []),
    "-f",
    format,
    "--write-subs",
    "--write-auto-subs",
    "--newline",
    // Without --ffmpeg-location a split-format download (bv*+ba) leaves
    // unmerged video.f<id>.<ext> files behind and still exits 0.
    ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath, "--convert-subs", "srt"] : []),
    "-o",
    `${directory}/video.%(ext)s`,
    candidate.canonicalUrl,
  ];
  options.onCommand?.(executable, args);

  try {
    const result = await runProcess(executable, args, { signal: options.signal });
    if (options.update) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const progress = parseDownloadProgress(line);
        if (progress !== null) await options.update(progress, `Downloading ${candidate.title}`);
      }
    }
  } catch (error: unknown) {
    await removeQuietly(() => clearDownloadedFiles(safeId));
    // An abort is a cancellation, not a broken source: the remedies differ, and a
    // cancelled download reported as failed reads as damage nobody caused.
    if (isAbort(error, options.signal)) {
      await patchCandidate(safeId, (current) => ({ ...current, status: "metadata", error: undefined }));
      throw error;
    }
    const message = redact(failureDetail(error));
    await patchCandidate(safeId, (current) => ({ ...current, status: "failed", error: message }));
    throw new Error(`yt-dlp could not download ${safeId}: ${message}`);
  }

  const files = await readdir(directory);
  const video = files.find((name) => /^video\.(mp4|mkv|webm|mov|m4a|mp3)$/.test(name));
  if (!video) {
    await removeQuietly(() => clearDownloadedFiles(safeId));
    const message = "yt-dlp exited successfully but wrote no video file.";
    await patchCandidate(safeId, (current) => ({ ...current, status: "failed", error: message }));
    throw new Error(`yt-dlp could not download ${safeId}: ${message}`);
  }

  const subtitle = selectSubtitle(files, languages);
  return patchCandidate(safeId, (current) => ({
    ...current,
    status: "downloaded",
    error: undefined,
    media: {
      videoRelativePath: video,
      ...(subtitle ? { subtitleRelativePath: subtitle.path, subtitleLanguage: subtitle.language } : {}),
      downloadedAt: new Date().toISOString(),
    },
  }));
}

async function patchCandidate(
  id: string,
  change: (current: SourceCandidate) => SourceCandidate,
): Promise<SourceCandidate> {
  return withCandidateLock(id, async () => {
    const updated = change(await requireCandidate(id));
    await saveCandidate(updated);
    return updated;
  });
}

async function clearDownloadedFiles(id: string): Promise<void> {
  const directory = resolveSourcePath(id);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of files) {
    if (name === CANDIDATE_FILE || name === "workspace") continue;
    await rm(resolveSourcePath(id, name), { recursive: true, force: true });
  }
}

/** A cleanup that itself fails must not suppress the status write that follows. */
async function removeQuietly(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    console.error("Unable to clean up a partial download:", error);
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function failureDetail(error: unknown): string {
  if (error instanceof ProcessError) {
    return error.stderr.trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
