import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeYouTube, type YouTubeRouteTools } from "../src/youtube/routes.ts";
import { saveTokens } from "../src/youtube/token-store.ts";
import { saveYouTubeStore, type YouTubeStore } from "../src/youtube/youtube-store.ts";

const remoteVideo = (id: string) => ({
  id,
  snippet: {
    title: `Video ${id}`,
    description: "Description",
    tags: ["review"],
    publishedAt: "2026-08-24T00:00:00Z",
    thumbnails: { default: { url: "https://img.example/thumb" } },
  },
  status: { privacyStatus: "public" },
  statistics: { viewCount: "12", likeCount: "3", commentCount: "1" },
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withRoute<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const previousClient = process.env.YOUTUBE_CLIENT_ID;
  const previousSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const root = await mkdtemp(join(tmpdir(), "yt-routes-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  process.env.YOUTUBE_CLIENT_ID = "client";
  process.env.YOUTUBE_CLIENT_SECRET = "secret";
  try {
    await saveTokens("series-1", {
      version: 1,
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: "scope",
      connectedAt: "2026-08-24T00:00:00.000Z",
    });
    const calls: string[] = [];
    return await run(calls);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    if (previousClient === undefined) delete process.env.YOUTUBE_CLIENT_ID;
    else process.env.YOUTUBE_CLIENT_ID = previousClient;
    if (previousSecret === undefined) delete process.env.YOUTUBE_CLIENT_SECRET;
    else process.env.YOUTUBE_CLIENT_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
}

test("handles every YouTube route prefix and returns false for unrelated routes", async () => {
  const bodies: unknown[] = [];
  const tools = {
    sendJson: (_status: number, body: unknown) => bodies.push(body),
    sendError: (_status: number, body: unknown) => bodies.push(body),
    readBody: async () => ({}),
  };
  assert.equal(await routeYouTube({ method: "GET", rest: "not-youtube", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools }), false);
  assert.equal(await routeYouTube({ method: "GET", rest: "youtube/unknown", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools }), true);
  assert.deepEqual(bodies.at(-1), { code: "not-found", message: "YouTube route not found." });
});

test("lists paged remote uploads and joins linked and external videos", async () => {
  await withRoute(async (calls) => {
    const store: YouTubeStore = { version: 1, remoteChannelId: "UC123", links: [{
      version: 1, videoId: "linked", channelId: "UC123", sourceKind: "story", sourceId: "story-1",
      exportPath: "workspace/exports/story.mp4", title: "Linked", privacyStatus: "public", publishAt: null,
      createdAt: "now", updatedAt: "now",
    }], jobs: [], analytics: {} };
    await saveYouTubeStore("series-1", store);
    const result: unknown[] = [];
    const handled = await routeYouTube({
      method: "GET", rest: "youtube/videos", url: new URL("http://local/videos?pageToken=next"), seriesId: "series-1", request: {} as never,
      tools: {
        sendJson: (_status, body) => result.push(body), sendError: (_status, body) => result.push(body), readBody: async () => ({}),
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) return response({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] });
          if (calls.length === 2) return response({ nextPageToken: "later", items: [{ contentDetails: { videoId: "linked" } }, { contentDetails: { videoId: "external" } }] });
          return response({ items: [remoteVideo("linked"), remoteVideo("external")] });
        },
      },
    });
    assert.equal(handled, true);
    assert.match(calls[1], /pageToken=next/);
    const body = result[0] as { ok: boolean; videos: Array<Record<string, unknown>>; nextPageToken: string };
    assert.equal(body.ok, true);
    assert.equal(body.nextPageToken, "later");
    assert.equal(body.videos[0].videoId, "linked");
    assert.deepEqual([body.videos[0].sourceProject, body.videos[0].sourceKind, body.videos[0].sourceId], ["series-1", "story", "story-1"]);
    assert.deepEqual([body.videos[1].sourceProject, body.videos[1].sourceKind, body.videos[1].sourceId], [null, null, null]);
  });
});

test("validates metadata patches and removes only the remote link after confirmed deletion", async () => {
  await withRoute(async () => {
    const result: unknown[] = [];
    const tools: YouTubeRouteTools = {
      sendJson: (_status: number, body: unknown) => result.push(body), sendError: (_status: number, body: unknown) => result.push(body),
      readBody: async () => ({ title: "", description: "", tags: [], privacyStatus: "public" }),
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return response({ items: [remoteVideo("v1")] });
      },
    };
    await routeYouTube({ method: "PATCH", rest: "youtube/videos/v1", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.deepEqual(result[0], { code: "youtube-invalid-metadata", message: "Title, description, tags, and privacy status are invalid." });

    await saveYouTubeStore("series-1", { version: 1, remoteChannelId: "UC123", links: [{
      version: 1, videoId: "v1", channelId: "UC123", sourceKind: "story", sourceId: "story-1", exportPath: "workspace/export.mp4", title: "T", privacyStatus: "public", publishAt: null, createdAt: "now", updatedAt: "now",
    }], jobs: [], analytics: {} });
    tools.readBody = async () => ({ confirm: true });
    await routeYouTube({ method: "DELETE", rest: "youtube/videos/v1", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.deepEqual(result.at(-1), { ok: true, videoId: "v1", deleted: true });
    const store = await (await import("../src/youtube/youtube-store.ts")).loadYouTubeStore("series-1");
    assert.equal(store.links.length, 0);
  });
});

test("gets a channel profile and rejects video deletion without server confirmation", async () => {
  await withRoute(async () => {
    const result: unknown[] = [];
    const tools: YouTubeRouteTools = {
      sendJson: (_status: number, body: unknown) => result.push(body), sendError: (_status: number, body: unknown) => result.push(body),
      readBody: async () => ({}), fetch: async () => response({ items: [{ id: "UC123", snippet: { title: "Channel" }, contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] }),
    };
    await routeYouTube({ method: "GET", rest: "youtube/channel", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.equal((result[0] as { channel: { id: string } }).channel.id, "UC123");
    await routeYouTube({ method: "DELETE", rest: "youtube/videos/v1", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.deepEqual(result.at(-1), { code: "youtube-confirmation-required", message: "Set confirm to true to delete the remote video." });
  });
});
