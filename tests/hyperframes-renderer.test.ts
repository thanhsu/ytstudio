import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHyperframesStoryVideo } from "../src/story-factory/hyperframes-renderer.ts";
import { buildHyperframesComposition } from "../src/story-factory/hyperframes-composition.ts";
import { makeFakeExecutable } from "./helpers.ts";

test("renderer writes composition files and invokes configured command without npx", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-render-"));
  const callsPath = join(root, "calls.jsonl");
  const fakeCli = await makeFakeExecutable(`
import { appendFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
const output = args[args.indexOf("--output") + 1];
await writeFile(output, "video-bytes");
`);
  try {
    const result = await renderHyperframesStoryVideo({
      workspacePath: root,
      command: process.execPath,
      args: [fakeCli],
      timeoutMinutes: 1,
      composition: baseComposition(),
      outputFileName: "story.mp4",
    });

    assert.equal(result.engine, "hyperframes");
    assert.match(result.videoPath, /story\.mp4$/);
    assert.equal(await readFile(join(root, "index.html"), "utf8"), baseComposition().html);
    const calls = await readFile(callsPath, "utf8");
    assert.ok(!calls.includes("npx"));
    assert.match(calls, /"--output"/);
    assert.match(calls, /"\."/);
  } finally {
    await removeTreeEventually(root);
  }
});

test("renderer resolves the default relative Hyperframes CLI before entering the composition workspace", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "hf-default-cli-"));
  const workspace = join(root, "stories", "story-001", "workspace", "render", "hyperframes");
  const cliPath = join(root, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
  const callsPath = join(root, "calls.jsonl");
  await mkdir(join(root, "node_modules", "hyperframes", "bin"), { recursive: true });
  await writeFile(cliPath, `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ cwd: process.cwd(), script: import.meta.url, args }) + "\\n", "utf8");
const output = args[args.indexOf("--output") + 1];
await mkdir(dirname(output), { recursive: true });
await writeFile(output, "video-bytes");
`, "utf8");
  await chmod(cliPath, 0o755);
  try {
    process.chdir(root);
    await renderHyperframesStoryVideo({
      workspacePath: workspace,
      command: process.execPath,
      args: ["./node_modules/hyperframes/bin/hyperframes.mjs"],
      timeoutMinutes: 1,
      composition: baseComposition(),
      outputFileName: "..\\story.mp4",
    });
    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /hyperframes[\\\/]bin[\\\/]hyperframes\.mjs/);
    assert.match(calls, /"cwd":".*hyperframes/);
  } finally {
    process.chdir(previousCwd);
    await removeTreeEventually(root);
  }
});

test("renderer aborts a hung Hyperframes process without leaving the direct child running", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-timeout-"));
  const pidPath = join(root, "pid.txt");
  const fakeCli = await makeFakeExecutable(`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), "utf8");
setInterval(() => {}, 1000);
`);
  try {
    await assert.rejects(
      () => renderHyperframesStoryVideo({
        workspacePath: root,
        command: process.execPath,
        args: [fakeCli],
        timeoutMinutes: 0.01,
        composition: baseComposition(),
        outputFileName: "story.mp4",
      }),
      /timed out|aborted/i,
    );
    const pid = Number(await readFile(pidPath, "utf8"));
    await waitForProcessExit(pid);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await removeTreeEventually(root);
  }
});

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function removeTreeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      if (!isBusy(error) || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
}

function baseComposition() {
  return buildHyperframesComposition({
    compositionId: "story",
    width: 1920,
    height: 1080,
    durationSeconds: 3,
    sourceHash: "hash",
    hyperframesVersion: "0.8.13",
    narrationRelativePath: "assets/narration.m4a",
    cues: [{
      sceneId: "SC-001",
      startSeconds: 0,
      endSeconds: 3,
      narrationExcerpt: "A quiet hallway.",
      visualPrompt: "mysterious hallway",
      mood: "mysterious",
      captionEmphasis: ["hallway"],
      motion: "slow-push",
      overlayText: "quiet hallway",
    }],
    imagesBySceneId: new Map([["SC-001", "assets/image-000.png"]]),
    bgmTracks: [],
    sfxEvents: [],
  });
}
