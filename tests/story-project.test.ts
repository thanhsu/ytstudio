import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStoryChannel } from "../src/story-factory/channel.ts";
import {
  approvalState,
  approveStoryStage,
  createStory,
  deriveStoryStatus,
  invalidateDependents,
  listStories,
  loadStory,
  readStageArtifact,
  saveStageRun,
  updateStory,
  writeStageArtifact,
} from "../src/story-factory/story-project.ts";
import { storyPath } from "../src/story-factory/paths.ts";
import type { StoryProject } from "../src/story-factory/types.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-project-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeStory(id = "story-001"): Promise<StoryProject> {
  const channel = await loadStoryChannel("es-horror");
  return createStory(channel, { id, title: "La habitación 307" });
}

test("a story snapshots channel config at create and refuses id collisions", async () => {
  await withTempCwd(async () => {
    const story = await makeStory();
    assert.equal(story.channelId, "es-horror");
    assert.equal(story.config.language, "es");
    assert.equal(story.config.locale, "es-MX");
    assert.equal(story.config.mode, "assisted");
    assert.equal(story.config.targetDurationMinutes, 25);
    assert.equal(deriveStoryStatus(story), "DRAFT");

    await assert.rejects(() => makeStory(), /already exists/);
  });
});

test("stories list, load, and survive a hand-corrupted story.json", async () => {
  await withTempCwd(async () => {
    await makeStory("story-001");
    await makeStory("story-002");
    const stories = await listStories("es-horror");
    assert.deepEqual(
      stories.map((story) => story.id),
      ["story-001", "story-002"],
    );

    await writeFile(
      storyPath("es-horror", "story-001", "story.json"),
      JSON.stringify({
        id: "story-001",
        channelId: "es-horror",
        stages: { idea: { status: "definitely-not-a-status", attemptCount: -4, costUsd: "nope" } },
        config: { targetDurationMinutes: 2, mode: 42 },
      }),
      "utf8",
    );
    const reloaded = await loadStory("es-horror", "story-001");
    assert.equal(reloaded.stages.idea?.status, "pending");
    assert.equal(reloaded.stages.idea?.attemptCount, 0);
    assert.equal(reloaded.stages.idea?.costUsd, 0);
    assert.equal(reloaded.config.targetDurationMinutes, 25);
    assert.equal(reloaded.config.mode, "assisted");
  });
});

test("metadata-style edits update the story without touching any stage", async () => {
  await withTempCwd(async () => {
    await makeStory();
    await saveStageRun("es-horror", "story-001", "idea", { status: "done" });
    const updated = await updateStory("es-horror", "story-001", {
      title: "El turno de noche",
      subNiche: "night shift horror",
      targetDurationMinutes: 30,
      maxCostPerStoryUsd: 2,
    });
    assert.equal(updated.title, "El turno de noche");
    assert.equal(updated.config.targetDurationMinutes, 30);
    assert.equal(updated.config.budget.maxCostPerStoryUsd, 2);
    assert.equal(updated.stages.idea?.status, "done");
  });
});

test("stage artifacts round-trip and stamp their hash on the stage run", async () => {
  await withTempCwd(async () => {
    await makeStory();
    const { story, artifactHash } = await writeStageArtifact("es-horror", "story-001", "idea", {
      version: 1,
      logline: "El ascensor se abre solo a las 3:17.",
    });
    assert.equal(story.stages.idea?.artifactHash, artifactHash);
    const artifact = await readStageArtifact<{ logline: string }>("es-horror", "story-001", "idea");
    assert.equal(artifact?.logline, "El ascensor se abre solo a las 3:17.");
    assert.equal(await readStageArtifact("es-horror", "story-001", "hook"), null);
  });
});

test("invalidation marks transitive dependents stale but leaves untouched branches alone", async () => {
  await withTempCwd(async () => {
    let story = await makeStory();
    for (const stage of ["idea", "hook", "outline", "bible", "sections", "scenes", "images", "metadata"] as const) {
      story = await saveStageRun("es-horror", "story-001", stage, { status: "done" });
    }

    const invalidated = invalidateDependents(story, "sections");
    assert.ok(invalidated.includes("scenes"));
    assert.ok(invalidated.includes("images"));
    assert.ok(invalidated.includes("metadata"));
    assert.equal(story.stages.scenes?.status, "stale");
    // Upstream stages are untouched.
    assert.equal(story.stages.bible?.status, "done");
    assert.equal(story.stages.idea?.status, "done");
    // Never-run stages stay pending rather than becoming stale noise.
    assert.equal(story.stages.render, undefined);
  });
});

test("a metadata edit invalidates only the cheap tail, never media", async () => {
  await withTempCwd(async () => {
    let story = await makeStory();
    for (const stage of ["sections", "tts", "images", "render", "metadata", "thumbnail", "final-qa", "export"] as const) {
      story = await saveStageRun("es-horror", "story-001", stage, { status: "done" });
    }
    const invalidated = invalidateDependents(story, "metadata");
    assert.deepEqual(invalidated.sort(), ["export", "final-qa", "thumbnail"]);
    assert.equal(story.stages.render?.status, "done");
    assert.equal(story.stages.tts?.status, "done");
    assert.equal(story.stages.images?.status, "done");
  });
});

test("the derived status ladder reflects the worst active condition", async () => {
  await withTempCwd(async () => {
    let story = await makeStory();
    assert.equal(deriveStoryStatus(story), "DRAFT");

    story = await saveStageRun("es-horror", "story-001", "idea", { status: "done" });
    assert.equal(deriveStoryStatus(story), "IN_PROGRESS");

    story = await saveStageRun("es-horror", "story-001", "hook", { status: "running" });
    assert.equal(deriveStoryStatus(story), "GENERATING");

    story = await saveStageRun("es-horror", "story-001", "hook", {
      status: "failed",
      lastError: { message: "boom", classification: "provider" },
    });
    assert.equal(deriveStoryStatus(story), "FAILED");

    story = await saveStageRun("es-horror", "story-001", "hook", {
      status: "failed",
      lastError: { message: "budget", classification: "budget" },
    });
    assert.equal(deriveStoryStatus(story), "BUDGET_PAUSED");

    story = await saveStageRun("es-horror", "story-001", "hook", { status: "awaiting-approval", lastError: undefined });
    assert.equal(deriveStoryStatus(story), "AWAITING_APPROVAL");

    story = await saveStageRun("es-horror", "story-001", "hook", { status: "done" });
    story = await saveStageRun("es-horror", "story-001", "export", { status: "done" });
    assert.equal(deriveStoryStatus(story), "READY_TO_PUBLISH");
  });
});

test("approvals bind to the anchor artifact hash and go stale on change", async () => {
  await withTempCwd(async () => {
    await makeStory();
    // Approving before the anchor stage completed is refused.
    await assert.rejects(() => approveStoryStage("es-horror", "story-001", "script"), /naturalize/);

    await writeStageArtifact("es-horror", "story-001", "naturalize", { version: 1, fullText: "v1" });
    await saveStageRun("es-horror", "story-001", "naturalize", { status: "done" });
    let story = await approveStoryStage("es-horror", "story-001", "script", "read it, sounds native");
    assert.equal(approvalState(story, "script"), "approved");

    // Editing the anchored artifact changes its hash: the approval is stale.
    ({ story } = await writeStageArtifact("es-horror", "story-001", "naturalize", { version: 1, fullText: "v2" }));
    assert.equal(approvalState(story, "script"), "stale");
    assert.equal(approvalState(story, "media"), "missing");
  });
});

test("story paths refuse traversal outside the story directory", async () => {
  await withTempCwd(async () => {
    assert.throws(() => storyPath("es-horror", "story-001", "..", "..", "other-project", "x.json"), /outside/i);
    assert.throws(() => storyPath("es-horror", "../evil"), /must match/);
  });
});
