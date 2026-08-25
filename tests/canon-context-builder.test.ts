import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextBudgetError,
  buildContext,
  buildContextOrThrow,
  effectiveBudget,
  estimateTokens,
  listBlock,
  proseBlock,
} from "../src/canon/context-builder.ts";
import { retrieve } from "../src/canon/memory.ts";
import type { MemoryRecord } from "../src/canon/types.ts";

function blocks(options: { events?: number; characters?: number; previousChapter?: string } = {}) {
  return [
    proseBlock("series-rules", "Series rules:", "The hotel has no third floor.", {
      priority: 100,
      dropRank: 0,
      required: true,
    }),
    proseBlock("chapter-plan", "This chapter must:", "Maria returns to the elevator.", {
      priority: 100,
      dropRank: 1,
      required: true,
    }),
    listBlock(
      "character-state",
      "Characters in this chapter:",
      Array.from({ length: options.characters ?? 3 }, (_u, i) => `character ${i} knows something specific`),
      { priority: 95, dropRank: 0, minItems: 1 },
    ),
    listBlock(
      "relevant-events",
      "Relevant past events:",
      Array.from({ length: options.events ?? 5 }, (_u, i) => `event ${i}: something happened in the hotel`),
      { priority: 80, dropRank: 0 },
    ),
    proseBlock("previous-chapter", "Previous chapter ended:", options.previousChapter ?? "Diego vanished.", {
      priority: 80,
      dropRank: 1,
    }),
    listBlock(
      "extra-memories",
      "Other possibly relevant memories:",
      Array.from({ length: 20 }, (_u, i) => `memory ${i}: a lower-priority recollection`),
      { priority: 50, dropRank: 0 },
    ),
  ];
}

test("a generous budget keeps every block", () => {
  const built = buildContext({ blocks: blocks(), budgetTokens: 100_000 });
  assert.ok(built.blocks.every((block) => block.included));
  assert.ok(built.estimatedTokens <= 100_000);
});

test("priority 50 is shed before priority 80", () => {
  const all = blocks();
  const generous = buildContext({ blocks: all, budgetTokens: 100_000 });
  // A budget that forces some trimming but not a lot.
  const tight = buildContext({ blocks: all, budgetTokens: Math.floor(generous.estimatedTokens * 0.7) });

  const extras = tight.blocks.find((block) => block.name === "extra-memories");
  const events = tight.blocks.find((block) => block.name === "relevant-events");
  assert.ok(extras && events);
  assert.ok(
    extras.itemsKept < extras.itemsOffered,
    "the cheapest block must give up items first",
  );
  assert.equal(events.itemsKept, events.itemsOffered, "priority 80 must survive while priority 50 still has items");
});

test("items are shed one at a time before a block is dropped whole", () => {
  const all = blocks();
  const generous = buildContext({ blocks: all, budgetTokens: 100_000 });
  const built = buildContext({ blocks: all, budgetTokens: generous.estimatedTokens - 20 });

  const extras = built.blocks.find((block) => block.name === "extra-memories");
  assert.ok(extras);
  assert.ok(extras.included, "a 20-token overflow must not delete an entire section");
  assert.ok(extras.itemsKept > 0 && extras.itemsKept < extras.itemsOffered);
});

test("equal priorities are broken by dropRank, not by caller ordering", () => {
  // Two blocks at the SAME priority, differing only in dropRank, with a budget
  // that fits one of them. Caller order deliberately contradicts drop order.
  const pair = [
    proseBlock("chapter-plan", "This chapter must:", "Continue.", {
      priority: 100,
      dropRank: 0,
      required: true,
    }),
    proseBlock("goes-second", "Second:", "B ".repeat(200), { priority: 80, dropRank: 1 }),
    proseBlock("goes-last", "First:", "A ".repeat(200), { priority: 80, dropRank: 0 }),
  ];
  const generous = buildContext({ blocks: pair, budgetTokens: 100_000 });
  const built = buildContext({ blocks: pair, budgetTokens: Math.floor(generous.estimatedTokens * 0.6) });

  const second = built.blocks.find((block) => block.name === "goes-second");
  const last = built.blocks.find((block) => block.name === "goes-last");
  assert.ok(second && last);
  // Higher dropRank at the same priority is shed first, regardless of the
  // order the caller happened to list the blocks in.
  assert.equal(second.included, false);
  assert.equal(last.included, true);
});

test("required blocks are never dropped; an impossible budget raises instead", () => {
  let error: ContextBudgetError | null = null;
  try {
    buildContextOrThrow("missing-floor", 12, { blocks: blocks(), budgetTokens: 5 }, []);
  } catch (thrown: unknown) {
    error = thrown as ContextBudgetError;
  }
  assert.ok(error instanceof ContextBudgetError, "an unfittable context must fail, not ship truncated");
  const required = error.report.blocks.filter(
    (block) => block.name === "series-rules" || block.name === "chapter-plan",
  );
  assert.equal(required.length, 2);
  assert.ok(required.every((block) => block.included), "canon rules must never be silently dropped");
  // Failing loudly is the point: the provider would otherwise truncate the
  // FRONT of the prompt, losing exactly these blocks, with no error at all.
  assert.match(error.message, /budget/i);
});

test("the model's own context window caps the configured budget", () => {
  // A generous configured budget against a small local model.
  assert.equal(
    effectiveBudget({
      blocks: [],
      budgetTokens: 12_000,
      endpoint: { contextWindowTokens: 8192, maxOutputTokens: 4000 },
      reserveTokens: 512,
    }),
    8192 - 4000 - 512,
  );
  // An unknown window (0) leaves the configured budget alone.
  assert.equal(
    effectiveBudget({ blocks: [], budgetTokens: 12_000, endpoint: { contextWindowTokens: 0, maxOutputTokens: 4000 } }),
    12_000,
  );
});

test("a truncated list tells the model it was truncated", () => {
  const all = blocks();
  const generous = buildContext({ blocks: all, budgetTokens: 100_000 });
  const built = buildContext({ blocks: all, budgetTokens: Math.floor(generous.estimatedTokens * 0.7) });
  assert.match(
    built.text,
    /entries omitted for length/,
    "a silently truncated list invites the model to treat it as exhaustive",
  );
});

test("the token estimate is conservative, never optimistic", () => {
  // Under-counting is the dangerous direction: it is what lets a prompt
  // overflow a model window that the builder believed it fitted.
  const text = "a".repeat(4000);
  assert.ok(estimateTokens(text) >= 1000);
});

// ---------------------------------------------------------------------------
// The claim the whole architecture rests on.
// ---------------------------------------------------------------------------

function syntheticSeriesMemory(chapters: number): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const cast = ["maria", "diego", "elena", "tomas", "rosa"];
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    for (const [index, character] of cast.entries()) {
      records.push({
        id: `event:${chapter}-${character}`,
        seriesId: "missing-floor",
        entityType: "event",
        entityId: `${chapter}-${character}`,
        chapterNumber: chapter,
        text: `In chapter ${chapter}, ${character} discovered something about the elevator and the third floor.`,
        importance: index === 0 ? 0.9 : 0.4,
        metadata: { characters: [character], locations: ["hotel-elevator"], threads: ["thread-room-307"] },
      });
    }
    records.push({
      id: `chapter-summary:${chapter}`,
      seriesId: "missing-floor",
      entityType: "chapter-summary",
      entityId: String(chapter),
      chapterNumber: chapter,
      text: `Chapter ${chapter} summary: the guests search the hotel and the third floor stays missing.`,
      importance: 0.6,
      metadata: { characters: cast, locations: ["hotel"], threads: ["thread-room-307"] },
    });
  }
  // The chapter-3 reveal: the thing chapter 41 must not have forgotten.
  records.push({
    id: "event:3-reveal",
    seriesId: "missing-floor",
    entityType: "event",
    entityId: "3-reveal",
    chapterNumber: 3,
    text: "Diego found the maintenance key that opens the sealed third floor stairwell.",
    importance: 1,
    metadata: { characters: ["diego"], locations: ["hotel-elevator"], threads: ["thread-room-307"] },
  });
  return records;
}

test("chapter 40 still fits the budget, and still reaches chapter 3", () => {
  const records = syntheticSeriesMemory(40);
  assert.equal(records.length, 40 * 6 + 1, "sanity: the synthetic series really is large");

  const scored = retrieve(records, {
    query: "Maria returns to the elevator looking for Diego and the third floor",
    currentChapter: 41,
    filter: { characters: ["maria", "diego"], recentChapters: [38, 39, 40] },
    topKPerClass: 6,
    weights: { keyword: 1, vector: 1, importance: 0.5, proximity: 0.5 },
  });

  // Per-class caps are what bound this: without them the 200 event records
  // would swamp every chapter summary and the writer would lose the structure.
  assert.ok(scored.length <= 6 * 2, "retrieval is capped per entity class");

  const built = buildContext({
    blocks: [
      proseBlock("series-rules", "Series rules:", "The hotel has no third floor.", {
        priority: 100,
        dropRank: 0,
        required: true,
      }),
      proseBlock("chapter-plan", "This chapter must:", "Maria confronts the elevator.", {
        priority: 100,
        dropRank: 1,
        required: true,
      }),
      // Character state is SELECTED by the chapter's cast, not "every character
      // in the series" - that selection is what keeps this block bounded as the
      // series grows, and is the reason the design does not collapse by ch. 20.
      listBlock("character-state", "Characters in this chapter:", [
        "maria: at the hotel, believes the third floor exists",
        "diego: missing since chapter 6",
      ], { priority: 95, dropRank: 0, minItems: 1 }),
      listBlock(
        "relevant-events",
        "Relevant past events:",
        scored.map((entry) => entry.record.text),
        { priority: 80, dropRank: 0 },
      ),
    ],
    budgetTokens: 12_000,
  });

  assert.ok(built.estimatedTokens <= 12_000, "a 40-chapter series must still fit the budget");
  assert.ok(
    built.blocks.every((block) => block.included),
    "with per-class retrieval and selected state, nothing has to be dropped at all",
  );

  // The payoff: the chapter-3 reveal is still retrieved while writing chapter
  // 41, across 40 chapters of routine material. A recency-ranked scheme loses
  // it, and losing it is exactly the failure this design exists to prevent.
  const reachedChapters = scored.map((entry) => entry.record.chapterNumber);
  assert.ok(
    scored.some((entry) => entry.record.id === "event:3-reveal"),
    `the chapter-3 reveal must survive to chapter 41; reached ${JSON.stringify(reachedChapters)}`,
  );
  assert.ok(
    Math.min(...reachedChapters) <= 5,
    `retrieval must still reach the early series; reached ${JSON.stringify(reachedChapters)}`,
  );
});

test("the landmark slice counterbalances recency even when importance is uniform", () => {
  // Every record equally important and equally on-topic: the blended score is
  // then pure recency. Without a reserved anti-recency slice, retrieval would
  // only ever see the newest chapters, and early canon would be unreachable.
  const flat: MemoryRecord[] = Array.from({ length: 30 }, (_u, index) => ({
    id: `event:${index + 1}`,
    seriesId: "missing-floor",
    entityType: "event" as const,
    entityId: String(index + 1),
    chapterNumber: index + 1,
    text: "The elevator opened onto the third floor.",
    importance: 0.5,
    metadata: { characters: ["maria"], locations: ["hotel-elevator"], threads: [] },
  }));

  const scored = retrieve(flat, {
    query: "The elevator opened onto the third floor.",
    currentChapter: 31,
    filter: { characters: ["maria"] },
    topKPerClass: 6,
    weights: { keyword: 1, vector: 1, importance: 0.5, proximity: 0.5 },
  });

  const chapters = scored.map((entry) => entry.record.chapterNumber);
  assert.equal(chapters.length, 6);
  assert.ok(
    chapters.some((chapter) => chapter <= 3),
    `at least one landmark slot must reach the start of the series; got ${JSON.stringify(chapters)}`,
  );
  assert.ok(
    chapters.some((chapter) => chapter >= 29),
    `recent chapters must still dominate the majority of slots; got ${JSON.stringify(chapters)}`,
  );
});

test("context never contains the previous chapter's full prose", () => {
  // The point of story memory is that chapter N reads STATE and RETRIEVED
  // FACTS, not the raw text of everything before it.
  const fullProse = "PROSE ".repeat(5000);
  const built = buildContext({
    blocks: [
      proseBlock("chapter-plan", "This chapter must:", "Continue.", { priority: 100, dropRank: 0, required: true }),
      proseBlock("previous-chapter", "Previous chapter ended:", fullProse, { priority: 80, dropRank: 1 }),
    ],
    budgetTokens: 500,
  });
  assert.ok(built.estimatedTokens <= 500);
  const previous = built.blocks.find((block) => block.name === "previous-chapter");
  assert.equal(previous?.included, false, "a whole prior chapter must not be able to consume the budget");
});
