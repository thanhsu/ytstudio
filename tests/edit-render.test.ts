import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEditManifest, type EditManifest } from "../src/edit-manifest.ts";
import { buildEditRenderArgs, renderEditedCut } from "../src/edit-render.ts";
import { makeFakeExecutable } from "./helpers.ts";

const srt =
  "1\n00:00:00,000 --> 00:00:03,000\nHe enters the village.\n\n" +
  "2\n00:00:03,000 --> 00:00:07,000\nA filler line nobody needs.\n\n" +
  "3\n00:00:07,000 --> 00:00:12,500\nThe training changes him.\n";

function sampleManifest(): EditManifest {
  return buildEditManifest({
    projectId: "sample-project",
    sourceVideoPath: "workspace/source/video.mp4",
    sourceSubtitlePath: "workspace/source/source.srt",
    sourceHash: "abc123",
    srt,
  });
}

function filterGraph(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

test("trims one video and audio pair per kept segment and concatenates them", () => {
  const manifest = sampleManifest();
  manifest.segments[1].keep = false;
  const graph = filterGraph(
    buildEditRenderArgs({ manifest, sourceVideoPath: "/src/video.mp4", outputPath: "/out/cut.mp4" }),
  );

  assert.equal(
    graph,
    "[0:v]trim=start=0:end=3,setpts=PTS-STARTPTS[v0];" +
      "[0:a]atrim=start=0:end=3,asetpts=PTS-STARTPTS[a0];" +
      "[0:v]trim=start=7:end=12.5,setpts=PTS-STARTPTS[v1];" +
      "[0:a]atrim=start=7:end=12.5,asetpts=PTS-STARTPTS[a1];" +
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
  );
});

test("keeps the source timestamps of dropped segments out of the filter graph", () => {
  const manifest = sampleManifest();
  manifest.segments[1].keep = false;
  const graph = filterGraph(
    buildEditRenderArgs({ manifest, sourceVideoPath: "/src/video.mp4", outputPath: "/out/cut.mp4" }),
  );
  assert.ok(!graph.includes("start=3:end=7"));
});

test("reads the source once and re-encodes the concatenated streams", () => {
  const args = buildEditRenderArgs({
    manifest: sampleManifest(),
    sourceVideoPath: "/src/video.mp4",
    outputPath: "/out/cut.mp4",
  });

  assert.deepEqual(args.filter((arg) => arg === "-i"), ["-i"]);
  assert.equal(args[args.indexOf("-i") + 1], "/src/video.mp4");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[v]", "-map", "[a]"]);
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.equal(args.at(-1), "/out/cut.mp4");
});

test("a single kept segment still produces a valid one-way concat", () => {
  const manifest = sampleManifest();
  manifest.segments[1].keep = false;
  manifest.segments[2].keep = false;
  const graph = filterGraph(
    buildEditRenderArgs({ manifest, sourceVideoPath: "/src/video.mp4", outputPath: "/out/cut.mp4" }),
  );
  assert.ok(graph.endsWith("[v0][a0]concat=n=1:v=1:a=1[v][a]"));
});

test("refuses a stream-copy manifest rather than cutting at the wrong frames", () => {
  const manifest: EditManifest = { ...sampleManifest(), cutMode: "stream-copy" };
  assert.throws(
    () => buildEditRenderArgs({ manifest, sourceVideoPath: "/src/video.mp4", outputPath: "/out/cut.mp4" }),
    /stream-copy/,
  );
});

test("records a render artifact describing the cut", async () => {
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-edit-render-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const fakeFfmpeg = await makeFakeExecutable(
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { dirname } from "node:path";',
        "const outputPath = process.argv.at(-1);",
        "await mkdir(dirname(outputPath), { recursive: true });",
        'await writeFile(outputPath, "video", "utf8");',
      ].join("\n"),
    );
    const manifest = sampleManifest();
    manifest.segments[1].keep = false;

    const artifact = await renderEditedCut({
      manifest,
      sourceVideoPath: join(root, "source.mp4"),
      outputPath: join(root, "sample-project", "renders", "cut.mp4"),
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });

    assert.equal(artifact.kind, "render");
    assert.equal(artifact.relativePath, "renders/cut.mp4");
    assert.equal(artifact.metadata.durationSeconds, 8.5);
    assert.equal(artifact.metadata.keptSegments, 2);
    assert.equal(artifact.metadata.droppedSegments, 1);
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
    const fakeFfmpeg = await makeFakeExecutable(
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { dirname } from "node:path";',
        "const outputPath = process.argv.at(-1);",
        "await mkdir(dirname(outputPath), { recursive: true });",
        'await writeFile(outputPath, "video", "utf8");',
      ].join("\n"),
    );
    const outputPath = join(root, "sample-project", "renders", "cut.mp4");
    const options = { sourceVideoPath: join(root, "source.mp4"), outputPath, ffmpegPath: process.execPath, ffmpegPrefixArgs: [fakeFfmpeg] };

    const everything = await renderEditedCut({ manifest: sampleManifest(), ...options });
    const trimmed = sampleManifest();
    trimmed.segments[1].keep = false;
    const fewer = await renderEditedCut({ manifest: trimmed, ...options });

    assert.notEqual(everything.sourceHash, fewer.sourceHash);
  } finally {
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
