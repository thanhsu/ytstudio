import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewJobManager } from "../src/review-jobs.ts";

test("review jobs reuse idempotent completed results", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-review-jobs-"));
  try {
    const manager = new ReviewJobManager(root);
    let calls = 0;
    const first = await manager.runIdempotent(
      {
        scopeId: "muc-than-ky/ep01-05-review",
        taskKind: "scene-map",
        episodeNumber: 3,
        idempotencyKey: "hash-1",
      },
      async ({ update }) => {
        calls += 1;
        await update(50, "Halfway");
        return { artifactPath: "sources/ep003/scenes.json" };
      },
    );
    const second = await manager.runIdempotent(
      {
        scopeId: "muc-than-ky/ep01-05-review",
        taskKind: "scene-map",
        episodeNumber: 3,
        idempotencyKey: "hash-1",
      },
      async () => {
        calls += 1;
        return { artifactPath: "should-not-run.json" };
      },
    );

    assert.equal(calls, 1);
    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.deepEqual(second.result, { artifactPath: "sources/ep003/scenes.json" });
    assert.equal(second.message, "Reused cached result");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
