import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadStoryChannel } from "../src/story-factory/channel.ts";
import { exportStoryPackage, StoryApprovalRequiredError } from "../src/story-factory/export.ts";
import { storyPath } from "../src/story-factory/paths.ts";
import {
  approveStoryStage,
  createStory,
  deriveStoryStatus,
  loadStory,
  saveStageRun,
  writeStageArtifact,
} from "../src/story-factory/story-project.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-export-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function writeStoryFile(relative: string, content: string): Promise<void> {
  const path = storyPath("es-horror", "story-001", ...relative.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function prepareCompletedStory(): Promise<void> {
  const channel = await loadStoryChannel("es-horror");
  await createStory(channel, { id: "story-001", title: "La habitación 307" });

  await writeStageArtifact("es-horror", "story-001", "naturalize", { version: 1, fullText: "guion" });
  await saveStageRun("es-horror", "story-001", "naturalize", { status: "done" });
  await writeStageArtifact("es-horror", "story-001", "images", { version: 1, images: [] });
  await saveStageRun("es-horror", "story-001", "images", { status: "done" });

  await writeStoryFile("workspace/render/story.mp4", "video-bytes");
  await writeStageArtifact("es-horror", "story-001", "render", {
    version: 1,
    videoPath: "stories/story-001/workspace/render/story.mp4",
    durationSeconds: 1500,
    width: 1920,
    height: 1080,
  });
  await saveStageRun("es-horror", "story-001", "render", { status: "done" });

  await writeStoryFile("workspace/thumbnail/thumbnail.png", "thumb-bytes");
  await writeStageArtifact("es-horror", "story-001", "thumbnail", {
    version: 1,
    backgroundPrompt: "p",
    backgroundPath: "stories/story-001/workspace/thumbnail/background.png",
    overlayText: "HABITACIÓN 307",
    finalPath: "stories/story-001/workspace/thumbnail/thumbnail.png",
  });

  await writeStageArtifact("es-horror", "story-001", "metadata", {
    version: 1,
    titles: [],
    chosenTitle: "La habitación 307 | Historia de terror",
    description: "Una historia original.\n\nEsta es una obra de ficción.",
    tags: ["terror", "historias de terror", "paranormal"],
    language: "es",
    provenance: { provider: "openai-compatible", model: "m", promptVersion: "v1", generatedAt: "t" },
  });

  await writeStoryFile("workspace/voice/narration-captions.srt", "1\n00:00:00,000 --> 00:00:04,000\nHola.\n");
  await writeStageArtifact("es-horror", "story-001", "tts", {
    version: 1,
    audioEncoding: "MP3",
    voiceName: "v",
    languageCode: "es-US",
    speakingRate: 0.95,
    pitch: 0,
    chunks: [],
    mergedPath: "stories/story-001/workspace/voice/narration.m4a",
    captionsPath: "stories/story-001/workspace/voice/narration-captions.srt",
    totalDurationSeconds: 1500,
    loudnormApplied: true,
  });
}

test("export refuses until every approval is in place, naming what is missing", async () => {
  await withTempCwd(async () => {
    await prepareCompletedStory();
    await assert.rejects(
      () => exportStoryPackage("es-horror", "story-001"),
      (error: unknown) => {
        assert.ok(error instanceof StoryApprovalRequiredError);
        assert.deepEqual(error.missing, ["script", "media", "final"]);
        return true;
      },
    );
  });
});

test("an approved story packages video, thumbnail, captions, and copy-paste metadata", async () => {
  await withTempCwd(async () => {
    await prepareCompletedStory();
    await approveStoryStage("es-horror", "story-001", "script");
    await approveStoryStage("es-horror", "story-001", "media");
    await approveStoryStage("es-horror", "story-001", "final");

    const manifest = await exportStoryPackage("es-horror", "story-001");

    const exportDir = storyPath("es-horror", "story-001", "workspace", "export");
    assert.equal(await readFile(join(exportDir, "story.mp4"), "utf8"), "video-bytes");
    assert.equal(await readFile(join(exportDir, "thumbnail.png"), "utf8"), "thumb-bytes");
    assert.match(await readFile(join(exportDir, "title.txt"), "utf8"), /La habitación 307/);
    assert.match(await readFile(join(exportDir, "description.txt"), "utf8"), /obra de ficción/);
    assert.match(await readFile(join(exportDir, "tags.txt"), "utf8"), /terror, historias de terror/);
    assert.match(await readFile(join(exportDir, "captions.srt"), "utf8"), /Hola\./);
    assert.match(manifest.videoPath, /workspace\/export\/story\.mp4$/);

    const story = await loadStory("es-horror", "story-001");
    assert.equal(story.stages.export?.status, "done");
    assert.equal(deriveStoryStatus(story), "READY_TO_PUBLISH");
  });
});
