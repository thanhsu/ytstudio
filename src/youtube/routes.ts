import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { loadStudioConfig } from "../config.ts";
import { refreshChannelAnalytics } from "../story-factory/analytics.ts";
import { buildAuthUrl, rememberOAuthState } from "./oauth.ts";
import { clearTokens, getFreshAccessToken, loadTokens } from "./token-store.ts";
import { assertRemoteChannelId, getChannelProfile } from "./channel.ts";
import { deleteRemoteVideo, getRemoteVideo, listRemoteVideos, updateRemoteVideo, validateMetadata, type VideoMetadata } from "./videos.ts";
import { fetchVideoStats } from "./analytics.ts";
import { loadYouTubeStore, removeVideoLink, saveYouTubeStore } from "./youtube-store.ts";

export type YouTubeRouteError = { code: string; message: string; action?: string; details?: unknown };

export type YouTubeRouteTools = {
  sendJson: (status: number, body: unknown) => void;
  sendError: (status: number, error: YouTubeRouteError) => void;
  readBody: () => Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
};

export async function routeYouTube(options: {
  method: string;
  rest: string;
  url: URL;
  seriesId: string;
  request: IncomingMessage;
  tools: YouTubeRouteTools;
}): Promise<boolean> {
  const { method, rest, seriesId, tools } = options;
  const isLegacyAnalytics = rest === "analytics/refresh";
  if (!rest.startsWith("youtube/") && !isLegacyAnalytics) return false;

  const route = rest.startsWith("youtube/") ? rest.slice("youtube/".length) : rest;
  const config = await loadStudioConfig();

  try {
    if (route === "status" && method === "GET") {
      const tokens = await loadTokens(seriesId);
      const configured = Boolean(process.env[config.youtube.clientIdEnv]?.trim() && process.env[config.youtube.clientSecretEnv]?.trim());
      tools.sendJson(200, { ok: true, connected: Boolean(tokens), ...(tokens ? { scope: tokens.scope, connectedAt: tokens.connectedAt } : {}), configured });
      return true;
    }

    if (route === "connect" && method === "POST") {
      const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? "";
      if (!clientId || !process.env[config.youtube.clientSecretEnv]?.trim()) {
        tools.sendError(409, { code: "youtube-not-configured", message: "Configure both YouTube client ID and client secret environment variables first." });
        return true;
      }
      const body = await tools.readBody();
      const redirectBaseUrl = typeof body.redirectBaseUrl === "string" && body.redirectBaseUrl.trim() ? body.redirectBaseUrl.trim().replace(/\/+$/, "") : "http://127.0.0.1:3000";
      const redirectUri = `${redirectBaseUrl}/api/youtube/oauth/callback`;
      const state = `${seriesId}.${randomUUID()}`;
      rememberOAuthState(state, seriesId);
      tools.sendJson(200, { ok: true, authUrl: buildAuthUrl({ clientId, redirectUri, scopes: config.youtube.scopes, state }) });
      return true;
    }

    if (route === "disconnect" && method === "POST") {
      await clearTokens(seriesId);
      tools.sendJson(200, { ok: true, connected: false });
      return true;
    }

    if ((route === "channel" && method === "GET") || (route === "videos" && method === "GET") || /^videos\/[^/]+$/.test(route)) {
      const accessToken = await freshAccessToken(seriesId, config, tools.fetch);
      if (route === "channel") {
        const channel = await getChannelProfile({ accessToken, fetch: tools.fetch });
        const store = await loadYouTubeStore(seriesId);
        assertRemoteChannelId(store.remoteChannelId, channel.id);
        if (!store.remoteChannelId) await saveYouTubeStore(seriesId, { ...store, remoteChannelId: channel.id });
        tools.sendJson(200, { ok: true, channel });
        return true;
      }
      if (route === "videos") {
        const remote = await listRemoteVideos({ accessToken, pageToken: options.url.searchParams.get("pageToken") ?? undefined, fetch: tools.fetch });
        const links = (await loadYouTubeStore(seriesId)).links;
        const videos = remote.videos.map((video) => {
          const link = links.find((candidate) => candidate.videoId === video.videoId);
          return { ...video, sourceProject: link ? seriesId : null, sourceKind: link?.sourceKind ?? null, sourceId: link?.sourceId ?? null };
        });
        tools.sendJson(200, { ok: true, videos, nextPageToken: remote.nextPageToken });
        return true;
      }
      const videoId = route.slice("videos/".length);
      if (method === "GET") {
        const video = await getRemoteVideo({ accessToken, videoId, fetch: tools.fetch });
        const link = (await loadYouTubeStore(seriesId)).links.find((candidate) => candidate.videoId === videoId);
        tools.sendJson(200, { ok: true, video: { ...video, sourceProject: link ? seriesId : null, sourceKind: link?.sourceKind ?? null, sourceId: link?.sourceId ?? null } });
        return true;
      }
      if (method === "PATCH") {
        const metadata = await tools.readBody();
        const candidate: VideoMetadata = { title: metadata.title as string, description: metadata.description as string, tags: metadata.tags as string[], privacyStatus: metadata.privacyStatus as VideoMetadata["privacyStatus"] };
        validateMetadata(candidate);
        const video = await updateRemoteVideo({ accessToken, videoId, metadata: candidate, fetch: tools.fetch });
        tools.sendJson(200, { ok: true, video });
        return true;
      }
      if (method === "DELETE") {
        const body = await tools.readBody();
        if (body.confirm !== true) {
          tools.sendError(400, { code: "youtube-confirmation-required", message: "Set confirm to true to delete the remote video." });
          return true;
        }
        await deleteRemoteVideo({ accessToken, videoId, confirm: true, fetch: tools.fetch });
        await removeVideoLink(seriesId, videoId);
        tools.sendJson(200, { ok: true, videoId, deleted: true });
        return true;
      }
    }

    if (route === "analytics/refresh" && method === "POST") {
      const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? "";
      const clientSecret = process.env[config.youtube.clientSecretEnv]?.trim() ?? "";
      if (!clientId || !clientSecret || !await loadTokens(seriesId)) {
        tools.sendError(409, { code: "youtube-not-connected", message: "Connect YouTube for this channel before refreshing analytics." });
        return true;
      }
      const accessToken = await getFreshAccessToken(seriesId, { clientId, clientSecret, fetch: tools.fetch });
      const result = await refreshChannelAnalytics(seriesId, { fetchStats: (videoIds) => fetchVideoStats({ accessToken, videoIds, fetch: tools.fetch }) });
      tools.sendJson(200, { ok: true, ...result });
      return true;
    }

    tools.sendError(404, { code: "not-found", message: "YouTube route not found." });
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "YouTube request failed.";
    const code = message.split(":", 1)[0] || "youtube-request-failed";
    const status = code === "youtube-invalid-metadata" || code === "youtube-confirmation-required" ? 400 : code === "youtube-channel-mismatch" ? 409 : code === "youtube-video-not-found" ? 404 : code === "youtube-not-connected" ? 409 : 502;
    tools.sendError(status, { code, message: message.includes(":") ? message.slice(message.indexOf(":") + 1).trim() : message });
    return true;
  }
}

async function freshAccessToken(seriesId: string, config: Awaited<ReturnType<typeof loadStudioConfig>>, fetchImpl?: typeof fetch): Promise<string> {
  const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? "";
  const clientSecret = process.env[config.youtube.clientSecretEnv]?.trim() ?? "";
  if (!clientId || !clientSecret || !await loadTokens(seriesId)) throw new Error("youtube-not-connected: Connect YouTube for this channel first.");
  return getFreshAccessToken(seriesId, { clientId, clientSecret, fetch: fetchImpl });
}
