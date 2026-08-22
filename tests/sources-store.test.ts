import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { projectsRoot, sourcesRoot } from "../src/fs.ts";
import {
  deriveSourceId,
  listCandidates,
  loadCandidate,
  resolveSourcePath,
  saveCandidate,
  validateSourceId,
} from "../src/sources/store.ts";
import { sampleCandidate, withSourcesRoot } from "./helpers.ts";

test("the sources root is a sibling of the projects root, never inside it", () => {
  assert.notEqual(sourcesRoot(), projectsRoot());
  assert.ok(!sourcesRoot().startsWith(projectsRoot()));
});

test("the sources root follows its own environment variable", async () => {
  await withSourcesRoot(async (root) => {
    assert.equal(sourcesRoot(), root);
  });
});

test("ids derive from the platform and its own video id", () => {
  assert.equal(deriveSourceId("Youtube", "dQw4w9WgXcQ"), "youtube-dqw4w9wgxcq");
  assert.equal(deriveSourceId("BiliBili", "BV1xx411c7XD"), "bilibili-bv1xx411c7xd");
});

test("a platform id that sanitises away still produces a usable id", () => {
  const id = deriveSourceId("Youtube", "!!!");
  assert.notEqual(id, "youtube-");
  assert.equal(validateSourceId(id), id);
  assert.equal(id, deriveSourceId("Youtube", "!!!"));
  assert.notEqual(id, deriveSourceId("Youtube", "???"));
});

test("an invalid source id is refused rather than normalised", () => {
  assert.throws(() => validateSourceId("../escape"), /Invalid source id/);
  assert.throws(() => validateSourceId(".trash"), /Invalid source id/);
  assert.throws(() => validateSourceId("ab"), /Invalid source id/);
});

test("source paths cannot escape the candidate directory", () => {
  assert.throws(() => resolveSourcePath("youtube-abc", "..", "..", "escape.txt"), /outside/);
});

test("candidates round-trip through the store", async () => {
  await withSourcesRoot(async () => {
    assert.equal(await loadCandidate("youtube-abc"), null);
    const candidate = sampleCandidate("youtube-abc");
    await saveCandidate(candidate);
    assert.deepEqual(await loadCandidate("youtube-abc"), candidate);
    assert.deepEqual((await listCandidates()).map((entry) => entry.id), ["youtube-abc"]);
  });
});

test("a directory without a readable candidate file is never listed", async () => {
  await withSourcesRoot(async (root) => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await mkdir(join(root, "youtube-orphan"), { recursive: true });
    await writeFile(join(root, "youtube-orphan", "video.mp4"), "not ours", "utf8");

    assert.deepEqual((await listCandidates()).map((entry) => entry.id), ["youtube-abc"]);
  });
});

test("a directory whose name is not a valid source id is ignored", async () => {
  await withSourcesRoot(async (root) => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await mkdir(join(root, ".trash"), { recursive: true });

    assert.deepEqual((await listCandidates()).map((entry) => entry.id), ["youtube-abc"]);
  });
});

test("listing an absent sources root is empty rather than an error", async () => {
  const previous = process.env.YT_STUDIO_SOURCES_DIR;
  process.env.YT_STUDIO_SOURCES_DIR = join(projectsRoot(), "..", "sources-that-do-not-exist");
  try {
    assert.deepEqual(await listCandidates(), []);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_SOURCES_DIR;
    else process.env.YT_STUDIO_SOURCES_DIR = previous;
  }
});
