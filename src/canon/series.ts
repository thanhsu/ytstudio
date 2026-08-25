import { readFile } from "node:fs/promises";
import { ensureProjectDir } from "../fs.ts";
import { resolveProjectPath, validateProjectId } from "../project-paths.ts";
import { isNotFound, nonNegativeNumber, textList, textOr, wholeNumber, writeJsonAtomic } from "./store.ts";
import type { CanonSeries, CanonSeriesStatus } from "./types.ts";

/**
 * `story-series.json` — the sidecar that marks a channel project as a canon
 * series. It sits beside `series.json` and `story-channel.json` (the brand-kit
 * pattern), so a canon series is discoverable through the existing series list
 * and opens in the existing channel workspace with no new plumbing.
 *
 * A canon series is a channel that never publishes: its `story-channel.json`
 * carries the canonical language, and its stories are canon chapters.
 */

const SERIES_FILE = "story-series.json";

export function seriesFilePath(seriesId: string): string {
  return resolveProjectPath(validateProjectId(seriesId), SERIES_FILE);
}

export function normalizeCanonSeries(seriesId: string, value: unknown): CanonSeries {
  const candidate = value && typeof value === "object" ? (value as Partial<CanonSeries>) : {};
  const budget = candidate.budget && typeof candidate.budget === "object" ? candidate.budget : {};
  return {
    version: 1,
    seriesId,
    title: textOr(candidate.title, seriesId),
    workingTitle: textOr(candidate.workingTitle, ""),
    // English is the default source of truth, not a hardcoded assumption:
    // nothing downstream reads a literal "en", only this field.
    canonicalLanguage: textOr(candidate.canonicalLanguage, "en"),
    genre: textOr(candidate.genre, ""),
    subGenres: textList(candidate.subGenres),
    tone: textOr(candidate.tone, ""),
    targetAudience: textOr(candidate.targetAudience, ""),
    status: seriesStatus(candidate.status),
    targetChapterCount: wholeNumber(candidate.targetChapterCount, 0),
    styleProfile: textOr(candidate.styleProfile, ""),
    budget: {
      // A canon series can run for hundreds of chapters, so it needs its own
      // ceilings: the story-level guard is per chapter and knows nothing about
      // the series total.
      maxCostPerChapterUsd: nonNegativeNumber(
        (budget as CanonSeries["budget"]).maxCostPerChapterUsd,
        2,
      ),
      maxCostPerSeriesUsd: nonNegativeNumber((budget as CanonSeries["budget"]).maxCostPerSeriesUsd, 0),
    },
    createdAt: textOr(candidate.createdAt, new Date(0).toISOString()),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

function seriesStatus(value: unknown): CanonSeriesStatus {
  return value === "ACTIVE" || value === "PAUSED" || value === "COMPLETE" ? value : "PLANNING";
}

/** Null when the project is not a canon series — the marker file is absent. */
export async function loadCanonSeries(seriesId: string): Promise<CanonSeries | null> {
  const id = validateProjectId(seriesId);
  try {
    return normalizeCanonSeries(id, JSON.parse(await readFile(seriesFilePath(id), "utf8")));
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function isCanonSeries(seriesId: string): Promise<boolean> {
  return (await loadCanonSeries(seriesId)) !== null;
}

export type SaveCanonSeriesInput = Partial<Omit<CanonSeries, "version" | "seriesId" | "createdAt">>;

export async function saveCanonSeries(seriesId: string, input: SaveCanonSeriesInput): Promise<CanonSeries> {
  const id = validateProjectId(seriesId);
  const current = await loadCanonSeries(id);
  const now = new Date().toISOString();
  const next = normalizeCanonSeries(id, {
    ...(current ?? {}),
    ...input,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  });
  if (!next.title.trim()) {
    throw new Error("A canon series needs a title.");
  }
  await ensureProjectDir(id);
  await writeJsonAtomic(seriesFilePath(id), next);
  return next;
}

/**
 * Chapter ids are derived, not chosen: `chapter-007`. Zero-padding keeps the
 * story directory listing in reading order, and `listStories` sorts by id.
 */
export function chapterIdFor(chapterNumber: number): string {
  const number = wholeNumber(chapterNumber, 0);
  if (number <= 0) {
    throw new Error(`Chapter number must be positive, got ${chapterNumber}.`);
  }
  return `chapter-${String(number).padStart(3, "0")}`;
}

export function chapterNumberFrom(chapterId: string): number | null {
  const match = /^chapter-(\d{3,})$/.exec(chapterId);
  return match ? Number(match[1]) : null;
}
