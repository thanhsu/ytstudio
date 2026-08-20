import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewProject, loadReviewProject, updateEpisodeSource } from "../src/review-project.ts";
import { mergeStoryArc, saveStoryArc } from "../src/story-arc.ts";
import type { EpisodeAnalysis } from "../src/episode-analysis.ts";

function analysis(episodeNumber: number, sceneId: string, summary: string): EpisodeAnalysis {
  return {
    version: 1,
    episodeNumber,
    summary,
    characters: ["Qin Mu"],
    keyEvents: [{ sceneId, description: summary, importance: 0.8 }],
    conflict: `Conflict in episode ${episodeNumber}`,
    turningPoint: `Turning point ${sceneId}`,
    loreTerms: ["Great Ruins"],
    detailsToExplain: ["Why nightfall matters"],
    endingHook: `Hook ${episodeNumber}`,
    sourceSceneIds: [sceneId],
    recommendedScenes: [sceneId],
    omittedScenes: [],
    spoilerBoundary: "donghua-only: use only current batch scenes.",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

test("merges episode analyses into ordered story arc sections", () => {
  const arc = mergeStoryArc([analysis(1, "EP01-SC002", "Qin Mu discovers danger."), analysis(2, "EP02-SC003", "The village is attacked.")], {
    title: "Tales of Herding Gods",
    sourceRange: "Episodes 01-02",
    spoilerMode: "donghua-only",
  });

  assert.equal(arc.hook[0].sourceScenes[0], "EP01-SC002");
  assert.equal(arc.setup.length, 1);
  assert.equal(arc.risingAction[0].sourceScenes[0], "EP02-SC003");
  assert.equal(arc.nextBatchHook[0].summary, "Hook 2");
  assert.match(arc.spoilerBoundary, /donghua-only/);
});

test("saves story arc from analyzed episodes and marks project story-ready", async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-"));
  process.chdir(root);
  try {
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-02",
      title: "Tales of Herding Gods",
      sourceRange: "Episodes 01-02",
      episodeNumbers: [1, 2],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });
    for (const episodeNumber of [1, 2]) {
      const sourceDir = join("projects", "muc-than-ky", "review-projects", "ep01-02", "sources", `ep${String(episodeNumber).padStart(3, "0")}`);
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, "analysis.json"),
        JSON.stringify(analysis(episodeNumber, `EP0${episodeNumber}-SC001`, `Episode ${episodeNumber} event.`)),
        "utf8",
      );
      await updateEpisodeSource("muc-than-ky", "ep01-02", episodeNumber, {
        analysisPath: `review-projects/ep01-02/sources/ep${String(episodeNumber).padStart(3, "0")}/analysis.json`,
        status: "analyzed",
      });
    }

    const saved = await saveStoryArc("muc-than-ky", "ep01-02");
    const project = await loadReviewProject("muc-than-ky", "ep01-02");

    assert.equal(saved.storyArcPath, "review-projects/ep01-02/story-arc.json");
    assert.equal(project.status, "story");
    assert.equal(project.outputs.storyArc, saved.storyArcPath);
  } finally {
    process.chdir(previous);
  }
});
