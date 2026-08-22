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

type YtDlpPayload = {
  extractor_key?: unknown;
  extractor?: unknown;
  id?: unknown;
  webpage_url?: unknown;
  original_url?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  description?: unknown;
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

function failureDetail(error: unknown): string {
  if (error instanceof ProcessError) {
    return error.stderr.trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
