import { sha256 } from "../project-state.ts";
import { normalizeText } from "../story-factory/fingerprint.ts";
import { appendJsonl, boundedUnit, canonPath, readJsonl, textList, textOr, withSeriesLock, wholeNumber } from "./store.ts";
import type { MemoryEntityType, MemoryRecord, MemoryVector, RetrievalScore } from "./types.ts";
import { MEMORY_ENTITY_TYPES } from "./types.ts";

/**
 * Story memory: the indexed corpus retrieval draws on, at
 * `projects/<seriesId>/canon/memory/`.
 *
 * Retrieval is keyword + structured FIRST. That is not a degraded mode — it is
 * the primary one, the only one that runs offline and in tests, and the only
 * one that works before any embedding model has been configured. Vectors, when
 * present, add a signal; they never become the mechanism.
 *
 * Memory is a derived index, never a source of truth: it is rebuilt from the
 * event ledger, chapter summaries, and the canon entities. Nothing is lost if
 * it is deleted.
 */

const INDEX_FILE = "memory/index.jsonl";
const VECTORS_FILE = "memory/vectors.jsonl";

export function memoryIdFor(entityType: MemoryEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export async function loadMemoryRecords(seriesId: string): Promise<{ records: MemoryRecord[]; tornLines: number }> {
  const result = await readJsonl<MemoryRecord>(canonPath(seriesId, INDEX_FILE));
  // Later writes win: the index is append-only on disk but last-write-wins in
  // memory, so re-indexing a chapter supersedes its earlier records without a
  // rewrite pass.
  const byId = new Map<string, MemoryRecord>();
  for (const raw of result.records) {
    const record = normalizeRecord(seriesId, raw);
    if (record) byId.set(record.id, record);
  }
  return { records: [...byId.values()], tornLines: result.tornLines };
}

export async function upsertMemoryRecords(seriesId: string, records: MemoryRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  return withSeriesLock(seriesId, async () => {
    for (const record of records) {
      await appendJsonl(canonPath(seriesId, INDEX_FILE), record);
    }
    return records.length;
  });
}

/** Removes records by id, by appending tombstones the loader honours. */
export async function forgetMemoryRecords(seriesId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return withSeriesLock(seriesId, async () => {
    for (const id of ids) {
      await appendJsonl(canonPath(seriesId, INDEX_FILE), { id, forgotten: true });
    }
    return ids.length;
  });
}

function normalizeRecord(seriesId: string, value: unknown): MemoryRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MemoryRecord> & { forgotten?: boolean };
  const id = textOr(candidate.id, "");
  if (!id) return null;
  // A tombstone removes the record from the materialised view entirely.
  if (candidate.forgotten === true) return null;
  const entityType = MEMORY_ENTITY_TYPES.includes(candidate.entityType as MemoryEntityType)
    ? (candidate.entityType as MemoryEntityType)
    : "canon-fact";
  const text = textOr(candidate.text, "");
  if (!text) return null;
  const metadata: Partial<MemoryRecord["metadata"]> =
    candidate.metadata && typeof candidate.metadata === "object" ? candidate.metadata : {};
  return {
    id,
    seriesId,
    entityType,
    entityId: textOr(candidate.entityId, id),
    chapterNumber: wholeNumber(candidate.chapterNumber, 0),
    text,
    importance: boundedUnit(candidate.importance, 0.5),
    metadata: {
      characters: textList(metadata.characters),
      locations: textList(metadata.locations),
      threads: textList(metadata.threads),
    },
  };
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export async function loadMemoryVectors(seriesId: string): Promise<Map<string, MemoryVector>> {
  const result = await readJsonl<MemoryVector>(canonPath(seriesId, VECTORS_FILE));
  const byId = new Map<string, MemoryVector>();
  for (const vector of result.records) {
    if (!vector?.id || !Array.isArray(vector.values) || vector.values.length === 0) continue;
    byId.set(vector.id, vector);
  }
  return byId;
}

export async function upsertMemoryVectors(seriesId: string, vectors: MemoryVector[]): Promise<number> {
  if (vectors.length === 0) return 0;
  return withSeriesLock(seriesId, async () => {
    for (const vector of vectors) {
      await appendJsonl(canonPath(seriesId, VECTORS_FILE), vector);
    }
    return vectors.length;
  });
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  // Clamped because float error can push an identical pair marginally over 1.
  return Math.min(1, Math.max(-1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export type RetrievalWeights = {
  keyword: number;
  vector: number;
  importance: number;
  proximity: number;
};

export type RetrieveOptions = {
  query: string;
  /** The chapter being written; proximity is measured against it. */
  currentChapter: number;
  /** Structured pre-filter. A record matching none of these is not a candidate. */
  filter?: {
    characters?: string[];
    locations?: string[];
    threads?: string[];
    /** Records from these chapters are always candidates (recency window). */
    recentChapters?: number[];
  };
  topKPerClass: number;
  weights: RetrievalWeights;
  /** Absent when embeddings are disabled, which is the default. */
  queryVector?: number[] | null;
  vectors?: Map<string, MemoryVector>;
  /** Guards against comparing vectors produced by different models. */
  embeddingModel?: string;
};

/**
 * Hybrid retrieval: structured filter, then a weighted blend of keyword
 * overlap, optional cosine similarity, importance, and story proximity.
 *
 * Two details matter more than the formula:
 *
 * - **topK is per entity class.** With one global topK a chatty character's
 *   events crowd out every plot thread and chapter summary, and the writer
 *   loses exactly the structural context it needed.
 * - **Weights are renormalised over the signals actually present.** A record
 *   with no vector must not be scored as though its vector similarity were
 *   zero: enabling embeddings at chapter 12 would then rank every earlier
 *   record last, permanently.
 */
export function retrieve(records: MemoryRecord[], options: RetrieveOptions): RetrievalScore[] {
  const queryTokens = tokenSet(options.query);
  const candidates = records.filter((record) => matchesFilter(record, options.filter));
  const scored = candidates.map((record) => scoreRecord(record, queryTokens, options));

  // Rank within each entity class, take the class's share, then order the
  // union by score so the prompt still reads best-first.
  const byClass = new Map<MemoryEntityType, RetrievalScore[]>();
  for (const entry of scored) {
    const list = byClass.get(entry.record.entityType) ?? [];
    list.push(entry);
    byClass.set(entry.record.entityType, list);
  }
  const kept: RetrievalScore[] = [];
  for (const list of byClass.values()) {
    kept.push(...selectForClass(list, options.topKPerClass));
  }
  kept.sort(compareScore);
  return kept.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Fill a class's slots from TWO rankings, not one.
 *
 * The blended score is recency-weighted, and in a long series that is
 * self-defeating: when several records score similarly on keywords — which is
 * the normal case for a story with a fixed cast and setting — proximity
 * decides, and retrieval can only ever see the last few chapters. A synthetic
 * 40-chapter series proved it: every slot went to chapters 35-40.
 *
 * So a minority of each class's slots are reserved for the highest-IMPORTANCE
 * records regardless of when they happened. That is what keeps a chapter-3
 * reveal reachable at chapter 40, which is the entire promise of story memory.
 */
function selectForClass(list: RetrievalScore[], topK: number): RetrievalScore[] {
  if (topK <= 0) return [];
  const byScore = [...list].sort(compareScore);
  if (list.length <= topK) return byScore;

  const landmarkSlots = topK >= 3 ? Math.max(1, Math.floor(topK / 3)) : 0;
  const scoreSlots = topK - landmarkSlots;

  const chosen: RetrievalScore[] = byScore.slice(0, scoreSlots);
  const taken = new Set(chosen.map((entry) => entry.record.id));

  if (landmarkSlots > 0) {
    const byImportance = [...list].sort(
      (left, right) =>
        right.importance - left.importance ||
        // Oldest first on a tie. The landmark slice exists to counterbalance
        // recency, so breaking its ties by score — which is recency-weighted —
        // would just re-pick the same late chapters the score pass already
        // took, and the slice would do nothing at all.
        left.record.chapterNumber - right.record.chapterNumber ||
        left.record.id.localeCompare(right.record.id),
    );
    for (const entry of byImportance) {
      if (chosen.length >= topK) break;
      if (taken.has(entry.record.id)) continue;
      chosen.push(entry);
      taken.add(entry.record.id);
    }
  }
  // Any slots the landmark pass could not fill fall back to score order.
  for (const entry of byScore) {
    if (chosen.length >= topK) break;
    if (taken.has(entry.record.id)) continue;
    chosen.push(entry);
    taken.add(entry.record.id);
  }
  return chosen;
}

function compareScore(left: RetrievalScore, right: RetrievalScore): number {
  // Ties break on id so retrieval is deterministic — a context debugger that
  // reordered between identical runs would be useless.
  return right.finalScore - left.finalScore || left.record.id.localeCompare(right.record.id);
}

function scoreRecord(record: MemoryRecord, queryTokens: Set<string>, options: RetrieveOptions): RetrievalScore {
  const keywordScore = jaccard(queryTokens, tokenSet(record.text));
  const vector = options.vectors?.get(record.id);
  const usableVector =
    vector && options.queryVector && vector.values.length === options.queryVector.length
      // A vector from a different embedding model lives in a different space;
      // comparing across them produces confident nonsense.
      && (!options.embeddingModel || vector.embeddingModel === options.embeddingModel)
      ? vector
      : null;
  const vectorScore = usableVector && options.queryVector ? cosineSimilarity(options.queryVector, usableVector.values) : null;

  const chapterDistance = Math.abs(options.currentChapter - record.chapterNumber);
  // Recent chapters matter more, but the decay is gentle: a chapter-3 reveal
  // must still be reachable at chapter 40, which is the entire point.
  const proximity = 1 / (1 + chapterDistance / 10);

  const signals: Array<{ weight: number; value: number }> = [
    { weight: options.weights.keyword, value: keywordScore },
    { weight: options.weights.importance, value: record.importance },
    { weight: options.weights.proximity, value: proximity },
  ];
  if (vectorScore !== null) {
    signals.push({ weight: options.weights.vector, value: Math.max(0, vectorScore) });
  }
  const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const finalScore =
    totalWeight > 0 ? signals.reduce((sum, signal) => sum + signal.weight * signal.value, 0) / totalWeight : 0;

  return {
    record,
    keywordScore,
    vectorScore,
    importance: record.importance,
    chapterDistance,
    finalScore,
    rank: 0,
  };
}

function matchesFilter(record: MemoryRecord, filter: RetrieveOptions["filter"]): boolean {
  if (!filter) return true;
  const hasConstraint =
    Boolean(filter.characters?.length) ||
    Boolean(filter.locations?.length) ||
    Boolean(filter.threads?.length) ||
    Boolean(filter.recentChapters?.length);
  if (!hasConstraint) return true;
  if (filter.recentChapters?.includes(record.chapterNumber)) return true;
  if (filter.characters?.some((id) => record.metadata.characters.includes(id))) return true;
  if (filter.locations?.some((id) => record.metadata.locations.includes(id))) return true;
  if (filter.threads?.some((id) => record.metadata.threads.includes(id))) return true;
  return false;
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Content hash of a record's text, for detecting a stale vector. */
export function memoryTextHash(text: string): string {
  return sha256(normalizeText(text)).slice(0, 16);
}
