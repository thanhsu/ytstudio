import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeYouTube } from "../src/youtube/routes.ts";
import { saveTokens } from "../src/youtube/token-store.ts";
import { saveYouTubeStore, type YouTubeStore } from "../src/youtube/youtube-store.ts";

const baseStore = (): YouTubeStore => ({ version: 1, remoteChannelId: "UC123", links: [{ version: 1, videoId: "v1", channelId: "UC123", sourceKind: "story", sourceId: "s1", exportPath: "x", title: "Video", privacyStatus: "public", publishAt: null, createdAt: "now", updatedAt: "now" }], jobs: [], analytics: { v1: { views: 1, likes: 2, comments: 3, fetchedAt: "2026-08-24T00:00:00.000Z" } } });

async function withRoute(run: (calls: string[]) => Promise<void>) {
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const previousClient = process.env.YOUTUBE_CLIENT_ID;
  const previousSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const root = await mkdtemp(join(tmpdir(), "yt-analytics-route-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root; process.env.YOUTUBE_CLIENT_ID = "client"; process.env.YOUTUBE_CLIENT_SECRET = "secret";
  try { await saveTokens("series-1", { version: 1, refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: "scope", connectedAt: "now" }); await saveYouTubeStore("series-1", baseStore()); await run([]); }
  finally { if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot; if (previousClient === undefined) delete process.env.YOUTUBE_CLIENT_ID; else process.env.YOUTUBE_CLIENT_ID = previousClient; if (previousSecret === undefined) delete process.env.YOUTUBE_CLIENT_SECRET; else process.env.YOUTUBE_CLIENT_SECRET = previousSecret; await rm(root, { recursive: true, force: true }); }
}

test("GET analytics returns cached snapshots without provider calls", async () => {
  await withRoute(async (calls) => {
    const result: unknown[] = [];
    await routeYouTube({ method: "GET", rest: "youtube/analytics", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools: { sendJson: (_status, body) => result.push(body), sendError: (_status, body) => result.push(body), readBody: async () => ({}), fetch: async () => { calls.push("provider"); return new Response("{}"); } } });
    assert.equal(calls.length, 0);
    assert.deepEqual((result[0] as { analytics: unknown }).analytics, [{ videoId: "v1", sourceProject: "series-1", sourceKind: "story", sourceId: "s1", snapshot: { views: 1, likes: 2, comments: 3, fetchedAt: "2026-08-24T00:00:00.000Z" } }]);
  });
});

test("POST analytics refresh updates snapshots atomically and returns timestamps", async () => {
  await withRoute(async (calls) => {
    const result: unknown[] = [];
    await routeYouTube({ method: "POST", rest: "youtube/analytics/refresh", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools: { sendJson: (_status, body) => result.push(body), sendError: (_status, body) => result.push(body), readBody: async () => ({ videoIds: ["v1"] }), fetch: async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ items: [{ id: "v1", statistics: { viewCount: "12", likeCount: "bad", commentCount: "4" } }] })); } } });
    assert.equal(calls.length, 1);
    assert.deepEqual((result[0] as { refreshed: Array<{ videoId: string }> }).refreshed.map((item) => item.videoId), ["v1"]);
    const store = await (await import("../src/youtube/youtube-store.ts")).loadYouTubeStore("series-1");
    assert.equal(store.analytics.v1.views, 12); assert.equal(store.analytics.v1.likes, 0); assert.equal(store.analytics.v1.comments, 4);
  });
});

test("analytics provider failures return redacted errors", async () => {
  await withRoute(async () => {
    const result: unknown[] = [];
    await routeYouTube({ method: "POST", rest: "youtube/analytics/refresh", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools: { sendJson: (_status, body) => result.push(body), sendError: (_status, body) => result.push(body), readBody: async () => ({ videoIds: ["v1"] }), fetch: async () => new Response("secret provider payload", { status: 500 }) } });
    assert.equal((result[0] as { code: string }).code, "youtube-upload-failed"); assert.doesNotMatch(JSON.stringify(result[0]), /secret provider payload/);
  });
});
