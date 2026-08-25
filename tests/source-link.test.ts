import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importSourceIntoProject } from "../src/source-link.ts";
import { resolveSourcePath, saveCandidate, type SourceCandidate } from "../src/sources/store.ts";
import { createSampleProject, sampleCandidate, withSourcesRoot } from "./helpers.ts";

const SRT = "1\n00:00:00,000 --> 00:00:02,000\nXin chào.\n";

async function withProjectCwd(run: () => Promise<void>): Promise<void> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-source-link-"));
  try {
    process.chdir(root);
    await mkdir(join(root, "projects", "sample-project", "workspace", "media"), { recursive: true });
    await createSampleProject(join(root, "projects", "sample-project"));
    await run();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function seedDownloaded(
  id: string,
  media: NonNullable<SourceCandidate["media"]>,
  files: Record<string, string>,
): Promise<void> {
  await saveCandidate({ ...sampleCandidate(id), status: "downloaded", rights: "third-party-fair-use", media });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolveSourcePath(id, name), content, "utf8");
  }
}

test("a downloaded source lands in the project media stage together with its srt", async () => {
  await withProjectCwd(() => withSourcesRoot(async () => {
    await seedDownloaded(
      "youtube-abc",
      { videoRelativePath: "video.mp4", subtitleRelativePath: "video.en.srt", subtitleLanguage: "en", downloadedAt: "2026-08-25T00:00:00.000Z" },
      { "video.mp4": "video-bytes", "video.en.srt": SRT },
    );

    const result = await importSourceIntoProject("sample-project", "youtube-abc");

    assert.equal(result.media.relativePath, join("workspace", "media", "source.mp4"));
    assert.ok(result.subtitle);
    assert.equal(result.subtitle?.cueCount, 1);
  }));
});

test("an audio-only source is accepted as project media", async () => {
  await withProjectCwd(() => withSourcesRoot(async () => {
    await seedDownloaded(
      "youtube-abc",
      { videoRelativePath: "video.m4a", audioOnly: true, downloadedAt: "2026-08-25T00:00:00.000Z" },
      { "video.m4a": "audio-bytes" },
    );

    const result = await importSourceIntoProject("sample-project", "youtube-abc");

    assert.equal(result.media.relativePath, join("workspace", "media", "source.m4a"));
    assert.equal(result.subtitle, null);
  }));
});

test("a non-srt subtitle is skipped rather than failing the import", async () => {
  await withProjectCwd(() => withSourcesRoot(async () => {
    await seedDownloaded(
      "youtube-abc",
      { videoRelativePath: "video.mp4", subtitleRelativePath: "video.en.vtt", subtitleLanguage: "en", downloadedAt: "2026-08-25T00:00:00.000Z" },
      { "video.mp4": "video-bytes", "video.en.vtt": "WEBVTT\n" },
    );

    const result = await importSourceIntoProject("sample-project", "youtube-abc");

    assert.equal(result.subtitle, null);
    assert.equal(result.media.relativePath, join("workspace", "media", "source.mp4"));
  }));
});

test("a source that has not finished downloading is refused by name", async () => {
  await withProjectCwd(() => withSourcesRoot(async () => {
    await saveCandidate({ ...sampleCandidate("youtube-abc"), rights: "third-party-fair-use" });

    await assert.rejects(() => importSourceIntoProject("sample-project", "youtube-abc"), /youtube-abc/);
  }));
});
