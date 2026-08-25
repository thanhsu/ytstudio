/**
 * Canon contracts. The canon is the authoritative representation of a story
 * universe; localized publications are renderings of it and never a source of
 * story truth. Everything here is English-only by construction — the canonical
 * language is a series field, but continuity reasoning only ever runs against
 * these records, never against localized prose.
 *
 * Storage: a canon series is a channel project, so its entities live at
 * `projects/<seriesId>/canon/*.json` and its chapters are ordinary
 * StoryProjects under `projects/<seriesId>/stories/chapter-NNN/`.
 *
 * Type names are prefixed `Canon*` because `src/audio-story.ts` (a deprecated
 * prototype of this feature) already exports StoryBible/StoryChapter/
 * StoryContinuityReport, and `src/story-arc.ts` already exports StoryArc.
 */

export type CanonProvenance = {
  provider: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
};

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

export type CanonSeriesStatus = "PLANNING" | "ACTIVE" | "PAUSED" | "COMPLETE";

/**
 * `story-series.json` — the sidecar that marks a channel project as a canon
 * series (the brand-kit pattern). The channel's own `story-channel.json` still
 * carries language/tts/visual settings; for a canon series its language is the
 * canonical one and it never publishes.
 */
export type CanonSeries = {
  version: 1;
  seriesId: string;
  title: string;
  workingTitle: string;
  /** Internal source-of-truth language. "en" for now; never assumed downstream. */
  canonicalLanguage: string;
  genre: string;
  subGenres: string[];
  tone: string;
  targetAudience: string;
  status: CanonSeriesStatus;
  targetChapterCount: number;
  /** Style guidance handed to the chapter writer verbatim. */
  styleProfile: string;
  budget: {
    maxCostPerChapterUsd: number;
    maxCostPerSeriesUsd: number;
  };
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Bible, characters, world
// ---------------------------------------------------------------------------

export type CanonFact = {
  id: string;
  text: string;
  /** Chapter that established it; 0 for facts authored during series design. */
  establishedInChapter: number;
};

export type CanonLocation = {
  id: string;
  name: string;
  description: string;
};

export type CanonObject = {
  id: string;
  name: string;
  description: string;
  /** Free text: where it is, who holds it, what condition it is in. */
  status: string;
};

export type CanonMysteryStatus = "OPEN" | "REVEALED";

export type CanonMystery = {
  id: string;
  question: string;
  status: CanonMysteryStatus;
  /** The planned answer. Never sent to the writer unless the arc allows it. */
  answer: string;
  revealedInChapter: number | null;
};

/**
 * The authoritative world description. Rule: CANON > MODEL CREATIVITY — when
 * generated prose contradicts this, the prose is rewritten, never the canon.
 *
 * `memory-apply` may only append to `worldRules`, `fixedFacts`, `locations`,
 * and `importantObjects`, and may only flip a mystery to REVEALED. Every other
 * field is authored by the series architect or a human.
 */
export type CanonBible = {
  version: 1;
  seriesId: string;
  premise: string;
  setting: string;
  worldRules: CanonFact[];
  fixedFacts: CanonFact[];
  locations: CanonLocation[];
  importantObjects: CanonObject[];
  mysteries: CanonMystery[];
  /** Constraints on how the series must end; the architect owns these. */
  endingConstraints: string[];
  revision: number;
  provenance?: CanonProvenance;
  updatedAt: string;
};

/** Fields `memory-apply` is permitted to append to. Anything else is rejected. */
export const BIBLE_APPENDABLE_FIELDS = [
  "worldRules",
  "fixedFacts",
  "locations",
  "importantObjects",
] as const;

export type BibleAppendableField = (typeof BIBLE_APPENDABLE_FIELDS)[number];

/**
 * A single thing a character knows. The lifecycle matters more than the text:
 * without `superseded`/`retracted`, an LLM extractor re-asserting a fact in
 * slightly different words accumulates duplicates that later read as
 * contradictions, and the continuity checker treats that mess as authoritative.
 */
export type CanonKnowledgeStatus = "active" | "superseded" | "retracted";

export type CanonKnowledge = {
  id: string;
  /** What is known, in one clause. */
  fact: string;
  /** Coarse subject key used to detect contradicting re-assertions. */
  subject: string;
  learnedInChapter: number;
  /** The event id that taught it. Knowledge with no source is rejected. */
  sourceEventId: string;
  status: CanonKnowledgeStatus;
  supersedes?: string;
};

export type CanonRelationship = {
  characterId: string;
  /** e.g. "sister", "distrusts", "owes a debt to". */
  relation: string;
  since: number;
};

export type CanonCharacterState = {
  currentLocation: string;
  emotionalState: string;
  health: string[];
  inventory: string[];
  relationships: CanonRelationship[];
  knowledge: CanonKnowledge[];
  secretsKnown: string[];
  goals: string[];
  /**
   * Rolled-up prose covering knowledge older than the retained window, so a
   * character's context stays bounded as the series grows past 40 chapters.
   */
  knowledgeSummary: string;
  /** Chapter the summary covers up to; deltas after it are kept verbatim. */
  summarizedThroughChapter: number;
};

export type CanonCharacterStaticProfile = {
  birthYear: number | null;
  appearance: string;
  personality: string[];
  background: string[];
};

export type CanonCharacter = {
  id: string;
  name: string;
  role: string;
  /** Immutable identity. `memory-apply` may never write here. */
  staticProfile: CanonCharacterStaticProfile;
  state: CanonCharacterState;
  /** Chapter after which the character is dead; the writer must respect it. */
  deceasedSinceChapter: number | null;
};

export type CanonCharacters = {
  version: 1;
  seriesId: string;
  characters: CanonCharacter[];
  revision: number;
  updatedAt: string;
};

export type CanonWorldState = {
  version: 1;
  seriesId: string;
  currentStoryTime: string;
  currentDate: string;
  /** locationId -> free-text current condition. */
  locations: Record<string, string>;
  activeThreats: string[];
  unresolvedMysteries: string[];
  revealedMysteries: string[];
  activeObjects: string[];
  environmentState: Record<string, string>;
  /** The chapter this state reflects; it is the state *after* that chapter. */
  asOfChapter: number;
  revision: number;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Arcs, threads, chapter cards
// ---------------------------------------------------------------------------

export type CanonArcStatus = "PLANNED" | "ACTIVE" | "COMPLETE" | "ABANDONED";

/**
 * A multi-chapter movement. `mustNotRevealYet` is the load-bearing field: it is
 * what stops a writer with good context from spending a twist ten chapters
 * early.
 */
export type CanonArc = {
  id: string;
  title: string;
  startChapter: number;
  targetEndChapter: number;
  goal: string;
  requiredReveals: string[];
  mustNotRevealYet: string[];
  /** characterId -> where they must end up by the arc's close. */
  characterProgression: Record<string, string>;
  requiredEvents: string[];
  endingHook: string;
  status: CanonArcStatus;
  /** Lightweight per-chapter concepts, generated when the arc is planned. */
  chapterCards: CanonChapterCard[];
};

export type CanonArcs = {
  version: 1;
  seriesId: string;
  arcs: CanonArc[];
  revision: number;
  updatedAt: string;
};

/** A cheap chapter concept. Prose is never generated at planning time. */
export type CanonChapterCard = {
  chapterNumber: number;
  goal: string;
  mainEvents: string[];
  characters: string[];
  locations: string[];
  requiredClues: string[];
  mustNotReveal: string[];
  endingHook: string;
  arcProgress: string;
};

export type CanonThreadStatus = "PLANNED" | "OPEN" | "DEVELOPING" | "RESOLVED" | "ABANDONED";

export type CanonThread = {
  id: string;
  title: string;
  status: CanonThreadStatus;
  introducedChapter: number;
  requiredResolutionArc: string;
  relatedCharacters: string[];
  relatedEvents: string[];
  notes: string;
};

export type CanonThreads = {
  version: 1;
  seriesId: string;
  threads: CanonThread[];
  revision: number;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Event ledger
// ---------------------------------------------------------------------------

export const CANON_EVENT_TYPES = [
  "CHARACTER_EVENT",
  "WORLD_EVENT",
  "CLUE_DISCOVERED",
  "MYSTERY_REVEALED",
  "RELATIONSHIP_CHANGE",
  "INJURY",
  "DEATH",
  "OBJECT_CHANGE",
  "LOCATION_CHANGE",
  "KNOWLEDGE_GAINED",
  "FORESHADOWING",
] as const;

export type CanonEventType = (typeof CANON_EVENT_TYPES)[number];

export function isCanonEventType(value: unknown): value is CanonEventType {
  return typeof value === "string" && (CANON_EVENT_TYPES as readonly string[]).includes(value);
}

export type CanonEvent = {
  /**
   * sha256(seriesId|chapterNumber|deltaIndex|payload). Content-addressed so a
   * crash between the ledger append and the stage's `done` write cannot
   * duplicate a chapter's events when the stage re-runs.
   */
  id: string;
  chapterNumber: number;
  eventType: CanonEventType;
  summary: string;
  characters: string[];
  locations: string[];
  /** 0..1. Drives retrieval ranking, so a flat 1.0 makes the term useless. */
  importance: number;
  /** In-world time, free text (e.g. "03:17", "the third night"). */
  storyTime: string;
  /** Typed values the alignment checker compares against, never re-parsed prose. */
  facts: CanonTypedFact[];
  at: string;
};

/**
 * A machine-comparable assertion extracted at canon time. The localization
 * alignment gate diffs against these, never against canon prose — re-extracting
 * from prose on both sides would compare two lossy parses instead of one.
 */
export type CanonTypedFactKind = "number" | "time" | "date" | "name";

export type CanonTypedFact = {
  id: string;
  kind: CanonTypedFactKind;
  /** What the value describes, e.g. "elevator opened at". */
  label: string;
  /** Canonical machine form: 317 for a number, "03:17", "2019-03-04", a name. */
  value: string;
};

/** A tombstone. Retracted events stay on disk but are invisible through the view. */
export type CanonRetraction = {
  type: "retract";
  targets: string[];
  reason: string;
  chapterNumber: number;
  at: string;
};

export type CanonLedgerRecord = ({ type: "event" } & CanonEvent) | CanonRetraction;

// ---------------------------------------------------------------------------
// Story memory / retrieval
// ---------------------------------------------------------------------------

export const MEMORY_ENTITY_TYPES = [
  "event",
  "chapter-summary",
  "character-fact",
  "plot-thread",
  "canon-fact",
  "location",
] as const;

export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

export type MemoryRecord = {
  id: string;
  seriesId: string;
  entityType: MemoryEntityType;
  entityId: string;
  chapterNumber: number;
  text: string;
  importance: number;
  metadata: {
    characters: string[];
    locations: string[];
    threads: string[];
  };
};

/** One vector row. The model and dimension are stamped so a model change is
 * detected rather than silently cosine-compared across incompatible spaces. */
export type MemoryVector = {
  id: string;
  embeddingModel: string;
  dim: number;
  values: number[];
};

/** Per-item scoring detail, exposed for debugging. Raw vectors never are. */
export type RetrievalScore = {
  record: MemoryRecord;
  keywordScore: number;
  vectorScore: number | null;
  importance: number;
  chapterDistance: number;
  finalScore: number;
  rank: number;
};

// ---------------------------------------------------------------------------
// Chapter artifacts
// ---------------------------------------------------------------------------

export type CanonChapterPlan = {
  version: 1;
  seriesId: string;
  chapterNumber: number;
  arcId: string;
  title: string;
  goal: string;
  beats: string[];
  characters: string[];
  locations: string[];
  requiredClues: string[];
  mustNotReveal: string[];
  endingHook: string;
  targetWords: number;
  provenance?: CanonProvenance;
};

/** One assembled context block, with the accounting the debugger shows. */
export type ContextBlockReport = {
  name: string;
  priority: number;
  dropRank: number;
  estimatedTokens: number;
  included: boolean;
  /** Items kept vs offered, for list blocks that shrank instead of dropping. */
  itemsKept: number;
  itemsOffered: number;
};

export type ContextReport = {
  version: 1;
  seriesId: string;
  chapterNumber: number;
  blocks: ContextBlockReport[];
  retrieved: RetrievalScore[];
  estimatedTokens: number;
  budgetTokens: number;
  /** Filled in after the write call so the estimator's error is measured. */
  actualPromptTokens: number | null;
  /** The assembled prompt body, so the operator sees exactly what the AI got. */
  text: string;
  builtAt: string;
};

export type CanonChapterArtifact = {
  version: 1;
  seriesId: string;
  chapterNumber: number;
  arcId: string;
  title: string;
  canonicalText: string;
  summary: string;
  wordCount: number;
  /** sha256 of canonicalText — the anchor every variant's canonRef binds to. */
  canonTextHash: string;
  provenance: CanonProvenance;
};

export type CanonContinuitySeverity = "ERROR" | "WARN";

export const CANON_CONTINUITY_ISSUE_TYPES = [
  "CHARACTER_IDENTITY",
  "CHARACTER_AGE",
  "APPEARANCE",
  "CHARACTER_KNOWLEDGE",
  "RELATIONSHIP",
  "TIMELINE",
  "LOCATION",
  "INVENTORY",
  "INJURY",
  "DEATH",
  "WORLD_RULE",
  "ESTABLISHED_FACT",
  "MYSTERY_STATE",
  "REVEAL_TIMING",
  "FORESHADOWING",
  "OPEN_THREAD",
] as const;

export type CanonContinuityIssueType = (typeof CANON_CONTINUITY_ISSUE_TYPES)[number];

export type CanonContinuityIssue = {
  severity: CanonContinuitySeverity;
  type: CanonContinuityIssueType;
  description: string;
  /** What in the canon it contradicts. Free text, but must not be empty. */
  canonReference: string;
  suggestedAction: "REWRITE" | "CLARIFY" | "ACCEPT";
};

/**
 * Loop state lives in the artifact, not on the StageRun: `attemptCount` there
 * counts stage *invocations*, so a rewrite loop inside one invocation is
 * invisible to it and a crash restarts the loop at zero.
 */
export type CanonContinuityAttempt = {
  n: number;
  model: string;
  issueCount: number;
  costUsd: number;
  at: string;
};

export type CanonContinuityReport = {
  version: 1;
  passed: boolean;
  issues: CanonContinuityIssue[];
  attempts: CanonContinuityAttempt[];
  /** Set when the loop gave up: no progress, or the ceiling was reached. */
  gaveUpReason: string | null;
  provenance?: CanonProvenance;
};

// ---------------------------------------------------------------------------
// Memory extraction
// ---------------------------------------------------------------------------

export type KnowledgeChangeType = "add" | "supersede" | "retract";

export type KnowledgeUpdate = {
  characterId: string;
  changeType: KnowledgeChangeType;
  fact: string;
  subject: string;
  /** Index into `newEvents` that taught it; resolved to an event id on apply. */
  sourceEventIndex: number | null;
  supersedes?: string;
};

export type CharacterStateUpdate = {
  characterId: string;
  currentLocation?: string;
  emotionalState?: string;
  addHealth?: string[];
  addInventory?: string[];
  removeInventory?: string[];
  addGoals?: string[];
  removeGoals?: string[];
  deceased?: boolean;
};

export type RelationshipUpdate = {
  characterId: string;
  otherCharacterId: string;
  relation: string;
};

export type WorldStateUpdate = {
  currentStoryTime?: string;
  currentDate?: string;
  setLocation?: { locationId: string; condition: string };
  addThreats?: string[];
  removeThreats?: string[];
  setEnvironment?: { key: string; value: string };
};

export type NewEventDelta = {
  eventType: CanonEventType;
  summary: string;
  characters: string[];
  locations: string[];
  importance: number;
  storyTime: string;
  facts: Array<Omit<CanonTypedFact, "id">>;
};

/**
 * What the extractor proposes. It is a *proposal*: `memory-apply` validates
 * every field against the existing canon and rejects rather than repairs, so a
 * sloppy small model degrades into rejected updates instead of corrupted state.
 */
export type CanonMemoryDelta = {
  version: 1;
  chapterNumber: number;
  newEvents: NewEventDelta[];
  newFacts: Array<{ field: BibleAppendableField; text: string }>;
  characterStateUpdates: CharacterStateUpdate[];
  knowledgeUpdates: KnowledgeUpdate[];
  relationshipUpdates: RelationshipUpdate[];
  worldStateUpdates: WorldStateUpdate[];
  newPlotThreads: Array<{ id: string; title: string; notes: string }>;
  resolvedPlotThreads: string[];
  foreshadowingAdded: string[];
  mysteriesRevealed: string[];
  provenance?: CanonProvenance;
};

export type MemoryRejection = {
  kind: string;
  detail: string;
  reason: string;
};

/** The applied result, written beside the delta so rejections are auditable. */
export type CanonMemoryReport = {
  version: 1;
  chapterNumber: number;
  delta: CanonMemoryDelta;
  appliedEventIds: string[];
  skippedEventIds: string[];
  rejections: MemoryRejection[];
  /** Health counters, so state degradation is visible before chapter 40. */
  health: {
    activeFacts: number;
    supersededFacts: number;
    retractedFacts: number;
  };
  appliedAt: string;
};

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

/**
 * Locale guidance. Not a registry: it lives inline on `story-channel.json`
 * beside the language/locale/pronunciations the channel already carries, so a
 * new locale is configuration and never code.
 */
export type LocaleNotes = {
  audience: string;
  spokenStyle: string;
  formality: string;
  avoid: string[];
  /**
   * Declared intentional divergence from canon — name respellings for TTS,
   * honorifics, unit conversions. Without this the alignment gate fires on the
   * very transformations localization is instructed to perform.
   */
  alignmentExemptions: string[];
};

export type LocalizeSectionAttempt = {
  sectionIndex: number;
  attemptCount: number;
  model: string;
  costUsd: number;
  lastIssue: string | null;
};

export type LocalizedReport = {
  version: 1;
  seriesId: string;
  chapterId: string;
  language: string;
  locale: string;
  sections: LocalizeSectionAttempt[];
  provenance: CanonProvenance;
};

export type AlignmentSeverity = "FAIL" | "WARN";

export type AlignmentIssue = {
  severity: AlignmentSeverity;
  kind: CanonTypedFactKind | "llm";
  /** The canon record this is anchored to. An unanchored issue is dropped. */
  canonAnchor: string;
  label: string;
  canonValue: string;
  localizedValue: string;
  sectionIndex: number;
  description: string;
};

export type CanonAlignmentReport = {
  version: 1;
  passed: boolean;
  issues: AlignmentIssue[];
  attempts: Array<{ n: number; failCount: number; at: string }>;
  gaveUpReason: string | null;
  /** Facts compared deterministically; the LLM pass only ever adds WARNs. */
  checkedFacts: number;
  provenance?: CanonProvenance;
};
