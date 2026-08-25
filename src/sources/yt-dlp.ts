import { ProcessError, runProcess } from "../process.ts";
import { redact } from "../redact.ts";

export type SourceMetadata = {
  platform: string;
  platformVideoId: string;
  canonicalUrl: string;
  title: string;
  uploader: string;
  durationSeconds: number;
  description: string;
};

export type SourceSearchPlatform = "youtube" | "bilibili" | "tiktok" | "douyin" | "facebook" | "seedance";

export type SourceSearchResult = {
  platform: string;
  platformVideoId: string;
  url: string;
  title: string;
  uploader: string;
  durationSeconds: number;
  viewCount: number;
  thumbnailUrl: string;
};

export type YtDlpOptions = {
  ytDlpPath?: string;
  /**
   * Prepended to every invocation. Supplied by configuration only — never from a
   * request body, where it would amount to arbitrary command execution.
   */
  ytDlpArgs?: string[];
  signal?: AbortSignal;
  onCommand?: (executable: string, args: string[]) => void;
};

export type SourceSearchOptions = YtDlpOptions & {
  platform: SourceSearchPlatform;
  limit: number;
  searchPrefixes?: Partial<Record<SourceSearchPlatform, string>>;
  /** Extra attempts after the first. Only transient upstream failures are retried. */
  retries?: number;
  retryDelayMs?: number;
};

type YtDlpPayload = {
  extractor_key?: unknown;
  extractor?: unknown;
  id?: unknown;
  webpage_url?: unknown;
  original_url?: unknown;
  url?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  view_count?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
  description?: unknown;
  entries?: unknown;
};

const DEFAULT_SEARCH_PREFIXES: Record<SourceSearchPlatform, string> = {
  youtube: "ytsearch",
  bilibili: "bilisearch",
  tiktok: "",
  douyin: "",
  facebook: "",
  seedance: "",
};

export function requireYtDlpPath(ytDlpPath?: string): string {
  if (!ytDlpPath) {
    throw new Error("No yt-dlp binary is configured. Set sources.ytDlpPath in studio.config.json.");
  }
  return ytDlpPath;
}

/**
 * Reads what a URL is without fetching any media, so adding a candidate stays
 * cheap and commits to nothing.
 */
export async function fetchSourceMetadata(url: string, options: YtDlpOptions): Promise<SourceMetadata> {
  const executable = requireYtDlpPath(options.ytDlpPath);
  const args = [...(options.ytDlpArgs ?? []), "--dump-single-json", "--skip-download", url];
  options.onCommand?.(executable, args);

  let stdout: string;
  try {
    stdout = (await runProcess(executable, args, { signal: options.signal })).stdout;
  } catch (error: unknown) {
    throw new Error(`yt-dlp could not read ${redact(url)}: ${redact(failureDetail(error))}`);
  }

  let payload: YtDlpPayload;
  try {
    payload = JSON.parse(stdout) as YtDlpPayload;
  } catch {
    throw new Error(`yt-dlp returned output that is not JSON for ${redact(url)}.`);
  }

  const platformVideoId = text(payload.id);
  if (!platformVideoId) {
    throw new Error(`yt-dlp reported no video id for ${redact(url)}.`);
  }

  return {
    platform: text(payload.extractor_key) || text(payload.extractor) || "unknown",
    platformVideoId,
    canonicalUrl: text(payload.webpage_url) || text(payload.original_url) || url,
    title: text(payload.title) || url,
    uploader: text(payload.uploader) || text(payload.channel),
    durationSeconds: Math.max(0, Math.floor(Number(payload.duration) || 0)),
    description: text(payload.description),
  };
}

/**
 * Searches metadata only. Results are candidates the operator may choose to add;
 * nothing is downloaded and no search result is adopted as source footage.
 */
export async function searchSourceMetadata(query: string, options: SourceSearchOptions): Promise<SourceSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("A source search query is required.");
  }
  const platform = searchPlatform(options.platform);
  const limit = clampLimit(options.limit);
  const prefix = options.searchPrefixes?.[platform] || DEFAULT_SEARCH_PREFIXES[platform];
  if (!prefix) {
    throw new Error(`${platform} does not have keyword search configured. Paste a direct video URL or configure sources.searchPrefixes.${platform}.`);
  }
  const executable = requireYtDlpPath(options.ytDlpPath);
  const target = `${prefix}${limit}:${trimmed}`;
  const args = [...(options.ytDlpArgs ?? []), "--dump-json", "--flat-playlist", "--skip-download", target];
  options.onCommand?.(executable, args);

  const attempts = Math.max(1, Math.floor(options.retries ?? DEFAULT_SEARCH_RETRIES) + 1);
  const delayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let stdout = "";
  let lastDetail = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      stdout = (await runProcess(executable, args, { signal: options.signal })).stdout;
      lastDetail = "";
      break;
    } catch (error: unknown) {
      if (isAbort(error, options.signal)) {
        throw error;
      }
      lastDetail = failureDetail(error);
      // Bilibili answers automated search with an intermittent 412, and the same
      // command succeeds seconds later. Retrying is the only honest handling: the
      // failure says nothing about the query, and reporting it as a dead end sends
      // the operator looking for a problem that is not theirs.
      if (attempt === attempts || !isTransientSearchFailure(lastDetail)) {
        break;
      }
      await pause(delayMs * attempt, options.signal);
    }
  }

  if (lastDetail) {
    const tried = attempts > 1 ? ` after ${attempts} attempts` : "";
    throw new Error(
      `yt-dlp could not search ${platform} for ${redact(trimmed)}${tried}: ${redact(lastDetail)}`,
    );
  }

  const payloads = parseSearchPayloads(stdout, trimmed);
  return payloads
    .map((payload) => searchResultFromPayload(payload, platform))
    .filter((result): result is SourceSearchResult => result !== null)
    .slice(0, limit);
}

function parseSearchPayloads(stdout: string, query: string): YtDlpPayload[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as YtDlpPayload;
    if (Array.isArray(parsed.entries)) {
      return parsed.entries.filter(isPayload);
    }
    if (isPayload(parsed)) {
      return [parsed];
    }
  } catch {
    // Fall through to newline-delimited JSON, which is what yt-dlp emits for
    // flat playlist search with --dump-json.
  }

  const payloads: YtDlpPayload[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const part = line.trim();
    if (!part) continue;
    try {
      const payload = JSON.parse(part) as unknown;
      if (isPayload(payload)) payloads.push(payload);
    } catch {
      throw new Error(`yt-dlp returned output that is not search JSON for ${redact(query)}.`);
    }
  }
  return payloads;
}

function searchResultFromPayload(payload: YtDlpPayload, platform: SourceSearchPlatform): SourceSearchResult | null {
  const platformVideoId = text(payload.id);
  const url = resultUrl(payload, platform, platformVideoId);
  if (!platformVideoId || !url) return null;
  return {
    platform: text(payload.extractor_key) || text(payload.extractor) || platform,
    platformVideoId,
    url,
    title: text(payload.title) || url,
    uploader: text(payload.uploader) || text(payload.channel),
    durationSeconds: Math.max(0, Math.floor(Number(payload.duration) || 0)),
    viewCount: Math.max(0, Math.floor(Number(payload.view_count) || 0)),
    thumbnailUrl: thumbnailUrl(payload),
  };
}

function thumbnailUrl(payload: YtDlpPayload): string {
  const direct = text(payload.thumbnail);
  if (direct) return direct;
  if (!Array.isArray(payload.thumbnails)) return "";
  const candidates = payload.thumbnails
    .map((thumbnail) => {
      if (!thumbnail || typeof thumbnail !== "object") return null;
      const record = thumbnail as { url?: unknown; width?: unknown; height?: unknown };
      const url = text(record.url);
      if (!url) return null;
      return {
        url,
        width: Number(record.width) || 0,
        height: Number(record.height) || 0,
      };
    })
    .filter((thumbnail): thumbnail is { url: string; width: number; height: number } => thumbnail !== null);
  candidates.sort((left, right) => right.width * right.height - left.width * left.height);
  return candidates[0]?.url ?? "";
}

function resultUrl(payload: YtDlpPayload, platform: SourceSearchPlatform, id: string): string {
  const explicitUrl = text(payload.webpage_url) || text(payload.original_url) || text(payload.url);
  if (/^https?:\/\//i.test(explicitUrl)) return explicitUrl;
  if (platform === "youtube" && id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  if (platform === "bilibili" && id) return `https://www.bilibili.com/video/${encodeURIComponent(id)}`;
  if (platform === "tiktok" && id) return `https://www.tiktok.com/@unknown/video/${encodeURIComponent(id)}`;
  if (platform === "douyin" && id) return `https://www.douyin.com/video/${encodeURIComponent(id)}`;
  if (platform === "facebook" && id) return `https://www.facebook.com/watch/?v=${encodeURIComponent(id)}`;
  return "";
}

function searchPlatform(value: SourceSearchPlatform): SourceSearchPlatform {
  if (value === "youtube" || value === "bilibili" || value === "tiktok" || value === "douyin" || value === "facebook" || value === "seedance") return value;
  throw new Error(`Unsupported source search platform ${JSON.stringify(value)}.`);
}

function clampLimit(value: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 5;
  return Math.min(number, 25);
}

const DEFAULT_SEARCH_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 900;

/**
 * Whether a failure is worth trying again. Rate limiting, Bilibili's 412
 * anti-automation response, a server error, and a timeout all clear on their own;
 * an unsupported URL, a 404, and an age gate never will, and retrying those only
 * makes the operator wait longer for the same answer.
 */
export function isTransientSearchFailure(detail: string): boolean {
  if (/HTTP Error (412|429|5\d\d)\b/i.test(detail)) return true;
  if (/\btimed? ?out\b/i.test(detail)) return true;
  if (/temporarily unavailable|connection reset|connection aborted/i.test(detail)) return true;
  return false;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPayload(value: unknown): value is YtDlpPayload {
  return Boolean(value && typeof value === "object");
}
