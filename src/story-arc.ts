import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReviewProject, updateReviewProject, type SpoilerMode } from "./review-project.ts";
import type { EpisodeAnalysis } from "./episode-analysis.ts";

export type StoryArcItem = {
  summary: string;
  sourceScenes: string[];
};

export type StoryArc = {
  version: 1;
  title: string;
  sourceRange: string;
  spoilerBoundary: string;
  hook: StoryArcItem[];
  setup: StoryArcItem[];
  risingAction: StoryArcItem[];
  climax: StoryArcItem[];
  resolution: StoryArcItem[];
  nextBatchHook: StoryArcItem[];
  omittedScenes: Array<{ sceneId: string; reason: string }>;
  createdAt: string;
};

export type StoryArcContext = {
  title: string;
  sourceRange: string;
  spoilerMode: SpoilerMode;
};

export type SavedStoryArc = {
  storyArcPath: string;
  sectionCount: number;
};

export function mergeStoryArc(analyses: EpisodeAnalysis[], context: StoryArcContext): StoryArc {
  const ordered = [...analyses].sort((left, right) => left.episodeNumber - right.episodeNumber);
  const middle = ordered.slice(1, -1);
  const final = ordered.at(-1);
  return {
    version: 1,
    title: context.title,
    sourceRange: context.sourceRange,
    spoilerBoundary:
      context.spoilerMode === "donghua-only"
        ? "donghua-only: merge only information present in this batch and its episode analyses."
        : "novel-spoilers: future source knowledge may be used when explicitly needed.",
    hook: ordered[0] ? [toItem(ordered[0].keyEvents[0]?.description ?? ordered[0].summary, ordered[0].recommendedScenes.slice(0, 1))] : [],
    setup: ordered[0] ? [toItem(ordered[0].summary, ordered[0].recommendedScenes)] : [],
    risingAction: (middle.length > 0 ? middle : ordered.slice(1)).map((analysis) => toItem(analysis.summary, analysis.recommendedScenes)),
    climax: final ? [toItem(final.turningPoint || final.summary, final.recommendedScenes.slice(0, 2))] : [],
    resolution: final ? [toItem(final.conflict, final.recommendedScenes.slice(0, 1))] : [],
    nextBatchHook: final ? [toItem(final.endingHook, final.recommendedScenes.slice(-1))] : [],
    omittedScenes: ordered.flatMap((analysis) => analysis.omittedScenes),
    createdAt: new Date().toISOString(),
  };
}

export async function saveStoryArc(seriesId: string, reviewProjectId: string): Promise<SavedStoryArc> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  const analyses: EpisodeAnalysis[] = [];
  for (const episode of project.episodes) {
    if (!episode.analysisPath) {
      throw new Error(`Episode ${episode.episodeNumber} needs analysis before story merge.`);
    }
    analyses.push(JSON.parse(await readFile(join("projects", seriesId, episode.analysisPath), "utf8")) as EpisodeAnalysis);
  }

  const storyArc = mergeStoryArc(analyses, {
    title: project.title,
    sourceRange: project.sourceRange,
    spoilerMode: project.spoilerMode,
  });
  const storyArcPath = ["review-projects", reviewProjectId, "story-arc.json"].join("/");
  await mkdir(join("projects", seriesId, "review-projects", reviewProjectId), { recursive: true });
  await writeFile(join("projects", seriesId, storyArcPath), `${JSON.stringify(storyArc, null, 2)}\n`, "utf8");
  await updateReviewProject(seriesId, reviewProjectId, {
    status: "story",
    outputs: { ...project.outputs, storyArc: storyArcPath },
  });
  return { storyArcPath, sectionCount: countSections(storyArc) };
}

function toItem(summary: string, sourceScenes: string[]): StoryArcItem {
  return {
    summary,
    sourceScenes: sourceScenes.filter(Boolean),
  };
}

function countSections(storyArc: StoryArc): number {
  return (
    storyArc.hook.length +
    storyArc.setup.length +
    storyArc.risingAction.length +
    storyArc.climax.length +
    storyArc.resolution.length +
    storyArc.nextBatchHook.length
  );
}
