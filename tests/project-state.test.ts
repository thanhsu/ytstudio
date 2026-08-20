import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectPath } from "../src/project-paths.ts";
import {
  approveStage,
  derivePipelineStatus,
  loadProjectState,
  setArtifact,
  type ProjectState,
} from "../src/project-state.ts";

test("project paths reject traversal", () => {
  assert.throws(() => resolveProjectPath("../outside", "brief.json"), /project id/i);
  assert.throws(() => resolveProjectPath("valid-project", "..", "secret"), /outside projects/i);
});

test("changed script hash invalidates script-dependent artifacts", () => {
  const state: ProjectState = {
    version: 1,
    approvals: {
      script: { sourceHash: "old-hash", approvedAt: "2026-08-20T00:00:00.000Z", note: "" },
      copyright: { sourceHash: "copyright-hash", approvedAt: "2026-08-20T00:00:00.000Z", note: "" },
      assets: { sourceHash: "assets-hash", approvedAt: "2026-08-20T00:00:00.000Z", note: "" },
    },
    artifacts: {
      voice: {
        kind: "voice",
        sourceHash: "old-hash",
        relativePath: "workspace/voice/draft.wav",
        createdAt: "2026-08-20T00:00:00.000Z",
        metadata: {},
      },
      captions: {
        kind: "captions",
        sourceHash: "old-hash",
        relativePath: "workspace/captions/draft.srt",
        createdAt: "2026-08-20T00:00:00.000Z",
        metadata: {},
      },
    },
  };

  const status = derivePipelineStatus(state, {
    script: "new-hash",
    copyright: "copyright-hash",
    assets: "assets-hash",
  });

  assert.equal(status.script, "stale");
  assert.equal(status.voice, "stale");
  assert.equal(status.captions, "stale");
  assert.equal(status.render, "blocked");
});

test("project state persists approvals and artifacts", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);

    await approveStage("sample-project", "script", "script-hash", "looks good");
    await setArtifact("sample-project", {
      kind: "voice",
      sourceHash: "script-hash",
      relativePath: "workspace/voice/draft.wav",
      createdAt: "2026-08-20T00:00:00.000Z",
      metadata: { provider: "piper" },
    });

    const state = await loadProjectState("sample-project");

    assert.equal(state.version, 1);
    assert.equal(state.approvals.script?.sourceHash, "script-hash");
    assert.equal(state.approvals.script?.note, "looks good");
    assert.equal(state.artifacts.voice?.relativePath, "workspace/voice/draft.wav");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
