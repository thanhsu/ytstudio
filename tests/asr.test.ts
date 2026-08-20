import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSourceSrtFromAsr } from "../src/asr.ts";
import { saveStudioConfig } from "../src/config.ts";
import { createSampleProject } from "./helpers.ts";

test("faster-whisper ASR provider creates validated project source subtitles", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-asr-"));

  try {
    process.chdir(root);
    await mkdir(join(root, "projects", "sample-project", "workspace", "media"), { recursive: true });
    await createSampleProject(join(root, "projects", "sample-project"));
    await writeFile(join(root, "projects", "sample-project", "workspace", "media", "asr-audio.wav"), "audio", "utf8");

    const fakeWhisper = join(root, "fake-whisper.mjs");
    const recordPath = join(root, "asr-record.json");
    await writeFile(
      fakeWhisper,
      `
import { writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
const args = process.argv.slice(2);
const audioPath = args.find((arg) => arg.endsWith(".wav"));
const outputDir = args[args.indexOf("--output_dir") + 1];
const srtPath = join(outputDir, basename(audioPath, extname(audioPath)) + ".srt");
await writeFile(${JSON.stringify(recordPath)}, JSON.stringify({ args }), "utf8");
await writeFile(srtPath, "1\\n00:00:00,000 --> 00:00:02,000\\n你好，秦牧。\\n", "utf8");
`,
      "utf8",
    );

    await saveStudioConfig({
      asr: {
        provider: "faster-whisper",
        executablePath: process.execPath,
        model: "tiny",
        language: "zh",
      },
    });

    const artifact = await generateSourceSrtFromAsr({
      projectId: "sample-project",
      prefixArgs: [fakeWhisper],
    });

    assert.equal(artifact.provider, "faster-whisper");
    assert.equal(artifact.cueCount, 1);
    assert.match(await readFile(join(root, "projects", "sample-project", artifact.relativePath), "utf8"), /秦牧/);
    assert.match(await readFile(recordPath, "utf8"), /--output_format/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("ASR refuses to run while provider is disabled", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-asr-disabled-"));

  try {
    process.chdir(root);
    await mkdir(join(root, "projects", "sample-project", "workspace", "media"), { recursive: true });
    await createSampleProject(join(root, "projects", "sample-project"));
    await assert.rejects(
      () => generateSourceSrtFromAsr({ projectId: "sample-project" }),
      /ASR provider is disabled/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
