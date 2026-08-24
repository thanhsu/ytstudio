import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { createCompilation, exportCompilation, loadCompilation, renderCompilation } from "../src/story-factory/compilation.ts";
import { makeFakeExecutable } from "./helpers.ts";

test("compilation validates 4-6 rendered stories, renders chapters, and exports after approval", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-compilation-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    for (let index = 1; index <= 4; index += 1) {
      const id = `story-00${index}`;
      const dir = join(root, "es-horror", "stories", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "story.json"), JSON.stringify({ version: 1, id, channelId: "es-horror", title: `Story ${index}`, config: {}, stages: { render: { status: "done" } }, approvals: {}, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" }), "utf8");
      await writeFile(join(dir, "render.json"), JSON.stringify({ version: 1, videoPath: `stories/${id}/workspace/render/story.mp4`, durationSeconds: index * 10, width: 1920, height: 1080 }), "utf8");
      await mkdir(join(dir, "workspace", "render"), { recursive: true });
      await writeFile(join(dir, "workspace", "render", "story.mp4"), `video-${index}`, "utf8");
    }
    await assert.rejects(() => createCompilation("es-horror", { id: "comp-001", title: "Too short", storyIds: ["story-001", "story-002", "story-003"] }));
    const compilation = await createCompilation("es-horror", { id: "comp-001", title: "Four nights", storyIds: ["story-001", "story-002", "story-003", "story-004"] });
    assert.equal(compilation.storyIds.length, 4);
    const ffmpeg = await makeFakeExecutable(`import { writeFile } from "node:fs/promises"; await writeFile(process.argv.at(-1), "compiled");`);
    await renderCompilation("es-horror", "comp-001", { config: { render: { ffmpegPath: "" } }, ffmpegPath: process.execPath, ffmpegPrefixArgs: [ffmpeg], probeDuration: async (path) => Number((await readFile(path, "utf8")).split("-")[1]) * 10 });
    const rendered = await loadCompilation("es-horror", "comp-001");
    assert.equal(rendered.stages.render?.status, "done");
    const renderJson = await readFile(join(root, "es-horror", "compilations", "comp-001", "render.json"));
    rendered.approvals.final = { artifactHash: createHash("sha256").update(renderJson).digest("hex"), approvedAt: new Date().toISOString(), note: "approved" };
    await writeFile(join(root, "es-horror", "compilations", "comp-001", "compilation.json"), JSON.stringify(rendered), "utf8");
    const exported = await exportCompilation("es-horror", "comp-001");
    assert.match(exported.videoPath, /compilations\/comp-001\/workspace\/export\/story\.mp4/);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
