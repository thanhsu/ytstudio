import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCleanSrt,
  buildEditManifest,
  keptSegments,
  loadEditManifest,
  outputTimeline,
  parseEditManifest,
  saveEditManifest,
  validateEditManifest,
} from "../src/edit-manifest.ts";

const srt =
  "1\n00:00:00,000 --> 00:00:03,000\nHe enters the village.\n\n" +
  "2\n00:00:03,000 --> 00:00:07,000\nA filler line nobody needs.\n\n" +
  "3\n00:00:07,000 --> 00:00:12,500\nThe training changes him.\n";

function sampleManifest() {
  return buildEditManifest({
    projectId: "sample-project",
    sourceVideoPath: "workspace/source/video.mp4",
    sourceSubtitlePath: "workspace/source/source.srt",
    sourceHash: "abc123",
    srt,
  });
}

test("builds one segment per cue, keeping everything, timed against the source", () => {
  const manifest = sampleManifest();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.cutMode, "reencode");
  assert.deepEqual(manifest.segments.map((segment) => segment.id), ["cue-001", "cue-002", "cue-003"]);
  assert.ok(manifest.segments.every((segment) => segment.keep));
  assert.deepEqual(
    manifest.segments.map((segment) => [segment.sourceStartSeconds, segment.sourceEndSeconds]),
    [[0, 3], [3, 7], [7, 12.5]],
  );
  assert.equal(manifest.segments[1].text, "A filler line nobody needs.");
});

test("output timeline closes the gap left by a dropped segment", () => {
  const manifest = sampleManifest();
  manifest.segments[1].keep = false;
  assert.deepEqual(
    outputTimeline(manifest).map((segment) => [segment.id, segment.outputStartSeconds, segment.outputEndSeconds]),
    [["cue-001", 0, 3], ["cue-003", 3, 8.5]],
  );
  assert.deepEqual(keptSegments(manifest).map((segment) => segment.id), ["cue-001", "cue-003"]);
});

test("clean srt renumbers from one and shifts onto the output timeline", () => {
  const manifest = sampleManifest();
  manifest.segments[1].keep = false;
  assert.equal(
    buildCleanSrt(manifest),
    "1\n00:00:00,000 --> 00:00:03,000\nHe enters the village.\n\n" +
      "2\n00:00:03,000 --> 00:00:08,500\nThe training changes him.\n",
  );
});

test("rejects segments whose source ranges overlap", () => {
  const manifest = sampleManifest();
  manifest.segments[1].sourceStartSeconds = 2;
  const result = validateEditManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("cue-002 starts before cue-001 ends."));
});

test("rejects a segment that ends before it starts", () => {
  const manifest = sampleManifest();
  manifest.segments[0].sourceEndSeconds = 0;
  assert.ok(validateEditManifest(manifest).errors.includes("cue-001 ends before it starts."));
});

test("rejects a manifest that keeps nothing", () => {
  const manifest = sampleManifest();
  for (const segment of manifest.segments) segment.keep = false;
  assert.ok(validateEditManifest(manifest).errors.includes("Manifest keeps no segments."));
});

test("parse names the field that is missing", () => {
  const { sourceVideoPath, ...withoutVideo } = sampleManifest();
  assert.throws(() => parseEditManifest(withoutVideo), /sourceVideoPath/);
});

test("parse refuses a version it was not written for", () => {
  assert.throws(() => parseEditManifest({ ...sampleManifest(), version: 2 }), /version/);
});

test("parse refuses an unknown cut mode instead of silently defaulting", () => {
  assert.throws(() => parseEditManifest({ ...sampleManifest(), cutMode: "fast" }), /cutMode/);
});

test("parse refuses a manifest that would not survive validation", () => {
  const manifest = sampleManifest();
  for (const segment of manifest.segments) segment.keep = false;
  assert.throws(() => parseEditManifest(manifest), /keeps no segments/);
});

test("parse accepts a manifest that round-trips through JSON", () => {
  const manifest = sampleManifest();
  const parsed = parseEditManifest(JSON.parse(JSON.stringify(manifest)));
  assert.deepEqual(parsed, manifest);
});

test("saved manifests reload from the project workspace", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-studio-manifest-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    assert.equal(await loadEditManifest("sample-project"), null);
    const manifest = sampleManifest();
    await saveEditManifest("sample-project", manifest);
    assert.deepEqual(await loadEditManifest("sample-project"), manifest);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
