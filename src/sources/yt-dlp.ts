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

export type SourceSearchPlatform = "youtube" | "bilibili";

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
  description?: unknown;
  entries?: unknown;
};

const DEFAULT_SEARCH_PREFIXES: Record<SourceSearchPlatform, string> = {
  youtube: "ytsearch",
  bilibili: "bilisearch",
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
  const executable = requireYtDlpPath(options.ytDlpPath);
  const target = `${prefix}${limit}:${trimmed}`;
  const args = [...(options.ytDlpArgs ?? []), "--dump-json", "--flat-playlist", "--skip-download", target];
  options.onCommand?.(executable, args);

  let stdout: string;
  try {
    stdout = (await runProcess(executable, args, { signal: options.signal })).stdout;
  } catch (error: unknown) {
    throw new Error(`yt-dlp could not search ${platform} for ${redact(trimmed)}: ${redact(failureDetail(error))}`);
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
    thumbnailUrl: text(payload.thumbnail),
  };
}

function resultUrl(payload: YtDlpPayload, platform: SourceSearchPlatform, id: string): string {
  const explicitUrl = text(payload.webpage_url) || text(payload.original_url) || text(payload.url);
  if (/^https?:\/\//i.test(explicitUrl)) return explicitUrl;
  if (platform === "youtube" && id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  if (platform === "bilibili" && id) return `https://www.bilibili.com/video/${encodeURIComponent(id)}`;
  return "";
}

function searchPlatform(value: SourceSearchPlatform): SourceSearchPlatform {
  if (value === "youtube" || value === "bilibili") return value;
  throw new Error(`Unsupported source search platform ${JSON.stringify(value)}.`);
}

function clampLimit(value: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 5;
  return Math.min(number, 25);
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
