import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

test("web shell exposes the complete approval pipeline", async () => {
  const html = await readFile("src/web/index.html", "utf8");

  for (const stage of ["Brief", "Script", "Voice", "Assets", "Copyright", "Render"]) {
    assert.match(html, new RegExp(stage));
  }
  assert.match(html, /aria-live="polite"/);
});

test("server serves the studio shell without exposing project files", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-web-"));

  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await writeFile(join("projects", "sample-project", "brief.json"), "{}", "utf8");

    const running = await startStudioServer(createStudioServer({ staticRoot: previousCwd }), { port: 0 });
    try {
      assert.equal((await fetch(`${running.url}/`)).status, 200);
      assert.equal((await fetch(`${running.url}/projects/sample-project/brief.json`)).status, 404);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
