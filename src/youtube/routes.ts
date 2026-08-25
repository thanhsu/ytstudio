import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { loadStudioConfig } from "../config.ts";
import { buildAuthUrl, rememberOAuthState } from "./oauth.ts";
import { clearTokens, getFreshAccessToken, loadTokens } from "./token-store.ts";
import { assertRemoteChannelId, getChannelProfile } from "./channel.ts";
import { deleteRemoteVideo, getRemoteVideo, listRemoteVideos, updateRemoteVideo, validateMetadata, type VideoMetadata } from "./videos.ts";
import { fetchVideoStats } from "./analytics.ts";
import { loadYouTubeStore, removeVideoLink, saveYouTubeStore, updateAnalyticsSnapshots } from "./youtube-store.ts";
import { cancelYouTubePublish, startYouTubePublish, type YouTubePublishDeps } from "./publish.ts";
import { evaluatePublishReadiness, type PublishSourceKind } from "./publish-readiness.ts";

export type YouTubeRouteError = { code: string; message: string; action?: string; details?: unknown };

export type YouTubeRouteTools = {
  sendJson: (status: number, body: unknown) => void;
  sendError: (status: number, error: YouTubeRouteError) => void;
  readBody: () => Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
  publishDeps?: YouTubePublishDeps;
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
      rememberOAuthState(state, seriesId, redirectUri);
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

    if (route === "analytics" && method === "GET") {
      const store = await loadYouTubeStore(seriesId);
      const analytics = store.links.map((link) => ({
        videoId: link.videoId,
        sourceProject: seriesId,
        sourceKind: link.sourceKind,
        sourceId: link.sourceId,
        snapshot: store.analytics[link.videoId] ?? null,
      }));
      tools.sendJson(200, { ok: true, analytics });
      return true;
    }

    if (route === "analytics/refresh" && method === "POST") {
      const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? "";
      const clientSecret = process.env[config.youtube.clientSecretEnv]?.trim() ?? "";
      if (!clientId || !clientSecret || !await loadTokens(seriesId)) {
        tools.sendError(409, { code: "youtube-not-connected", message: "Connect YouTube for this channel before refreshing analytics." });
        return true;
      }
      const accessToken = await getFreshAccessToken(seriesId, { clientId, clientSecret, fetch: tools.fetch });
      const body = await tools.readBody();
      const store = await loadYouTubeStore(seriesId);
      const requestedIds = Array.isArray(body.videoIds) ? body.videoIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : store.links.map((link) => link.videoId);
      const uniqueIds = [...new Set(requestedIds)];
      const stats = await fetchVideoStats({ accessToken, videoIds: uniqueIds, fetch: tools.fetch });
      const fetchedAt = new Date().toISOString();
      const snapshots = Object.fromEntries(uniqueIds.map((videoId) => {
        const values = stats.get(videoId) ?? { views: 0, likes: 0, comments: 0 };
        return [videoId, { ...values, fetchedAt }];
      }));
      await updateAnalyticsSnapshots(seriesId, snapshots);
      tools.sendJson(200, { ok: true, refreshed: uniqueIds.map((videoId) => ({ videoId, fetchedAt })) });
      return true;
    }

    if (route === "publish" && method === "GET") {
      tools.sendJson(200, { ok: true, jobs: await loadYouTubeStore(seriesId).then((store) => store.jobs) });
      return true;
    }
    if (route === "publish/readiness" && method === "GET") {
      const sourceKind = options.url.searchParams.get("sourceKind") as PublishSourceKind | null;
      const sourceId = options.url.searchParams.get("sourceId") ?? "";
      if (!sourceKind || !["story", "review", "compilation"].includes(sourceKind) || !sourceId.trim()) {
        tools.sendError(400, { code: "youtube-readiness-input", message: "Choose a source kind and source id before checking publish readiness." });
        return true;
      }
      const readiness = await evaluatePublishReadiness(seriesId, sourceKind, sourceId);
      tools.sendJson(200, { ok: true, readiness });
      return true;
    }
    const publishJobMatch = /^publish\/([^/]+)$/.exec(route);
    if (publishJobMatch && method === "GET") {
      const job = (await loadYouTubeStore(seriesId)).jobs.find((candidate) => candidate.id === publishJobMatch[1]);
      if (!job) { tools.sendError(404, { code: "youtube-job-not-found", message: "Publish job not found." }); return true; }
      tools.sendJson(200, { ok: true, job });
      return true;
    }
    const cancelMatch = /^publish\/([^/]+)\/cancel$/.exec(route);
    if (cancelMatch && method === "POST") {
      const job = await cancelYouTubePublish(seriesId, cancelMatch[1], tools.publishDeps);
      tools.sendJson(200, { ok: true, job });
      return true;
    }
    if (route === "publish" && method === "POST") {
      const body = await tools.readBody();
      const job = await startYouTubePublish(seriesId, {
        sourceKind: body.sourceKind as "story" | "review" | "compilation",
        sourceId: typeof body.sourceId === "string" ? body.sourceId : "",
        exportPath: typeof body.exportPath === "string" ? body.exportPath : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        thumbnailPath: typeof body.thumbnailPath === "string" ? body.thumbnailPath : undefined,
        privacyStatus: body.privacyStatus as "public" | "private" | "unlisted" | undefined,
        publishAt: typeof body.publishAt === "string" ? body.publishAt : undefined,
      }, tools.publishDeps);
      tools.sendJson(202, { ok: true, job });
      return true;
    }

    tools.sendError(404, { code: "not-found", message: "YouTube route not found." });
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "YouTube request failed.";
    const code = message.split(":", 1)[0] || "youtube-request-failed";
    const status = code === "youtube-invalid-metadata" || code === "youtube-metadata-invalid" || code === "youtube-confirmation-required" ? 400 : code === "source-not-found" || code === "youtube-job-not-found" || code === "youtube-video-not-found" ? 404 : code === "youtube-approval-required" || code === "youtube-export-missing" || code === "youtube-channel-mismatch" || code === "youtube-not-connected" || code === "youtube-publish-running" ? 409 : 502;
    const typed = error as { action?: string; matrix?: unknown };
    tools.sendError(status, { code, message: message.includes(":") ? message.slice(message.indexOf(":") + 1).trim() : message, ...(typed.action ? { action: typed.action } : {}), ...(typed.matrix ? { details: { matrix: typed.matrix } } : {}) });
    return true;
  }
}

async function freshAccessToken(seriesId: string, config: Awaited<ReturnType<typeof loadStudioConfig>>, fetchImpl?: typeof fetch): Promise<string> {
  const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? "";
  const clientSecret = process.env[config.youtube.clientSecretEnv]?.trim() ?? "";
  if (!clientId || !clientSecret || !await loadTokens(seriesId)) throw new Error("youtube-not-connected: Connect YouTube for this channel first.");
  return getFreshAccessToken(seriesId, { clientId, clientSecret, fetch: fetchImpl });
}
