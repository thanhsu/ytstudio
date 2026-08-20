import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewProject, loadReviewProject, updateReviewProject } from "../src/review-project.ts";
import { generateReviewScript, regenerateScriptSegment, saveReviewScript } from "../src/review-script.ts";
import type { StoryArc } from "../src/story-arc.ts";

const storyArc: StoryArc = {
  version: 1,
  title: "Tales of Herding Gods",
  sourceRange: "Episodes 01-05",
  spoilerBoundary: "donghua-only",
  hook: [{ summary: "Qin Mu faces nightfall.", sourceScenes: ["EP01-SC001"] }],
  setup: [{ summary: "The village rules are established.", sourceScenes: ["EP01-SC002"] }],
  risingAction: [{ summary: "The enemy pressure grows.", sourceScenes: ["EP03-SC004"] }],
  climax: [{ summary: "Qin Mu makes a decisive choice.", sourceScenes: ["EP05-SC003"] }],
  resolution: [{ summary: "The batch closes on a fragile win.", sourceScenes: ["EP05-SC004"] }],
  nextBatchHook: [{ summary: "A larger secret remains.", sourceScenes: ["EP05-SC005"] }],
  omittedScenes: [],
  createdAt: "2026-08-20T00:00:00.000Z",
};

test("generates review script segments with source scene references", () => {
  const script = generateReviewScript(storyArc, { targetDurationMinutes: 20 });

  assert.equal(script.segments[0].segmentId, "SEG-001");
  assert.equal(script.segments[0].section, "hook");
  assert.equal(script.segments[0].sourceScenes[0], "EP01-SC001");
  assert.equal(script.mix.plotPercent, 70);
  assert.match(script.narrationText, /Qin Mu faces nightfall/);
});

test("regenerates only one script segment and increments revision", () => {
  const script = generateReviewScript(storyArc, { targetDurationMinutes: 20 });
  const updated = regenerateScriptSegment(script, "SEG-003", "The pressure grows, but Qin Mu starts reading the danger differently.");

  assert.equal(updated.revision, 2);
  assert.equal(updated.segments.find((segment) => segment.segmentId === "SEG-003")?.narration, "The pressure grows, but Qin Mu starts reading the danger differently.");
  assert.equal(updated.segments.find((segment) => segment.segmentId === "SEG-001")?.narration, script.segments[0].narration);
});

test("saves review script and marks project script-ready", async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-script-"));
  process.chdir(root);
  try {
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-05",
      title: "Tales of Herding Gods",
      sourceRange: "Episodes 01-05",
      episodeNumbers: [1],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });
    await mkdir(join("projects", "muc-than-ky", "review-projects", "ep01-05"), { recursive: true });
    await writeFile(join("projects", "muc-than-ky", "review-projects", "ep01-05", "story-arc.json"), JSON.stringify(storyArc), "utf8");
    await updateReviewProject("muc-than-ky", "ep01-05", {
      status: "story",
      outputs: { storyArc: "review-projects/ep01-05/story-arc.json" },
    });

    const saved = await saveReviewScript("muc-than-ky", "ep01-05");
    const project = await loadReviewProject("muc-than-ky", "ep01-05");

    assert.equal(saved.scriptPath, "review-projects/ep01-05/review-script.json");
    assert.equal(project.status, "script");
    assert.equal(project.outputs.reviewScript, saved.scriptPath);
  } finally {
    process.chdir(previous);
  }
});
