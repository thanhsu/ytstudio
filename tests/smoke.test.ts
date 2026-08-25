import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { buildNarrationScenes, generateVisualMapping, saveVisualMapping } from "../src/visual-mapping.ts";
import { DEFAULT_SEGMENT_EFFECTS } from "../src/visual-effects.ts";
import { resolveProjectPath } from "../src/project-paths.ts";
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

test("render writes into the configured projects root", async () => {
  const previousCwd = process.cwd();
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const workingDirectory = await mkdtemp(join(tmpdir(), "yt-smoke-cwd-"));
  const library = await mkdtemp(join(tmpdir(), "yt-smoke-library-"));

  try {
    process.chdir(workingDirectory);
    process.env.YT_STUDIO_PROJECTS_DIR = library;
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
      join(library, "sample-project", "copyright-check.json"),
      JSON.stringify({ blocked: false, risk: "low" }),
      "utf8",
    );
    const modelPath = join(workingDirectory, "voice.onnx");
    await writeFile(modelPath, "model", "utf8");
    const fakePiper = await makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await writeFile(args[args.indexOf("--output_file") + 1], "audio", "utf8");
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
    await prepareCaptions("sample-project", voice.durationSeconds);
    await approveEmptyAssetManifest("sample-project");
    await approveCurrentCopyrightCheck("sample-project");
    const render = await renderDraftProject("sample-project", {
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });

    await stat(join(library, "sample-project", render.relativePath));
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(workingDirectory, { recursive: true, force: true });
    await rm(library, { recursive: true, force: true });
  }
});

test("an approved background loop reaches ffmpeg as a repeated input", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-smoke-loop-"));

  try {
    process.chdir(root);
    await createBrief({
      id: "loop-project",
      topic: "Ambient story",
      show: "Ambient",
      format: "longform",
      audience: "VN listeners",
      language: "Vietnamese",
    });
    await generateDryRunScript("loop-project");
    await writeFile(join("projects", "loop-project", "copyright-check.json"), JSON.stringify({ blocked: false, risk: "low" }), "utf8");
    const modelPath = join(root, "voice.onnx");
    await writeFile(modelPath, "model", "utf8");
    const fakePiper = await makeFakeExecutable([
      'import { writeFile } from "node:fs/promises";',
      "const args = process.argv.slice(2);",
      'await writeFile(args[args.indexOf("--output_file") + 1], "audio");',
    ].join("\n"));
    const argsRecord = join(root, "ffmpeg-args.json");
    const fakeFfmpeg = await makeFakeExecutable([
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import { dirname } from "node:path";',
      "const outputPath = process.argv.at(-1);",
      "await mkdir(dirname(outputPath), { recursive: true });",
      'await writeFile(outputPath, "video");',
      `await writeFile(${JSON.stringify(argsRecord)}, JSON.stringify(process.argv.slice(2)));`,
    ].join("\n"));

    // A video asset the operator owns, plus the loop that points at it.
    const clipPath = join("projects", "loop-project", "assets", "clips", "ambience.mp4");
    await mkdir(join("projects", "loop-project", "assets", "clips"), { recursive: true });
    await writeFile(clipPath, "clip", "utf8");
    await writeFile(
      join("projects", "loop-project", "assets", "asset-manifest.json"),
      JSON.stringify({
        version: 1,
        assets: [{
          id: "loop-1", filename: "ambience.mp4", relativePath: "assets/clips/ambience.mp4", mediaType: "video",
          mimeType: "video/mp4", sizeBytes: 5, rightsConfirmed: true, usagePurpose: "looping background",
          createdAt: "2026-08-25T00:00:00.000Z", analysisStatus: "ready", durationSeconds: 10,
        }],
      }),
      "utf8",
    );

    await approveCurrentScript("loop-project");
    const voice = await generateVoice({
      projectId: "loop-project", provider: "piper", piperExecutable: process.execPath,
      piperPrefixArgs: [fakePiper], piperModelPath: modelPath, probeDuration: async () => 30,
    });
    await prepareCaptions("loop-project", voice.durationSeconds);
    await approveEmptyAssetManifest("loop-project");
    await approveCurrentCopyrightCheck("loop-project");

    const captionsText = await readFile(resolveProjectPath("loop-project", "workspace/captions/" + (await readdir(resolveProjectPath("loop-project", "workspace/captions")))[0]), "utf8");
    const mapping = generateVisualMapping(buildNarrationScenes(captionsText), []);
    await saveVisualMapping("loop-project", {
      ...mapping,
      status: "approved",
      backgroundLoop: { assetId: "loop-1", fitMode: "cover", effects: DEFAULT_SEGMENT_EFFECTS },
    });

    await renderDraftProject("loop-project", { ffmpegPath: process.execPath, ffmpegPrefixArgs: [fakeFfmpeg] });

    const args = JSON.parse(await readFile(argsRecord, "utf8")) as string[];
    const loopAt = args.indexOf("-stream_loop");
    assert.ok(loopAt >= 0, `expected -stream_loop in ${args.join(" ")}`);
    assert.equal(args[loopAt + 1], "-1");
    assert.ok(args[loopAt + 3].endsWith("ambience.mp4"), args[loopAt + 3]);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("long-form projects render at the configured 16:9 size", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-longform-"));

  try {
    process.chdir(root);
    await createBrief({
      id: "longform-project",
      topic: "Every arc in Tales of Herding Gods",
      show: "Tales of Herding Gods",
      format: "longform",
      audience: "EU donghua viewers",
      language: "English",
    });
    await generateDryRunScript("longform-project");
    await writeFile(
      join("projects", "longform-project", "copyright-check.json"),
      JSON.stringify({ blocked: false, risk: "low" }),
      "utf8",
    );
    const modelPath = join(root, "voice.onnx");
    await writeFile(modelPath, "model", "utf8");
    const fakePiper = await makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await writeFile(args[args.indexOf("--output_file") + 1], "audio", "utf8");
`);
    const argsPath = join(root, "ffmpeg-args.json");
    const recordingFfmpeg = await makeFakeExecutable(`
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const argv = process.argv.slice(2);
await writeFile(${JSON.stringify(argsPath)}, JSON.stringify(argv), "utf8");
const outputPath = argv.at(-1);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, "video", "utf8");
`);

    await approveCurrentScript("longform-project");
    const voice = await generateVoice({
      projectId: "longform-project",
      provider: "piper",
      piperExecutable: process.execPath,
      piperPrefixArgs: [fakePiper],
      piperModelPath: modelPath,
      probeDuration: async () => 3,
    });
    await prepareCaptions("longform-project", voice.durationSeconds);
    await approveEmptyAssetManifest("longform-project");
    await approveCurrentCopyrightCheck("longform-project");
    const render = await renderDraftProject("longform-project", {
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [recordingFfmpeg],
    });

    const ffmpegArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(ffmpegArgs.includes("1920x1080"));
    assert.equal(render.metadata.width, 1920);
    assert.equal(render.metadata.height, 1080);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
