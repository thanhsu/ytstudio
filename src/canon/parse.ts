import {
  optionalStringArray,
  parseJsonObject,
  requireObject,
  requireText,
  requireStringArray,
} from "../llm/parse.ts";
import { boundedUnit, slugId, textList, textOr, wholeNumber } from "./store.ts";
import { isCanonEventType } from "./types.ts";
import type {
  CanonArc,
  CanonChapterCard,
  CanonCharacter,
  CanonContinuityIssue,
  CanonContinuityReport,
  CanonMemoryDelta,
  CanonTypedFact,
  NewEventDelta,
} from "./types.ts";

/**
 * Parsers for canon LLM output. Every one validates BEFORE anything is written,
 * so a malformed response leaves no artifact behind — the rule `runLlmCall`
 * already enforces for the story factory.
 */

/**
 * Raised when the writer reports it cannot write the chapter without inventing
 * canon. This is a success of the design, not a failure: a paused chapter costs
 * one retry, while a hallucinated canon fact is permanent and every later
 * chapter inherits it.
 */
export class ContextGapError extends Error {
  readonly missing: string[];
  readonly question: string;

  constructor(missing: string[], question: string) {
    super(
      `The chapter writer reported missing context: ${missing.join("; ")}` +
        (question ? ` (${question})` : ""),
    );
    this.name = "ContextGapError";
    this.missing = missing;
    this.question = question;
  }
}

export type ParsedChapter = { title: string; text: string; summary: string };

export function parseChapter(raw: string): ParsedChapter {
  const payload = parseJsonObject(raw);
  // The gap check runs first: a response carrying a gap must not be salvaged
  // for whatever prose it happened to include alongside it.
  const gap = payload.contextGap;
  if (gap && typeof gap === "object") {
    const record = gap as { missing?: unknown; question?: unknown };
    const missing = optionalStringArray(record.missing, "contextGap.missing");
    const question = typeof record.question === "string" ? record.question : "";
    if (missing.length > 0 || question) {
      throw new ContextGapError(missing, question);
    }
  }
  return {
    title: requireText(payload.title, "title"),
    text: requireText(payload.text, "text"),
    summary: requireText(payload.summary, "summary"),
  };
}

export type ParsedPlan = {
  title: string;
  goal: string;
  beats: string[];
  characters: string[];
  locations: string[];
  requiredClues: string[];
  mustNotReveal: string[];
  endingHook: string;
  targetWords: number;
};

export function parseChapterPlan(raw: string): ParsedPlan {
  const payload = parseJsonObject(raw);
  return {
    title: requireText(payload.title, "title"),
    goal: requireText(payload.goal, "goal"),
    beats: requireStringArray(payload.beats, "beats"),
    characters: optionalStringArray(payload.characters, "characters"),
    locations: optionalStringArray(payload.locations, "locations"),
    requiredClues: optionalStringArray(payload.requiredClues, "requiredClues"),
    mustNotReveal: optionalStringArray(payload.mustNotReveal, "mustNotReveal"),
    endingHook: textOr(payload.endingHook, ""),
    targetWords: wholeNumber(payload.targetWords, 1800),
  };
}

export function parseContinuityReport(raw: string): Omit<CanonContinuityReport, "attempts" | "gaveUpReason"> {
  const payload = parseJsonObject(raw);
  // An EMPTY issues array is the correct answer for a clean chapter, so this
  // cannot use requireArray — that helper rejects empty arrays, which would
  // make every passing continuity check fail to parse.
  const rawIssues = Array.isArray(payload.issues) ? payload.issues : [];
  const issues = rawIssues.map((entry, index) => {
    const record = requireObject(entry, `issues[${index}]`);
    const severity = record.severity === "ERROR" ? "ERROR" : "WARN";
    const action = record.suggestedAction;
    const issue: CanonContinuityIssue = {
      severity,
      type: (textOr(record.type, "ESTABLISHED_FACT") as CanonContinuityIssue["type"]),
      description: requireText(record.description, `issues[${index}].description`),
      canonReference: textOr(record.canonReference, ""),
      suggestedAction: action === "CLARIFY" || action === "ACCEPT" ? action : "REWRITE",
    };
    return issue;
  });
  // `passed` is derived, never trusted: a model that reports errors and then
  // claims to have passed would otherwise wave its own contradictions through.
  return {
    version: 1,
    passed: !issues.some((issue) => issue.severity === "ERROR"),
    issues,
  };
}

export function parseMemoryDelta(raw: string, chapterNumber: number): CanonMemoryDelta {
  const payload = parseJsonObject(raw);
  return {
    version: 1,
    chapterNumber,
    newEvents: parseEvents(payload.newEvents),
    newFacts: parseNewFacts(payload.newFacts),
    characterStateUpdates: parseCharacterStateUpdates(payload.characterStateUpdates),
    knowledgeUpdates: parseKnowledgeUpdates(payload.knowledgeUpdates),
    relationshipUpdates: parseRelationshipUpdates(payload.relationshipUpdates),
    worldStateUpdates: parseWorldStateUpdates(payload.worldStateUpdates),
    newPlotThreads: parseNewThreads(payload.newPlotThreads),
    resolvedPlotThreads: optionalStringArray(payload.resolvedPlotThreads, "resolvedPlotThreads"),
    foreshadowingAdded: optionalStringArray(payload.foreshadowingAdded, "foreshadowingAdded"),
    mysteriesRevealed: optionalStringArray(payload.mysteriesRevealed, "mysteriesRevealed"),
  };
}

function parseEvents(value: unknown): NewEventDelta[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const summary = textOr(record.summary, "");
      if (!summary) return null;
      return {
        eventType: isCanonEventType(record.eventType) ? record.eventType : "WORLD_EVENT",
        summary,
        characters: textList(record.characters),
        locations: textList(record.locations),
        importance: boundedUnit(record.importance, 0.5),
        storyTime: textOr(record.storyTime, ""),
        facts: parseTypedFacts(record.facts),
      } satisfies NewEventDelta;
    })
    .filter((entry): entry is NewEventDelta => entry !== null);
}

function parseTypedFacts(value: unknown): Array<Omit<CanonTypedFact, "id">> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const rawValue = textOr(record.value, "");
      const label = textOr(record.label, "");
      if (!rawValue || !label) return null;
      const kind = record.kind;
      if (kind !== "number" && kind !== "time" && kind !== "date" && kind !== "name") return null;
      return { kind, label, value: rawValue };
    })
    .filter((entry): entry is Omit<CanonTypedFact, "id"> => entry !== null);
}

function parseNewFacts(value: unknown): CanonMemoryDelta["newFacts"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const text = textOr(record.text, "");
      const field = textOr(record.field, "");
      if (!text || !field) return null;
      // The field is passed through unvalidated on purpose: memory-apply owns
      // the allowlist and records a rejection, which is how a misbehaving
      // extractor becomes visible instead of silently filtered here.
      return { field: field as CanonMemoryDelta["newFacts"][number]["field"], text };
    })
    .filter((entry): entry is CanonMemoryDelta["newFacts"][number] => entry !== null);
}

function parseCharacterStateUpdates(value: unknown): CanonMemoryDelta["characterStateUpdates"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const characterId = textOr(record.characterId, "");
      if (!characterId) return null;
      return {
        characterId,
        ...(record.currentLocation ? { currentLocation: textOr(record.currentLocation, "") } : {}),
        ...(record.emotionalState ? { emotionalState: textOr(record.emotionalState, "") } : {}),
        ...(record.addHealth ? { addHealth: textList(record.addHealth) } : {}),
        ...(record.addInventory ? { addInventory: textList(record.addInventory) } : {}),
        ...(record.removeInventory ? { removeInventory: textList(record.removeInventory) } : {}),
        ...(record.addGoals ? { addGoals: textList(record.addGoals) } : {}),
        ...(record.removeGoals ? { removeGoals: textList(record.removeGoals) } : {}),
        ...(record.deceased === true ? { deceased: true } : {}),
      };
    })
    .filter((entry): entry is CanonMemoryDelta["characterStateUpdates"][number] => entry !== null);
}

function parseKnowledgeUpdates(value: unknown): CanonMemoryDelta["knowledgeUpdates"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const characterId = textOr(record.characterId, "");
      const fact = textOr(record.fact, "");
      if (!characterId || !fact) return null;
      const changeType = record.changeType;
      const sourceIndex = Number(record.sourceEventIndex);
      return {
        characterId,
        changeType:
          changeType === "supersede" || changeType === "retract" ? changeType : ("add" as const),
        fact,
        subject: textOr(record.subject, slugId(fact, "subject")),
        sourceEventIndex: Number.isInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : null,
        ...(record.supersedes ? { supersedes: textOr(record.supersedes, "") } : {}),
      };
    })
    .filter((entry): entry is CanonMemoryDelta["knowledgeUpdates"][number] => entry !== null);
}

function parseRelationshipUpdates(value: unknown): CanonMemoryDelta["relationshipUpdates"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const characterId = textOr(record.characterId, "");
      const otherCharacterId = textOr(record.otherCharacterId, "");
      const relation = textOr(record.relation, "");
      if (!characterId || !otherCharacterId || !relation) return null;
      return { characterId, otherCharacterId, relation };
    })
    .filter((entry): entry is CanonMemoryDelta["relationshipUpdates"][number] => entry !== null);
}

function parseWorldStateUpdates(value: unknown): CanonMemoryDelta["worldStateUpdates"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const setLocation =
        record.setLocation && typeof record.setLocation === "object"
          ? (record.setLocation as Record<string, unknown>)
          : null;
      return {
        ...(record.currentStoryTime ? { currentStoryTime: textOr(record.currentStoryTime, "") } : {}),
        ...(record.currentDate ? { currentDate: textOr(record.currentDate, "") } : {}),
        ...(setLocation && textOr(setLocation.locationId, "")
          ? {
              setLocation: {
                locationId: textOr(setLocation.locationId, ""),
                condition: textOr(setLocation.condition, ""),
              },
            }
          : {}),
        ...(record.addThreats ? { addThreats: textList(record.addThreats) } : {}),
        ...(record.removeThreats ? { removeThreats: textList(record.removeThreats) } : {}),
      };
    })
    .filter((entry): entry is CanonMemoryDelta["worldStateUpdates"][number] => entry !== null);
}

function parseNewThreads(value: unknown): CanonMemoryDelta["newPlotThreads"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const title = textOr(record.title, "");
      if (!title) return null;
      return { id: textOr(record.id, slugId(title, "thread")), title, notes: textOr(record.notes, "") };
    })
    .filter((entry): entry is CanonMemoryDelta["newPlotThreads"][number] => entry !== null);
}

// ---------------------------------------------------------------------------
// Series design
// ---------------------------------------------------------------------------

export function parseSeriesBible(raw: string): {
  premise: string;
  setting: string;
  worldRules: string[];
  fixedFacts: string[];
  locations: Array<{ name: string; description: string }>;
  importantObjects: Array<{ name: string; description: string; status: string }>;
  mysteries: Array<{ question: string; answer: string }>;
  endingConstraints: string[];
} {
  const payload = parseJsonObject(raw);
  return {
    premise: requireText(payload.premise, "premise"),
    setting: requireText(payload.setting, "setting"),
    worldRules: optionalStringArray(payload.worldRules, "worldRules"),
    fixedFacts: optionalStringArray(payload.fixedFacts, "fixedFacts"),
    locations: namedList(payload.locations).map((entry) => ({
      name: entry.name,
      description: textOr(entry.record.description, ""),
    })),
    importantObjects: namedList(payload.importantObjects).map((entry) => ({
      name: entry.name,
      description: textOr(entry.record.description, ""),
      status: textOr(entry.record.status, ""),
    })),
    mysteries: (Array.isArray(payload.mysteries) ? payload.mysteries : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const question = textOr(record.question, "");
        if (!question) return null;
        return { question, answer: textOr(record.answer, "") };
      })
      .filter((entry): entry is { question: string; answer: string } => entry !== null),
    endingConstraints: optionalStringArray(payload.endingConstraints, "endingConstraints"),
  };
}

export function parseSeriesCharacters(raw: string): CanonCharacter[] {
  const payload = parseJsonObject(raw);
  return namedList(payload.characters).map((entry, index) => {
    const record = entry.record;
    const birthYear = Number(record.birthYear);
    return {
      id: slugId(entry.name, `character-${index + 1}`),
      name: entry.name,
      role: textOr(record.role, ""),
      staticProfile: {
        birthYear: Number.isFinite(birthYear) && birthYear > 0 ? Math.floor(birthYear) : null,
        appearance: textOr(record.appearance, ""),
        personality: textList(record.personality),
        background: textList(record.background),
      },
      state: {
        currentLocation: textOr(record.startingLocation, ""),
        emotionalState: "",
        health: [],
        inventory: [],
        relationships: [],
        knowledge: [],
        secretsKnown: [],
        goals: textList(record.startingGoals),
        knowledgeSummary: "",
        summarizedThroughChapter: 0,
      },
      deceasedSinceChapter: null,
    } satisfies CanonCharacter;
  });
}

export function parseSeriesArcs(raw: string): CanonArc[] {
  const payload = parseJsonObject(raw);
  const arcs = Array.isArray(payload.arcs) ? payload.arcs : [];
  return arcs
    .map((entry, index): CanonArc | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const title = textOr(record.title, "");
      if (!title) return null;
      return {
        id: slugId(title, `arc-${index + 1}`),
        title,
        startChapter: wholeNumber(record.startChapter, 1),
        targetEndChapter: wholeNumber(record.targetEndChapter, 1),
        goal: textOr(record.goal, ""),
        requiredReveals: textList(record.requiredReveals),
        mustNotRevealYet: textList(record.mustNotRevealYet),
        characterProgression: {},
        requiredEvents: textList(record.requiredEvents),
        endingHook: textOr(record.endingHook, ""),
        status: "PLANNED" as const,
        chapterCards: parseChapterCards(record.chapterCards),
      };
    })
    .filter((entry): entry is CanonArc => entry !== null);
}

function parseChapterCards(value: unknown): CanonChapterCard[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
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
      } satisfies CanonChapterCard;
    })
    .filter((entry): entry is CanonChapterCard => entry !== null)
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
}

function namedList(value: unknown): Array<{ name: string; record: Record<string, unknown> }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const name = textOr(record.name, "");
      return name ? { name, record } : null;
    })
    .filter((entry): entry is { name: string; record: Record<string, unknown> } => entry !== null);
}
