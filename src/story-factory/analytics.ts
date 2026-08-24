import { readFile } from "node:fs/promises";
import { writeJson } from "../fs.ts";
import { storyPath } from "./paths.ts";
import { listStories, readStageArtifact } from "./story-project.ts";
import type { PublishArtifact, StoryProject } from "./types.ts";
import { rebuildPerformanceProfile } from "./performance.ts";

export const SNAPSHOT_BUCKETS = [
  { id: "24h", hours: 24 },
  { id: "72h", hours: 72 },
  { id: "7d", hours: 168 },
  { id: "28d", hours: 672 },
] as const;

export type BucketId = (typeof SNAPSHOT_BUCKETS)[number]["id"];
export type StoryAnalytics = {
  version: 1;
  videoId: string;
  snapshots: Array<{ bucket: BucketId; capturedAt: string; ageHours: number; views: number; likes: number; comments: number }>;
};

export function dueBuckets(uploadedAt: string, existing: StoryAnalytics | null, now: Date): BucketId[] {
  const ageHours = (now.getTime() - Date.parse(uploadedAt)) / 3_600_000;
  const captured = new Set((existing?.snapshots ?? []).map((snapshot) => snapshot.bucket));
  return SNAPSHOT_BUCKETS.filter((bucket) => ageHours >= bucket.hours && !captured.has(bucket.id)).map((bucket) => bucket.id);
}

export async function refreshChannelAnalytics(channelId: string, options: {
  fetchStats: (videoIds: string[]) => Promise<Map<string, { views: number; likes: number; comments: number }>>;
  now?: Date;
}): Promise<{ updated: string[] }> {
  const now = options.now ?? new Date();
  const pending: Array<{ story: StoryProject; publish: PublishArtifact; existing: StoryAnalytics | null; due: BucketId[] }> = [];
  for (const story of await listStories(channelId)) {
    const publish = await readStageArtifact<PublishArtifact>(channelId, story.id, "publish");
    if (!publish?.videoId || !publish.uploadedAt) continue;
    const existing = await loadAnalytics(channelId, story.id);
    const due = dueBuckets(publish.uploadedAt, existing, now);
    if (due.length) pending.push({ story, publish, existing, due });
  }
  const stats = await options.fetchStats(pending.map((entry) => entry.publish.videoId));
  const updated: string[] = [];
  for (const entry of pending) {
    const values = stats.get(entry.publish.videoId) ?? { views: 0, likes: 0, comments: 0 };
    const ageHours = (now.getTime() - Date.parse(entry.publish.uploadedAt)) / 3_600_000;
    const snapshots = [...(entry.existing?.snapshots ?? [])];
    for (const bucket of entry.due) {
      const bucketHours = SNAPSHOT_BUCKETS.find((candidate) => candidate.id === bucket)!.hours;
      snapshots.push({ bucket, capturedAt: now.toISOString(), ageHours: Math.round(ageHours * 100) / 100, ...values });
      void bucketHours;
    }
    await saveAnalytics(channelId, entry.story.id, { version: 1, videoId: entry.publish.videoId, snapshots });
    updated.push(entry.story.id);
  }
  await rebuildPerformanceProfile(channelId);
  return { updated };
}

export async function loadAnalytics(channelId: string, storyId: string): Promise<StoryAnalytics | null> {
  try {
    const parsed = JSON.parse(await readFile(storyPath(channelId, storyId, "analytics.json"), "utf8")) as Partial<StoryAnalytics>;
    if (parsed.version !== 1 || typeof parsed.videoId !== "string" || !Array.isArray(parsed.snapshots)) return null;
    return { version: 1, videoId: parsed.videoId, snapshots: parsed.snapshots.filter((snapshot): snapshot is StoryAnalytics["snapshots"][number] => Boolean(snapshot && typeof snapshot === "object" && typeof snapshot.bucket === "string")) };
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function saveAnalytics(channelId: string, storyId: string, analytics: StoryAnalytics): Promise<void> {
  await writeJson(storyPath(channelId, storyId, "analytics.json"), analytics);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
