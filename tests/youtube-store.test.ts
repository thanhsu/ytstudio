import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadYouTubeStore, saveYouTubeStore, upsertPublishJob, upsertVideoLink, listPublishJobs, getAnalyticsSnapshot, type YouTubeStore } from "../src/youtube/youtube-store.ts";

test("round-trips a versioned store at the owning workspace path", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-store-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const store: YouTubeStore = { version: 1, remoteChannelId: "UC123", links: [], jobs: [], analytics: { v1: { views: 1, likes: 2, comments: 3, fetchedAt: "2026-08-24T00:00:00.000Z" } } };
    await saveYouTubeStore("series-one", store);
    assert.deepEqual(await loadYouTubeStore("series-one"), store);
    assert.match(await readFile(join(root, "series-one", "workspace", "youtube", "store.json"), "utf8"), /"version": 1/);
  } finally { if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous; await rm(root, { recursive: true, force: true }); }
});

test("normalizes malformed records and retains valid remote identity", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-store-invalid-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const path = join(root, "series-one", "workspace", "youtube", "store.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "series-one", "workspace", "youtube"), { recursive: true }));
    await writeFile(path, JSON.stringify({ version: 99, remoteChannelId: "UC123", links: [{ videoId: "v", channelId: "UC123", sourceKind: "story", sourceId: "s", exportPath: "x", title: "T", privacyStatus: "public", publishAt: null, createdAt: "now", updatedAt: "now" }, { videoId: 4 }], jobs: [{ id: "j", status: "completed", channelId: "UC123", sourceKind: "story", sourceId: "s", requestedPrivacy: "public", requestedPublishAt: null, videoId: null, progress: 100, error: null, createdAt: "now", updatedAt: "now" }, { id: 4 }], analytics: { v: { views: "bad", likes: 2, comments: -1, fetchedAt: "now" } } }), "utf8");
    const store = await loadYouTubeStore("series-one");
    assert.equal(store.remoteChannelId, "UC123"); assert.equal(store.links.length, 1); assert.equal(store.jobs.length, 1); assert.deepEqual(store.analytics.v, { views: 0, likes: 2, comments: 0, fetchedAt: "now" });
  } finally { if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous; await rm(root, { recursive: true, force: true }); }
});

test("upserts links and jobs by their remote ids and returns analytics snapshots", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR; const root = await mkdtemp(join(tmpdir(), "yt-store-upsert-")); process.env.YT_STUDIO_PROJECTS_DIR = root;
  const link = { version: 1 as const, videoId: "v1", channelId: "UC123", sourceKind: "story" as const, sourceId: "s", exportPath: "x", title: "T", privacyStatus: "public" as const, publishAt: null, createdAt: "now", updatedAt: "now" };
  const job = { version: 1 as const, id: "j1", channelId: "UC123", sourceKind: "story" as const, sourceId: "s", status: "completed" as const, requestedPrivacy: "public" as const, requestedPublishAt: null, videoId: "v1", progress: 100, error: null, createdAt: "now", updatedAt: "now" };
  try { await upsertVideoLink("series-one", link); await upsertVideoLink("series-one", { ...link, title: "Updated" }); await upsertPublishJob("series-one", job); await upsertPublishJob("series-one", { ...job, progress: 100 }); const store = await loadYouTubeStore("series-one"); assert.equal(store.links.length, 1); assert.equal(store.links[0].title, "Updated"); assert.equal((await listPublishJobs("series-one")).length, 1); assert.deepEqual(await getAnalyticsSnapshot("series-one", "missing"), null); }
  finally { if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
