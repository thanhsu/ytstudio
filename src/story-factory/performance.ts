import { mkdir, readFile } from "node:fs/promises";
import { sha256 } from "../project-state.ts";
import { writeJson } from "../fs.ts";
import { channelStoryFactoryPath } from "./paths.ts";
import { listStories, readStageArtifact } from "./story-project.ts";
import { loadAnalytics, type StoryAnalytics } from "./analytics.ts";
import type { IdeaArtifact } from "./types.ts";

export type PerformanceProfile = {
  version: 1;
  updatedAt: string;
  storyCount: number;
  themes: Array<{ theme: string; stories: number; avgViews: number }>;
  subNiches: Array<{ subNiche: string; stories: number; avgViews: number }>;
  provenThemes: string[];
};

export async function rebuildPerformanceProfile(channelId: string): Promise<PerformanceProfile> {
  const themeValues = new Map<string, number[]>();
  const subNicheValues = new Map<string, number[]>();
  let storyCount = 0;
  for (const story of await listStories(channelId)) {
    const idea = await readStageArtifact<IdeaArtifact>(channelId, story.id, "idea");
    const analytics = await loadAnalytics(channelId, story.id);
    if (!idea || !analytics) continue;
    const views = bestViews(analytics);
    storyCount += 1;
    for (const theme of idea.themes) addValue(themeValues, theme, views);
    addValue(subNicheValues, story.config.subNiche, views);
  }
  const themes = aggregate(themeValues);
  const subNiches = aggregate(subNicheValues).map((entry) => ({ subNiche: entry.theme, stories: entry.stories, avgViews: entry.avgViews }));
  const median = medianValue(themes.map((entry) => entry.avgViews));
  const topHalf = new Set(themes.slice(0, Math.ceil(themes.length / 2)).map((entry) => entry.theme));
  const provenThemes = themes.filter((entry) => topHalf.has(entry.theme) && entry.avgViews > median).slice(0, 8).map((entry) => entry.theme);
  const profile: PerformanceProfile = { version: 1, updatedAt: new Date().toISOString(), storyCount, themes, subNiches, provenThemes };
  await mkdir(channelStoryFactoryPath(channelId), { recursive: true });
  await writeJson(channelStoryFactoryPath(channelId, "performance-profile.json"), profile);
  return profile;
}

export async function loadPerformanceProfile(channelId: string): Promise<PerformanceProfile | null> {
  try {
    const parsed = JSON.parse(await readFile(channelStoryFactoryPath(channelId, "performance-profile.json"), "utf8")) as Partial<PerformanceProfile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.provenThemes)) return null;
    return parsed as PerformanceProfile;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function ideaDirective(storyId: string): "proven" | "explore" {
  return Number.parseInt(sha256(storyId).slice(0, 8), 16) % 10 < 3 ? "explore" : "proven";
}

function bestViews(analytics: StoryAnalytics): number {
  return Math.max(0, ...analytics.snapshots.map((snapshot) => snapshot.views));
}

function addValue(target: Map<string, number[]>, key: string, value: number): void {
  if (!key.trim()) return;
  target.set(key, [...(target.get(key) ?? []), value]);
}

function aggregate(values: Map<string, number[]>): Array<{ theme: string; stories: number; avgViews: number }> {
  return [...values.entries()].map(([theme, entries]) => ({ theme, stories: entries.length, avgViews: entries.reduce((sum, value) => sum + value, 0) / entries.length }))
    .sort((left, right) => right.avgViews - left.avgViews || left.theme.localeCompare(right.theme))
    .map((entry) => ({ ...entry, avgViews: Math.round(entry.avgViews * 100) / 100 }));
}

function medianValue(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
