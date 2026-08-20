import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureProjectDir, PROJECTS_DIR, writeJson } from "./fs.ts";
import { validateProjectId } from "./project-paths.ts";

export type ReviewProjectStatus =
  | "draft"
  | "sources"
  | "analyzed"
  | "story"
  | "script"
  | "editing-plan"
  | "exported";

export type SpoilerMode = "donghua-only" | "novel-spoilers";
export type ReviewStyle = "story-review";
export type ReviewTargetLanguage = "English";

export type EpisodeSourceStatus =
  | "empty"
  | "source-ready"
  | "transcript-ready"
  | "scene-ready"
  | "analyzed"
  | "failed";

export type EpisodeSource = {
  episodeNumber: number;
  label: string;
  sourceVideoPath?: string;
  subtitlePath?: string;
  audioPath?: string;
  transcriptPath?: string;
  sceneMapPath?: string;
  analysisPath?: string;
  sourceHash?: string;
  status: EpisodeSourceStatus;
  error?: string;
};

export type ReviewProject = {
  version: 1;
  id: string;
  seriesId: string;
  title: string;
  sourceRange: string;
  episodeNumbers: number[];
  targetLanguage: ReviewTargetLanguage;
  reviewStyle: ReviewStyle;
  targetDurationMinutes: number;
  spoilerMode: SpoilerMode;
  status: ReviewProjectStatus;
  episodes: EpisodeSource[];
  outputs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type CreateReviewProjectInput = {
  seriesId: string;
  id: string;
  title: string;
  sourceRange: string;
  episodeNumbers: number[];
  targetLanguage: ReviewTargetLanguage;
  reviewStyle: ReviewStyle;
  targetDurationMinutes: number;
  spoilerMode: SpoilerMode;
};

export type UpdateReviewProjectInput = Partial<
  Pick<
    ReviewProject,
    "title" | "sourceRange" | "episodeNumbers" | "targetDurationMinutes" | "spoilerMode" | "status" | "outputs"
  >
>;

export type UpdateEpisodeSourceInput = Partial<
  Pick<
    EpisodeSource,
    | "sourceVideoPath"
    | "subtitlePath"
    | "audioPath"
    | "transcriptPath"
    | "sceneMapPath"
    | "analysisPath"
    | "sourceHash"
    | "status"
    | "error"
  >
>;

const BATCH_FILE = "batch.json";

export async function createReviewProject(input: CreateReviewProjectInput): Promise<ReviewProject> {
  const seriesId = validateProjectId(input.seriesId);
  const id = validateProjectId(input.id);
  const now = new Date().toISOString();
  const episodeNumbers = normalizeEpisodeNumbers(input.episodeNumbers);
  const reviewProject: ReviewProject = {
    version: 1,
    id,
    seriesId,
    title: required(input.title, "title"),
    sourceRange: required(input.sourceRange, "sourceRange"),
    episodeNumbers,
    targetLanguage: "English",
    reviewStyle: "story-review",
    targetDurationMinutes: boundedDuration(input.targetDurationMinutes),
    spoilerMode: normalizeSpoilerMode(input.spoilerMode),
    status: "draft",
    episodes: episodeNumbers.map(buildEpisodeSource),
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
  await saveReviewProject(reviewProject);
  return reviewProject;
}

export async function loadReviewProject(seriesId: string, reviewProjectId: string): Promise<ReviewProject> {
  const raw = await readFile(reviewProjectPath(seriesId, reviewProjectId), "utf8");
  return normalizeReviewProject(JSON.parse(raw));
}

export async function listReviewProjects(seriesId: string): Promise<ReviewProject[]> {
  const root = reviewProjectsDir(seriesId);
  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const projects: ReviewProject[] = [];
  for (const id of entries.sort()) {
    try {
      projects.push(await loadReviewProject(seriesId, id));
    } catch {
      // Ignore incomplete folders or files that are not batch review projects.
    }
  }
  return projects;
}

export async function updateReviewProject(
  seriesId: string,
  reviewProjectId: string,
  updates: UpdateReviewProjectInput,
): Promise<ReviewProject> {
  const current = await loadReviewProject(seriesId, reviewProjectId);
  const episodeNumbers = updates.episodeNumbers
    ? normalizeEpisodeNumbers(updates.episodeNumbers)
    : current.episodeNumbers;
  const existingByNumber = new Map(current.episodes.map((episode) => [episode.episodeNumber, episode]));
  const next: ReviewProject = {
    ...current,
    title: updates.title === undefined ? current.title : required(updates.title, "title"),
    sourceRange: updates.sourceRange === undefined ? current.sourceRange : required(updates.sourceRange, "sourceRange"),
    episodeNumbers,
    targetDurationMinutes:
      updates.targetDurationMinutes === undefined
        ? current.targetDurationMinutes
        : boundedDuration(updates.targetDurationMinutes),
    spoilerMode: updates.spoilerMode === undefined ? current.spoilerMode : normalizeSpoilerMode(updates.spoilerMode),
    status: updates.status === undefined ? current.status : normalizeStatus(updates.status),
    outputs: updates.outputs === undefined ? current.outputs : normalizeOutputs(updates.outputs),
    episodes: episodeNumbers.map((number) => existingByNumber.get(number) ?? buildEpisodeSource(number)),
    updatedAt: new Date().toISOString(),
  };
  await saveReviewProject(next);
  return next;
}

export async function updateEpisodeSource(
  seriesId: string,
  reviewProjectId: string,
  episodeNumber: number,
  updates: UpdateEpisodeSourceInput,
): Promise<ReviewProject> {
  const current = await loadReviewProject(seriesId, reviewProjectId);
  const index = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
  if (index === -1) {
    throw new Error(`Episode ${episodeNumber} is not part of review project ${reviewProjectId}.`);
  }

  current.episodes[index] = normalizeEpisodeSource({
    ...current.episodes[index],
    ...updates,
  });
  current.updatedAt = new Date().toISOString();
  if (current.status === "draft") current.status = "sources";
  await saveReviewProject(current);
  return current;
}

export async function saveReviewProject(reviewProject: ReviewProject): Promise<void> {
  const seriesDir = await ensureProjectDir(validateProjectId(reviewProject.seriesId));
  const dir = join(seriesDir, "review-projects", validateProjectId(reviewProject.id));
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, BATCH_FILE), normalizeReviewProject(reviewProject));
}

function normalizeReviewProject(value: unknown): ReviewProject {
  const candidate = value as Partial<ReviewProject>;
  const episodeNumbers = normalizeEpisodeNumbers(candidate.episodeNumbers ?? []);
  const existing = Array.isArray(candidate.episodes) ? candidate.episodes.map(normalizeEpisodeSource) : [];
  const byNumber = new Map(existing.map((episode) => [episode.episodeNumber, episode]));
  return {
    version: 1,
    id: validateProjectId(String(candidate.id ?? "")),
    seriesId: validateProjectId(String(candidate.seriesId ?? "")),
    title: String(candidate.title ?? "").trim(),
    sourceRange: String(candidate.sourceRange ?? "").trim(),
    episodeNumbers,
    targetLanguage: "English",
    reviewStyle: "story-review",
    targetDurationMinutes: boundedDuration(candidate.targetDurationMinutes ?? 20),
    spoilerMode: normalizeSpoilerMode(candidate.spoilerMode),
    status: normalizeStatus(candidate.status),
    episodes: episodeNumbers.map((number) => byNumber.get(number) ?? buildEpisodeSource(number)),
    outputs: normalizeOutputs(candidate.outputs),
    createdAt: String(candidate.createdAt ?? new Date().toISOString()),
    updatedAt: String(candidate.updatedAt ?? new Date().toISOString()),
  };
}

function normalizeEpisodeSource(value: unknown): EpisodeSource {
  const candidate = value as Partial<EpisodeSource>;
  const episodeNumber = normalizeEpisodeNumber(candidate.episodeNumber);
  return {
    episodeNumber,
    label: String(candidate.label ?? episodeLabel(episodeNumber)).trim(),
    sourceVideoPath: optionalString(candidate.sourceVideoPath),
    subtitlePath: optionalString(candidate.subtitlePath),
    audioPath: optionalString(candidate.audioPath),
    transcriptPath: optionalString(candidate.transcriptPath),
    sceneMapPath: optionalString(candidate.sceneMapPath),
    analysisPath: optionalString(candidate.analysisPath),
    sourceHash: optionalString(candidate.sourceHash),
    status: normalizeEpisodeStatus(candidate.status),
    error: optionalString(candidate.error),
  };
}

function buildEpisodeSource(episodeNumber: number): EpisodeSource {
  return {
    episodeNumber,
    label: episodeLabel(episodeNumber),
    status: "empty",
  };
}

function reviewProjectsDir(seriesId: string): string {
  return join(PROJECTS_DIR, validateProjectId(seriesId), "review-projects");
}

function reviewProjectPath(seriesId: string, reviewProjectId: string): string {
  return join(reviewProjectsDir(seriesId), validateProjectId(reviewProjectId), BATCH_FILE);
}

function required(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function normalizeEpisodeNumbers(value: number[]): number[] {
  const numbers = [...new Set(value.map(normalizeEpisodeNumber))].sort((left, right) => left - right);
  if (numbers.length === 0) throw new Error("episodeNumbers is required.");
  if (numbers.length > 20) throw new Error("Batch review supports at most 20 episodes.");
  return numbers;
}

function normalizeEpisodeNumber(value: unknown): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1 || number > 999) {
    throw new Error("Episode number must be between 1 and 999.");
  }
  return number;
}

function boundedDuration(value: unknown): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 5) return 20;
  return Math.min(number, 60);
}

function normalizeSpoilerMode(value: unknown): SpoilerMode {
  return value === "novel-spoilers" ? "novel-spoilers" : "donghua-only";
}

function normalizeStatus(value: unknown): ReviewProjectStatus {
  if (
    value === "sources" ||
    value === "analyzed" ||
    value === "story" ||
    value === "script" ||
    value === "editing-plan" ||
    value === "exported"
  ) {
    return value;
  }
  return "draft";
}

function normalizeEpisodeStatus(value: unknown): EpisodeSourceStatus {
  if (
    value === "source-ready" ||
    value === "transcript-ready" ||
    value === "scene-ready" ||
    value === "analyzed" ||
    value === "failed"
  ) {
    return value;
  }
  return "empty";
}

function normalizeOutputs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, output]) => typeof output === "string")
      .map(([key, output]) => [key, String(output)]),
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function episodeLabel(episodeNumber: number): string {
  return `EP${String(episodeNumber).padStart(3, "0")}`;
}
