import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrief } from "./brief.ts";
import { ensureProjectDir, PROJECTS_DIR, writeJson } from "./fs.ts";
import { validateProjectId } from "./project-paths.ts";
import { normalizeWorkflowType } from "./workflow-templates.ts";
import type { WorkflowType } from "./types.ts";

export type EpisodeStatus = "idea" | "script" | "voice" | "caption" | "render" | "ready" | "published";

export type SeriesEpisode = {
  id: string;
  episodeNumber: number;
  episodeProjectId: string;
  sourceTitle: string;
  workingTitle: string;
  angle: string;
  hook: string;
  outline: string[];
  titleOptions: string[];
  description: string;
  hashtags: string[];
  pinnedComment: string;
  priority: "high" | "medium" | "low";
  status: EpisodeStatus;
  updatedAt: string;
};

export type SeriesProject = {
  version: 1;
  id: string;
  title: string;
  show: string;
  originalTitle: string;
  workflowType: WorkflowType;
  audience: string;
  language: string;
  brandNotes: string;
  titleStyle: string;
  thumbnailStyle: string;
  scheduleNotes: string;
  episodes: SeriesEpisode[];
  createdAt: string;
  updatedAt: string;
};

export type CreateSeriesInput = {
  id: string;
  title: string;
  show: string;
  originalTitle?: string;
  workflowType?: unknown;
  audience: string;
  language: string;
  brandNotes?: string;
  titleStyle?: string;
  thumbnailStyle?: string;
  scheduleNotes?: string;
};

export type GenerateEpisodePlanInput = {
  count: number;
  startEpisode?: number;
};

export type UpdateEpisodeInput = Partial<
  Pick<
    SeriesEpisode,
    | "sourceTitle"
    | "workingTitle"
    | "angle"
    | "hook"
    | "outline"
    | "titleOptions"
    | "description"
    | "hashtags"
    | "pinnedComment"
    | "priority"
    | "status"
  >
>;

const SERIES_FILE = "series.json";

export async function createSeriesProject(input: CreateSeriesInput): Promise<SeriesProject> {
  validateProjectId(input.id);
  const now = new Date().toISOString();
  const series: SeriesProject = {
    version: 1,
    id: input.id,
    title: required(input.title, "title"),
    show: required(input.show, "show"),
    originalTitle: input.originalTitle?.trim() ?? "",
    workflowType: normalizeWorkflowType(input.workflowType),
    audience: required(input.audience, "audience"),
    language: required(input.language, "language"),
    brandNotes: input.brandNotes?.trim() ?? "",
    titleStyle: input.titleStyle?.trim() ?? "Clear curiosity title with the show name when useful.",
    thumbnailStyle: input.thumbnailStyle?.trim() ?? "Readable face-safe visual, large contrast text, no misleading source frames.",
    scheduleNotes: input.scheduleNotes?.trim() ?? "Publish at a fixed day and hour.",
    episodes: [],
    createdAt: now,
    updatedAt: now,
  };
  await ensureProjectDir(series.id);
  await saveSeriesProject(series);
  return series;
}

export async function loadSeriesProject(seriesId: string): Promise<SeriesProject> {
  validateProjectId(seriesId);
  const raw = await readFile(seriesPath(seriesId), "utf8");
  return normalizeSeriesProject(JSON.parse(raw));
}

export async function listSeriesProjects(): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const id of entries) {
    try {
      validateProjectId(id);
      await readFile(seriesPath(id), "utf8");
      ids.push(id);
    } catch {
      // Normal one-video projects do not have series.json.
    }
  }
  return ids.sort();
}

export async function generateEpisodePlan(
  seriesId: string,
  input: GenerateEpisodePlanInput,
): Promise<SeriesProject> {
  const series = await loadSeriesProject(seriesId);
  const count = boundedCount(input.count);
  const startEpisode = Math.max(1, Math.floor(input.startEpisode ?? 1));
  const existingIds = new Set(series.episodes.map((episode) => episode.id));
  const nextEpisodes: SeriesEpisode[] = [];

  for (let index = 0; index < count; index += 1) {
    const episodeNumber = startEpisode + index;
    const id = episodeId(episodeNumber);
    if (existingIds.has(id)) continue;
    const episode = buildEpisode(series, episodeNumber);
    nextEpisodes.push(episode);
    await createBrief({
      id: episode.episodeProjectId,
      topic: episode.angle,
      show: series.show,
      format: "shorts",
      workflowType: series.workflowType,
      audience: series.audience,
      language: series.language,
      notes: [
        `Series: ${series.title}`,
        `Episode: ${episode.id}`,
        `Hook: ${episode.hook}`,
        `Outline: ${episode.outline.join(" | ")}`,
      ].join("\n"),
    });
  }

  series.episodes = [...series.episodes, ...nextEpisodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
  series.updatedAt = new Date().toISOString();
  await saveSeriesProject(series);
  return series;
}

export async function updateSeriesEpisode(
  seriesId: string,
  episodeIdValue: string,
  updates: UpdateEpisodeInput,
): Promise<SeriesProject> {
  const series = await loadSeriesProject(seriesId);
  const index = series.episodes.findIndex((episode) => episode.id === episodeIdValue);
  if (index === -1) {
    throw new Error(`Episode not found: ${episodeIdValue}`);
  }

  const current = series.episodes[index];
  const next: SeriesEpisode = {
    ...current,
    ...sanitizeEpisodeUpdates(updates),
    updatedAt: new Date().toISOString(),
  };
  series.episodes[index] = next;
  series.updatedAt = next.updatedAt;
  await saveSeriesProject(series);
  return series;
}

export async function saveSeriesProject(series: SeriesProject): Promise<void> {
  await ensureProjectDir(series.id);
  await writeJson(seriesPath(series.id), normalizeSeriesProject(series));
}

function buildEpisode(series: SeriesProject, episodeNumber: number): SeriesEpisode {
  const id = episodeId(episodeNumber);
  const episodeLabel = `Tap ${episodeNumber}`;
  const angle = episodeAngle(series, episodeNumber);
  const workingTitle = `${series.show} ${episodeLabel}: ${angle}`;
  const now = new Date().toISOString();
  return {
    id,
    episodeNumber,
    episodeProjectId: `${series.id}-${id}`,
    sourceTitle: `${series.show} ${episodeLabel}`,
    workingTitle,
    angle,
    hook: `${series.show} ${episodeLabel} dang xem vi mot chi tiet nho ma nhieu nguoi bo qua.`,
    outline: [
      "Mo dau bang cau hoi/kich thich binh luan",
      "Giai thich boi canh ngan, khong ke lai lan man",
      "Dua ra 2-3 nhan xet rieng ve nhan vat/cot truyen",
      "Ket bang cau hoi keo comment cho tap tiep theo",
    ],
    titleOptions: [
      `${series.show} ${episodeLabel} co gi dang xem?`,
      `Vi sao ${series.show} ${episodeLabel} van giu chan nguoi xem?`,
      `${series.show}: chi tiet quan trong trong ${episodeLabel}`,
    ],
    description: `Review ${series.show} ${episodeLabel} theo goc nhin rieng, tap trung vao nhan vat va mach truyen.`,
    hashtags: ["#reviewphim", "#donghua", `#${slugTag(series.show)}`],
    pinnedComment: `Ban muon tap tiep theo phan tich nhan vat nao trong ${series.show}?`,
    priority: episodeNumber <= 5 ? "high" : episodeNumber <= 15 ? "medium" : "low",
    status: "idea",
    updatedAt: now,
  };
}

function episodeAngle(series: SeriesProject, episodeNumber: number): string {
  const angles = [
    "main co gi khac mau nhan vat thuong thay",
    "the gioi va luat choi nao khien phim cuon hon",
    "nhan vat phu nao dang bi danh gia thap",
    "mot chi tiet nho co the anh huong cac tap sau",
    "vi sao mach truyen van dang theo doi du khong qua hot",
  ];
  return `${angles[(episodeNumber - 1) % angles.length]} trong tap ${episodeNumber}`;
}

function sanitizeEpisodeUpdates(updates: UpdateEpisodeInput): UpdateEpisodeInput {
  const next = { ...updates };
  if (next.priority && !["high", "medium", "low"].includes(next.priority)) delete next.priority;
  if (next.status && !["idea", "script", "voice", "caption", "render", "ready", "published"].includes(next.status)) {
    delete next.status;
  }
  if (next.outline && !Array.isArray(next.outline)) delete next.outline;
  if (next.titleOptions && !Array.isArray(next.titleOptions)) delete next.titleOptions;
  if (next.hashtags && !Array.isArray(next.hashtags)) delete next.hashtags;
  return next;
}

function normalizeSeriesProject(value: unknown): SeriesProject {
  const candidate = value as Partial<SeriesProject>;
  return {
    version: 1,
    id: validateProjectId(String(candidate.id ?? "")),
    title: String(candidate.title ?? "").trim(),
    show: String(candidate.show ?? "").trim(),
    originalTitle: String(candidate.originalTitle ?? "").trim(),
    workflowType: normalizeWorkflowType(candidate.workflowType),
    audience: String(candidate.audience ?? "").trim(),
    language: String(candidate.language ?? "").trim(),
    brandNotes: String(candidate.brandNotes ?? "").trim(),
    titleStyle: String(candidate.titleStyle ?? "").trim(),
    thumbnailStyle: String(candidate.thumbnailStyle ?? "").trim(),
    scheduleNotes: String(candidate.scheduleNotes ?? "").trim(),
    episodes: Array.isArray(candidate.episodes) ? candidate.episodes.map(normalizeEpisode) : [],
    createdAt: String(candidate.createdAt ?? new Date().toISOString()),
    updatedAt: String(candidate.updatedAt ?? new Date().toISOString()),
  };
}

function normalizeEpisode(value: unknown): SeriesEpisode {
  const candidate = value as Partial<SeriesEpisode>;
  const number = Number(candidate.episodeNumber);
  return {
    id: String(candidate.id ?? episodeId(number)).trim(),
    episodeNumber: Number.isFinite(number) ? number : 1,
    episodeProjectId: validateProjectId(String(candidate.episodeProjectId ?? "")),
    sourceTitle: String(candidate.sourceTitle ?? "").trim(),
    workingTitle: String(candidate.workingTitle ?? "").trim(),
    angle: String(candidate.angle ?? "").trim(),
    hook: String(candidate.hook ?? "").trim(),
    outline: Array.isArray(candidate.outline) ? candidate.outline.map(String) : [],
    titleOptions: Array.isArray(candidate.titleOptions) ? candidate.titleOptions.map(String) : [],
    description: String(candidate.description ?? "").trim(),
    hashtags: Array.isArray(candidate.hashtags) ? candidate.hashtags.map(String) : [],
    pinnedComment: String(candidate.pinnedComment ?? "").trim(),
    priority: candidate.priority === "high" || candidate.priority === "low" ? candidate.priority : "medium",
    status: isEpisodeStatus(candidate.status) ? candidate.status : "idea",
    updatedAt: String(candidate.updatedAt ?? new Date().toISOString()),
  };
}

function isEpisodeStatus(value: unknown): value is EpisodeStatus {
  return (
    value === "idea" ||
    value === "script" ||
    value === "voice" ||
    value === "caption" ||
    value === "render" ||
    value === "ready" ||
    value === "published"
  );
}

function seriesPath(seriesId: string): string {
  return join(PROJECTS_DIR, validateProjectId(seriesId), SERIES_FILE);
}

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function boundedCount(count: number): number {
  const normalized = Math.floor(Number(count));
  if (!Number.isFinite(normalized) || normalized < 1) return 1;
  return Math.min(normalized, 100);
}

function episodeId(episodeNumber: number): string {
  return `ep${String(episodeNumber).padStart(3, "0")}`;
}

function slugTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) || "series";
}
