import { normalizeText } from "../story-factory/fingerprint.ts";
import { activeKnowledge, loadArcs, loadBible, loadCharacters, loadThreads, loadWorldState, updateBible, updateCharacters, updateThreads, updateWorldState } from "./entities.ts";
import { appendEvents, buildEvent, loadEvents, retractEvents } from "./events.ts";
import { memoryIdFor, upsertMemoryRecords } from "./memory.ts";
import { slugId } from "./store.ts";
import { BIBLE_APPENDABLE_FIELDS } from "./types.ts";
import type {
  BibleAppendableField,
  CanonCharacter,
  CanonEvent,
  CanonKnowledge,
  CanonMemoryDelta,
  CanonMemoryReport,
  MemoryRecord,
  MemoryRejection,
} from "./types.ts";

/**
 * The validation layer between an LLM's proposal and the canon.
 *
 * The extractor is a *proposal*, not an authority. Referential checks alone are
 * not enough: a duplicate fact ("Elena knows about the key") and a contradicting
 * one ("Elena learned of the key") both pass a foreign-key test and both
 * accumulate. The continuity checker then treats mutually contradictory state
 * as authoritative and either fires spurious errors forever or silently picks
 * one. That is the concrete mechanism by which a small local model degrades a
 * series into noise over 40 chapters.
 *
 * So this module REJECTS rather than repairs, and every rejection is recorded.
 * A degraded extractor produces a growing rejection list — visible, diagnosable
 * — instead of quietly corrupted canon.
 */

export type ApplyMemoryOptions = {
  seriesId: string;
  chapterNumber: number;
  delta: CanonMemoryDelta;
  /** Text used to build the retrievable memory records. */
  chapterSummary: string;
  now?: () => string;
};

export async function applyMemoryDelta(options: ApplyMemoryOptions): Promise<CanonMemoryReport> {
  const { seriesId, chapterNumber, delta } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const rejections: MemoryRejection[] = [];

  const [characters, bible, threads, arcs, worldState, ledger] = await Promise.all([
    loadCharacters(seriesId),
    loadBible(seriesId),
    loadThreads(seriesId),
    loadArcs(seriesId),
    loadWorldState(seriesId),
    loadEvents(seriesId),
  ]);
  void arcs;

  const knownCharacters = new Set(characters.characters.map((character) => character.id));
  const knownLocations = new Set(bible.locations.map((location) => location.id));

  // Re-applying a chapter must first withdraw what its previous run asserted,
  // or the ledger accumulates two contradictory versions of the same events and
  // retrieval serves both.
  const previous = ledger.events.filter((event) => event.chapterNumber === chapterNumber);
  const rebuiltIds = new Set<string>();

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  const events: CanonEvent[] = [];
  for (const [index, candidate] of delta.newEvents.entries()) {
    const unknownCharacter = candidate.characters.find((id) => !knownCharacters.has(id));
    if (unknownCharacter) {
      rejections.push({
        kind: "event",
        detail: candidate.summary,
        reason: `names a character the canon does not have: ${unknownCharacter}`,
      });
      continue;
    }
    const unknownLocation = candidate.locations.find((id) => !knownLocations.has(id));
    if (unknownLocation) {
      rejections.push({
        kind: "event",
        detail: candidate.summary,
        reason: `names a location the canon does not have: ${unknownLocation}`,
      });
      continue;
    }
    if (!candidate.summary.trim()) {
      rejections.push({ kind: "event", detail: "(empty)", reason: "an event needs a summary" });
      continue;
    }
    const event = buildEvent(seriesId, chapterNumber, index, candidate, now());
    events.push(event);
    rebuiltIds.add(event.id);
  }

  // Withdraw only what this chapter previously asserted and no longer does.
  const stale = previous.filter((event) => !rebuiltIds.has(event.id)).map((event) => event.id);
  if (stale.length > 0) {
    await retractEvents(seriesId, stale, `chapter ${chapterNumber} memory re-applied`, chapterNumber);
  }
  const { appended, skipped } = await appendEvents(seriesId, events);
  const eventById = new Map(events.map((event) => [event.id, event]));

  // -------------------------------------------------------------------------
  // Character state and knowledge
  // -------------------------------------------------------------------------
  await updateCharacters(seriesId, (current) => {
    const next = { ...current, characters: current.characters.map((character) => ({ ...character })) };
    const byId = new Map(next.characters.map((character) => [character.id, character]));

    for (const update of delta.characterStateUpdates) {
      const character = byId.get(update.characterId);
      if (!character) {
        rejections.push({
          kind: "character-state",
          detail: update.characterId,
          reason: "no such character in the canon",
        });
        continue;
      }
      character.state = { ...character.state };
      if (update.currentLocation) character.state.currentLocation = update.currentLocation;
      if (update.emotionalState) character.state.emotionalState = update.emotionalState;
      if (update.addHealth?.length) character.state.health = unique([...character.state.health, ...update.addHealth]);
      if (update.addInventory?.length) {
        character.state.inventory = unique([...character.state.inventory, ...update.addInventory]);
      }
      if (update.removeInventory?.length) {
        const removing = new Set(update.removeInventory.map(normalizeText));
        character.state.inventory = character.state.inventory.filter((item) => !removing.has(normalizeText(item)));
      }
      if (update.addGoals?.length) character.state.goals = unique([...character.state.goals, ...update.addGoals]);
      if (update.removeGoals?.length) {
        const removing = new Set(update.removeGoals.map(normalizeText));
        character.state.goals = character.state.goals.filter((goal) => !removing.has(normalizeText(goal)));
      }
      if (update.deceased === true && character.deceasedSinceChapter === null) {
        character.deceasedSinceChapter = chapterNumber;
      }
    }

    for (const update of delta.knowledgeUpdates) {
      const character = byId.get(update.characterId);
      if (!character) {
        rejections.push({
          kind: "knowledge",
          detail: `${update.characterId}: ${update.fact}`,
          reason: "no such character in the canon",
        });
        continue;
      }
      applyKnowledgeUpdate(character, update, {
        chapterNumber,
        events,
        eventById,
        rejections,
      });
    }

    for (const update of delta.relationshipUpdates) {
      const character = byId.get(update.characterId);
      if (!character) {
        rejections.push({
          kind: "relationship",
          detail: update.characterId,
          reason: "no such character in the canon",
        });
        continue;
      }
      if (!byId.has(update.otherCharacterId)) {
        rejections.push({
          kind: "relationship",
          detail: `${update.characterId} -> ${update.otherCharacterId}`,
          reason: "the other character is not in the canon",
        });
        continue;
      }
      const existing = character.state.relationships.find(
        (entry) => entry.characterId === update.otherCharacterId,
      );
      if (existing) {
        existing.relation = update.relation;
      } else {
        character.state.relationships = [
          ...character.state.relationships,
          { characterId: update.otherCharacterId, relation: update.relation, since: chapterNumber },
        ];
      }
    }
    return next;
  });

  // -------------------------------------------------------------------------
  // World state
  // -------------------------------------------------------------------------
  await updateWorldState(seriesId, (current) => {
    const next = { ...current, locations: { ...current.locations }, environmentState: { ...current.environmentState } };
    for (const update of delta.worldStateUpdates) {
      if (update.currentStoryTime) next.currentStoryTime = update.currentStoryTime;
      if (update.currentDate) next.currentDate = update.currentDate;
      if (update.setLocation) {
        if (!knownLocations.has(update.setLocation.locationId)) {
          rejections.push({
            kind: "world-state",
            detail: update.setLocation.locationId,
            reason: "no such location in the canon",
          });
        } else {
          next.locations[update.setLocation.locationId] = update.setLocation.condition;
        }
      }
      if (update.addThreats?.length) next.activeThreats = unique([...next.activeThreats, ...update.addThreats]);
      if (update.removeThreats?.length) {
        const removing = new Set(update.removeThreats.map(normalizeText));
        next.activeThreats = next.activeThreats.filter((threat) => !removing.has(normalizeText(threat)));
      }
      if (update.setEnvironment) next.environmentState[update.setEnvironment.key] = update.setEnvironment.value;
    }
    // World state describes the world AFTER the most recent canon chapter.
    next.asOfChapter = Math.max(next.asOfChapter, chapterNumber);
    return next;
  });

  // -------------------------------------------------------------------------
  // Bible: append-only, and only to the sanctioned fields
  // -------------------------------------------------------------------------
  const allowedBibleFields = new Set<string>(BIBLE_APPENDABLE_FIELDS);
  const bibleAdditions = delta.newFacts.filter((fact) => {
    if (!allowedBibleFields.has(fact.field)) {
      rejections.push({
        kind: "bible",
        detail: `${fact.field}: ${fact.text}`,
        reason: `the memory extractor may only append to ${[...allowedBibleFields].join(", ")}`,
      });
      return false;
    }
    return true;
  });
  if (bibleAdditions.length > 0) {
    await updateBible(seriesId, (current) => {
      const next = { ...current };
      for (const addition of bibleAdditions) {
        const field = addition.field as BibleAppendableField;
        if (field === "worldRules" || field === "fixedFacts") {
          const existing = next[field];
          const normalized = normalizeText(addition.text);
          if (existing.some((entry) => normalizeText(entry.text) === normalized)) continue;
          next[field] = [
            ...existing,
            { id: slugId(addition.text, `${field}-${existing.length + 1}`), text: addition.text, establishedInChapter: chapterNumber },
          ];
        }
        // locations and importantObjects need structure the extractor does not
        // produce; a bare string is refused rather than guessed at.
        if (field === "locations" || field === "importantObjects") {
          rejections.push({
            kind: "bible",
            detail: `${field}: ${addition.text}`,
            reason: "new locations and objects must be authored with structure, not extracted from prose",
          });
        }
      }
      return next;
    });
  }

  // Mysteries may only be flipped to REVEALED, never invented or re-hidden.
  if (delta.mysteriesRevealed.length > 0) {
    await updateBible(seriesId, (current) => {
      const known = new Map(current.mysteries.map((mystery) => [mystery.id, mystery]));
      for (const id of delta.mysteriesRevealed) {
        const mystery = known.get(id);
        if (!mystery) {
          rejections.push({ kind: "mystery", detail: id, reason: "no such mystery in the canon" });
          continue;
        }
        if (mystery.status === "REVEALED") continue;
        mystery.status = "REVEALED";
        mystery.revealedInChapter = chapterNumber;
      }
      return { ...current, mysteries: [...known.values()] };
    });
  }

  // -------------------------------------------------------------------------
  // Plot threads
  // -------------------------------------------------------------------------
  if (delta.newPlotThreads.length > 0 || delta.resolvedPlotThreads.length > 0) {
    await updateThreads(seriesId, (current) => {
      const byId = new Map(current.threads.map((thread) => [thread.id, { ...thread }]));
      for (const candidate of delta.newPlotThreads) {
        const id = candidate.id || slugId(candidate.title, `thread-${byId.size + 1}`);
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          title: candidate.title,
          status: "OPEN",
          introducedChapter: chapterNumber,
          requiredResolutionArc: "",
          relatedCharacters: [],
          relatedEvents: [...rebuiltIds],
          notes: candidate.notes,
        });
      }
      for (const id of delta.resolvedPlotThreads) {
        const thread = byId.get(id);
        if (!thread) {
          rejections.push({ kind: "plot-thread", detail: id, reason: "no such plot thread in the canon" });
          continue;
        }
        thread.status = "RESOLVED";
      }
      return { ...current, threads: [...byId.values()] };
    });
  }
  void threads;

  // -------------------------------------------------------------------------
  // Retrievable memory records
  // -------------------------------------------------------------------------
  const memoryRecords: MemoryRecord[] = events.map((event) => ({
    id: memoryIdFor("event", event.id),
    seriesId,
    entityType: "event",
    entityId: event.id,
    chapterNumber,
    text: event.summary,
    importance: event.importance,
    metadata: { characters: event.characters, locations: event.locations, threads: [] },
  }));
  if (options.chapterSummary.trim()) {
    memoryRecords.push({
      id: memoryIdFor("chapter-summary", String(chapterNumber)),
      seriesId,
      entityType: "chapter-summary",
      entityId: String(chapterNumber),
      chapterNumber,
      text: options.chapterSummary.trim(),
      importance: 0.7,
      metadata: {
        characters: unique(events.flatMap((event) => event.characters)),
        locations: unique(events.flatMap((event) => event.locations)),
        threads: [],
      },
    });
  }
  await upsertMemoryRecords(seriesId, memoryRecords);

  const finalCharacters = await loadCharacters(seriesId);
  return {
    version: 1,
    chapterNumber,
    delta,
    appliedEventIds: appended,
    skippedEventIds: skipped,
    rejections,
    health: knowledgeHealth(finalCharacters.characters),
    appliedAt: now(),
  };
}

/**
 * A knowledge delta is only accepted when it says what KIND of change it is and
 * where the knowledge came from. Two rules do the real work:
 *
 * - An `add` whose subject already has an active fact is refused. That is the
 *   contradiction case: without it, "Elena knows the key exists" and "Elena
 *   does not know about the key" coexist and the checker cannot tell which is
 *   canon.
 * - Knowledge with no source event is refused outright. A character knowing
 *   something no scene taught them is the single most common continuity bug in
 *   generated fiction, and it is trivially detectable right here.
 */
function applyKnowledgeUpdate(
  character: CanonCharacter,
  update: CanonMemoryDelta["knowledgeUpdates"][number],
  context: {
    chapterNumber: number;
    events: CanonEvent[];
    eventById: Map<string, CanonEvent>;
    rejections: MemoryRejection[];
  },
): void {
  const { rejections } = context;
  const label = `${character.id}: ${update.fact}`;

  if (update.changeType === "retract") {
    const target = character.state.knowledge.find((entry) => entry.id === update.supersedes);
    if (!target) {
      rejections.push({ kind: "knowledge", detail: label, reason: "retract names no existing fact" });
      return;
    }
    target.status = "retracted";
    return;
  }

  const sourceEvent =
    update.sourceEventIndex !== null && update.sourceEventIndex !== undefined
      ? context.events[update.sourceEventIndex]
      : undefined;
  if (!sourceEvent) {
    rejections.push({
      kind: "knowledge",
      detail: label,
      reason: "knowledge must name the event that taught it; a character cannot learn from nothing",
    });
    return;
  }
  if (!sourceEvent.characters.includes(character.id)) {
    rejections.push({
      kind: "knowledge",
      detail: label,
      reason: `the source event does not involve ${character.id}, so they were not there to learn it`,
    });
    return;
  }

  const subject = update.subject.trim() || slugId(update.fact, "subject");
  const active = activeKnowledge(character);
  const normalizedFact = normalizeText(update.fact);

  if (update.changeType === "supersede") {
    const target = character.state.knowledge.find((entry) => entry.id === update.supersedes);
    if (!target) {
      rejections.push({
        kind: "knowledge",
        detail: label,
        reason: "supersede must name the fact it replaces",
      });
      return;
    }
    target.status = "superseded";
  } else {
    // add
    if (active.some((entry) => normalizeText(entry.fact) === normalizedFact)) {
      // An exact restatement is a no-op, not an error: extractors repeat
      // themselves across chapters and that is harmless.
      return;
    }
    const conflicting = active.find((entry) => entry.subject === subject);
    if (conflicting) {
      rejections.push({
        kind: "knowledge",
        detail: label,
        reason:
          `${character.id} already knows something about "${subject}" ` +
          `("${conflicting.fact}"). Use supersede with the fact id, not add.`,
      });
      return;
    }
  }

  const entry: CanonKnowledge = {
    id: `${sourceEvent.id}-k${character.state.knowledge.length + 1}`,
    fact: update.fact,
    subject,
    learnedInChapter: context.chapterNumber,
    sourceEventId: sourceEvent.id,
    status: "active",
    ...(update.supersedes ? { supersedes: update.supersedes } : {}),
  };
  character.state.knowledge = [...character.state.knowledge, entry];
}

/** Counters so state degradation is visible long before chapter 40. */
function knowledgeHealth(characters: CanonCharacter[]): CanonMemoryReport["health"] {
  let activeFacts = 0;
  let supersededFacts = 0;
  let retractedFacts = 0;
  for (const character of characters) {
    for (const entry of character.state.knowledge) {
      if (entry.status === "active") activeFacts += 1;
      else if (entry.status === "superseded") supersededFacts += 1;
      else retractedFacts += 1;
    }
  }
  return { activeFacts, supersededFacts, retractedFacts };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
