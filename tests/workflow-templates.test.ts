import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";
import {
  deriveWorkflowStepStates,
  getWorkflowTemplate,
  WORKFLOW_TEMPLATES,
} from "../src/workflow-templates.ts";
import type { ProjectState, WorkflowType } from "../src/types.ts";

test("workflow templates describe the supported video production flows", () => {
  assert.deepEqual(
    WORKFLOW_TEMPLATES.map((template) => template.type),
    ["review-recap", "audio-story", "subtitle-render", "licensed-source"],
  );

  const audioStory = getWorkflowTemplate("audio-story");
  assert.equal(audioStory.title, "Audio Story");
  assert.equal(audioStory.steps.some((step) => step.id === "story-text"), true);
  assert.equal(audioStory.steps.some((step) => step.id === "media"), false);
});

test("workflow step states expose ready tasks that can run in parallel", () => {
  const state: ProjectState = {
    version: 1,
    approvals: {},
    artifacts: {
      media: {
        kind: "media",
        sourceHash: "media",
        relativePath: "workspace/media/source.mp4",
        createdAt: "2026-08-20T00:00:00.000Z",
        metadata: {},
      },
    },
  };

  const steps = deriveWorkflowStepStates("subtitle-render", state);
  const ready = steps.filter((step) => step.status === "ready").map((step) => step.id);

  assert.equal(steps.find((step) => step.id === "input")?.status, "done");
  assert.deepEqual(ready, ["extract-audio", "source-risk"]);
  assert.equal(steps.find((step) => step.id === "asr")?.status, "blocked");
});

test("new project API persists the requested workflow type", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-workflow-api-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "story-project",
          topic: "Chapter one",
          show: "Original web novel",
          format: "longform",
          audience: "Vietnamese audio story listeners",
          language: "Vietnamese",
          workflowType: "audio-story" satisfies WorkflowType,
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).brief.workflowType, "audio-story");

      const project = await fetch(`${running.url}/api/projects/story-project`);
      const body = await project.json();
      assert.equal(body.workflow.type, "audio-story");
      assert.equal(body.workflow.steps.some((step: { id: string }) => step.id === "story-text"), true);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown workflow type falls back to review recap", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-workflow-fallback-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "legacy-project"), { recursive: true });
    await writeFile(
      join("projects", "legacy-project", "brief.json"),
      JSON.stringify({
        id: "legacy-project",
        topic: "Legacy review",
        show: "Sample",
        format: "shorts",
        audience: "Vietnamese viewers",
        language: "Vietnamese",
        workflowType: "unknown",
        notes: "",
        createdAt: "2026-08-20T00:00:00.000Z",
      }),
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/legacy-project`);
      const body = await response.json();
      assert.equal(body.workflow.type, "review-recap");
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
