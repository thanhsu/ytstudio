import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJson } from "../fs.ts";
import { sha256 } from "../project-state.ts";
import { validateProjectId } from "../project-paths.ts";
import { normalizeMode, normalizeTtsProfile, normalizeVisualStyle } from "./channel.ts";
import { storiesRootPath, storyPath, validateStoryId } from "./paths.ts";
import type {
  CanonRef,
  StageRun,
  StageRunStatus,
  StoryApprovalStage,
  StoryChannelConfig,
  StoryKind,
  StoryProject,
  StoryProjectConfig,
  StoryStageId,
  StoryStatus,
} from "./types.ts";
import { STORY_APPROVAL_STAGES, STORY_STAGES, allStagesForKind, stagesForKind } from "./types.ts";

/**
 * The story entity: `projects/<channelId>/stories/<storyId>/story.json` plus
 * one JSON artifact per stage beside it. story.json stores per-stage StageRun
 * records; the coarse dashboard status is derived from them on every read and
 * never stored, so a crashed process can never leave a stale label behind.
 */

const STORY_FILE = "story.json";

/**
 * stage → its direct dependencies. Invalidation walks this graph forward:
 * editing a stage's artifact marks every transitive dependent stale. Media
 * caches (TTS chunks by text hash, images by file presence) make re-running a
 * stale stage cheap when its actual inputs did not change.
 */
export const STAGE_DEPS: Record<StoryStageId, StoryStageId[]> = {
  idea: [],
  hook: ["idea"],
  outline: ["hook"],
  bible: ["outline"],
  sections: ["bible"],
  "continuity-qa": ["sections"],
  naturalize: ["continuity-qa"],
  "originality-qa": ["naturalize"],
  "tts-normalize": ["naturalize"],
  tts: ["tts-normalize"],
  scenes: ["sections"],
  images: ["scenes"],
  bgm: ["tts"],
  "visual-prompts": ["naturalize", "tts", "scenes"],
  render: ["tts", "images", "bgm", "visual-prompts"],
  metadata: ["sections"],
  // Only the drawtext overlay depends on metadata; the stage reuses an existing
  // background image, so a metadata edit re-runs the cheap overlay pass only.
  thumbnail: ["metadata"],
  "final-qa": ["render", "metadata", "thumbnail"],
  export: ["final-qa"],
  publish: ["export"],

  // Canon chapter stages. `chapter-plan` has no stage dependency because its
  // input is a series entity (the arc's chapter card), not another stage —
  // the same reason `idea` has none.
  "chapter-plan": [],
  "canon-context": ["chapter-plan"],
  "canon-write": ["canon-context"],
  "canon-continuity": ["canon-write"],
  "memory-extract": ["canon-continuity"],
  "memory-apply": ["memory-extract"],

  // Variant stages. `localize` reads the canon chapter, an entity outside this
  // story, so it has no stage dependency either. It writes the `sections`
  // artifacts, which is what lets naturalize/scenes/metadata run unchanged.
  localize: [],
  // Alignment checks the naturalized narration — the text TTS actually reads —
  // so a naturalizer rewrite can never smuggle a canon contradiction past it.
  "canon-alignment": ["naturalize"],
};

/** The artifact file each stage writes; the sections stage also writes sections/section-NNN.json. */
export const STAGE_ARTIFACT_FILES: Record<StoryStageId, string> = {
  idea: "idea.json",
  hook: "hook.json",
  outline: "outline.json",
  bible: "bible.json",
  sections: "script.json",
  "continuity-qa": "continuity-report.json",
  naturalize: "naturalized.json",
  "originality-qa": "originality-report.json",
  "tts-normalize": "tts-normalized.json",
  tts: "tts-chunks.json",
  scenes: "scenes.json",
  images: "images.json",
  bgm: "bgm.json",
  "visual-prompts": "visual-prompts.json",
  render: "render.json",
  thumbnail: "thumbnail.json",
  metadata: "metadata.json",
  "final-qa": "final-qa.json",
  export: "export.json",
  publish: "publish.json",

  "chapter-plan": "plan.json",
  "canon-context": "context.json",
  // canon-write also writes sections/section-NNN.json and script.json, so the
  // existing scenes/metadata stages read a canon chapter exactly as they read
  // an original story.
  "canon-write": "chapter.json",
  // Deliberately not "continuity-report.json": no story runs both this and
  // continuity-qa, but sharing a filename would make an artifact's owner
  // ambiguous to anyone reading the directory.
  "canon-continuity": "canon-continuity.json",
  "memory-extract": "memory-delta.json",
  "memory-apply": "memory.json",

  localize: "localized.json",
  "canon-alignment": "canon-alignment.json",
};

export type CreateStoryInput = {
  id: string;
  title: string;
  niche?: string;
  subNiche?: string;
  targetDurationMinutes?: number;
  tone?: string;
  mode?: string;
  /** Omitted for the standalone stories the factory has always produced. */
  kind?: StoryKind;
  /** Supplied when creating a localized variant of a canon chapter. */
  canonRef?: CanonRef;
};

export type UpdateStoryInput = {
  title?: string;
  subNiche?: string;
  targetDurationMinutes?: number;
  tone?: string;
  mode?: string;
  maxCostPerStoryUsd?: number;
};

export async function createStory(
  channel: StoryChannelConfig,
  input: CreateStoryInput,
): Promise<StoryProject> {
  const channelId = validateProjectId(channel.channelId);
  const storyId = validateStoryId(input.id);
  const path = storyPath(channelId, storyId, STORY_FILE);
  if (await exists(path)) {
    throw new Error(`Story ${storyId} already exists on channel ${channelId}.`);
  }
  const now = new Date().toISOString();
  const story: StoryProject = {
    version: 1,
    id: storyId,
    channelId,
    title: required(input.title, "title"),
    kind: resolveStoryKind(input.kind, input.canonRef),
    ...(input.canonRef ? { canonRef: normalizeCanonRef(input.canonRef) } : {}),
    config: snapshotConfig(channel, input),
    stages: {},
    approvals: {},
    createdAt: now,
    updatedAt: now,
  };
  await saveStory(story);
  return story;
}

export async function loadStory(channelId: string, storyId: string): Promise<StoryProject> {
  const raw = await readFile(storyPath(channelId, storyId, STORY_FILE), "utf8");
  return normalizeStory(channelId, storyId, JSON.parse(raw));
}

export async function listStories(channelId: string): Promise<StoryProject[]> {
  let entries: string[] = [];
  try {
    entries = (await readdir(storiesRootPath(channelId), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const stories: StoryProject[] = [];
  for (const id of entries.sort()) {
    try {
      stories.push(await loadStory(channelId, id));
    } catch {
      // A folder without a readable story.json is not a story; never claim it.
    }
  }
  return stories;
}

export async function updateStory(
  channelId: string,
  storyId: string,
  updates: UpdateStoryInput,
): Promise<StoryProject> {
  const story = await loadStory(channelId, storyId);
  // These fields steer future generation or the dashboard only. None of them is
  // an input to an existing artifact, so an edit here never invalidates media.
  if (updates.title !== undefined) story.title = required(updates.title, "title");
  if (updates.subNiche !== undefined) story.config.subNiche = String(updates.subNiche).trim();
  if (updates.targetDurationMinutes !== undefined) {
    story.config.targetDurationMinutes = boundedMinutes(updates.targetDurationMinutes);
  }
  if (updates.tone !== undefined) story.config.tone = String(updates.tone).trim();
  if (updates.mode !== undefined) story.config.mode = normalizeMode(updates.mode);
  if (updates.maxCostPerStoryUsd !== undefined) {
    story.config.budget.maxCostPerStoryUsd = boundedBudget(updates.maxCostPerStoryUsd);
  }
  story.updatedAt = new Date().toISOString();
  await saveStory(story);
  return story;
}

export async function saveStory(story: StoryProject): Promise<void> {
  const path = storyPath(story.channelId, story.id, STORY_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, normalizeStory(story.channelId, story.id, story));
}

export async function saveStageRun(
  channelId: string,
  storyId: string,
  stage: StoryStageId,
  run: Partial<StageRun>,
): Promise<StoryProject> {
  const story = await loadStory(channelId, storyId);
  const current = story.stages[stage] ?? emptyStageRun();
  story.stages[stage] = normalizeStageRun({ ...current, ...run });
  story.updatedAt = new Date().toISOString();
  await saveStory(story);
  return story;
}

/**
 * Write a stage's JSON artifact and record its hash on the StageRun in one
 * step, so the hash on the story always describes the file actually on disk.
 */
export async function writeStageArtifact(
  channelId: string,
  storyId: string,
  stage: StoryStageId,
  value: unknown,
): Promise<{ story: StoryProject; artifactHash: string }> {
  const path = storyPath(channelId, storyId, STAGE_ARTIFACT_FILES[stage]);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, value);
  const artifactHash = sha256(JSON.stringify(value));
  const story = await saveStageRun(channelId, storyId, stage, { artifactHash });
  return { story, artifactHash };
}

export async function readStageArtifact<T>(
  channelId: string,
  storyId: string,
  stage: StoryStageId,
): Promise<T | null> {
  try {
    const raw = await readFile(storyPath(channelId, storyId, STAGE_ARTIFACT_FILES[stage]), "utf8");
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Mark every transitive dependent of a stage stale. Returns the stage ids that
 * changed. Stages that never ran stay pending; a running stage is left alone
 * (the running job re-reads its inputs anyway).
 */
export function invalidateDependents(story: StoryProject, changed: StoryStageId): StoryStageId[] {
  // Only stages that exist for this story's kind may be invalidated. Without
  // the filter, editing a variant's localized section would mark
  // `continuity-qa` stale through STAGE_DEPS — a stage a variant never runs, so
  // nothing could ever clear it and deriveStoryStatus would pin the variant at
  // IN_PROGRESS forever. Note this is the ALL-stages set, not the runnable one:
  // export and publish are human-only but absolutely can go stale.
  const ownStages = new Set(allStagesForKind(story.kind));
  const dependentsOf = new Map<StoryStageId, StoryStageId[]>();
  for (const stage of STORY_STAGES) {
    if (!ownStages.has(stage)) continue;
    for (const dep of STAGE_DEPS[stage]) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(stage);
      dependentsOf.set(dep, list);
    }
  }
  const invalidated: StoryStageId[] = [];
  const queue: StoryStageId[] = [...(dependentsOf.get(changed) ?? [])];
  const seen = new Set<StoryStageId>();
  while (queue.length > 0) {
    const stage = queue.shift() as StoryStageId;
    if (seen.has(stage)) continue;
    seen.add(stage);
    queue.push(...(dependentsOf.get(stage) ?? []));
    const run = story.stages[stage];
    if (!run || run.status === "pending" || run.status === "running" || run.status === "stale") continue;
    story.stages[stage] = { ...run, status: "stale" };
    invalidated.push(stage);
  }
  return invalidated;
}

/** Coarse dashboard status, derived on every read and never stored. */
export function deriveStoryStatus(story: StoryProject): StoryStatus {
  const runs = Object.values(story.stages).filter((run): run is StageRun => Boolean(run));
  if (runs.some((run) => run.status === "running")) return "GENERATING";
  if (runs.some((run) => run.status === "awaiting-approval")) return "AWAITING_APPROVAL";
  if (runs.some((run) => run.status === "failed" && run.lastError?.classification === "budget")) {
    return "BUDGET_PAUSED";
  }
  if (runs.some((run) => run.status === "failed")) return "FAILED";
  if (story.stages.publish?.status === "done") return "PUBLISHED";
  if (story.stages.export?.status === "done") return "READY_TO_PUBLISH";
  if (runs.some((run) => run.status === "done" || run.status === "stale")) return "IN_PROGRESS";
  return "DRAFT";
}

/**
 * Record an approval bound to the hash of what was approved. The hash is the
 * anchor stage's artifactHash, so editing that artifact makes the approval
 * stale by mismatch — nothing has to remember to revoke it.
 */
export const APPROVAL_ANCHOR_STAGE: Record<StoryApprovalStage, StoryStageId> = {
  script: "naturalize",
  media: "images",
  final: "render",
  // Anchoring canon approval to the chapter artifact gives the composite
  // behaviour for free: regenerating the plan invalidates canon-context and
  // canon-write through STAGE_DEPS, which drops canon-write out of `done` and
  // makes approvalState report `stale` without any extra hashing.
  canon: "canon-write",
};

export async function approveStoryStage(
  channelId: string,
  storyId: string,
  approval: StoryApprovalStage,
  note = "",
): Promise<StoryProject> {
  const story = await loadStory(channelId, storyId);
  const anchor = story.stages[APPROVAL_ANCHOR_STAGE[approval]];
  if (!anchor?.artifactHash || anchor.status !== "done") {
    throw new Error(`Cannot approve ${approval}: the ${APPROVAL_ANCHOR_STAGE[approval]} stage has no completed artifact.`);
  }
  story.approvals[approval] = {
    artifactHash: anchor.artifactHash,
    approvedAt: new Date().toISOString(),
    note: String(note ?? "").trim(),
  };
  story.updatedAt = new Date().toISOString();
  await saveStory(story);
  return story;
}

export type ApprovalState = "missing" | "approved" | "stale";

export function approvalState(story: StoryProject, approval: StoryApprovalStage): ApprovalState {
  const record = story.approvals[approval];
  if (!record) return "missing";
  const anchor = story.stages[APPROVAL_ANCHOR_STAGE[approval]];
  if (!anchor?.artifactHash || anchor.artifactHash !== record.artifactHash || anchor.status !== "done") {
    return "stale";
  }
  return "approved";
}

export function emptyStageRun(): StageRun {
  return { status: "pending", attemptCount: 0, costUsd: 0 };
}

/** The ordered stage list this particular story runs. */
export function pipelineStagesFor(story: StoryProject): StoryStageId[] {
  return stagesForKind(story.kind);
}

/**
 * `kind` is derived from the canonRef, not trusted from disk. A variant whose
 * canonRef was lost would otherwise read back as an `original`, and the next
 * pipeline run would generate a brand-new English story over the top of it.
 * A stored kind is honoured only where it cannot contradict the ref.
 */
export function resolveStoryKind(stored: unknown, canonRef: CanonRef | undefined): StoryKind {
  if (canonRef) return "variant";
  return stored === "canon" ? "canon" : "original";
}

export function normalizeCanonRef(value: CanonRef): CanonRef {
  return {
    seriesId: validateProjectId(value.seriesId),
    chapterId: validateStoryId(value.chapterId),
    chapterNumber: boundedCount(value.chapterNumber),
    canonTextHash: String(value.canonTextHash ?? "").trim(),
  };
}

/** Reads a canonRef off disk, returning undefined for anything unusable. */
function readCanonRef(value: unknown): CanonRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CanonRef>;
  if (typeof candidate.seriesId !== "string" || typeof candidate.chapterId !== "string") {
    return undefined;
  }
  try {
    return normalizeCanonRef(candidate as CanonRef);
  } catch {
    // A ref naming an invalid project or story id is not a ref. Returning
    // undefined makes the story an `original`, which callers must catch — the
    // variant pipeline refuses to run without a resolvable canon chapter.
    return undefined;
  }
}

/** True when a variant's localization is out of date with its canon chapter. */
export type CanonLinkState = "fresh" | "stale" | "unlinked";

export function canonState(story: StoryProject, canonTextHash: string | null): CanonLinkState {
  if (!story.canonRef) return "unlinked";
  if (!canonTextHash || !story.canonRef.canonTextHash) return "stale";
  return story.canonRef.canonTextHash === canonTextHash ? "fresh" : "stale";
}

function snapshotConfig(channel: StoryChannelConfig, input: CreateStoryInput): StoryProjectConfig {
  return {
    language: channel.language,
    locale: channel.locale,
    niche: stringOr(input.niche, channel.niche),
    subNiche: stringOr(input.subNiche, channel.subNiches[0] ?? ""),
    targetDurationMinutes: boundedMinutes(input.targetDurationMinutes ?? channel.defaultTargetDurationMinutes),
    tone: stringOr(input.tone, "calm, mysterious, slowly building dread"),
    mode: input.mode === undefined ? channel.mode : normalizeMode(input.mode),
    ttsProfile: { ...channel.ttsProfile },
    visualStyleProfile: { ...channel.visualStyleProfile },
    budget: { ...channel.budget },
  };
}

function normalizeStory(channelId: string, storyId: string, value: unknown): StoryProject {
  const candidate = value && typeof value === "object" ? (value as Partial<StoryProject>) : {};
  const configCandidate =
    candidate.config && typeof candidate.config === "object"
      ? (candidate.config as Partial<StoryProjectConfig>)
      : {};
  const stages: StoryProject["stages"] = {};
  if (candidate.stages && typeof candidate.stages === "object") {
    for (const stage of STORY_STAGES) {
      const run = (candidate.stages as Record<string, unknown>)[stage];
      if (run && typeof run === "object") {
        stages[stage] = normalizeStageRun(run as Partial<StageRun>);
      }
    }
  }
  const approvals: StoryProject["approvals"] = {};
  if (candidate.approvals && typeof candidate.approvals === "object") {
    for (const key of STORY_APPROVAL_STAGES) {
      const record = (candidate.approvals as Record<string, unknown>)[key];
      if (record && typeof record === "object") {
        const approval = record as Partial<StoryProject["approvals"]["script"]>;
        if (typeof approval?.artifactHash === "string" && approval.artifactHash) {
          approvals[key] = {
            artifactHash: approval.artifactHash,
            approvedAt: stringOr(approval.approvedAt, new Date(0).toISOString()),
            note: typeof approval.note === "string" ? approval.note : "",
          };
        }
      }
    }
  }
  // A story written before the canon layer existed has neither field. It is an
  // `original`, which is exactly what an absent canonRef derives to — so old
  // files need no migration. The fields must be listed here at all because this
  // function REBUILDS the object and runs on every stage write: anything it
  // does not name is erased the first time a stage saves.
  const canonRef = readCanonRef(candidate.canonRef);
  return {
    version: 1,
    id: validateStoryId(String(candidate.id ?? storyId)),
    channelId: validateProjectId(String(candidate.channelId ?? channelId)),
    title: stringOr(candidate.title, "Untitled story"),
    kind: resolveStoryKind(candidate.kind, canonRef),
    ...(canonRef ? { canonRef } : {}),
    ...(optionalString(candidate.lockedAt) ? { lockedAt: candidate.lockedAt } : {}),
    config: {
      language: stringOr(configCandidate.language, "es"),
      locale: stringOr(configCandidate.locale, "es-MX"),
      niche: stringOr(configCandidate.niche, "horror"),
      subNiche: typeof configCandidate.subNiche === "string" ? configCandidate.subNiche.trim() : "",
      targetDurationMinutes: boundedMinutes(configCandidate.targetDurationMinutes ?? 25),
      tone: stringOr(configCandidate.tone, "calm, mysterious, slowly building dread"),
      mode: normalizeMode(configCandidate.mode),
      ttsProfile: normalizeTtsProfile(configCandidate.ttsProfile),
      visualStyleProfile: normalizeVisualStyle(configCandidate.visualStyleProfile),
      budget: {
        maxCostPerStoryUsd: boundedBudget(configCandidate.budget?.maxCostPerStoryUsd),
        maxCostPerMonthUsd: boundedMonthlyBudget(configCandidate.budget?.maxCostPerMonthUsd),
      },
    },
    stages,
    approvals,
    createdAt: stringOr(candidate.createdAt, new Date().toISOString()),
    updatedAt: stringOr(candidate.updatedAt, new Date().toISOString()),
  };
}

function normalizeStageRun(value: Partial<StageRun>): StageRun {
  const classification = value.lastError?.classification;
  return {
    status: normalizeStageStatus(value.status),
    attemptCount: boundedCount(value.attemptCount),
    lastError:
      value.lastError && typeof value.lastError.message === "string"
        ? {
            message: value.lastError.message,
            classification:
              classification === "provider" ||
              classification === "quota" ||
              classification === "content" ||
              classification === "budget"
                ? classification
                : "retryable",
          }
        : undefined,
    costUsd: nonNegative(value.costUsd),
    startedAt: optionalString(value.startedAt),
    finishedAt: optionalString(value.finishedAt),
    provider: optionalString(value.provider),
    model: optionalString(value.model),
    promptVersion: optionalString(value.promptVersion),
    artifactHash: optionalString(value.artifactHash),
  };
}

function normalizeStageStatus(value: unknown): StageRunStatus {
  if (
    value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "stale" ||
    value === "awaiting-approval"
  ) {
    return value;
  }
  return "pending";
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function required(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function boundedMinutes(value: unknown): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 5) return 25;
  return Math.min(number, 60);
}

function boundedBudget(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10000 ? number : 5;
}

function boundedMonthlyBudget(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100000 ? number : 0;
}

function boundedCount(value: unknown): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
