import { createHash } from "node:crypto";
import { assertValidProductionProject } from "./validate.ts";
import type {
  CaptionTrack,
  EditSegment,
  EditTimeline,
  NarrationTrack,
  ProductionAsset,
  ProductionFormat,
  ProductionProject,
  PublishMetadata,
} from "./types.ts";

export type ReviewProductionInput = {
  projectId: string;
  format: ProductionFormat;
  title: string;
  summary: string;
  scriptPath?: string;
  sourcePaths?: string[];
  scriptHash: string;
  narration?: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  timeline: EditTimeline;
  publish: PublishMetadata;
};

export type AudioStoryProductionInput = {
  projectId: string;
  format: ProductionFormat;
  title: string;
  logline: string;
  storyPath?: string;
  narration: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  segments: Array<Pick<EditSegment, "id" | "startSeconds" | "endSeconds" | "narrationText" | "assetId" | "fitMode" | "sourceStartSeconds" | "muteSourceAudio">>;
  durationSeconds: number;
  publish: PublishMetadata;
};

export function normalizeReviewProject(input: ReviewProductionInput): ProductionProject {
  const project: ProductionProject = {
    version: 1,
    projectId: input.projectId,
    workflowType: "review-recap",
    format: input.format,
    content: {
      title: input.title,
      summary: input.summary,
      sourceHash: input.scriptHash,
      ...(input.scriptPath ? { scriptPath: input.scriptPath } : {}),
      sourcePaths: [...(input.sourcePaths ?? [])],
    },
    narration: cloneOptionalTrack(input.narration),
    captions: cloneOptionalTrack(input.captions),
    assets: input.assets.map((asset) => ({ ...asset })),
    timeline: cloneTimeline(input.timeline),
    publish: clonePublishMetadata(input.publish),
  };
  assertValidProductionProject(project);
  return project;
}

export function normalizeAudioStoryProject(input: AudioStoryProductionInput): ProductionProject {
  const project: ProductionProject = {
    version: 1,
    projectId: input.projectId,
    workflowType: "audio-story",
    format: input.format,
    content: {
      title: input.title,
      summary: input.logline,
      sourceHash: hashAudioStoryInput(input),
      ...(input.storyPath ? { scriptPath: input.storyPath } : {}),
      sourcePaths: input.storyPath ? [input.storyPath] : [],
    },
    narration: { ...input.narration },
    captions: input.captions ? { ...input.captions } : undefined,
    assets: input.assets.map((asset) => ({ ...asset })),
    timeline: {
      version: 1,
      durationSeconds: input.durationSeconds,
      segments: input.segments.map((segment) => ({ ...segment })),
    },
    publish: clonePublishMetadata(input.publish),
  };
  assertValidProductionProject(project);
  return project;
}

function hashAudioStoryInput(input: AudioStoryProductionInput): string {
  const canonical = JSON.stringify({
    title: input.title,
    logline: input.logline,
    storyPath: input.storyPath ?? null,
    narrationSourceHash: input.narration.sourceHash,
    durationSeconds: input.durationSeconds,
    segments: input.segments.map((segment) => ({
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      narrationText: segment.narrationText ?? null,
      assetId: segment.assetId ?? null,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function cloneOptionalTrack<T extends NarrationTrack | CaptionTrack>(track: T | undefined): T | undefined {
  return track ? { ...track } : undefined;
}

function cloneTimeline(timeline: EditTimeline): EditTimeline {
  return { version: 1, durationSeconds: timeline.durationSeconds, segments: timeline.segments.map((segment) => ({ ...segment })) };
}

function clonePublishMetadata(publish: PublishMetadata): PublishMetadata {
  return { ...publish, tags: [...publish.tags] };
}
