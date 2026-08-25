import assert from "node:assert/strict";
import test from "node:test";
import { deriveStoryStatus, STAGE_ARTIFACT_FILES, STAGE_DEPS } from "../src/story-factory/story-project.ts";
import { PIPELINE_STAGES, runSingleStage } from "../src/story-factory/pipeline.ts";
import type { StoryProject } from "../src/story-factory/types.ts";

test("publish is a terminal stage after export and is not part of the pipeline", () => {
  assert.equal(STAGE_DEPS.publish[0], "export");
  assert.equal(STAGE_ARTIFACT_FILES.publish, "publish.json");
  assert.equal(PIPELINE_STAGES.includes("publish"), false);
  assert.equal(PIPELINE_STAGES.includes("export"), false);
});

test("a completed publish stage derives PUBLISHED above READY_TO_PUBLISH", async () => {
  const story = {
    version: 1,
    id: "story-001",
    channelId: "es-horror",
    title: "Title",
    kind: "original" as const,
    config: {} as StoryProject["config"],
    stages: { export: { status: "done", attemptCount: 1, costUsd: 0 }, publish: { status: "done", attemptCount: 1, costUsd: 0 } },
    approvals: {},
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  } satisfies StoryProject;
  assert.equal(deriveStoryStatus(story), "PUBLISHED");
  await assert.rejects(() => runSingleStage("es-horror", "story-001", "publish", {} as never));
});
