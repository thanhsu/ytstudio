import { readdir, rm, writeFile } from "node:fs/promises";
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
  /** Fetch only the audio track; overrides `format`. */
  audioOnly?: boolean;
  subtitleLanguages?: string[];
  /** Absent means subtitles are not converted, not that the download fails. */
  ffmpegPath?: string;
  signal?: AbortSignal;
  fetch?: DirectVideoFetch;
  update?: (progress: number, message: string) => Promise<void>;
  onCommand?: (executable: string, args: string[]) => void;
};

export type SubtitleChoice = { path: string; language: string };
type DirectVideoFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const CANDIDATE_FILE = "candidate.json";
const SUBTITLE_PATTERN = /^video\.([a-z]{2,3}(?:-[A-Za-z0-9]+)?)(\.auto)?\.(srt|vtt|ass)$/;
const VIDEO_PATTERN = /^video\.(mp4|mkv|webm|mov|m4a|mp3)$/;
/** Comment streams that pose as subtitle tracks and that ffmpeg cannot convert. */
const NON_SUBTITLE_TRACKS = ["danmaku", "live_chat"];

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
 * The `--sub-langs` value for the configured languages. yt-dlp reads each entry
 * as a pattern, so an empty list would request nothing at all; falling back to
 * the excluded-only form would do the same. `all` minus the comment streams is
 * the honest reading of "no language preference".
 */
export function subtitleLanguageArgument(languages: string[]): string {
  const wanted = languages.map((language) => language.trim()).filter(Boolean);
  return [...(wanted.length ? wanted : ["all"]), ...NON_SUBTITLE_TRACKS.map((track) => `-${track}`)].join(",");
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
  if (candidate.platform === "SeedancePrompt") {
    return downloadDirectVideoCandidate(safeId, candidate, options);
  }

  const config = await loadStudioConfig().catch(() => null);
  const executable = requireYtDlpPath(options.ytDlpPath ?? config?.sources.ytDlpPath ?? "");
  const format = options.audioOnly ? "ba/b" : options.format ?? config?.sources.format ?? "bv*+ba/b";
  const languages = options.subtitleLanguages ?? config?.sources.subtitleLanguages ?? ["en"];
  const ffmpegPath = options.ffmpegPath ?? config?.render.ffmpegPath ?? "";
  const directory = resolveSourcePath(safeId);

  // A retry must not inherit half of an earlier attempt.
  await clearDownloadedFiles(safeId);
  await patchCandidate(safeId, (current) => ({
    ...current,
    status: "downloading",
    error: undefined,
    warning: undefined,
    media: undefined,
  }));

  const args = [
    ...(options.ytDlpArgs ?? config?.sources.ytDlpArgs ?? []),
    "-f",
    format,
    "--write-subs",
    "--write-auto-subs",
    // Naming the languages keeps two hazards away. Left to itself yt-dlp takes
    // whatever track a platform offers first, and on Bilibili that is danmaku —
    // scrolling comments in an XML ffmpeg cannot convert, which failed the whole
    // download after the video had already arrived. Asking for `all` instead
    // trades that for YouTube handing back a hundred auto-translated languages
    // until it answers 429. The exclusions still hold the line for an operator
    // who configures `all` deliberately.
    "--sub-langs",
    subtitleLanguageArgument(languages),
    "--newline",
    // Without --ffmpeg-location a split-format download (bv*+ba) leaves
    // unmerged video.f<id>.<ext> files behind and still exits 0.
    ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath, "--convert-subs", "srt"] : []),
    "-o",
    `${directory}/video.%(ext)s`,
    candidate.canonicalUrl,
  ];
  options.onCommand?.(executable, args);

  let warning = "";
  try {
    // Progress must reach the job while yt-dlp is still running, throttled to
    // whole percents so a chatty download does not thrash the job store.
    let lastPercent = -1;
    await runProcess(executable, args, {
      signal: options.signal,
      onStdoutLine: options.update
        ? (line) => {
            const progress = parseDownloadProgress(line);
            if (progress === null) return;
            const percent = Math.floor(progress);
            if (percent === lastPercent) return;
            lastPercent = percent;
            // Fire-and-forget: a failed progress write must not kill the download.
            void options.update?.(percent, `Downloading ${candidate.title}`)?.catch(() => {});
          }
        : undefined,
    });
  } catch (error: unknown) {
    // An abort is a cancellation, not a broken source: the remedies differ, and a
    // cancelled download reported as failed reads as damage nobody caused.
    if (isAbort(error, options.signal)) {
      await removeQuietly(() => clearDownloadedFiles(safeId));
      await patchCandidate(safeId, (current) => ({ ...current, status: "metadata", error: undefined }));
      throw error;
    }
    const message = redact(failureDetail(error));
    // yt-dlp reports a post-processing failure — a subtitle it could not convert
    // or could not fetch past a rate limit — with the same non-zero exit as a
    // download that never started, and `--ignore-errors` does not soften it. The
    // subtitle is optional here, so throwing away a merged video over one is the
    // more expensive mistake: keep the video and carry the complaint instead.
    if (!(await hasMergedVideo(directory))) {
      await removeQuietly(() => clearDownloadedFiles(safeId));
      await patchCandidate(safeId, (current) => ({ ...current, status: "failed", error: message }));
      throw new Error(`yt-dlp could not download ${safeId}: ${message}`);
    }
    warning = message;
  }

  const files = await readdir(directory);
  const video = files.find((name) => VIDEO_PATTERN.test(name));
  if (!video) {
    await removeQuietly(() => clearDownloadedFiles(safeId));
    const message = "yt-dlp exited successfully but wrote no video file.";
    await patchCandidate(safeId, (current) => ({ ...current, status: "failed", error: message }));
    throw new Error(`yt-dlp could not download ${safeId}: ${message}`);
  }

  const subtitle = selectSubtitle(files, languages);
  await options.update?.(100, `Saved ${resolveSourcePath(safeId, video)}`);
  return patchCandidate(safeId, (current) => ({
    ...current,
    status: "downloaded",
    error: undefined,
    warning: warning || undefined,
    media: {
      videoRelativePath: video,
      ...(options.audioOnly ? { audioOnly: true } : {}),
      ...(subtitle ? { subtitleRelativePath: subtitle.path, subtitleLanguage: subtitle.language } : {}),
      downloadedAt: new Date().toISOString(),
    },
  }));
}

async function downloadDirectVideoCandidate(
  id: string,
  candidate: SourceCandidate,
  options: DownloadOptions,
): Promise<SourceCandidate> {
  const fetcher = options.fetch ?? fetch;
  await clearDownloadedFiles(id);
  await patchCandidate(id, (current) => ({ ...current, status: "downloading", error: undefined, media: undefined }));

  try {
    await options.update?.(5, `Downloading ${candidate.title}`);
    const response = await fetcher(candidate.canonicalUrl, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const extension = directVideoExtension(candidate.canonicalUrl, response.headers.get("content-type") ?? "");
    const fileName = `video.${extension}`;
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(resolveSourcePath(id, fileName), bytes);
    await options.update?.(100, `Saved ${resolveSourcePath(id, fileName)}`);
    return patchCandidate(id, (current) => ({
      ...current,
      status: "downloaded",
      error: undefined,
      media: {
        videoRelativePath: fileName,
        downloadedAt: new Date().toISOString(),
      },
    }));
  } catch (error: unknown) {
    await removeQuietly(() => clearDownloadedFiles(id));
    if (isAbort(error, options.signal)) {
      await patchCandidate(id, (current) => ({ ...current, status: "metadata", error: undefined }));
      throw error;
    }
    const message = redact(failureDetail(error));
    await patchCandidate(id, (current) => ({ ...current, status: "failed", error: message }));
    throw new Error(`Seedance video could not download ${id}: ${message}`);
  }
}

function directVideoExtension(url: string, contentType: string): string {
  const fromType = /^video\/([a-z0-9-]+)/i.exec(contentType)?.[1];
  if (fromType === "quicktime") return "mov";
  if (fromType === "mp4" || fromType === "webm" || fromType === "x-matroska") {
    return fromType === "x-matroska" ? "mkv" : fromType;
  }
  try {
    const suffix = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    if (suffix === "mp4" || suffix === "webm" || suffix === "mov" || suffix === "mkv") return suffix;
  } catch {
    // Fall through to the safest default the renderer accepts.
  }
  return "mp4";
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

/**
 * Whether a run left a video that is whole. yt-dlp downloads to `.part` and only
 * renames once a stream is complete, and a split format becomes `video.<ext>`
 * only after the merge, so a merged name with no `.part` beside it is the one
 * signal that the media stage finished — whatever the exit code says.
 */
async function hasMergedVideo(directory: string): Promise<boolean> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return false;
  }
  if (files.some((name) => name.endsWith(".part"))) return false;
  return files.some((name) => VIDEO_PATTERN.test(name));
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
