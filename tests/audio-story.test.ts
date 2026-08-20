import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkStoryContinuity,
  createStoryBible,
  exportAudioStoryPackage,
  generateStoryChapter,
  generateStoryOutline,
  loadAudioStoryWorkspace,
} from "../src/audio-story.ts";
import { saveBrandKit } from "../src/brand-kit.ts";
import { createSeriesProject } from "../src/series.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-audio-story-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function createAudioSeries(): Promise<void> {
  await createSeriesProject({
    id: "ai-story-channel",
    title: "AI Story Channel",
    show: "Original Cultivation Story",
    workflowType: "audio-story",
    audience: "English fantasy audio story listeners",
    language: "English",
  });
}

test("audio story workflow creates bible, outline, chapter, continuity report and export files", async () => {
  await withTempCwd(async () => {
    await createAudioSeries();

    const bible = await createStoryBible("ai-story-channel", {
      title: "Ashes Under the Moon Gate",
      genre: "cultivation fantasy",
      premise: "A courier discovers a forgotten sect under a border town.",
      tone: "cinematic, mysterious, serialized",
      audience: "English fantasy audio story listeners",
      language: "English",
      rules: ["No direct copying of known donghua or novels.", "Power growth must have a cost."],
      characters: [
        {
          name: "Lin Vale",
          role: "courier protagonist",
          traits: ["observant", "stubborn"],
          voiceNotes: "plainspoken but tense",
        },
      ],
      locations: ["Moon Gate Town", "Ash River"],
    });
    assert.equal(bible.title, "Ashes Under the Moon Gate");

    const outline = await generateStoryOutline("ai-story-channel", { chapterCount: 3, targetMinutesPerChapter: 12 });
    assert.equal(outline.chapters.length, 3);
    assert.match(outline.chapters[0].titleOptions[0], /Chapter 1/);

    const chapter = await generateStoryChapter("ai-story-channel", 1);
    assert.equal(chapter.chapterNumber, 1);
    assert.match(chapter.narration, /Lin Vale/);
    assert.equal(chapter.status, "draft");

    const report = await checkStoryContinuity("ai-story-channel", 1);
    assert.equal(report.chapterNumber, 1);
    assert.equal(report.blocked, false);
    await saveBrandKit("ai-story-channel", {
      channelName: "Arc Lantern Stories",
      thumbnailPreset: "audio-cover",
      primaryColor: "#f4c430",
    });

    const exported = await exportAudioStoryPackage("ai-story-channel");
    assert.match(exported.manuscriptPath, /audio-story\/exports\/manuscript\.md/);
    const metadata = await readFile(join("projects", "ai-story-channel", exported.youtubeMetadataPath), "utf8");
    assert.match(metadata, /Ashes Under the Moon Gate/);
    assert.match(metadata, /Arc Lantern Stories/);
    assert.match(metadata, /audio-cover/);

    const workspace = await loadAudioStoryWorkspace("ai-story-channel");
    assert.equal(workspace.outline?.chapters.length, 3);
    assert.equal(workspace.chapters.length, 1);
    assert.equal(workspace.outputs.manuscript, exported.manuscriptPath);
  });
});

test("audio story API exposes end-to-end story creation routes", async () => {
  await withTempCwd(async () => {
    await createAudioSeries();
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const headers = { "content-type": "application/json", origin: running.url };
      const bibleResponse = await fetch(`${running.url}/api/series/ai-story-channel/audio-story/bible`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Signal Lantern",
          genre: "urban fantasy",
          premise: "A night bus driver hears prophecies through broken station speakers.",
          tone: "slow-burn mystery",
          audience: "English audio story listeners",
          language: "English",
        }),
      });
      assert.equal(bibleResponse.status, 200);
      assert.equal((await bibleResponse.json()).bible.title, "Signal Lantern");

      const outlineResponse = await fetch(`${running.url}/api/series/ai-story-channel/audio-story/outline`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chapterCount: 2, targetMinutesPerChapter: 10 }),
      });
      assert.equal(outlineResponse.status, 200);
      assert.equal((await outlineResponse.json()).outline.chapters.length, 2);

      const chapterResponse = await fetch(`${running.url}/api/series/ai-story-channel/audio-story/chapters/1`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(chapterResponse.status, 200);
      assert.match((await chapterResponse.json()).chapter.narration, /night bus driver|Signal Lantern/);

      const continuityResponse = await fetch(
        `${running.url}/api/series/ai-story-channel/audio-story/chapters/1/continuity`,
        { method: "POST", headers, body: "{}" },
      );
      assert.equal(continuityResponse.status, 200);
      assert.equal((await continuityResponse.json()).report.blocked, false);

      const exportResponse = await fetch(`${running.url}/api/series/ai-story-channel/audio-story/export`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(exportResponse.status, 200);
      assert.match((await exportResponse.json()).exported.voiceOverSrtPath, /voice-over\.srt/);
    } finally {
      await running.close();
    }
  });
});
