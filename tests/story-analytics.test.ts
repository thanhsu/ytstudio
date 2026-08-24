import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchVideoStats } from "../src/youtube/analytics.ts";
import { dueBuckets, refreshChannelAnalytics } from "../src/story-factory/analytics.ts";

test("dueBuckets only returns uncaptured buckets whose age has elapsed", () => {
  const uploaded = "2026-08-20T00:00:00.000Z";
  assert.deepEqual(dueBuckets(uploaded, null, new Date("2026-08-20T23:59:00.000Z")), []);
  assert.deepEqual(dueBuckets(uploaded, null, new Date("2026-08-23T08:00:00.000Z")), ["24h", "72h"]);
  assert.deepEqual(dueBuckets(uploaded, {
    version: 1,
    videoId: "video-1",
    snapshots: [{ bucket: "24h", capturedAt: "2026-08-21T00:00:00.000Z", ageHours: 24, views: 1, likes: 0, comments: 0 }],
  }, new Date("2026-08-23T08:00:00.000Z")), ["72h"]);
});

test("YouTube stats parser defaults missing counters to zero", async () => {
  const result = await fetchVideoStats({
    accessToken: "access",
    videoIds: ["one", "two"],
    fetch: async (input) => {
      assert.match(String(input), /id=one%2Ctwo/);
      return new Response(JSON.stringify({ items: [
        { id: "one", statistics: { viewCount: "12", likeCount: "3" } },
        { id: "two", statistics: {} },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual([...result], [["one", { views: 12, likes: 3, comments: 0 }], ["two", { views: 0, likes: 0, comments: 0 }]]);
});

test("refreshChannelAnalytics captures due published stories and skips unpublished stories", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-story-analytics-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    await mkdir(join(root, "es-horror", "stories", "published"), { recursive: true });
    await mkdir(join(root, "es-horror", "stories", "draft"), { recursive: true });
    const base = (id: string, publish: boolean) => ({ version: 1, id, channelId: "es-horror", title: id, config: {}, stages: publish ? { publish: { status: "done" } } : {}, approvals: {}, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
    await writeFile(join(root, "es-horror", "stories", "published", "story.json"), JSON.stringify(base("published", true)), "utf8");
    await writeFile(join(root, "es-horror", "stories", "published", "publish.json"), JSON.stringify({ version: 1, videoId: "video-1", uploadedAt: "2026-08-20T00:00:00.000Z" }), "utf8");
    await writeFile(join(root, "es-horror", "stories", "draft", "story.json"), JSON.stringify(base("draft", false)), "utf8");
    const calls: string[][] = [];
    const result = await refreshChannelAnalytics("es-horror", {
      now: new Date("2026-08-23T08:00:00.000Z"),
      fetchStats: async (ids) => { calls.push(ids); return new Map(ids.map((id) => [id, { views: 10, likes: 2, comments: 1 }])); },
    });
    assert.deepEqual(result.updated, ["published"]);
    assert.deepEqual(calls, [["video-1"]]);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
