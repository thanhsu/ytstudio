import { copyFile, mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { resolveProjectPath } from "../project-paths.ts";
import { storyPath, storyRelativePath } from "./paths.ts";
import {
  approvalState,
  loadStory,
  readStageArtifact,
  saveStageRun,
  writeStageArtifact,
} from "./story-project.ts";
import type {
  ExportManifest,
  StoryMetadataArtifact,
  ThumbnailArtifact,
  TtsChunkManifest,
} from "./types.ts";

/**
 * READY_TO_PUBLISH is a folder the operator can upload from in two minutes:
 * the video, the thumbnail, and the title/description/tags as copy-paste text
 * files. Publishing itself stays manual in Phase 1 — this stage is always
 * human-triggered and gated on every approval, per the studio's approval rule.
 */

export class StoryApprovalRequiredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Export needs every approval in place first. Missing or stale: ${missing.join(", ")}. ` +
        "Review the story and approve script, media, and final render.",
    );
    this.name = "StoryApprovalRequiredError";
    this.missing = missing;
  }
}

export type RenderStageArtifact = {
  version: 1;
  videoPath: string;
  durationSeconds: number;
  width: number;
  height: number;
};

export async function exportStoryPackage(channelId: string, storyId: string): Promise<ExportManifest> {
  const story = await loadStory(channelId, storyId);
  const missing = (["script", "media", "final"] as const).filter(
    (stage) => approvalState(story, stage) !== "approved",
  );
  if (missing.length > 0) {
    throw new StoryApprovalRequiredError(missing);
  }

  const render = await readStageArtifact<RenderStageArtifact>(channelId, storyId, "render");
  const thumbnail = await readStageArtifact<ThumbnailArtifact>(channelId, storyId, "thumbnail");
  const metadata = await readStageArtifact<StoryMetadataArtifact>(channelId, storyId, "metadata");
  const ttsManifest = await readStageArtifact<TtsChunkManifest>(channelId, storyId, "tts");
  if (!render?.videoPath) throw new Error("Export needs a completed render (render.json is missing).");
  if (!thumbnail?.finalPath) throw new Error("Export needs a completed thumbnail (thumbnail.json is missing).");
  if (!metadata?.chosenTitle) throw new Error("Export needs completed metadata (metadata.json is missing).");

  const exportDir = storyPath(channelId, storyId, "workspace", "export");
  await mkdir(exportDir, { recursive: true });

  const manifest: ExportManifest = {
    version: 1,
    videoPath: storyRelativePath(storyId, "workspace", "export", "story.mp4"),
    thumbnailPath: storyRelativePath(storyId, "workspace", "export", "thumbnail.png"),
    titlePath: storyRelativePath(storyId, "workspace", "export", "title.txt"),
    descriptionPath: storyRelativePath(storyId, "workspace", "export", "description.txt"),
    tagsPath: storyRelativePath(storyId, "workspace", "export", "tags.txt"),
    srtPath: storyRelativePath(storyId, "workspace", "export", "captions.srt"),
    packagedAt: new Date().toISOString(),
  };

  await copyFile(resolveProjectPath(channelId, render.videoPath), resolveProjectPath(channelId, manifest.videoPath));
  await copyFile(
    resolveProjectPath(channelId, thumbnail.finalPath),
    resolveProjectPath(channelId, manifest.thumbnailPath),
  );
  if (ttsManifest?.captionsPath) {
    await copyFile(
      resolveProjectPath(channelId, ttsManifest.captionsPath),
      resolveProjectPath(channelId, manifest.srtPath),
    );
  }
  await writeFile(resolveProjectPath(channelId, manifest.titlePath), `${metadata.chosenTitle}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.descriptionPath), `${metadata.description}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.tagsPath), `${metadata.tags.join(", ")}\n`, "utf8");

  await writeStageArtifact(channelId, storyId, "export", manifest);
  await saveStageRun(channelId, storyId, "export", {
    status: "done",
    finishedAt: new Date().toISOString(),
  });
  return manifest;
}
