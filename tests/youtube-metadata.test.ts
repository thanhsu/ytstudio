import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateYoutubeMetadata } from "../src/youtube-metadata.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

const SAMPLE_SRT = `1
00:00:04,000 --> 00:00:06,000
Who's on the flag platform?

2
00:10:00,000 --> 00:10:02,000
He awakened a legendary mutant spiritual root!

3
01:30:00,000 --> 01:30:02,000
His parents secretly rule both paths.
`;

async function setupProject(root: string, projectId: string): Promise<void> {
  const dir = join("projects", projectId);
  await mkdir(join(dir, "workspace", "subtitles"), { recursive: true });
  await writeFile(
    join(dir, "brief.json"),
    JSON.stringify({
      id: projectId,
      topic: "Hidden overpowered family",
      show: "Cultivation Chronicle",
      format: "longform",
      workflowType: "subtitle-render",
      audience: "Australian anime recap viewers",
      language: "English",
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(join(dir, "workspace", "subtitles", "source.srt"), SAMPLE_SRT, "utf8");
  await writeFile(
    join(dir, "project-state.json"),
    JSON.stringify({
      version: 1,
      approvals: {},
      artifacts: {
        "source-subtitles": {
          kind: "source-subtitles",
          sourceHash: "x",
          relativePath: "workspace/subtitles/source.srt",
          createdAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
        },
      },
    }),
    "utf8",
  );
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-metadata-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("dry-run youtube metadata carries three title angles, chapters, and tags", async () => {
  await withTempCwd(async () => {
    await setupProject(process.cwd(), "meta-demo");

    const metadata = await generateYoutubeMetadata("meta-demo", {});

    assert.deepEqual(metadata.titles.map((title) => title.type), ["ctr", "seo", "balanced"]);
    for (const title of metadata.titles) {
      assert.ok(title.title.length > 10);
      assert.ok(title.reason.length > 10);
    }
    assert.match(metadata.description, /00:00/);
    assert.ok(metadata.tags.length >= 5);
    assert.ok(metadata.summary.length > 20);

    const savedJson = JSON.parse(await readFile(join("projects", "meta-demo", "workspace", "youtube", "metadata.json"), "utf8"));
    assert.equal(savedJson.titles.length, 3);
    const savedMd = await readFile(join("projects", "meta-demo", "workspace", "youtube", "metadata.md"), "utf8");
    assert.match(savedMd, /## Titles/);

    const state = JSON.parse(await readFile(join("projects", "meta-demo", "project-state.json"), "utf8"));
    assert.equal(state.artifacts["youtube-metadata"].relativePath, "workspace/youtube/metadata.md");
  });
});

test("the metadata route refuses to start without source subtitles", async () => {
  await withTempCwd(async () => {
    await mkdir(join("projects", "meta-demo"), { recursive: true });
    await writeFile(
      join("projects", "meta-demo", "brief.json"),
      JSON.stringify({ id: "meta-demo", topic: "T", show: "S", format: "longform", workflowType: "subtitle-render", audience: "A", language: "en", notes: "", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/meta-demo/youtube-metadata`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "youtube-metadata-prerequisites");
    } finally {
      await running.close();
    }
  });
});
