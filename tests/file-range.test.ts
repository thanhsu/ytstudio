import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-file-range-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "demo-project", "workspace"), { recursive: true });
    await writeFile(join("projects", "demo-project", "workspace", "clip.txt"), "0123456789", "utf8");
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("project files answer range requests with the requested slice", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const url = `${running.url}/api/projects/demo-project/files/${encodeURIComponent("workspace/clip.txt")}`;

      const full = await fetch(url);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("accept-ranges"), "bytes");
      assert.equal(full.headers.get("content-length"), "10");
      assert.equal(await full.text(), "0123456789");

      const middle = await fetch(url, { headers: { range: "bytes=2-5" } });
      assert.equal(middle.status, 206);
      assert.equal(middle.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(await middle.text(), "2345");

      const openEnded = await fetch(url, { headers: { range: "bytes=7-" } });
      assert.equal(openEnded.status, 206);
      assert.equal(openEnded.headers.get("content-range"), "bytes 7-9/10");
      assert.equal(await openEnded.text(), "789");

      const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
      assert.equal(suffix.status, 206);
      assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
      assert.equal(await suffix.text(), "789");

      const beyond = await fetch(url, { headers: { range: "bytes=20-" } });
      assert.equal(beyond.status, 416);
      assert.equal(beyond.headers.get("content-range"), "bytes */10");
    } finally {
      await running.close();
    }
  });
});
