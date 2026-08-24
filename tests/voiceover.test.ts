import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importVoiceoverSegments, renderVoiceoverTrack } from "../src/voiceover.ts";
import { makeFakeExecutable } from "./helpers.ts";

const TIMING_SRT = `1
00:00:01,000 --> 00:00:02,000
First line.

2
00:00:02,500 --> 00:00:03,500
Second line.

3
00:00:04,000 --> 00:00:05,000
Third line.

4
00:00:05,500 --> 00:00:06,500
Fourth line.
`;

function makePcm16Wav(samples: number[], sampleRate = 24000, channels = 1): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

async function withTempCwd(run: (root: string) => Promise<void>): Promise<void> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-voiceover-"));
  try {
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function readPcm16Samples(wav: Buffer): { sampleRate: number; channels: number; samples: number[] } {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  const samples: number[] = [];
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
    } else if (chunkId === "data") {
      for (let i = 0; i < chunkSize; i += 2) {
        samples.push(wav.readInt16LE(offset + 8 + i));
      }
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { sampleRate, channels, samples };
}

test("imports voiceover segments matched to SRT cues by filename index", async () => {
  await withTempCwd(async () => {
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), TIMING_SRT, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav([1000, -1000]));
    await writeFile(join("input", "audio", "0002.wav"), makePcm16Wav([2000, -2000]));
    await writeFile(join("input", "audio", "0004.wav"), makePcm16Wav([4000, -4000]));
    await writeFile(join("input", "audio", "0005.wav"), makePcm16Wav([5000, -5000]));
    await writeFile(join("input", "audio", "voice_segments.csv"), "index,file\n", "utf8");

    const result = await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });

    assert.equal(result.cueCount, 4);
    assert.equal(result.segmentCount, 3);
    assert.deepEqual(result.missingCues, [3]);
    assert.deepEqual(result.extraFiles, ["0005.wav"]);

    const projectRoot = join("projects", "sample-project");
    const copied = await readFile(join(projectRoot, "workspace", "voiceover", "segments", "0002.wav"));
    assert.deepEqual(copied, makePcm16Wav([2000, -2000]));

    const timing = await readFile(join(projectRoot, "workspace", "voiceover", "timing.srt"), "utf8");
    assert.match(timing, /Second line\./);

    const manifest = JSON.parse(
      await readFile(join(projectRoot, "workspace", "voiceover", "segments.json"), "utf8"),
    );
    assert.equal(manifest.segments.length, 3);
    assert.deepEqual(manifest.segments[0], {
      cueIndex: 1,
      file: "0001.wav",
      startMs: 1000,
      endMs: 2000,
    });

    const state = JSON.parse(await readFile(join(projectRoot, "project-state.json"), "utf8"));
    assert.equal(state.artifacts["voiceover-segments"].relativePath, "workspace/voiceover/segments.json");
  });
});

test("renders a single track placing segments at cue start times with silence gaps", async () => {
  await withTempCwd(async () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
First line.

2
00:00:02,500 --> 00:00:03,500
Second line.
`;
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), srt, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav(Array(500).fill(1111), 1000));
    await writeFile(join("input", "audio", "0002.wav"), makePcm16Wav(Array(800).fill(2222), 1000));

    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });

    const result = await renderVoiceoverTrack({ projectId: "sample-project" });

    assert.equal(result.wavRelativePath, "workspace/voiceover/voiceover.wav");
    assert.equal(result.segmentCount, 2);
    assert.equal(result.durationMs, 3300);
    assert.deepEqual(result.warnings, []);

    const wav = await readFile(join("projects", "sample-project", "workspace", "voiceover", "voiceover.wav"));
    const { sampleRate, channels, samples } = readPcm16Samples(wav);
    assert.equal(sampleRate, 1000);
    assert.equal(channels, 1);
    assert.equal(samples.length, 3300);
    assert.equal(samples[0], 0);
    assert.equal(samples[999], 0);
    assert.equal(samples[1000], 1111);
    assert.equal(samples[1499], 1111);
    assert.equal(samples[1500], 0);
    assert.equal(samples[2499], 0);
    assert.equal(samples[2500], 2222);
    assert.equal(samples[3299], 2222);

    const state = JSON.parse(
      await readFile(join("projects", "sample-project", "project-state.json"), "utf8"),
    );
    assert.equal(state.artifacts["voiceover-track"].relativePath, "workspace/voiceover/voiceover.wav");
  });
});

test("trims a segment that overlaps the next cue and reports a warning", async () => {
  await withTempCwd(async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nFirst line.\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line.\n";
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), srt, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav(Array(1500).fill(1111), 1000));
    await writeFile(join("input", "audio", "0002.wav"), makePcm16Wav(Array(500).fill(2222), 1000));

    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });
    const result = await renderVoiceoverTrack({ projectId: "sample-project" });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /0001\.wav overlaps cue 2/);
    assert.match(result.warnings[0], /trimmed 500ms/);

    const wav = await readFile(join("projects", "sample-project", "workspace", "voiceover", "voiceover.wav"));
    const { samples } = readPcm16Samples(wav);
    assert.equal(samples.length, 2500);
    assert.equal(samples[1999], 1111);
    assert.equal(samples[2000], 2222);
  });
});

test("keeps silence for cues without an audio segment and warns about them", async () => {
  await withTempCwd(async () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\nFirst line.\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line.\n";
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), srt, "utf8");
    await writeFile(join("input", "audio", "0002.wav"), makePcm16Wav(Array(300).fill(2222), 1000));

    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });
    const result = await renderVoiceoverTrack({ projectId: "sample-project" });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Cue 1 has no audio segment/);

    const wav = await readFile(join("projects", "sample-project", "workspace", "voiceover", "voiceover.wav"));
    const { samples } = readPcm16Samples(wav);
    assert.equal(samples.length, 2300);
    assert.equal(samples[0], 0);
    assert.equal(samples[1999], 0);
    assert.equal(samples[2000], 2222);
  });
});

test("encodes an m4a copy when an ffmpeg path is provided", async () => {
  await withTempCwd(async () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\nFirst line.\n";
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), srt, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav(Array(100).fill(1111), 1000));
    const fakeFfmpeg = await makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
await writeFile(process.argv.at(-1), "fake-m4a", "utf8");
`);

    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });
    const result = await renderVoiceoverTrack({
      projectId: "sample-project",
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });

    assert.equal(result.m4aRelativePath, "workspace/voiceover/voiceover.m4a");
    const encoded = await readFile(
      join("projects", "sample-project", "workspace", "voiceover", "voiceover.m4a"),
      "utf8",
    );
    assert.equal(encoded, "fake-m4a");
  });
});

test("keeps the wav and warns when the m4a encode fails", async () => {
  await withTempCwd(async () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\nFirst line.\n";
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), srt, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav(Array(100).fill(1111), 1000));
    const failingFfmpeg = await makeFakeExecutable(`process.exit(1);`);

    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });
    const result = await renderVoiceoverTrack({
      projectId: "sample-project",
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [failingFfmpeg],
    });

    assert.equal(result.m4aRelativePath, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /m4a encode failed/i);
    assert.equal(result.wavRelativePath, "workspace/voiceover/voiceover.wav");
  });
});

test("falls back to the project source subtitles when no srt path is given", async () => {
  await withTempCwd(async () => {
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "source.srt"), TIMING_SRT, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav([1000]));
    const { importSubtitle } = await import("../src/translation.ts");
    await importSubtitle("sample-project", join("input", "source.srt"));

    const result = await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
    });

    assert.equal(result.cueCount, 4);
    assert.equal(result.segmentCount, 1);
  });
});

test("rejects import when no srt path is given and the project has no source subtitles", async () => {
  await withTempCwd(async () => {
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav([1000]));

    await assert.rejects(
      importVoiceoverSegments({ projectId: "sample-project", folderPath: join("input", "audio") }),
      /source subtitles/i,
    );
  });
});

test("voiceover import route reads the folder from a local path", async () => {
  await withTempCwd(async () => {
    const { createStudioServer, startStudioServer } = await import("../src/server.ts");
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), TIMING_SRT, "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav([1000]));

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/voiceover/import`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          folderPath: join(process.cwd(), "input", "audio"),
          srtPath: join(process.cwd(), "input", "timing.srt"),
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.result.cueCount, 4);
      assert.equal(body.result.segmentCount, 1);
      assert.deepEqual(body.result.missingCues, [2, 3, 4]);
    } finally {
      await running.close();
    }
  });
});

test("voiceover render route starts a project job", async () => {
  await withTempCwd(async () => {
    const { createStudioServer, startStudioServer } = await import("../src/server.ts");
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await mkdir(join("input", "audio"), { recursive: true });
    await writeFile(join("input", "timing.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi.\n", "utf8");
    await writeFile(join("input", "audio", "0001.wav"), makePcm16Wav([1000], 1000));
    await importVoiceoverSegments({
      projectId: "sample-project",
      folderPath: join("input", "audio"),
      srtPath: join("input", "timing.srt"),
    });

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/voiceover/render`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });

      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.job.kind, "voiceover-render");

      // Wait for the background job to settle so cleanup does not race its writes.
      const jobFile = join("projects", "sample-project", "workspace", "jobs", `${body.job.id}.json`);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const record = JSON.parse(await readFile(jobFile, "utf8"));
          if (record.status !== "running") break;
        } catch {
          // The record file may not exist yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await running.close();
    }
  });
});
