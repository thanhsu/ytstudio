import type { StudioConfig } from "../config.ts";
import type { JobKind } from "../jobs.ts";
import { listStories, loadStory, readStageArtifact } from "../story-factory/story-project.ts";
import { designSeries } from "./design.ts";
import {
  loadArcs,
  loadBible,
  loadCharacters,
  loadThreads,
  loadWorldState,
  normalizeArcs,
  normalizeBible,
  normalizeCharacters,
  normalizeThreads,
  normalizeWorldState,
  updateArcs,
  updateBible,
  updateCharacters,
  updateThreads,
  updateWorldState,
} from "./entities.ts";
import { loadEvents } from "./events.ts";
import { loadMemoryRecords, retrieve } from "./memory.ts";
import { canonPerformance } from "./performance.ts";
import { loadCanonSeries, saveCanonSeries } from "./series.ts";
import {
  channelsForSeries,
  createPublicationVariant,
  CanonChapterNotApprovedError,
  listSeriesVariants,
  lockCanonChapter,
  unlockCanonChapter,
} from "./variant.ts";
import type { CanonChapterArtifact } from "./types.ts";

/**
 * Canon HTTP surface, mounted INSIDE the story-factory router at
 * `/api/series/:seriesId/canon/...`. Chapters themselves need no routes: a
 * canon chapter is a StoryProject, so the existing `stories/...` endpoints
 * already cover its stage runs, artifacts, approvals, AI log, and cost.
 *
 * Only the series-level entities and the publication fan-out are new.
 */

export type CanonRouteTools = {
  sendJson: (status: number, body: unknown) => void;
  sendError: (status: number, error: { code: string; message: string; action?: string; details?: unknown }) => void;
  readBody: () => Promise<Record<string, unknown>>;
  startChannelJob: (
    kind: JobKind,
    operation: (context: { signal: AbortSignal; update: (progress: number, message: string) => Promise<void> }) => Promise<unknown>,
    ownerSuffix?: string,
  ) => Promise<void>;
  /** Project ids the studio knows about, for discovering linked channels. */
  listProjectIds: () => Promise<string[]>;
};

/** Entities exposed for read and hand-editing, each with its own normalizer. */
const ENTITIES = {
  bible: { load: loadBible, update: updateBible, normalize: normalizeBible },
  characters: { load: loadCharacters, update: updateCharacters, normalize: normalizeCharacters },
  "world-state": { load: loadWorldState, update: updateWorldState, normalize: normalizeWorldState },
  arcs: { load: loadArcs, update: updateArcs, normalize: normalizeArcs },
  threads: { load: loadThreads, update: updateThreads, normalize: normalizeThreads },
} as const;

export async function routeCanon(options: {
  method: string;
  /** Path after `canon/`. */
  rest: string;
  url: URL;
  seriesId: string;
  config: StudioConfig;
  tools: CanonRouteTools;
}): Promise<boolean> {
  const { method, rest, url, seriesId, config, tools } = options;

  if (rest === "series") {
    if (method === "GET") {
      const series = await loadCanonSeries(seriesId);
      if (!series) {
        tools.sendError(404, { code: "canon-series-missing", message: `${seriesId} is not a canon series.` });
        return true;
      }
      tools.sendJson(200, { ok: true, series });
      return true;
    }
    if (method === "PUT") {
      const body = await tools.readBody();
      try {
        tools.sendJson(200, { ok: true, series: await saveCanonSeries(seriesId, body) });
      } catch (error: unknown) {
        tools.sendError(400, {
          code: "canon-series-invalid",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
  }

  const entityMatch = /^(bible|characters|world-state|arcs|threads)$/.exec(rest);
  if (entityMatch) {
    const entity = ENTITIES[entityMatch[1] as keyof typeof ENTITIES];
    if (method === "GET") {
      tools.sendJson(200, { ok: true, [entityMatch[1]]: await entity.load(seriesId) });
      return true;
    }
    if (method === "PUT") {
      const body = await tools.readBody();
      // The hand edit goes through the same normalizer and the same series
      // lock as a generated write, so a malformed paste is repaired rather
      // than persisted and cannot interleave with a running job.
      const saved = await entity.update(seriesId, (current) =>
        entity.normalize(seriesId, { ...body, revision: current.revision }) as never,
      );
      tools.sendJson(200, { ok: true, [entityMatch[1]]: saved });
      return true;
    }
  }

  if (rest === "events" && method === "GET") {
    const ledger = await loadEvents(seriesId);
    tools.sendJson(200, {
      ok: true,
      events: ledger.events,
      retracted: ledger.retracted,
      // Surfaced, not swallowed: for the canon ledger a torn line is lost
      // story history and the operator has to be able to see it.
      tornLines: ledger.tornLines,
    });
    return true;
  }

  if (rest === "memory" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const memory = await loadMemoryRecords(seriesId);
    if (!query.trim()) {
      tools.sendJson(200, { ok: true, records: memory.records, tornLines: memory.tornLines });
      return true;
    }
    const chapter = Number(url.searchParams.get("chapter") ?? "0") || memory.records.length;
    const scored = retrieve(memory.records, {
      query,
      currentChapter: chapter,
      topKPerClass: config.storyFactory.canon.retrievalTopKPerClass,
      weights: config.storyFactory.canon.retrievalWeights,
    });
    // Scores are exposed for debugging; raw embeddings never are.
    tools.sendJson(200, {
      ok: true,
      query,
      results: scored.map((entry) => ({
        id: entry.record.id,
        entityType: entry.record.entityType,
        chapterNumber: entry.record.chapterNumber,
        text: entry.record.text,
        keywordScore: round(entry.keywordScore),
        vectorScore: entry.vectorScore === null ? null : round(entry.vectorScore),
        importance: entry.importance,
        chapterDistance: entry.chapterDistance,
        finalScore: round(entry.finalScore),
        rank: entry.rank,
      })),
    });
    return true;
  }

  if (rest === "design/run" && method === "POST") {
    const body = await tools.readBody();
    if (body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: "Designing a series calls the architect model.",
        action: "confirm-paid-request",
      });
      return true;
    }
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    if (!brief) {
      tools.sendError(400, { code: "canon-brief-required", message: "A series brief is required." });
      return true;
    }
    await tools.startChannelJob(
      "canon-design",
      async ({ signal, update }) =>
        designSeries({
          seriesId,
          brief,
          config,
          confirmedPaidRequest: true,
          signal,
          update: async (message) => update(-1, message),
        }),
      "design",
    );
    return true;
  }

  if (rest === "chapters" && method === "GET") {
    const chapters = [];
    for (const story of await listStories(seriesId)) {
      if (story.kind !== "canon") continue;
      const artifact = await readStageArtifact<CanonChapterArtifact>(seriesId, story.id, "canon-write");
      chapters.push({
        id: story.id,
        chapterNumber: artifact?.chapterNumber ?? 0,
        title: artifact?.title ?? story.title,
        summary: artifact?.summary ?? "",
        canonTextHash: artifact?.canonTextHash ?? null,
        approved: Boolean(story.approvals.canon),
        locked: Boolean(story.lockedAt),
        updatedAt: story.updatedAt,
      });
    }
    chapters.sort((left, right) => left.chapterNumber - right.chapterNumber);
    tools.sendJson(200, { ok: true, chapters });
    return true;
  }

  if (rest === "variants" && method === "GET") {
    const channelIds = await channelsForSeries(seriesId, await tools.listProjectIds());
    tools.sendJson(200, { ok: true, channels: channelIds, variants: await listSeriesVariants(seriesId, channelIds) });
    return true;
  }

  if (rest === "performance" && method === "GET") {
    const channelIds = await channelsForSeries(seriesId, await tools.listProjectIds());
    tools.sendJson(200, { ok: true, performance: await canonPerformance(seriesId, channelIds) });
    return true;
  }

  return false;
}

/**
 * Chapter-scoped canon actions, mounted under `stories/:chapterId/`. These are
 * canon-specific verbs the generic story routes have no notion of.
 */
export async function routeCanonChapter(options: {
  method: string;
  rest: string;
  seriesId: string;
  chapterId: string;
  tools: CanonRouteTools;
}): Promise<boolean> {
  const { method, rest, seriesId, chapterId, tools } = options;

  if (rest === "lock" && method === "POST") {
    tools.sendJson(200, { ok: true, chapter: await lockCanonChapter(seriesId, chapterId) });
    return true;
  }

  if (rest === "unlock" && method === "POST") {
    const body = await tools.readBody();
    try {
      const chapter = await unlockCanonChapter(seriesId, chapterId, String(body.note ?? ""));
      // Published variants are reported stale, never regenerated. Deciding what
      // to do about an already-uploaded video is the operator's call.
      const channelIds = await channelsForSeries(seriesId, await tools.listProjectIds());
      const affected = (await listSeriesVariants(seriesId, channelIds)).filter(
        (link) => link.chapterId === chapterId,
      );
      tools.sendJson(200, { ok: true, chapter, affectedVariants: affected });
    } catch (error: unknown) {
      tools.sendError(400, {
        code: "canon-unlock-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (rest === "publish-variants" && method === "POST") {
    const body = await tools.readBody();
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (targets.length === 0) {
      tools.sendError(400, {
        code: "canon-targets-required",
        message: "Name at least one target channel to publish into.",
      });
      return true;
    }
    const created: Array<{ channelId: string; storyId: string; locale: string }> = [];
    const failed: Array<{ channelId: string; message: string }> = [];
    for (const target of targets) {
      const channelId = typeof target?.channelId === "string" ? target.channelId : "";
      if (!channelId) continue;
      try {
        const variant = await createPublicationVariant({
          seriesId,
          chapterId,
          channelId,
          storyId: typeof target?.storyId === "string" ? target.storyId : undefined,
        });
        created.push({ channelId, storyId: variant.id, locale: variant.config.locale });
      } catch (error: unknown) {
        // One bad channel must not lose the others: this is a fan-out, and a
        // partial result the operator can see beats an all-or-nothing failure.
        failed.push({ channelId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const status = created.length === 0 ? 409 : 200;
    if (status === 409) {
      const notApproved = failed.some((entry) => /not ready to publish/.test(entry.message));
      tools.sendError(409, {
        code: notApproved ? "canon-chapter-not-approved" : "canon-variants-failed",
        message: "No publication variants could be created.",
        details: { failed },
      });
      return true;
    }
    tools.sendJson(200, { ok: true, created, failed });
    return true;
  }

  return false;
}

export function isCanonApprovalError(error: unknown): error is CanonChapterNotApprovedError {
  return error instanceof CanonChapterNotApprovedError;
}

/** Whether this project is a canon series, for the UI to branch on. */
export async function canonSeriesSummary(seriesId: string): Promise<{ isCanon: boolean; title: string } | null> {
  const series = await loadCanonSeries(seriesId);
  return series ? { isCanon: true, title: series.title } : null;
}

export async function chapterIsLocked(seriesId: string, chapterId: string): Promise<boolean> {
  try {
    return Boolean((await loadStory(seriesId, chapterId)).lockedAt);
  } catch {
    return false;
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
