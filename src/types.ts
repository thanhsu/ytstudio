export type VideoFormat = "shorts" | "longform";

export type VideoBrief = {
  id: string;
  topic: string;
  show: string;
  format: VideoFormat;
  audience: string;
  language: string;
  notes: string;
  createdAt: string;
};

export type ScenePlan = {
  projectId: string;
  scenes: Array<{
    label: string;
    durationSeconds: number;
    purpose: string;
    visualDirection: string;
  }>;
};

export type Metadata = {
  projectId: string;
  titles: string[];
  description: string;
  hashtags: string[];
  pinnedComment: string;
};

export type CopyrightCheckInput = {
  projectId: string;
  commentaryPercent: number;
  footagePercent: number;
  longestClipSeconds: number;
  usesFullScene: boolean;
  thumbnailFromCopyrightFrame: boolean;
  clipsHaveCommentaryPurpose: boolean;
};

export type CopyrightRisk = "low" | "medium" | "high" | "blocked";

export type CopyrightCheckResult = CopyrightCheckInput & {
  risk: CopyrightRisk;
  score: number;
  blocked: boolean;
  findings: string[];
  checkedAt: string;
};

export type ApprovalStage = "script" | "assets" | "copyright";

export type StageApproval = {
  sourceHash: string;
  approvedAt: string;
  note: string;
};

export type ArtifactKind = "media" | "audio" | "source-subtitles" | "voice" | "captions" | "render";

export type ArtifactRecord = {
  kind: ArtifactKind;
  sourceHash: string;
  relativePath: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
};

export type ProjectState = {
  version: 1;
  approvals: Partial<Record<ApprovalStage, StageApproval>>;
  artifacts: Partial<Record<ArtifactKind, ArtifactRecord>>;
};
