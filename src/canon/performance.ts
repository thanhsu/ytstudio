import { loadAnalytics } from "../story-factory/analytics.ts";
import { loadStoryCost } from "../story-factory/cost.ts";
import { listStories } from "../story-factory/story-project.ts";
import type { LocalizedReport } from "./types.ts";
import { readStageArtifact } from "../story-factory/story-project.ts";

/**
 * Canon performance: how one chapter did across every language it published in.
 *
 * This is the whole point of linking variants back to a canon chapter. Without
 * it, a chapter that underperforms in Spanish and overperforms in French looks
 * like two unrelated results; with it, story quality can be told apart from
 * localization quality, voice, thumbnail, and market.
 *
 * It reuses the existing per-story analytics snapshots — nothing new is
 * fetched here — so it is only as complete as the analytics refresh that
 * populated them.
 */

export type LocalePerformance = {
  channelId: string;
  storyId: string;
  locale: string;
  views: number;
  likes: number;
  comments: number;
  productionCostUsd: number;
  /** The model that wrote this localization, for comparing localizers. */
  localizerModel: string;
  voiceName: string;
  published: boolean;
};

export type ChapterPerformance = {
  chapterId: string;
  chapterNumber: number;
  totalViews: number;
  localeCount: number;
  bestLocale: string | null;
  productionCostUsd: number;
  byLocale: LocalePerformance[];
};

export type CanonPerformance = {
  version: 1;
  seriesId: string;
  chapters: ChapterPerformance[];
  totalViews: number;
  totalCostUsd: number;
  /** Across the whole series, which market performs best on average. */
  bestLocale: string | null;
  computedAt: string;
};

export async function canonPerformance(seriesId: string, channelIds: string[]): Promise<CanonPerformance> {
  const byChapter = new Map<string, ChapterPerformance>();

  for (const channelId of channelIds) {
    for (const story of await listStories(channelId)) {
      if (story.kind !== "variant" || story.canonRef?.seriesId !== seriesId) continue;

      const [analytics, cost, localized] = await Promise.all([
        loadAnalytics(channelId, story.id),
        loadStoryCost(channelId, story.id),
        readStageArtifact<LocalizedReport>(channelId, story.id, "localize"),
      ]);
      // Snapshots accumulate per bucket; the newest is the most complete view.
      const latest = (analytics?.snapshots ?? []).at(-1);

      const entry: LocalePerformance = {
        channelId,
        storyId: story.id,
        locale: story.config.locale,
        views: latest?.views ?? 0,
        likes: latest?.likes ?? 0,
        comments: latest?.comments ?? 0,
        productionCostUsd: cost.totalUsd,
        localizerModel: localized?.provenance.model ?? "",
        voiceName: story.config.ttsProfile.voiceName,
        published: story.stages.publish?.status === "done",
      };

      const chapterId = story.canonRef.chapterId;
      const chapter = byChapter.get(chapterId) ?? {
        chapterId,
        chapterNumber: story.canonRef.chapterNumber,
        totalViews: 0,
        localeCount: 0,
        bestLocale: null,
        productionCostUsd: 0,
        byLocale: [],
      };
      chapter.byLocale.push(entry);
      chapter.totalViews += entry.views;
      chapter.productionCostUsd = round(chapter.productionCostUsd + entry.productionCostUsd);
      chapter.localeCount = chapter.byLocale.length;
      byChapter.set(chapterId, chapter);
    }
  }

  const chapters = [...byChapter.values()].map((chapter) => ({
    ...chapter,
    byLocale: [...chapter.byLocale].sort((left, right) => right.views - left.views || left.locale.localeCompare(right.locale)),
    // Null rather than an arbitrary winner: with no views yet, naming a "best"
    // locale would be an invention dressed as a measurement.
    bestLocale: chapter.totalViews > 0 ? bestOf(chapter.byLocale) : null,
  }));
  chapters.sort((left, right) => left.chapterNumber - right.chapterNumber);

  const localeTotals = new Map<string, { views: number; count: number }>();
  for (const chapter of chapters) {
    for (const entry of chapter.byLocale) {
      const current = localeTotals.get(entry.locale) ?? { views: 0, count: 0 };
      current.views += entry.views;
      current.count += 1;
      localeTotals.set(entry.locale, current);
    }
  }
  const ranked = [...localeTotals.entries()]
    .map(([locale, totals]) => ({ locale, average: totals.views / Math.max(1, totals.count) }))
    .sort((left, right) => right.average - left.average || left.locale.localeCompare(right.locale));

  return {
    version: 1,
    seriesId,
    chapters,
    totalViews: chapters.reduce((sum, chapter) => sum + chapter.totalViews, 0),
    totalCostUsd: round(chapters.reduce((sum, chapter) => sum + chapter.productionCostUsd, 0)),
    bestLocale: ranked[0] && ranked[0].average > 0 ? ranked[0].locale : null,
    computedAt: new Date().toISOString(),
  };
}

function bestOf(entries: LocalePerformance[]): string | null {
  const sorted = [...entries].sort((left, right) => right.views - left.views);
  return sorted[0]?.locale ?? null;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
