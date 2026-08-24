import { redact } from "../redact.ts";
import { normalizeYouTubeError, redactedYouTubeError } from "./errors.ts";

const STATS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export async function fetchVideoStats(options: {
  accessToken: string;
  videoIds: string[];
  fetch?: typeof fetch;
}): Promise<Map<string, { views: number; likes: number; comments: number }>> {
  if (options.videoIds.length === 0) return new Map();
  const url = `${STATS_ENDPOINT}?part=statistics&id=${encodeURIComponent(options.videoIds.join(","))}`;
  let response: Response;
  try { response = await (options.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${options.accessToken}` } }); }
  catch (error) { throw redactedYouTubeError(error); }
  if (!response.ok) {
    const mapped = normalizeYouTubeError({ response: { status: response.status, body: await response.text() } });
    throw new Error(`${mapped.code}: ${mapped.message}`);
  }
  const body = await response.json() as { items?: Array<{ id?: unknown; statistics?: Record<string, unknown> }> };
  const result = new Map<string, { views: number; likes: number; comments: number }>();
  for (const item of body.items ?? []) {
    if (typeof item.id !== "string") continue;
    result.set(item.id, {
      views: nonNegativeCount(item.statistics?.viewCount),
      likes: nonNegativeCount(item.statistics?.likeCount),
      comments: nonNegativeCount(item.statistics?.commentCount),
    });
  }
  return result;
}

function nonNegativeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
