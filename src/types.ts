export type VideoFormat = "shorts" | "longform";

export type WorkflowType = "review-recap" | "audio-story" | "subtitle-render" | "licensed-source";

export type VideoBrief = {
  id: string;
  topic: string;
  show: string;
  format: VideoFormat;
  workflowType?: WorkflowType;
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

/**
 * What actually produced the script on disk. Persisted so the studio can never
 * describe an existing script by whatever provider happens to be configured now.
 */
export type ScriptGenerator = {
  provider: string;
  model: string;
};

export type Metadata = {
  projectId: string;
  titles: string[];
  description: string;
  hashtags: string[];
  pinnedComment: string;
  // Absent on metadata.json written before provenance was recorded.
  generator?: ScriptGenerator;
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
