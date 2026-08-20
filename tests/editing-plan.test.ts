import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewProject, loadReviewProject, updateEpisodeSource, updateReviewProject } from "../src/review-project.ts";
import { buildEditingPlan, saveEditingPlan } from "../src/editing-plan.ts";
import { exportReviewPackage } from "../src/export-package.ts";
import type { ReviewScript } from "../src/review-script.ts";
import type { Scene } from "../src/scene-map.ts";

const script: ReviewScript = {
  version: 1,
  title: "Tales of Herding Gods",
  sourceRange: "Episodes 01-02",
  targetDurationMinutes: 20,
  revision: 1,
  mix: { plotPercent: 70, lorePercent: 20, analysisPercent: 10 },
  segments: [
    {
      segmentId: "SEG-001",
      section: "hook",
      narration: "Qin Mu sees the danger before everyone else understands it.",
      estimatedSeconds: 18,
      sourceScenes: ["EP01-SC001"],
      commentaryType: "plot_and_lore",
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
  ],
  narrationText: "Qin Mu sees the danger before everyone else understands it.",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const scene: Scene = {
  episode: 1,
  sceneId: "EP01-SC001",
  startMs: 354200,
  endMs: 371800,
  dialogue: "The darkness is coming.",
  characters: ["Qin Mu"],
  visualSummary: "Qin Mu returns to the village before nightfall.",
  importance: 0.82,
  tags: ["conflict"],
  sourceCueIds: ["1"],
  keyframes: ["workspace/keyframes/ep01-sc001.jpg"],
};

test("builds editing plan using exact timestamps from scene map", () => {
  const plan = buildEditingPlan(script, [scene]);

  assert.equal(plan.items[0].segmentId, "SEG-001");
  assert.equal(plan.items[0].source.episode, 1);
  assert.equal(plan.items[0].source.startMs, 354200);
  assert.equal(plan.items[0].source.endMs, 371800);
  assert.equal(plan.items[0].assetType, "footage");
  assert.match(plan.items[0].instruction, /remove original audio/i);
});

test("saves editing plan and exports json csv srt and youtube metadata", async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-editing-"));
  process.chdir(root);
  try {
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-02",
      title: "Tales of Herding Gods",
      sourceRange: "Episodes 01-02",
      episodeNumbers: [1],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });
    const batchDir = join("projects", "muc-than-ky", "review-projects", "ep01-02");
    const sourceDir = join(batchDir, "sources", "ep001");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(batchDir, "review-script.json"), JSON.stringify(script), "utf8");
    await writeFile(join(sourceDir, "scenes.json"), JSON.stringify([scene]), "utf8");
    await updateEpisodeSource("muc-than-ky", "ep01-02", 1, {
      sceneMapPath: "review-projects/ep01-02/sources/ep001/scenes.json",
      status: "scene-ready",
    });
    await updateReviewProject("muc-than-ky", "ep01-02", {
      status: "script",
      outputs: { reviewScript: "review-projects/ep01-02/review-script.json" },
    });

    const saved = await saveEditingPlan("muc-than-ky", "ep01-02");
    const exported = await exportReviewPackage("muc-than-ky", "ep01-02");
    const project = await loadReviewProject("muc-than-ky", "ep01-02");

    assert.equal(saved.editingPlanPath, "review-projects/ep01-02/editing-plan.json");
    assert.equal(project.status, "exported");
    assert.match(await readFile(join("projects", "muc-than-ky", exported.csvPath), "utf8"), /SEG-001,EP01-SC001/);
    assert.match(await readFile(join("projects", "muc-than-ky", exported.voiceOverSrtPath), "utf8"), /Qin Mu sees the danger/);
    assert.match(await readFile(join("projects", "muc-than-ky", exported.youtubeMetadataPath), "utf8"), /thumbnailText/);
  } finally {
    process.chdir(previous);
  }
});
