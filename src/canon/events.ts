import { sha256 } from "../project-state.ts";
import { appendJsonl, boundedUnit, canonPath, readJsonl, textList, textOr, withSeriesLock, wholeNumber } from "./store.ts";
import { isCanonEventType, type CanonEvent, type CanonLedgerRecord, type CanonTypedFact, type NewEventDelta } from "./types.ts";

/**
 * The event ledger: `projects/<seriesId>/canon/events.jsonl`, append-only.
 *
 * Append-only is the right shape for story history — an event happened, and
 * later chapters were written believing it — but a canon correction has to be
 * able to withdraw one. Rather than rewriting the file (which would destroy the
 * audit trail and race with readers), a retraction is itself a record, and
 * every reader goes through `loadEvents`, which applies them. That invariant is
 * the thing worth testing: a reader that touches the raw file sees ghosts.
 */

const EVENTS_FILE = "events.jsonl";

/**
 * Content-addressed id. `executeGuarded` re-runs any stage that is not `done`,
 * so a crash between the ledger append and the `done` write replays the whole
 * chapter's extraction; without a deterministic id that would duplicate every
 * event. With one, the replay is a no-op.
 */
export function eventIdFor(seriesId: string, chapterNumber: number, deltaIndex: number, payload: unknown): string {
  return sha256(`${seriesId}|${chapterNumber}|${deltaIndex}|${JSON.stringify(payload)}`).slice(0, 32);
}

export function buildEvent(
  seriesId: string,
  chapterNumber: number,
  deltaIndex: number,
  delta: NewEventDelta,
  now: string,
): CanonEvent {
  const payload = {
    eventType: delta.eventType,
    summary: delta.summary,
    characters: [...delta.characters].sort(),
    locations: [...delta.locations].sort(),
    storyTime: delta.storyTime,
  };
  const id = eventIdFor(seriesId, chapterNumber, deltaIndex, payload);
  return {
    id,
    chapterNumber,
    eventType: delta.eventType,
    summary: delta.summary,
    characters: delta.characters,
    locations: delta.locations,
    importance: boundedUnit(delta.importance, 0.5),
    storyTime: delta.storyTime,
    facts: delta.facts.map((fact, factIndex) => ({
      ...fact,
      id: `${id}-f${factIndex + 1}`,
    })),
    at: now,
  };
}

export async function appendEvents(seriesId: string, events: CanonEvent[]): Promise<{ appended: string[]; skipped: string[] }> {
  return withSeriesLock(seriesId, async () => {
    const existing = new Set((await readLedger(seriesId)).records.filter(isEventRecord).map((record) => record.id));
    const appended: string[] = [];
    const skipped: string[] = [];
    for (const event of events) {
      if (existing.has(event.id)) {
        skipped.push(event.id);
        continue;
      }
      await appendJsonl(canonPath(seriesId, EVENTS_FILE), { type: "event", ...event });
      existing.add(event.id);
      appended.push(event.id);
    }
    return { appended, skipped };
  });
}

export async function retractEvents(
  seriesId: string,
  targets: string[],
  reason: string,
  chapterNumber: number,
): Promise<number> {
  if (targets.length === 0) return 0;
  return withSeriesLock(seriesId, async () => {
    await appendJsonl(canonPath(seriesId, EVENTS_FILE), {
      type: "retract",
      targets,
      reason,
      chapterNumber,
      at: new Date().toISOString(),
    });
    return targets.length;
  });
}

export type LoadedEvents = {
  events: CanonEvent[];
  /** Ids withdrawn by a retraction record; kept so the UI can explain a gap. */
  retracted: string[];
  tornLines: number;
};

/**
 * THE reader. Applies retractions, so no caller can accidentally see a
 * withdrawn event. Nothing else in the codebase may read events.jsonl.
 */
export async function loadEvents(seriesId: string): Promise<LoadedEvents> {
  const ledger = await readLedger(seriesId);
  const retracted = new Set<string>();
  for (const record of ledger.records) {
    if (!isEventRecord(record) && record.type === "retract") {
      for (const target of record.targets) retracted.add(target);
    }
  }
  const seen = new Set<string>();
  const events: CanonEvent[] = [];
  for (const record of ledger.records) {
    if (!isEventRecord(record)) continue;
    if (retracted.has(record.id) || seen.has(record.id)) continue;
    seen.add(record.id);
    events.push(normalizeEvent(record));
  }
  return { events, retracted: [...retracted], tornLines: ledger.tornLines };
}

export type EventFilter = {
  characters?: string[];
  locations?: string[];
  fromChapter?: number;
  toChapter?: number;
  types?: string[];
  minImportance?: number;
};

export function filterEvents(events: CanonEvent[], filter: EventFilter): CanonEvent[] {
  return events.filter((event) => {
    if (filter.fromChapter !== undefined && event.chapterNumber < filter.fromChapter) return false;
    if (filter.toChapter !== undefined && event.chapterNumber > filter.toChapter) return false;
    if (filter.minImportance !== undefined && event.importance < filter.minImportance) return false;
    if (filter.types?.length && !filter.types.includes(event.eventType)) return false;
    if (filter.characters?.length && !filter.characters.some((id) => event.characters.includes(id))) return false;
    if (filter.locations?.length && !filter.locations.some((id) => event.locations.includes(id))) return false;
    return true;
  });
}

/** Every typed fact the alignment checker may compare a localization against. */
export function typedFactsForChapter(events: CanonEvent[], chapterNumber: number): CanonTypedFact[] {
  return events.filter((event) => event.chapterNumber === chapterNumber).flatMap((event) => event.facts);
}

export function eventsForChapter(events: CanonEvent[], chapterNumber: number): CanonEvent[] {
  return events.filter((event) => event.chapterNumber === chapterNumber);
}

async function readLedger(seriesId: string): Promise<{ records: CanonLedgerRecord[]; tornLines: number }> {
  const result = await readJsonl<CanonLedgerRecord>(canonPath(seriesId, EVENTS_FILE));
  return { records: result.records.filter(Boolean), tornLines: result.tornLines };
}

function isEventRecord(record: CanonLedgerRecord): record is { type: "event" } & CanonEvent {
  return (record as { type?: string }).type === "event";
}

function normalizeEvent(record: { type: "event" } & CanonEvent): CanonEvent {
  return {
    id: record.id,
    chapterNumber: wholeNumber(record.chapterNumber, 0),
    eventType: isCanonEventType(record.eventType) ? record.eventType : "WORLD_EVENT",
    summary: textOr(record.summary, ""),
    characters: textList(record.characters),
    locations: textList(record.locations),
    importance: boundedUnit(record.importance, 0.5),
    storyTime: textOr(record.storyTime, ""),
    facts: Array.isArray(record.facts) ? record.facts.filter((fact) => fact && typeof fact.value === "string") : [],
    at: textOr(record.at, new Date(0).toISOString()),
  };
}
