import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EditManifest } from "../src/edit-manifest.ts";
import { buildCutSrt, buildEditRenderArgs, cutTimeline, renderEditedCut } from "../src/edit-render.ts";
import { makeFakeExecutable } from "./helpers.ts";

function sampleManifest(): EditManifest {
  return {
    version: 1,
    sourceRelativePath: "workspace/edit/source.srt",
    sourceHash: "abc123",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    segments: [
      { cueIndex: 1, start: "00:00:00,000", end: "00:00:03,000", text: "He enters the village.", decision: "keep" },
      { cueIndex: 2, start: "00:00:03,000", end: "00:00:07,000", text: "A filler line nobody needs.", decision: "keep" },
      { cueIndex: 3, start: "00:00:07,000", end: "00:00:12,500", text: "The training changes him.", decision: "keep" },
    ],
  };
}

function withoutSecondCue(): EditManifest {
  const manifest = sampleManifest();
  manifest.segments[1].decision = "remove";
  return manifest;
}

function filterGraph(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

function renderArgs(manifest: EditManifest): string[] {
  return buildEditRenderArgs({
    projectId: "sample-project",
    manifest,
    sourceVideoPath: "/src/video.mp4",
    outputPath: "/out/cut.mp4",
  });
}

test("closes the gap left by a removed cue when laying out the output timeline", () => {
  assert.deepEqual(
    cutTimeline(withoutSecondCue()).map((segment) => [
      segment.cueIndex,
      segment.sourceStartSeconds,
      segment.sourceEndSeconds,
      segment.outputStartSeconds,
      segment.outputEndSeconds,
    ]),
    [[1, 0, 3, 0, 3], [3, 7, 12.5, 3, 8.5]],
  );
});

test("realigns kept subtitles onto the cut, not onto the source", () => {
  assert.equal(
    buildCutSrt(withoutSecondCue()),
    "1\n00:00:00,000 --> 00:00:03,000\nHe enters the village.\n\n" +
      "2\n00:00:03,000 --> 00:00:08,500\nThe training changes him.\n",
  );
});

test("trims one video and audio pair per kept cue and concatenates them", () => {
  assert.equal(
    filterGraph(renderArgs(withoutSecondCue())),
    "[0:v]trim=start=0:end=3,setpts=PTS-STARTPTS[v0];" +
      "[0:a]atrim=start=0:end=3,asetpts=PTS-STARTPTS[a0];" +
      "[0:v]trim=start=7:end=12.5,setpts=PTS-STARTPTS[v1];" +
      "[0:a]atrim=start=7:end=12.5,asetpts=PTS-STARTPTS[a1];" +
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
  );
});

test("keeps the source range of a removed cue out of the filter graph", () => {
  assert.ok(!filterGraph(renderArgs(withoutSecondCue())).includes("start=3:end=7"));
});

test("reads the source once and re-encodes the concatenated streams", () => {
  const args = renderArgs(sampleManifest());
  assert.deepEqual(args.filter((arg) => arg === "-i"), ["-i"]);
  assert.equal(args[args.indexOf("-i") + 1], "/src/video.mp4");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[v]", "-map", "[a]"]);
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.equal(args.at(-1), "/out/cut.mp4");
});

test("a single kept cue still produces a valid one-way concat", () => {
  const manifest = sampleManifest();
  manifest.segments[1].decision = "remove";
  manifest.segments[2].decision = "remove";
  assert.ok(filterGraph(renderArgs(manifest)).endsWith("[v0][a0]concat=n=1:v=1:a=1[v][a]"));
});

test("refuses a manifest that removes every cue", () => {
  const manifest = sampleManifest();
  for (const segment of manifest.segments) segment.decision = "remove";
  assert.throws(() => renderArgs(manifest), /keeps no cues/);
});

test("refuses a cue whose timing was hand-edited into an impossible range", () => {
  const manifest = sampleManifest();
  manifest.segments[0].end = "00:00:00,000";
  assert.throws(() => renderArgs(manifest), /cue 1 ends before it starts/);
});

test("refuses cues whose source ranges overlap", () => {
  const manifest = sampleManifest();
  manifest.segments[1].start = "00:00:02,000";
  assert.throws(() => renderArgs(manifest), /cue 2 starts before cue 1 ends/);
});

async function fakeFfmpeg(): Promise<string> {
  return makeFakeExecutable(
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import { dirname } from "node:path";',
      "const outputPath = process.argv.at(-1);",
      "await mkdir(dirname(outputPath), { recursive: true });",
      'await writeFile(outputPath, "video", "utf8");',
    ].join("\n"),
  );
}

test("records a render artifact describing the cut", async () => {
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-edit-render-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const artifact = await renderEditedCut({
      projectId: "sample-project",
      manifest: withoutSecondCue(),
      sourceVideoPath: join(root, "source.mp4"),
      outputPath: join(root, "sample-project", "renders", "cut.mp4"),
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [await fakeFfmpeg()],
    });

    assert.equal(artifact.kind, "cut");
    assert.equal(artifact.relativePath, "renders/cut.mp4");
    assert.equal(artifact.metadata.durationSeconds, 8.5);
    assert.equal(artifact.metadata.keptCues, 2);
    assert.equal(artifact.metadata.removedCues, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-render after a different edit gets a different source hash", async () => {
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-edit-render-hash-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const shared = {
      projectId: "sample-project",
      sourceVideoPath: join(root, "source.mp4"),
      outputPath: join(root, "sample-project", "renders", "cut.mp4"),
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [await fakeFfmpeg()],
    };

    const everything = await renderEditedCut({ manifest: sampleManifest(), ...shared });
    const fewer = await renderEditedCut({ manifest: withoutSecondCue(), ...shared });

    assert.notEqual(everything.sourceHash, fewer.sourceHash);
  } finally {
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
