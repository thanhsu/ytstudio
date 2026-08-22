import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyRemoveSelection,
  createEditManifest,
  exportEditManifest,
  parseCueSelection,
} from "../src/edit-manifest.ts";

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:01,200
First line

2
00:00:01,300 --> 00:00:03,000
Second, "quoted" line

3
00:00:03,100 --> 00:00:04,000
Third line
`;

test("parses cue numbers and inclusive ranges into a sorted unique selection", () => {
  assert.deepEqual(parseCueSelection("5, 1, 3-4, 3", 5), [1, 3, 4, 5]);
  assert.deepEqual(parseCueSelection("", 5), []);
});

test("rejects malformed, reversed, non-positive, and out-of-range selections", () => {
  assert.throws(() => parseCueSelection("1,x", 5), /Invalid cue selection token/);
  assert.throws(() => parseCueSelection("4-2", 5), /must not be reversed/);
  assert.throws(() => parseCueSelection("0", 5), /positive/);
  assert.throws(() => parseCueSelection("6", 5), /outside the available range/);
});

test("creates, updates, and exports a project edit manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-edit-manifest-"));
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  process.env.YT_STUDIO_PROJECTS_DIR = root;

  try {
    const subtitleDir = join(root, "sample-project", "workspace", "subtitles");
    await mkdir(subtitleDir, { recursive: true });
    await writeFile(join(subtitleDir, "source.srt"), SAMPLE_SRT, "utf8");

    const created = await createEditManifest("sample-project", "workspace/subtitles/source.srt");
    assert.equal(created.version, 1);
    assert.equal(created.sourceRelativePath, "workspace/subtitles/source.srt");
    assert.match(created.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(created.segments.map((segment) => segment.decision), ["keep", "keep", "keep"]);

    const updated = await applyRemoveSelection("sample-project", "2");
    assert.deepEqual(updated.segments.map((segment) => segment.decision), ["keep", "remove", "keep"]);

    const exported = await exportEditManifest("sample-project");
    assert.equal(exported.keptCueCount, 2);
    assert.equal(exported.removedCueCount, 1);
    assert.equal(exported.cleanSrtRelativePath, "workspace/edit/clean.srt");
    assert.equal(exported.csvRelativePath, "workspace/edit/segments.csv");

    const cleanSrt = await readFile(join(root, "sample-project", exported.cleanSrtRelativePath), "utf8");
    assert.equal(
      cleanSrt,
      `1
00:00:00,000 --> 00:00:01,200
First line

2
00:00:03,100 --> 00:00:04,000
Third line
`,
    );

    const csv = await readFile(join(root, "sample-project", exported.csvRelativePath), "utf8");
    assert.match(csv, /^cueIndex,start,end,decision,text\r?\n/);
    assert.match(csv, /2,"00:00:01,300","00:00:03,000",remove,"Second, ""quoted"" line"/);

    const persisted = JSON.parse(
      await readFile(join(root, "sample-project", "workspace", "edit", "segments.json"), "utf8"),
    );
    assert.equal(persisted.segments[1].decision, "remove");

    await assert.rejects(
      createEditManifest("sample-project", "workspace/subtitles/source.srt"),
      /already exists/i,
    );
    const preserved = JSON.parse(
      await readFile(join(root, "sample-project", "workspace", "edit", "segments.json"), "utf8"),
    );
    assert.equal(preserved.segments[1].decision, "remove");

    const replaced = await createEditManifest(
      "sample-project",
      "workspace/subtitles/source.srt",
      { replace: true },
    );
    assert.deepEqual(replaced.segments.map((segment) => segment.decision), ["keep", "keep", "keep"]);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.YT_STUDIO_PROJECTS_DIR;
    } else {
      process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    }
    await rm(root, { recursive: true, force: true });
  }
});
