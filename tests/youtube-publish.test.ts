import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizePublishInput, normalizePublishAt } from "../src/youtube/publish.ts";
import { startYouTubePublish } from "../src/youtube/publish.ts";
import { loadYouTubeStore, saveYouTubeStore } from "../src/youtube/youtube-store.ts";
import { ProjectJobManager } from "../src/jobs.ts";
import { createStory, loadStory, readStageArtifact } from "../src/story-factory/story-project.ts";

test("scheduled publish normalizes an ISO timestamp to UTC and private visibility", () => {
  const input = normalizePublishInput({
    sourceKind: "story",
    sourceId: "story-001",
    exportPath: "stories/story-001/workspace/export/story.mp4",
    title: "Title",
    description: "Description",
    tags: ["review"],
    thumbnailPath: "stories/story-001/workspace/export/thumbnail.png",
    privacyStatus: "public",
    publishAt: "2026-08-25T10:00:00+07:00",
  });
  assert.equal(input.privacyStatus, "private");
  assert.equal(input.publishAt, "2026-08-25T03:00:00.000Z");
  assert.equal(normalizePublishAt("2026-08-25T10:00:00+07:00"), "2026-08-25T03:00:00.000Z");
});

test("publishing persists one completed job and duplicate prevention reuses its video id", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-publish-"));
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  const manager = new ProjectJobManager();
  let uploads = 0;
  try {
    await mkdir(join(root, "channel-1"), { recursive: true });
    await saveYouTubeStore("channel-1", { version: 1, remoteChannelId: "UCchannel", links: [], jobs: [], analytics: {} });
    const readiness = async () => ({ ready: true, matrix: { script: "current", media: "current", final: "current", export: "current" } as const, exportPath: "workspace/video.mp4", thumbnailPath: "workspace/thumb.png", metadata: { title: "Title", description: "Description", tags: [] as string[] } });
    const deps = {
      jobManager: manager,
      readiness,
      accessToken: async () => "token",
      upload: async () => { uploads += 1; return { videoId: "video-1" }; },
      thumbnail: async () => undefined,
    };
    const first = await startYouTubePublish("channel-1", { sourceKind: "story", sourceId: "story-1" }, deps);
    await manager.waitForIdle("channel-1::youtube-publish::story::story-1");
    assert.equal((await loadYouTubeStore("channel-1")).jobs.find((job) => job.id === first.id)?.status, "completed");
    const second = await startYouTubePublish("channel-1", { sourceKind: "story", sourceId: "story-1" }, deps);
    await manager.waitForIdle("channel-1::youtube-publish::story::story-1");
    assert.equal(uploads, 1);
    assert.equal((await loadYouTubeStore("channel-1")).jobs.find((job) => job.id === second.id)?.videoId, "video-1");
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("story publishing keeps the legacy publish artifact and stage as a compatibility side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-publish-compat-"));
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  const manager = new ProjectJobManager();
  try {
    await createStory({ channelId: "channel-1", language: "en", locale: "en-US", niche: "reviews", subNiches: ["anime"], defaultTargetDurationMinutes: 10, mode: "story", ttsProfile: {}, visualStyleProfile: {}, budget: {} } as never, { id: "story-1", title: "Title" });
    await saveYouTubeStore("channel-1", { version: 1, remoteChannelId: "UCchannel", links: [], jobs: [], analytics: {} });
    const readiness = async () => ({ ready: true, matrix: { script: "current", media: "current", final: "current", export: "current" } as const, exportPath: "workspace/video.mp4", thumbnailPath: null, metadata: { title: "Title", description: "", tags: [] as string[] } });
    const job = await startYouTubePublish("channel-1", { sourceKind: "story", sourceId: "story-1" }, { jobManager: manager, readiness, accessToken: async () => "token", upload: async () => ({ videoId: "video-compat" }) });
    await manager.waitForIdle("channel-1::youtube-publish::story::story-1");
    const artifact = await readStageArtifact<{ videoId: string }>("channel-1", "story-1", "publish");
    assert.equal(artifact?.videoId, "video-compat");
    assert.equal((await loadStory("channel-1", "story-1")).stages.publish?.status, "done");
    assert.equal((await loadYouTubeStore("channel-1")).jobs.find((candidate) => candidate.id === job.id)?.status, "completed");
  } finally { if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR; else process.env.YT_STUDIO_PROJECTS_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
