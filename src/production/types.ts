export type ProductionWorkflowType = "review-recap" | "audio-story" | "subtitle-render" | "licensed-source";
export type ProductionFormat = "shorts" | "longform";
export type ProductionAssetRole =
  | "source-clip"
  | "generated-background"
  | "story-image"
  | "cover"
  | "diagram"
  | "caption-card"
  | "music"
  | "logo";
export type ProductionMediaType = "image" | "video" | "audio";
export type RightsStatus = "owned" | "licensed" | "user-confirmed" | "generated" | "unknown";

export type ContentArtifact = {
  title: string;
  summary: string;
  sourceHash: string;
  scriptPath?: string;
  sourcePaths: string[];
};

export type NarrationTrack = {
  relativePath: string;
  format: "wav" | "mp3";
  durationSeconds: number;
  sourceHash: string;
};

export type CaptionTrack = {
  relativePath: string;
  format: "srt";
  cueCount: number;
  sourceHash: string;
};

export type ProductionAsset = {
  id: string;
  relativePath: string;
  mediaType: ProductionMediaType;
  role: ProductionAssetRole;
  durationSeconds?: number;
  sourceStartSeconds?: number;
  sourceHash: string;
  rightsStatus: RightsStatus;
  usagePurpose: string;
};

export type EditSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  narrationText?: string;
  assetId?: string;
  fitMode: "cover" | "contain";
  sourceStartSeconds?: number;
  muteSourceAudio: boolean;
};

export type EditTimeline = {
  version: 1;
  durationSeconds: number;
  segments: EditSegment[];
};

export type PublishMetadata = {
  title: string;
  description: string;
  tags: string[];
  language: string;
  thumbnailAssetId?: string;
};

export type ProductionProject = {
  version: 1;
  projectId: string;
  workflowType: ProductionWorkflowType;
  format: ProductionFormat;
  content: ContentArtifact;
  narration?: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  timeline: EditTimeline;
  publish: PublishMetadata;
};
