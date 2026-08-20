import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBrief } from "../src/brief.ts";
import { generateDryRunScript } from "../src/script.ts";
import {
  approveCurrentCopyrightCheck,
  approveCurrentScript,
  approveEmptyAssetManifest,
  generateVoice,
  prepareCaptions,
  renderDraftProject,
} from "../src/workflow.ts";
import { makeFakeExecutable } from "./helpers.ts";

test("sample project completes the free draft pipeline", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-smoke-"));

  try {
    process.chdir(root);
    await createBrief({
      id: "sample-project",
      topic: "Why Qin Mu feels different",
      show: "Tales of Herding Gods",
      format: "shorts",
      audience: "EU donghua viewers",
      language: "English",
    });
    await generateDryRunScript("sample-project");
    await writeFile(
      join("projects", "sample-project", "copyright-check.json"),
      JSON.stringify({ blocked: false, risk: "low" }),
      "utf8",
    );
    const modelPath = join(root, "voice.onnx");
    await writeFile(modelPath, "model", "utf8");
    const fakePiper = await makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output_file") + 1];
await writeFile(outputPath, "audio", "utf8");
`);
    const fakeFfmpeg = await makeFakeExecutable(`
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const outputPath = process.argv.at(-1);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, "video", "utf8");
`);

    await approveCurrentScript("sample-project");
    const voice = await generateVoice({
      projectId: "sample-project",
      provider: "piper",
      piperExecutable: process.execPath,
      piperPrefixArgs: [fakePiper],
      piperModelPath: modelPath,
      probeDuration: async () => 3,
    });
    const captions = await prepareCaptions("sample-project", voice.durationSeconds);
    await approveEmptyAssetManifest("sample-project");
    await approveCurrentCopyrightCheck("sample-project");
    const render = await renderDraftProject("sample-project", { ffmpegPath: process.execPath, ffmpegPrefixArgs: [fakeFfmpeg] });

    assert.equal(voice.provider, "piper");
    assert.ok(captions.relativePath.endsWith(".srt"));
    assert.ok(render.relativePath.endsWith(".mp4"));
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
