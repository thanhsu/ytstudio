import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeYouTube } from "../src/youtube/routes.ts";
import { loadYouTubeStore, saveYouTubeStore } from "../src/youtube/youtube-store.ts";

test("publish routes create a 202 job and list it without provider calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-publish-routes-"));
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    await saveYouTubeStore("series-1", { version: 1, remoteChannelId: "UC123", links: [], jobs: [], analytics: {} });
    const result: Array<{ status: number; body: any }> = [];
    const tools = {
      sendJson: (status: number, body: unknown) => result.push({ status, body }),
      sendError: (status: number, body: unknown) => result.push({ status, body }),
      readBody: async () => ({ sourceKind: "story", sourceId: "story-1", title: "Title" }),
      publishDeps: {
        readiness: async () => ({ ready: true, matrix: { script: "current", media: "current", final: "current", export: "current" } as const, exportPath: "video.mp4", thumbnailPath: null, metadata: { title: "Title", description: "", tags: [] as string[] } }),
        accessToken: async () => "token",
        upload: async () => ({ videoId: "video-1" }),
        thumbnail: async () => undefined,
      },
    };
    await routeYouTube({ method: "POST", rest: "youtube/publish", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.equal(result[0].status, 202);
    const jobId = result[0].body.job.id;
    let providerCalls = 0;
    tools.publishDeps.upload = async () => { providerCalls += 1; return { videoId: "never" }; };
    await routeYouTube({ method: "GET", rest: "youtube/publish", url: new URL("http://local"), seriesId: "series-1", request: {} as never, tools });
    assert.equal(result[1].status, 200);
    assert.equal(result[1].body.jobs[0].id, jobId);
    assert.equal(providerCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("publish readiness route validates source input before reading artifacts", async () => {
  const result: Array<{ status: number; body: any }> = [];
  const tools = {
    sendJson: (status: number, body: unknown) => result.push({ status, body }),
    sendError: (status: number, body: unknown) => result.push({ status, body }),
    readBody: async () => ({}),
  };
  await routeYouTube({
    method: "GET",
    rest: "youtube/publish/readiness",
    url: new URL("http://local?sourceKind=bad&sourceId="),
    seriesId: "series-1",
    request: {} as never,
    tools,
  });
  assert.equal(result[0].status, 400);
  assert.equal(result[0].body.code, "youtube-readiness-input");
});
