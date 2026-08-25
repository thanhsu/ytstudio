import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReupWizard, scanReupFolder } from "../src/reup-wizard.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

function tinyWav(samples = 800): Buffer {
  const dataBytes = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:02,000
First line.

2
00:00:03,000 --> 00:00:04,000
Second line.
`;

async function buildSourceFolder(root: string): Promise<string> {
  const folder = join(root, "150.9 su");
  await mkdir(join(folder, "audio_usa", "audio_usa"), { recursive: true });
  await writeFile(join(folder, "150.9-full_reaudio.mp4"), Buffer.alloc(4096, 7));
  await writeFile(join(folder, "150_9_English_QA_fixed.srt"), SAMPLE_SRT, "utf8");
  await writeFile(join(folder, "cover.jpg"), Buffer.alloc(64, 1));
  await writeFile(join(folder, "audio_usa", "audio_usa", "0001.wav"), tinyWav());
  await writeFile(join(folder, "audio_usa", "audio_usa", "0002.wav"), tinyWav());
  return folder;
}

async function withTempCwd<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-reup-wizard-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn(root);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("scanReupFolder finds the video, srt, nested audio folder, and cover", async () => {
  await withTempCwd(async (root) => {
    const folder = await buildSourceFolder(root);
    const scan = await scanReupFolder(folder);
    assert.ok(scan.videoPath?.endsWith("150.9-full_reaudio.mp4"));
    assert.ok(scan.srtPath?.endsWith("150_9_English_QA_fixed.srt"));
    assert.ok(scan.audioDir?.endsWith(join("audio_usa", "audio_usa")));
    assert.ok(scan.coverPath?.endsWith("cover.jpg"));
    assert.deepEqual(scan.missing, []);
  });
});

test("runReupWizard sets up the whole project from one folder", async () => {
  await withTempCwd(async (root) => {
    const folder = await buildSourceFolder(root);
    const summary = await runReupWizard({
      projectId: "su-150-9",
      folderPath: folder,
      finalRender: false,
    });

    assert.equal(summary.projectId, "su-150-9");
    assert.equal(summary.cueCount, 2);
    assert.equal(summary.segmentCount, 2);

    const brief = JSON.parse(await readFile(join("projects", "su-150-9", "brief.json"), "utf8"));
    assert.equal(brief.workflowType, "subtitle-render");

    const state = JSON.parse(await readFile(join("projects", "su-150-9", "project-state.json"), "utf8"));
    for (const kind of ["media", "source-subtitles", "voiceover-segments", "voiceover-track"]) {
      assert.ok(state.artifacts[kind], `expected artifact ${kind}`);
    }

    const branding = JSON.parse(await readFile(join("projects", "su-150-9", "workspace", "branding", "branding.json"), "utf8"));
    assert.equal(branding.coverFile, "cover.jpg");
  });
});

test("the wizard route rejects a folder without the required files", async () => {
  await withTempCwd(async (root) => {
    await mkdir(join(root, "empty-folder"), { recursive: true });
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/reup-wizard`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ id: "su-150-9", folderPath: join(root, "empty-folder") }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "reup-folder-invalid");
      assert.ok(body.message.includes("video"));
    } finally {
      await running.close();
    }
  });
});
