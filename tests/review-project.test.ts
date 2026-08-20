import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewProject,
  listReviewProjects,
  loadReviewProject,
  updateReviewProject,
} from "../src/review-project.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";
import { createSeriesProject } from "../src/series.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-project-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("creates a batch review project under a series folder", async () => {
  await withTempCwd(async () => {
    await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      workflowType: "review-recap",
      audience: "Vietnamese donghua viewers",
      language: "Vietnamese",
    });

    const project = await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-05-review",
      title: "Tales of Herding Gods EP01-05",
      sourceRange: "Episodes 01-05",
      episodeNumbers: [1, 2, 3, 4, 5],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });

    assert.equal(project.episodes.length, 5);
    assert.equal(project.episodes[0].episodeNumber, 1);
    assert.equal(project.episodes[0].status, "empty");
    assert.equal(project.status, "draft");
    assert.deepEqual((await listReviewProjects("muc-than-ky")).map((item) => item.id), ["ep01-05-review"]);
    assert.match(await readFile(join("projects", "muc-than-ky", "review-projects", "ep01-05-review", "batch.json"), "utf8"), /EP01-05/);
  });
});

test("updates batch review metadata without replacing episode sources", async () => {
  await withTempCwd(async () => {
    await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      workflowType: "review-recap",
      audience: "Vietnamese viewers",
      language: "Vietnamese",
    });
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-05-review",
      title: "Initial",
      sourceRange: "Episodes 01-05",
      episodeNumbers: [1, 2, 3, 4, 5],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });

    const updated = await updateReviewProject("muc-than-ky", "ep01-05-review", {
      title: "Updated Batch",
      targetDurationMinutes: 24,
      status: "sources",
    });

    assert.equal(updated.title, "Updated Batch");
    assert.equal(updated.targetDurationMinutes, 24);
    assert.equal(updated.episodes.length, 5);
    assert.equal((await loadReviewProject("muc-than-ky", "ep01-05-review")).status, "sources");
  });
});

test("batch review API creates lists and patches review projects", async () => {
  await withTempCwd(async () => {
    await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      workflowType: "review-recap",
      audience: "Vietnamese viewers",
      language: "Vietnamese",
    });

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await fetch(`${running.url}/api/series/muc-than-ky/review-projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "ep01-05-review",
          title: "Tales of Herding Gods EP01-05",
          sourceRange: "Episodes 01-05",
          episodeNumbers: [1, 2, 3, 4, 5],
          targetLanguage: "English",
          reviewStyle: "story-review",
          targetDurationMinutes: 20,
          spoilerMode: "donghua-only",
        }),
      });

      assert.equal(created.status, 200);
      assert.equal((await created.json()).reviewProject.episodes.length, 5);

      const patched = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-05-review`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ status: "sources", targetDurationMinutes: 22 }),
      });

      assert.equal(patched.status, 200);
      const patchedBody = await patched.json();
      assert.equal(patchedBody.reviewProject.status, "sources");
      assert.equal(patchedBody.reviewProject.targetDurationMinutes, 22);

      const listed = await fetch(`${running.url}/api/series/muc-than-ky/review-projects`);
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).reviewProjects.map((project: { id: string }) => project.id), [
        "ep01-05-review",
      ]);
    } finally {
      await running.close();
    }
  });
});
