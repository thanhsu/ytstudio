import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBible, loadCharacters, loadThreads, loadWorldState, updateBible, updateCharacters, updateThreads } from "../src/canon/entities.ts";
import { loadEvents } from "../src/canon/events.ts";
import { applyMemoryDelta } from "../src/canon/memory-apply.ts";
import { loadMemoryRecords } from "../src/canon/memory.ts";
import type { CanonMemoryDelta } from "../src/canon/types.ts";

const SERIES = "missing-floor";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-canon-memory-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function seedCanon(): Promise<void> {
  await updateBible(SERIES, (current) => ({
    ...current,
    premise: "A hotel whose third floor appears at night.",
    setting: "Hotel Rivera, Mexico City",
    locations: [
      { id: "hotel-elevator", name: "The elevator", description: "Brass doors, one button too many." },
      { id: "room-307", name: "Room 307", description: "Should not exist." },
    ],
    mysteries: [
      { id: "why-307", question: "Why does Room 307 appear?", status: "OPEN", answer: "The hotel remembers.", revealedInChapter: null },
    ],
  }));
  await updateCharacters(SERIES, (current) => ({
    ...current,
    characters: [
      {
        id: "maria",
        name: "María Torres",
        role: "night auditor",
        staticProfile: { birthYear: 1998, appearance: "", personality: [], background: [] },
        state: {
          currentLocation: "hotel-elevator",
          emotionalState: "wary",
          health: [],
          inventory: [],
          relationships: [],
          knowledge: [],
          secretsKnown: [],
          goals: [],
          knowledgeSummary: "",
          summarizedThroughChapter: 0,
        },
        deceasedSinceChapter: null,
      },
      {
        id: "diego",
        name: "Diego Ruiz",
        role: "guest",
        staticProfile: { birthYear: 1990, appearance: "", personality: [], background: [] },
        state: {
          currentLocation: "hotel-elevator",
          emotionalState: "calm",
          health: [],
          inventory: [],
          relationships: [],
          knowledge: [],
          secretsKnown: [],
          goals: [],
          knowledgeSummary: "",
          summarizedThroughChapter: 0,
        },
        deceasedSinceChapter: null,
      },
    ],
  }));
  await updateThreads(SERIES, (current) => ({
    ...current,
    threads: [
      {
        id: "thread-room-307",
        title: "Why does Room 307 appear?",
        status: "OPEN",
        introducedChapter: 2,
        requiredResolutionArc: "arc-03",
        relatedCharacters: ["maria"],
        relatedEvents: [],
        notes: "",
      },
    ],
  }));
}

function delta(overrides: Partial<CanonMemoryDelta> = {}): CanonMemoryDelta {
  return {
    version: 1,
    chapterNumber: 6,
    newEvents: [
      {
        eventType: "CHARACTER_EVENT",
        summary: "Diego enters the elevator and disappears.",
        characters: ["diego", "maria"],
        locations: ["hotel-elevator"],
        importance: 1,
        storyTime: "03:31",
        facts: [{ kind: "time", label: "elevator opened at", value: "03:17" }],
      },
    ],
    newFacts: [],
    characterStateUpdates: [],
    knowledgeUpdates: [],
    relationshipUpdates: [],
    worldStateUpdates: [],
    newPlotThreads: [],
    resolvedPlotThreads: [],
    foreshadowingAdded: [],
    mysteriesRevealed: [],
    ...overrides,
  };
}

test("a valid delta applies events, state, and retrievable memory", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "Diego vanishes in the elevator while María watches.",
      delta: delta({
        characterStateUpdates: [{ characterId: "maria", emotionalState: "terrified" }],
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "add",
            fact: "Diego vanished inside the elevator",
            subject: "diego-whereabouts",
            sourceEventIndex: 0,
          },
        ],
        worldStateUpdates: [{ currentStoryTime: "03:31", setLocation: { locationId: "hotel-elevator", condition: "doors jammed open" } }],
      }),
    });

    assert.deepEqual(report.rejections, []);
    assert.equal(report.appliedEventIds.length, 1);

    const events = await loadEvents(SERIES);
    assert.equal(events.events.length, 1);

    const characters = await loadCharacters(SERIES);
    const maria = characters.characters.find((character) => character.id === "maria");
    assert.equal(maria?.state.emotionalState, "terrified");
    assert.equal(maria?.state.knowledge.length, 1);
    assert.equal(maria?.state.knowledge[0].sourceEventId, events.events[0].id);

    const world = await loadWorldState(SERIES);
    assert.equal(world.currentStoryTime, "03:31");
    assert.equal(world.locations["hotel-elevator"], "doors jammed open");
    assert.equal(world.asOfChapter, 6);

    const memory = await loadMemoryRecords(SERIES);
    assert.equal(memory.records.length, 2, "one event record plus the chapter summary");
    assert.ok(memory.records.some((record) => record.entityType === "chapter-summary"));
  });
});

test("knowledge with no source event is refused", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "add",
            fact: "The hotel was built on a filled-in shaft",
            subject: "hotel-origin",
            sourceEventIndex: null,
          },
        ],
      }),
    });
    assert.equal(report.rejections.length, 1);
    assert.match(report.rejections[0].reason, /cannot learn from nothing/);
    const characters = await loadCharacters(SERIES);
    assert.equal(characters.characters.find((c) => c.id === "maria")?.state.knowledge.length, 0);
  });
});

test("a character cannot learn from an event they were not present for", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        newEvents: [
          {
            eventType: "CLUE_DISCOVERED",
            summary: "Diego alone finds the maintenance key.",
            characters: ["diego"],
            locations: ["room-307"],
            importance: 0.9,
            storyTime: "03:20",
            facts: [],
          },
        ],
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "add",
            fact: "There is a maintenance key",
            subject: "maintenance-key",
            sourceEventIndex: 0,
          },
        ],
      }),
    });
    assert.equal(report.rejections.length, 1);
    assert.match(report.rejections[0].reason, /not there to learn it/);
  });
});

test("an unknown character or location is refused, never invented", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        newEvents: [
          {
            eventType: "CHARACTER_EVENT",
            summary: "A stranger appears.",
            characters: ["unknown-person"],
            locations: ["hotel-elevator"],
            importance: 0.5,
            storyTime: "",
            facts: [],
          },
          {
            eventType: "WORLD_EVENT",
            summary: "The pool floods.",
            characters: ["maria"],
            locations: ["rooftop-pool"],
            importance: 0.5,
            storyTime: "",
            facts: [],
          },
        ],
        characterStateUpdates: [{ characterId: "ghost", emotionalState: "angry" }],
      }),
    });
    assert.equal(report.appliedEventIds.length, 0);
    assert.equal(report.rejections.length, 3);
    assert.ok(report.rejections.some((entry) => /character the canon does not have/.test(entry.reason)));
    assert.ok(report.rejections.some((entry) => /location the canon does not have/.test(entry.reason)));
    assert.ok(report.rejections.some((entry) => /no such character/.test(entry.reason)));
  });
});

test("a contradicting add is refused; supersede is the sanctioned path", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const base = {
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
    };
    await applyMemoryDelta({
      ...base,
      delta: delta({
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "add",
            fact: "Diego is missing",
            subject: "diego-whereabouts",
            sourceEventIndex: 0,
          },
        ],
      }),
    });

    // A second, contradicting claim about the SAME subject must not silently
    // coexist: that is how state degrades into mutually exclusive "facts".
    const conflict = await applyMemoryDelta({
      ...base,
      chapterNumber: 7,
      delta: delta({
        chapterNumber: 7,
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "add",
            fact: "Diego was never in the hotel at all",
            subject: "diego-whereabouts",
            sourceEventIndex: 0,
          },
        ],
      }),
    });
    assert.equal(conflict.rejections.length, 1);
    assert.match(conflict.rejections[0].reason, /Use supersede/);

    const characters = await loadCharacters(SERIES);
    const maria = characters.characters.find((character) => character.id === "maria");
    const active = maria?.state.knowledge.filter((entry) => entry.status === "active") ?? [];
    assert.equal(active.length, 1, "the canon keeps exactly one active fact per subject");
    assert.equal(active[0].fact, "Diego is missing");
  });
});

test("supersede retires the old fact and keeps it for audit", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        knowledgeUpdates: [
          { characterId: "maria", changeType: "add", fact: "Diego is missing", subject: "diego-whereabouts", sourceEventIndex: 0 },
        ],
      }),
    });
    const before = await loadCharacters(SERIES);
    const factId = before.characters.find((c) => c.id === "maria")!.state.knowledge[0].id;

    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 7,
      chapterSummary: "",
      delta: delta({
        chapterNumber: 7,
        knowledgeUpdates: [
          {
            characterId: "maria",
            changeType: "supersede",
            fact: "Diego is on the third floor",
            subject: "diego-whereabouts",
            sourceEventIndex: 0,
            supersedes: factId,
          },
        ],
      }),
    });
    assert.deepEqual(report.rejections, []);
    assert.equal(report.health.activeFacts, 1);
    assert.equal(report.health.supersededFacts, 1, "the retired fact stays on disk for audit");
  });
});

test("the bible is append-only, and only into sanctioned fields", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        newFacts: [
          { field: "fixedFacts", text: "The elevator has no button for floor three." },
          { field: "locations", text: "The rooftop pool" },
          { field: "premise" as never, text: "Actually it is a spaceship." },
        ],
      }),
    });
    const bible = await loadBible(SERIES);
    assert.equal(bible.fixedFacts.length, 1);
    assert.equal(bible.premise, "A hotel whose third floor appears at night.", "premise is not extractor-writable");
    assert.equal(bible.locations.length, 2, "no location was invented from a bare string");
    assert.ok(report.rejections.some((entry) => /may only append to/.test(entry.reason)));
    assert.ok(report.rejections.some((entry) => /must be authored with structure/.test(entry.reason)));
  });
});

test("mysteries can only be revealed, and only if they exist", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 9,
      chapterSummary: "",
      delta: delta({ chapterNumber: 9, mysteriesRevealed: ["why-307", "invented-mystery"] }),
    });
    const bible = await loadBible(SERIES);
    assert.equal(bible.mysteries[0].status, "REVEALED");
    assert.equal(bible.mysteries[0].revealedInChapter, 9);
    assert.ok(report.rejections.some((entry) => entry.kind === "mystery"));
  });
});

test("plot threads open and resolve; an unknown thread is refused", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const report = await applyMemoryDelta({
      seriesId: SERIES,
      chapterNumber: 6,
      chapterSummary: "",
      delta: delta({
        newPlotThreads: [{ id: "thread-key", title: "Who made the maintenance key?", notes: "" }],
        resolvedPlotThreads: ["thread-room-307", "thread-that-never-was"],
      }),
    });
    const threads = await loadThreads(SERIES);
    assert.equal(threads.threads.find((thread) => thread.id === "thread-room-307")?.status, "RESOLVED");
    assert.equal(threads.threads.find((thread) => thread.id === "thread-key")?.status, "OPEN");
    assert.ok(report.rejections.some((entry) => entry.kind === "plot-thread"));
  });
});

test("re-applying a chapter replaces its events instead of doubling them", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const options = { seriesId: SERIES, chapterNumber: 6, chapterSummary: "First pass." };
    await applyMemoryDelta({ ...options, delta: delta() });

    // The chapter is rewritten and memory re-extracted: the old event must be
    // withdrawn, not left alongside the new one.
    await applyMemoryDelta({
      ...options,
      chapterSummary: "Second pass.",
      delta: delta({
        newEvents: [
          {
            eventType: "CHARACTER_EVENT",
            summary: "Diego steps out of the elevator unharmed.",
            characters: ["diego"],
            locations: ["hotel-elevator"],
            importance: 1,
            storyTime: "03:31",
            facts: [],
          },
        ],
      }),
    });

    const events = await loadEvents(SERIES);
    assert.equal(events.events.length, 1, "the superseded version of the chapter is withdrawn");
    assert.match(events.events[0].summary, /unharmed/);
    assert.equal(events.retracted.length, 1);
  });
});

test("an identical replay applies nothing new and rejects nothing", async () => {
  await withTempCwd(async () => {
    await seedCanon();
    const options = { seriesId: SERIES, chapterNumber: 6, chapterSummary: "Same." };
    const first = await applyMemoryDelta({ ...options, delta: delta() });
    const second = await applyMemoryDelta({ ...options, delta: delta() });

    assert.equal(first.appliedEventIds.length, 1);
    assert.equal(second.appliedEventIds.length, 0, "the replay is a no-op");
    assert.equal(second.skippedEventIds.length, 1);
    assert.deepEqual(second.rejections, []);
    assert.equal((await loadEvents(SERIES)).events.length, 1);
  });
});
