import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewProject, loadReviewProject } from "../src/review-project.ts";
import { analyzeEpisodeScenes, saveEpisodeAnalysis } from "../src/episode-analysis.ts";
import type { Scene } from "../src/scene-map.ts";

test("analyzes one episode without leaking future episodes", async () => {
  const scenes: Scene[] = [
    {
      episode: 2,
      sceneId: "EP02-SC001",
      startMs: 0,
      endMs: 6000,
      dialogue: "Qin Mu returns to the village before darkness.",
      characters: ["Qin Mu"],
      visualSummary: "Qin Mu returns to the village before darkness.",
      importance: 0.78,
      tags: ["lore"],
      sourceCueIds: ["1"],
      keyframes: [],
    },
    {
      episode: 2,
      sceneId: "EP02-SC002",
      startMs: 7000,
      endMs: 16000,
      dialogue: "The enemy arrives and the village prepares to fight.",
      characters: ["Qin Mu", "Granny Si"],
      visualSummary: "The village prepares to fight.",
      importance: 0.91,
      tags: ["conflict"],
      sourceCueIds: ["2"],
      keyframes: [],
    },
  ];

  const analysis = analyzeEpisodeScenes(scenes, {
    title: "Tales of Herding Gods",
    spoilerMode: "donghua-only",
  });

  assert.equal(analysis.episodeNumber, 2);
  assert.equal(analysis.sourceSceneIds.includes("EP02-SC001"), true);
  assert.equal(analysis.characters.includes("Qin Mu"), true);
  assert.equal(analysis.keyEvents[0].sceneId, "EP02-SC002");
  assert.match(analysis.spoilerBoundary, /donghua/i);
  assert.equal(analysis.recommendedScenes[0], "EP02-SC002");
});

test("saves episode analysis and marks only that episode analyzed", async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-analysis-"));
  process.chdir(root);
  try {
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-05",
      title: "Tales of Herding Gods",
      sourceRange: "Episodes 01-05",
      episodeNumbers: [1, 2],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });
    const sourceDir = join("projects", "muc-than-ky", "review-projects", "ep01-05", "sources", "ep001");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "scenes.json"),
      JSON.stringify([
        {
          episode: 1,
          sceneId: "EP01-SC001",
          startMs: 0,
          endMs: 4000,
          dialogue: "The darkness is coming.",
          characters: ["Qin Mu"],
          visualSummary: "The darkness is coming.",
          importance: 0.82,
          tags: ["conflict"],
          sourceCueIds: ["1"],
          keyframes: [],
        },
      ]),
      "utf8",
    );

    const saved = await saveEpisodeAnalysis("muc-than-ky", "ep01-05", 1, "review-projects/ep01-05/sources/ep001/scenes.json");
    const project = await loadReviewProject("muc-than-ky", "ep01-05");

    assert.equal(saved.analysisPath, "review-projects/ep01-05/sources/ep001/analysis.json");
    assert.equal(project.episodes[0].status, "analyzed");
    assert.equal(project.episodes[1].status, "empty");
    assert.equal(project.episodes[0].analysisPath, saved.analysisPath);
  } finally {
    process.chdir(previous);
  }
});
