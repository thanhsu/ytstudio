/**
 * Shared contracts for the AI Audio Story Factory. A story is a nested entity
 * under a channel (a series project): `projects/<channelId>/stories/<storyId>/`.
 * Each pipeline stage writes one JSON artifact beside `story.json`; generated
 * media lands under the story's `workspace/` folder, which is gitignored.
 */

export const STORY_STAGES = [
  "idea",
  "hook",
  "outline",
  "bible",
  "sections",
  "continuity-qa",
  "naturalize",
  "originality-qa",
  "tts-normalize",
  "tts",
  "scenes",
  "images",
  "bgm",
  "visual-prompts",
  "render",
  // Metadata precedes the thumbnail: the overlay text comes from metadata.
  "metadata",
  "thumbnail",
  "final-qa",
  "export",
  "publish",
] as const;

export type StoryStageId = (typeof STORY_STAGES)[number];

export function isStoryStageId(value: unknown): value is StoryStageId {
  return typeof value === "string" && (STORY_STAGES as readonly string[]).includes(value);
}

/**
 * Why a stage failed, so the operator knows the remedy without reading logs:
 * retryable → run it again; quota → wait or raise limits; provider → the model
 * or API returned something unusable; content → the material itself was refused
 * (safety block, QA fail); budget → the story hit its cost ceiling.
 */
export type StageErrorClassification = "retryable" | "provider" | "quota" | "content" | "budget";

export type StageRunStatus = "pending" | "running" | "done" | "failed" | "stale" | "awaiting-approval";

export type StageRun = {
  status: StageRunStatus;
  attemptCount: number;
  lastError?: { message: string; classification: StageErrorClassification };
  costUsd: number;
  startedAt?: string;
  finishedAt?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  /** sha256 of the stage's artifact file content — the approval/staleness anchor. */
  artifactHash?: string;
};

export type StoryApprovalStage = "script" | "media" | "final";

export type StoryApproval = {
  artifactHash: string;
  approvedAt: string;
  note: string;
};

export type TtsQualityTier = "economy" | "standard" | "premium";

export type StoryTtsProfile = {
  provider: "google";
  tier: TtsQualityTier;
  /** A concrete Google voice name, e.g. "es-US-Neural2-B". */
  voiceName: string;
  /** The voice's locale, which may differ from the channel locale (Google has no es-MX Neural2). */
  languageCode: string;
  speakingRate: number;
  pitch: number;
};

export type VisualStyleProfile = {
  stylePrompt: string;
  negativePrompt: string;
  imageIntervalSeconds: number;
  aspectRatio: "16:9";
};

export type StoryMode = "manual" | "assisted";

export type StoryBudget = { maxCostPerStoryUsd: number; maxCostPerMonthUsd?: number };

/** Snapshot of channel settings taken when the story is created, then editable per story. */
export type StoryProjectConfig = {
  language: string;
  locale: string;
  niche: string;
  subNiche: string;
  targetDurationMinutes: number;
  tone: string;
  mode: StoryMode;
  ttsProfile: StoryTtsProfile;
  visualStyleProfile: VisualStyleProfile;
  budget: StoryBudget;
};

export type StoryProject = {
  version: 1;
  id: string;
  channelId: string;
  title: string;
  config: StoryProjectConfig;
  stages: Partial<Record<StoryStageId, StageRun>>;
  approvals: Partial<Record<StoryApprovalStage, StoryApproval>>;
  createdAt: string;
  updatedAt: string;
};

export type StoryStatus =
  | "DRAFT"
  | "IN_PROGRESS"
  | "GENERATING"
  | "AWAITING_APPROVAL"
  | "FAILED"
  | "BUDGET_PAUSED"
  | "READY_TO_PUBLISH"
  | "PUBLISHED";

export type StoryChannelConfig = {
  version: 1;
  channelId: string;
  enabled: boolean;
  language: string;
  locale: string;
  niche: string;
  subNiches: string[];
  /** Free-text channel voice/style notes injected into every prompt. */
  promptStyle: string;
  defaultTargetDurationMinutes: number;
  mode: StoryMode;
  ttsProfile: StoryTtsProfile;
  visualStyleProfile: VisualStyleProfile;
  bgm: {
    ambienceTrackPath: string;
    volumeDb: number;
    sfx: {
      /** Stinger played at every scene boundary, timed against the scaled render. */
      sceneChange: { path: string; volumeDb: number } | null;
      /** Fixed cues at absolute story timestamps (e.g. an intro sting at 0). */
      events: Array<{ path: string; atSeconds: number; volumeDb: number }>;
    };
  };
  /** Applied at TTS-normalization time only; the stored script is never altered. */
  pronunciations: Array<{ original: string; pronunciation: string }>;
  budget: StoryBudget;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Stage artifacts. Every AI-produced artifact carries provenance so the file
// describes what generated it, not the configuration in force today.
// ---------------------------------------------------------------------------

export type Provenance = {
  provider: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
};

export type IdeaArtifact = {
  version: 1;
  logline: string;
  premise: string;
  themes: string[];
  whyItWorks: string;
  duplicateCheck: {
    checkedAgainst: number;
    nearest: Array<{ storyId: string; similarity: number }>;
    flagged: boolean;
  };
  provenance: Provenance;
};

export type HookArtifact = {
  version: 1;
  hookText: string;
  altHooks: string[];
  estimatedSeconds: number;
  provenance: Provenance;
};

export type OutlineSection = {
  index: number;
  title: string;
  goal: string;
  beats: string[];
  targetWords: number;
};

export type OutlineArtifact = {
  version: 1;
  sections: OutlineSection[];
  provenance: Provenance;
};

export type BibleCharacter = {
  name: string;
  role: string;
  description: string;
  arc: string;
};

export type BibleLocation = {
  name: string;
  description: string;
};

export type BibleArtifact = {
  version: 1;
  setting: string;
  characters: BibleCharacter[];
  timeline: string[];
  locations: BibleLocation[];
  supernaturalRules: string[];
  knownFacts: string[];
  openQuestions: string[];
  endingConstraints: string[];
  provenance: Provenance;
};

/** Array fields a section may append to; the bible is patched after each section. */
export type BibleUpdates = {
  timeline?: string[];
  knownFacts?: string[];
  openQuestions?: string[];
  supernaturalRules?: string[];
};

export type SectionArtifact = {
  version: 1;
  index: number;
  title: string;
  text: string;
  wordCount: number;
  bibleUpdates: BibleUpdates;
  provenance: Provenance;
};

export type ScriptArtifact = {
  version: 1;
  fullText: string;
  sections: Array<{ index: number; textHash: string }>;
  wordCount: number;
  /** sha256 of fullText — the anchor the script approval binds to. */
  sourceHash: string;
};

export type ContinuityIssue = {
  severity: "minor" | "major";
  sectionIndex: number;
  description: string;
  suggestion: string;
};

export type ContinuityReport = {
  version: 1;
  issues: ContinuityIssue[];
  pass: boolean;
  provenance: Provenance;
};

export type NaturalizedScript = {
  version: 1;
  fullText: string;
  changes: Array<{ sectionIndex: number; note: string }>;
  locale: string;
  provenance: Provenance;
};

export type OriginalityReport = {
  version: 1;
  score: number;
  similarity: Array<{ storyId: string; jaccard: number }>;
  safetyIssues: string[];
  publishable: boolean;
  provenance: Provenance;
};

export type TtsNormalizedText = {
  version: 1;
  text: string;
  appliedPronunciations: number;
  normalizations: string[];
};

export type TtsChunkStatus = "pending" | "done" | "failed";

export type TtsChunk = {
  index: number;
  text: string;
  chars: number;
  cacheKey: string;
  relativePath: string;
  durationSeconds: number;
  status: TtsChunkStatus;
  attemptCount: number;
  lastError?: string;
};

export type TtsChunkManifest = {
  version: 1;
  audioEncoding: "MP3" | "LINEAR16";
  voiceName: string;
  languageCode: string;
  speakingRate: number;
  pitch: number;
  chunks: TtsChunk[];
  mergedPath: string;
  captionsPath: string;
  totalDurationSeconds: number;
  loudnormApplied: boolean;
};

export type StoryScene = {
  sceneId: string;
  startSeconds: number;
  endSeconds: number;
  summary: string;
  imagePrompt: string;
  continuityRefs: string[];
};

export type SceneList = {
  version: 1;
  scenes: StoryScene[];
  provenance: Provenance;
};

export type SceneImageStatus = "pending" | "done" | "failed";

export type SceneImage = {
  sceneId: string;
  prompt: string;
  relativePath: string;
  status: SceneImageStatus;
  attemptCount: number;
  lastError?: string;
  costUsd: number;
};

export type ImageManifest = {
  version: 1;
  provider: string;
  model: string;
  images: SceneImage[];
};

export type BgmPlan = {
  version: 1;
  tracks: Array<{ path: string; startSeconds: number; volumeDb: number; loop: boolean }>;
  /** Scene-change stinger config, copied verbatim from the channel; the render stage expands it into `events`. */
  sceneChangeSfx: { path: string; volumeDb: number } | null;
  /** Concrete SFX cues to mix in, at absolute (already-scaled) story seconds. */
  events: Array<{ path: string; atSeconds: number; volumeDb: number }>;
};

export type VisualPromptMood = "calm" | "tense" | "mysterious" | "reveal" | "action";

export type VisualPromptMotion = "slow-push" | "slow-pull" | "drift-left" | "drift-right" | "hold";

export type VisualPromptCue = {
  sceneId: string;
  startSeconds: number;
  endSeconds: number;
  narrationExcerpt: string;
  visualPrompt: string;
  mood: VisualPromptMood;
  captionEmphasis: string[];
  motion: VisualPromptMotion;
  overlayText: string;
};

export type VisualPromptArtifact = {
  version: 1;
  sourceHash: string;
  cues: VisualPromptCue[];
};

export type ThumbnailArtifact = {
  version: 1;
  backgroundPrompt: string;
  backgroundPath: string;
  overlayText: string;
  finalPath: string;
};

export type MetadataTitle = {
  title: string;
  score: number;
  rationale: string;
};

export type StoryMetadataArtifact = {
  version: 1;
  titles: MetadataTitle[];
  chosenTitle: string;
  description: string;
  tags: string[];
  /** 2-5 words drawn onto the thumbnail by the app, never by the image model. */
  thumbnailText: string;
  /** A one-line visual concept for the thumbnail background. */
  thumbnailConcept: string;
  language: string;
  provenance: Provenance;
};

export type FinalQaCheck = {
  id: string;
  pass: boolean;
  note: string;
};

export type FinalQaReport = {
  version: 1;
  checks: FinalQaCheck[];
  pass: boolean;
};

export type ExportManifest = {
  version: 1;
  videoPath: string;
  thumbnailPath: string;
  titlePath: string;
  descriptionPath: string;
  tagsPath: string;
  srtPath: string;
  packagedAt: string;
};

export type PublishArtifact = {
  version: 1;
  videoId: string;
  uploadedAt: string;
  privacyStatus: "private" | "unlisted" | "public";
  publishAt?: string;
  thumbnailSet: boolean;
  title: string;
};

export type StoryFingerprints = {
  version: 1;
  storyId: string;
  title: string;
  logline: string;
  ideaSignature: number[];
  scriptSignature?: number[];
};

export type ChannelFingerprintIndex = {
  version: 1;
  entries: StoryFingerprints[];
};

export type StoryCost = {
  version: 1;
  llmUsd: number;
  ttsUsd: number;
  imageUsd: number;
  totalUsd: number;
  updatedAt: string;
};

export type ChannelCosts = {
  version: 1;
  totalUsd: number;
  byKind: { llm: number; tts: number; image: number };
  byStory: Record<string, number>;
  byMonth: Record<string, number>;
  updatedAt: string;
};

export type AiLogEntry = {
  at: string;
  stage: StoryStageId;
  promptName: string;
  promptVersion: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error?: string;
};
