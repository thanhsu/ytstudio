import { redact } from "../redact.ts";
import { normalizeYouTubeError, redactedYouTubeError } from "./errors.ts";

const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";

export type ChannelProfile = {
  id: string; title: string; description: string; customUrl: string | null; thumbnailUrl: string | null;
  uploadsPlaylistId: string | null; subscriberCount: number; videoCount: number; viewCount: number;
};

export async function getChannelProfile(options: { accessToken: string; fetch?: typeof fetch }): Promise<ChannelProfile> {
  const url = `${CHANNELS_ENDPOINT}?${new URLSearchParams({ part: "snippet,contentDetails,statistics", mine: "true" })}`;
  let response: Response;
  try { response = await (options.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${options.accessToken}` } }); }
  catch (error) { throw redactedYouTubeError(error); }
  if (!response.ok) { const body = redact(await response.text()); throw new Error(`${normalizeYouTubeError({ response: { status: response.status, body } }).code}: YouTube channel request failed.`); }
  const payload = await response.json() as { items?: unknown[] };
  const item = payload.items?.[0] as Record<string, any> | undefined;
  if (!item || typeof item.id !== "string" || !/^UC[\w-]+$/.test(item.id)) throw new Error("youtube-channel-not-found: No connected YouTube channel was found.");
  const snippet = item.snippet ?? {}; const stats = item.statistics ?? {}; const playlists = item.contentDetails?.relatedPlaylists ?? {};
  return { id: item.id, title: stringValue(snippet.title), description: stringValue(snippet.description), customUrl: stringOrNull(snippet.customUrl), thumbnailUrl: stringOrNull(snippet.thumbnails?.default?.url), uploadsPlaylistId: stringOrNull(playlists.uploads), subscriberCount: count(stats.subscriberCount), videoCount: count(stats.videoCount), viewCount: count(stats.viewCount) };
}

export function assertRemoteChannelId(storedRemoteId: string | null, fetchedRemoteId: string): void {
  if (storedRemoteId && storedRemoteId !== fetchedRemoteId) throw new Error("youtube-channel-mismatch: This series is connected to a different YouTube channel. Reconnect to change it.");
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function count(value: unknown): number { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
