import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

function jobJson(id: string, projectId: string, status: string, updatedAt: string): string {
  return JSON.stringify({
    id,
    projectId,
    kind: "final-render",
    status,
    progress: status === "running" ? 10 : 100,
    message: status === "running" ? "Encoding" : "Done",
    createdAt: updatedAt,
    updatedAt,
  });
}

test("GET /api/jobs lists persisted jobs across projects, newest first", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-list-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "alpha", "workspace", "jobs"), { recursive: true });
    await mkdir(join("projects", "beta", "workspace", "jobs"), { recursive: true });
    await writeFile(join("projects", "alpha", "workspace", "jobs", "job-1.json"), jobJson("job-1", "alpha", "succeeded", "2026-08-25T01:00:00.000Z"));
    await writeFile(join("projects", "beta", "workspace", "jobs", "job-2.json"), jobJson("job-2", "beta", "running", "2026-08-25T02:00:00.000Z"));

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/jobs`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.jobs.map((job: { id: string }) => job.id), ["job-2", "job-1"]);
      assert.equal(body.jobs[0].projectId, "beta");
      assert.equal(body.jobs[0].status, "running");
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("jobs screen exposes a debug drawer with raw job JSON", async () => {
  const [script, styles] = await Promise.all([
    readFile("src/web/screens/jobs.js", "utf8"),
    readFile("src/web/styles.css", "utf8"),
  ]);

  assert.match(script, /Debug/);
  assert.match(script, /openJobDebug/);
  assert.match(script, /job-debug-drawer/);
  assert.match(script, /JSON\.stringify\(job, null, 2\)/);
  assert.match(styles, /\.job-debug-drawer/);
  assert.match(styles, /\.job-debug-json/);
});
