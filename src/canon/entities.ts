import {
  boundedUnit,
  loadCanonEntity,
  nonNegativeNumber,
  slugId,
  textList,
  textOr,
  updateCanonEntity,
  wholeNumber,
} from "./store.ts";
import type {
  CanonArc,
  CanonArcs,
  CanonBible,
  CanonChapterCard,
  CanonCharacter,
  CanonCharacterState,
  CanonCharacters,
  CanonFact,
  CanonKnowledge,
  CanonKnowledgeStatus,
  CanonLocation,
  CanonMystery,
  CanonObject,
  CanonRelationship,
  CanonThread,
  CanonThreads,
  CanonWorldState,
} from "./types.ts";

/**
 * The canon entities, each one file under `projects/<seriesId>/canon/`.
 *
 * Every loader normalizes on read, so a hand-edited file always loads and can
 * be repaired in the UI rather than crashing a pipeline run. Every mutation
 * goes through `updateCanonEntity`, which takes the series lock and bumps the
 * revision — no caller can forget either.
 */

export const BIBLE_FILE = "bible.json";
export const CHARACTERS_FILE = "characters.json";
export const WORLD_STATE_FILE = "world-state.json";
export const ARCS_FILE = "arcs.json";
export const THREADS_FILE = "threads.json";

// ---------------------------------------------------------------------------
// Bible
// ---------------------------------------------------------------------------

export function normalizeBible(seriesId: string, value: unknown): CanonBible {
  const candidate = asRecord<CanonBible>(value);
  return {
    version: 1,
    seriesId,
    premise: textOr(candidate.premise, ""),
    setting: textOr(candidate.setting, ""),
    worldRules: factList(candidate.worldRules, "rule"),
    fixedFacts: factList(candidate.fixedFacts, "fact"),
    locations: locationList(candidate.locations),
    importantObjects: objectList(candidate.importantObjects),
    mysteries: mysteryList(candidate.mysteries),
    endingConstraints: textList(candidate.endingConstraints),
    revision: wholeNumber(candidate.revision, 0),
    ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

export async function loadBible(seriesId: string): Promise<CanonBible> {
  return loadCanonEntity(seriesId, BIBLE_FILE, normalizeBible);
}

export async function updateBible(
  seriesId: string,
  mutate: (current: CanonBible) => CanonBible | Promise<CanonBible>,
): Promise<CanonBible> {
  return updateCanonEntity(seriesId, BIBLE_FILE, normalizeBible, mutate);
}

function factList(value: unknown, prefix: string): CanonFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      // A hand-written bible may list plain strings; accept both shapes so the
      // operator never has to hand-author ids.
      if (typeof entry === "string") {
        return entry.trim()
          ? { id: `${prefix}-${index + 1}`, text: entry.trim(), establishedInChapter: 0 }
          : null;
      }
      const record = asRecord<CanonFact>(entry);
      const text = textOr(record.text, "");
      if (!text) return null;
      return {
        id: textOr(record.id, slugId(text, `${prefix}-${index + 1}`)),
        text,
        establishedInChapter: wholeNumber(record.establishedInChapter, 0),
      };
    })
    .filter((entry): entry is CanonFact => entry !== null);
}

function locationList(value: unknown): CanonLocation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const record = asRecord<CanonLocation>(entry);
      const name = textOr(record.name, "");
      if (!name) return null;
      return {
        id: textOr(record.id, slugId(name, `location-${index + 1}`)),
        name,
        description: textOr(record.description, ""),
      };
    })
    .filter((entry): entry is CanonLocation => entry !== null);
}

function objectList(value: unknown): CanonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const record = asRecord<CanonObject>(entry);
      const name = textOr(record.name, "");
      if (!name) return null;
      return {
        id: textOr(record.id, slugId(name, `object-${index + 1}`)),
        name,
        description: textOr(record.description, ""),
        status: textOr(record.status, ""),
      };
    })
    .filter((entry): entry is CanonObject => entry !== null);
}

function mysteryList(value: unknown): CanonMystery[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const record = asRecord<CanonMystery>(entry);
      const question = textOr(record.question, "");
      if (!question) return null;
      const revealedInChapter =
        record.revealedInChapter === null || record.revealedInChapter === undefined
          ? null
          : wholeNumber(record.revealedInChapter, 0);
      return {
        id: textOr(record.id, slugId(question, `mystery-${index + 1}`)),
        question,
        status: record.status === "REVEALED" ? ("REVEALED" as const) : ("OPEN" as const),
        answer: textOr(record.answer, ""),
        revealedInChapter,
      };
    })
    .filter((entry): entry is CanonMystery => entry !== null);
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export function normalizeCharacters(seriesId: string, value: unknown): CanonCharacters {
  const candidate = asRecord<CanonCharacters>(value);
  const characters = Array.isArray(candidate.characters) ? candidate.characters : [];
  return {
    version: 1,
    seriesId,
    characters: characters
      .map((entry, index) => normalizeCharacter(entry, index))
      .filter((entry): entry is CanonCharacter => entry !== null),
    revision: wholeNumber(candidate.revision, 0),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

function normalizeCharacter(value: unknown, index: number): CanonCharacter | null {
  const candidate = asRecord<CanonCharacter>(value);
  const name = textOr(candidate.name, "");
  if (!name) return null;
  const staticProfile = asRecord<CanonCharacter["staticProfile"]>(candidate.staticProfile);
  const birthYearValue = Number(staticProfile.birthYear);
  return {
    id: textOr(candidate.id, slugId(name, `character-${index + 1}`)),
    name,
    role: textOr(candidate.role, ""),
    staticProfile: {
      birthYear: Number.isFinite(birthYearValue) && birthYearValue !== 0 ? Math.floor(birthYearValue) : null,
      appearance: textOr(staticProfile.appearance, ""),
      personality: textList(staticProfile.personality),
      background: textList(staticProfile.background),
    },
    state: normalizeCharacterState(candidate.state),
    deceasedSinceChapter:
      candidate.deceasedSinceChapter === null || candidate.deceasedSinceChapter === undefined
        ? null
        : wholeNumber(candidate.deceasedSinceChapter, 0),
  };
}

function normalizeCharacterState(value: unknown): CanonCharacterState {
  const candidate = asRecord<CanonCharacterState>(value);
  return {
    currentLocation: textOr(candidate.currentLocation, ""),
    emotionalState: textOr(candidate.emotionalState, ""),
    health: textList(candidate.health),
    inventory: textList(candidate.inventory),
    relationships: relationshipList(candidate.relationships),
    knowledge: knowledgeList(candidate.knowledge),
    secretsKnown: textList(candidate.secretsKnown),
    goals: textList(candidate.goals),
    knowledgeSummary: textOr(candidate.knowledgeSummary, ""),
    summarizedThroughChapter: wholeNumber(candidate.summarizedThroughChapter, 0),
  };
}

function relationshipList(value: unknown): CanonRelationship[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord<CanonRelationship>(entry);
      const characterId = textOr(record.characterId, "");
      const relation = textOr(record.relation, "");
      if (!characterId || !relation) return null;
      return { characterId, relation, since: wholeNumber(record.since, 0) };
    })
    .filter((entry): entry is CanonRelationship => entry !== null);
}

function knowledgeList(value: unknown): CanonKnowledge[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const record = asRecord<CanonKnowledge>(entry);
      const fact = textOr(record.fact, "");
      if (!fact) return null;
      return {
        id: textOr(record.id, `knowledge-${index + 1}`),
        fact,
        subject: textOr(record.subject, slugId(fact, `subject-${index + 1}`)),
        learnedInChapter: wholeNumber(record.learnedInChapter, 0),
        sourceEventId: textOr(record.sourceEventId, ""),
        status: knowledgeStatus(record.status),
        ...(record.supersedes ? { supersedes: String(record.supersedes) } : {}),
      };
    })
    .filter((entry): entry is CanonKnowledge => entry !== null);
}

function knowledgeStatus(value: unknown): CanonKnowledgeStatus {
  return value === "superseded" || value === "retracted" ? value : "active";
}

export async function loadCharacters(seriesId: string): Promise<CanonCharacters> {
  return loadCanonEntity(seriesId, CHARACTERS_FILE, normalizeCharacters);
}

export async function updateCharacters(
  seriesId: string,
  mutate: (current: CanonCharacters) => CanonCharacters | Promise<CanonCharacters>,
): Promise<CanonCharacters> {
  return updateCanonEntity(seriesId, CHARACTERS_FILE, normalizeCharacters, mutate);
}

/** Only knowledge that is still true. Superseded and retracted facts stay on
 * disk for audit but must never reach a prompt or the continuity checker. */
export function activeKnowledge(character: CanonCharacter): CanonKnowledge[] {
  return character.state.knowledge.filter((entry) => entry.status === "active");
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

export function normalizeWorldState(seriesId: string, value: unknown): CanonWorldState {
  const candidate = asRecord<CanonWorldState>(value);
  return {
    version: 1,
    seriesId,
    currentStoryTime: textOr(candidate.currentStoryTime, ""),
    currentDate: textOr(candidate.currentDate, ""),
    locations: stringRecord(candidate.locations),
    activeThreats: textList(candidate.activeThreats),
    unresolvedMysteries: textList(candidate.unresolvedMysteries),
    revealedMysteries: textList(candidate.revealedMysteries),
    activeObjects: textList(candidate.activeObjects),
    environmentState: stringRecord(candidate.environmentState),
    asOfChapter: wholeNumber(candidate.asOfChapter, 0),
    revision: wholeNumber(candidate.revision, 0),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

export async function loadWorldState(seriesId: string): Promise<CanonWorldState> {
  return loadCanonEntity(seriesId, WORLD_STATE_FILE, normalizeWorldState);
}

export async function updateWorldState(
  seriesId: string,
  mutate: (current: CanonWorldState) => CanonWorldState | Promise<CanonWorldState>,
): Promise<CanonWorldState> {
  return updateCanonEntity(seriesId, WORLD_STATE_FILE, normalizeWorldState, mutate);
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

export function normalizeArcs(seriesId: string, value: unknown): CanonArcs {
  const candidate = asRecord<CanonArcs>(value);
  const arcs = Array.isArray(candidate.arcs) ? candidate.arcs : [];
  return {
    version: 1,
    seriesId,
    arcs: arcs.map((entry, index) => normalizeArc(entry, index)).filter((entry): entry is CanonArc => entry !== null),
    revision: wholeNumber(candidate.revision, 0),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

function normalizeArc(value: unknown, index: number): CanonArc | null {
  const candidate = asRecord<CanonArc>(value);
  const title = textOr(candidate.title, "");
  if (!title) return null;
  const status = candidate.status;
  return {
    id: textOr(candidate.id, slugId(title, `arc-${index + 1}`)),
    title,
    startChapter: wholeNumber(candidate.startChapter, 1),
    targetEndChapter: wholeNumber(candidate.targetEndChapter, 1),
    goal: textOr(candidate.goal, ""),
    requiredReveals: textList(candidate.requiredReveals),
    mustNotRevealYet: textList(candidate.mustNotRevealYet),
    characterProgression: stringRecord(candidate.characterProgression),
    requiredEvents: textList(candidate.requiredEvents),
    endingHook: textOr(candidate.endingHook, ""),
    status:
      status === "ACTIVE" || status === "COMPLETE" || status === "ABANDONED" ? status : "PLANNED",
    chapterCards: chapterCardList(candidate.chapterCards),
  };
}

function chapterCardList(value: unknown): CanonChapterCard[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord<CanonChapterCard>(entry);
      const chapterNumber = wholeNumber(record.chapterNumber, 0);
      if (chapterNumber <= 0) return null;
      return {
        chapterNumber,
        goal: textOr(record.goal, ""),
        mainEvents: textList(record.mainEvents),
        characters: textList(record.characters),
        locations: textList(record.locations),
        requiredClues: textList(record.requiredClues),
        mustNotReveal: textList(record.mustNotReveal),
        endingHook: textOr(record.endingHook, ""),
        arcProgress: textOr(record.arcProgress, ""),
      };
    })
    .filter((entry): entry is CanonChapterCard => entry !== null)
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
}

export async function loadArcs(seriesId: string): Promise<CanonArcs> {
  return loadCanonEntity(seriesId, ARCS_FILE, normalizeArcs);
}

export async function updateArcs(
  seriesId: string,
  mutate: (current: CanonArcs) => CanonArcs | Promise<CanonArcs>,
): Promise<CanonArcs> {
  return updateCanonEntity(seriesId, ARCS_FILE, normalizeArcs, mutate);
}

/** The arc a chapter belongs to, or null when no arc covers that number. */
export function arcForChapter(arcs: CanonArcs, chapterNumber: number): CanonArc | null {
  return (
    arcs.arcs.find(
      (arc) => chapterNumber >= arc.startChapter && chapterNumber <= arc.targetEndChapter,
    ) ?? null
  );
}

export function cardForChapter(arcs: CanonArcs, chapterNumber: number): CanonChapterCard | null {
  for (const arc of arcs.arcs) {
    const card = arc.chapterCards.find((entry) => entry.chapterNumber === chapterNumber);
    if (card) return card;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plot threads
// ---------------------------------------------------------------------------

export function normalizeThreads(seriesId: string, value: unknown): CanonThreads {
  const candidate = asRecord<CanonThreads>(value);
  const threads = Array.isArray(candidate.threads) ? candidate.threads : [];
  return {
    version: 1,
    seriesId,
    threads: threads
      .map((entry, index) => normalizeThread(entry, index))
      .filter((entry): entry is CanonThread => entry !== null),
    revision: wholeNumber(candidate.revision, 0),
    updatedAt: textOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

function normalizeThread(value: unknown, index: number): CanonThread | null {
  const candidate = asRecord<CanonThread>(value);
  const title = textOr(candidate.title, "");
  if (!title) return null;
  const status = candidate.status;
  return {
    id: textOr(candidate.id, slugId(title, `thread-${index + 1}`)),
    title,
    status:
      status === "OPEN" || status === "DEVELOPING" || status === "RESOLVED" || status === "ABANDONED"
        ? status
        : "PLANNED",
    introducedChapter: wholeNumber(candidate.introducedChapter, 0),
    requiredResolutionArc: textOr(candidate.requiredResolutionArc, ""),
    relatedCharacters: textList(candidate.relatedCharacters),
    relatedEvents: textList(candidate.relatedEvents),
    notes: textOr(candidate.notes, ""),
  };
}

export async function loadThreads(seriesId: string): Promise<CanonThreads> {
  return loadCanonEntity(seriesId, THREADS_FILE, normalizeThreads);
}

export async function updateThreads(
  seriesId: string,
  mutate: (current: CanonThreads) => CanonThreads | Promise<CanonThreads>,
): Promise<CanonThreads> {
  return updateCanonEntity(seriesId, THREADS_FILE, normalizeThreads, mutate);
}

/** Threads a chapter must not quietly forget. */
export function openThreads(threads: CanonThreads): CanonThread[] {
  return threads.threads.filter(
    (thread) => thread.status === "OPEN" || thread.status === "DEVELOPING",
  );
}

/**
 * Open threads whose resolution arc has already closed — the "accidentally
 * forgotten major plot thread" continuity QA is supposed to catch.
 */
export function overdueThreads(threads: CanonThreads, arcs: CanonArcs, chapterNumber: number): CanonThread[] {
  return openThreads(threads).filter((thread) => {
    if (!thread.requiredResolutionArc) return false;
    const arc = arcs.arcs.find((candidate) => candidate.id === thread.requiredResolutionArc);
    return Boolean(arc && chapterNumber > arc.targetEndChapter);
  });
}

// ---------------------------------------------------------------------------

function asRecord<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim()) result[key] = entry.trim();
  }
  return result;
}

export { boundedUnit, nonNegativeNumber };
