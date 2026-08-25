import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STUDIO_CONFIG, type StudioConfig } from "../src/config.ts";
import type { ChatMessage, ChatResult, OpenAiCompatibleConfig } from "../src/llm/chat.ts";
import { designSeries } from "../src/canon/design.ts";
import { loadBible, loadCharacters, loadWorldState } from "../src/canon/entities.ts";
import { loadEvents } from "../src/canon/events.ts";
import { chapterIdFor, saveCanonSeries } from "../src/canon/series.ts";
import { createPublicationVariant, listSeriesVariants } from "../src/canon/variant.ts";
import { saveStoryChannel } from "../src/story-factory/channel.ts";
import { runSingleStage, runStoryPipeline, type StoryPipelineDeps } from "../src/story-factory/pipeline.ts";
import {
  approveStoryStage,
  createStory,
  loadStory,
  readStageArtifact,
} from "../src/story-factory/story-project.ts";
import { loadStoryChannel } from "../src/story-factory/channel.ts";
import type { CanonChapterArtifact, ContextReport } from "../src/canon/types.ts";
import type { ScriptArtifact } from "../src/story-factory/types.ts";

/**
 * The two MVP acceptance tests, end to end on a scripted chat with no network:
 *
 *   1. Canon: create a series, design it, write chapter 1, check continuity,
 *      approve, extract memory. Then chapter 2's context must carry chapter 1's
 *      STATE and RETRIEVED EVENTS and NOT chapter 1's prose.
 *   2. Localization: the same approved chapter becomes an es-MX variant through
 *      localize -> naturalize -> canon-alignment, reusing the canon scene plan.
 */

const SERIES = "missing-floor";
const CHANNEL = "horror-es";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-canon-smoke-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function config(): StudioConfig {
  const base = structuredClone(DEFAULT_STUDIO_CONFIG);
  const endpoint = { ...base.storyFactory.models.planner, model: "test-model", contextWindowTokens: 32000 };
  base.storyFactory.enabled = true;
  base.storyFactory.canon.enabled = true;
  base.storyFactory.models = {
    planner: endpoint,
    writer: endpoint,
    qa: endpoint,
    architect: endpoint,
    localizer: endpoint,
    memory: endpoint,
  };
  return base;
}

/** Routes a call by a marker in its system prompt, like the story-factory tests. */
function createFakeChat(responses: Record<string, unknown | ((count: number) => unknown)>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fn = async (
    _config: OpenAiCompatibleConfig,
    messages: ChatMessage[],
  ): Promise<ChatResult> => {
    const system = messages[0]?.content ?? "";
    const key = Object.keys(responses).find((marker) => system.includes(marker));
    if (!key) throw new Error(`No fake response matches: ${system.slice(0, 120)}`);
    calls.push(key);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const value = responses[key];
    const resolved = typeof value === "function" ? (value as (n: number) => unknown)(count) : value;
    return {
      content: JSON.stringify(resolved),
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    };
  };
  return Object.assign(fn, { calls });
}

const CHAPTER_ONE_PROSE = [
  "The night auditor's desk faced the elevator, and María had learned to watch it.",
  "At three seventeen the doors opened on their own. Diego stepped in before she could speak, and the doors closed on a floor that did not exist.",
  "She pressed every button. The car never moved. When the doors opened again the lobby was empty and the guest register had one fewer name.",
].join("\n\n");

const CHAPTER_TWO_PROSE = "María went back to the elevator at the same hour, holding the register.";

function canonResponses(): Record<string, unknown | ((count: number) => unknown)> {
  return {
    "authoritative bible": {
      premise: "A hotel whose third floor appears only at night.",
      setting: "Hotel Rivera, Mexico City, present day.",
      worldRules: ["The third floor exists only between 03:00 and 04:00.", "Anyone who rides to it is unmade from the register."],
      fixedFacts: ["The elevator panel has buttons for floors one, two, four and five."],
      locations: [
        { name: "The elevator", description: "Brass doors, one button too many." },
        { name: "Room 307", description: "A room that should not exist." },
      ],
      importantObjects: [{ name: "The guest register", description: "Leather, handwritten.", status: "at the front desk" }],
      mysteries: [{ question: "Why does Room 307 appear?", answer: "The hotel is remembering a fire it caused." }],
      endingConstraints: ["The register must be the last thing burned."],
    },
    "defining the cast": {
      characters: [
        {
          name: "María Torres",
          role: "night auditor",
          birthYear: 1998,
          appearance: "Tired eyes, always in the same grey cardigan.",
          personality: ["stubborn", "observant"],
          background: ["Has worked nights for three years."],
          startingLocation: "the-elevator",
          startingGoals: ["Get through the shift"],
        },
        {
          name: "Diego Ruiz",
          role: "guest in 204",
          birthYear: 1990,
          appearance: "A salesman's suit, one size too big.",
          personality: ["restless"],
          background: ["Checked in without luggage."],
          startingLocation: "the-elevator",
          startingGoals: ["Find his brother"],
        },
      ],
    },
    "major arcs": {
      arcs: [
        {
          title: "The Missing Floor",
          goal: "Reveal that the hotel is remembering a fire.",
          startChapter: 1,
          targetEndChapter: 8,
          requiredReveals: ["The register erases riders."],
          mustNotRevealYet: ["The hotel caused the fire."],
          requiredEvents: ["Diego disappears."],
          endingHook: "The register writes a name by itself.",
          chapterCards: [
            {
              chapterNumber: 1,
              goal: "Establish the elevator and lose Diego.",
              mainEvents: ["Diego enters the elevator at 03:17 and does not come back."],
              characters: ["maria-torres", "diego-ruiz"],
              locations: ["the-elevator"],
              requiredClues: ["The register loses a name."],
              mustNotReveal: ["The hotel caused the fire."],
              endingHook: "One fewer name in the register.",
              arcProgress: "Opens the arc.",
            },
            {
              chapterNumber: 2,
              goal: "María returns to the elevator with the register.",
              mainEvents: ["María rides the elevator alone."],
              characters: ["maria-torres"],
              locations: ["the-elevator"],
              requiredClues: ["The register is warm."],
              mustNotReveal: ["The hotel caused the fire."],
              endingHook: "A name appears in her handwriting.",
              arcProgress: "Raises the stakes.",
            },
          ],
        },
      ],
    },
    "lightweight chapter card into a concrete chapter plan": (count: number) => ({
      title: count === 1 ? "Three Seventeen" : "The Warm Register",
      goal: count === 1 ? "Lose Diego to the elevator." : "María rides alone.",
      beats: count === 1 ? ["Night shift begins.", "The doors open.", "Diego steps in.", "A name is gone."] : ["María returns.", "She rides alone."],
      characters: count === 1 ? ["maria-torres", "diego-ruiz"] : ["maria-torres"],
      locations: ["the-elevator"],
      requiredClues: ["The register loses a name."],
      mustNotReveal: ["The hotel caused the fire."],
      endingHook: "One fewer name.",
      targetWords: 1200,
    }),
    "write ONE chapter": (count: number) => ({
      title: count === 1 ? "Three Seventeen" : "The Warm Register",
      text: count === 1 ? CHAPTER_ONE_PROSE : CHAPTER_TWO_PROSE,
      summary:
        count === 1
          ? "Diego steps into the elevator at 03:17 and vanishes; the register loses his name."
          : "María rides the elevator alone at the same hour.",
    }),
    "continuity checker": { passed: true, issues: [] },
    "extract structured memory": (count: number) =>
      count === 1
        ? {
            newEvents: [
              {
                eventType: "CHARACTER_EVENT",
                summary: "Diego enters the elevator at 03:17 and disappears.",
                characters: ["maria-torres", "diego-ruiz"],
                locations: ["the-elevator"],
                importance: 1,
                storyTime: "03:17",
                facts: [{ kind: "time", label: "the elevator opened at", value: "03:17" }],
              },
            ],
            newFacts: [{ field: "fixedFacts", text: "The register loses the name of anyone who rides to the third floor." }],
            characterStateUpdates: [{ characterId: "maria-torres", emotionalState: "shaken" }],
            knowledgeUpdates: [
              {
                characterId: "maria-torres",
                changeType: "add",
                fact: "Diego rode the elevator and did not come back",
                subject: "diego-whereabouts",
                sourceEventIndex: 0,
              },
            ],
            relationshipUpdates: [],
            worldStateUpdates: [{ currentStoryTime: "03:17" }],
            newPlotThreads: [{ id: "thread-register", title: "What is the register?", notes: "" }],
            resolvedPlotThreads: [],
            foreshadowingAdded: [],
            mysteriesRevealed: [],
          }
        : { newEvents: [], newFacts: [], characterStateUpdates: [], knowledgeUpdates: [], relationshipUpdates: [], worldStateUpdates: [], newPlotThreads: [], resolvedPlotThreads: [], foreshadowingAdded: [], mysteriesRevealed: [] },
    "extract visual scenes": {
      scenes: [
        { summary: "The lobby desk at night.", imagePrompt: "A dim hotel lobby desk at night", continuityRefs: [] },
        { summary: "The elevator doors open.", imagePrompt: "Brass elevator doors opening in a dim corridor", continuityRefs: [] },
      ],
    },
  };
}

function deps(chat: ReturnType<typeof createFakeChat>): StoryPipelineDeps {
  return { config: config(), chat, confirmedPaidRequest: true };
}

async function seedSeries(): Promise<void> {
  await saveCanonSeries(SERIES, {
    title: "The Missing Floor",
    canonicalLanguage: "en",
    genre: "horror",
    tone: "calm, mysterious, slowly building dread",
    targetAudience: "adults who listen at night",
    targetChapterCount: 8,
    styleProfile: "Conversational cinematic storytelling for listening.",
    status: "ACTIVE",
  });
  // A canon series is a channel project whose language is the canonical one.
  await saveStoryChannel(SERIES, { language: "en", locale: "en-US", niche: "horror", mode: "manual" });
}

async function runCanonChapter(chapterNumber: number, chat: ReturnType<typeof createFakeChat>): Promise<string> {
  const chapterId = chapterIdFor(chapterNumber);
  const channel = await loadStoryChannel(SERIES);
  await createStory(channel, { id: chapterId, title: `Chapter ${chapterNumber}`, kind: "canon" });

  for (const stage of ["chapter-plan", "canon-context", "canon-write", "canon-continuity"] as const) {
    await runSingleStage(SERIES, chapterId, stage, deps(chat));
  }
  // The canon gate: a human accepts the chapter before anything enters memory.
  await approveStoryStage(SERIES, chapterId, "canon", "smoke test");
  for (const stage of ["memory-extract", "memory-apply"] as const) {
    await runSingleStage(SERIES, chapterId, stage, deps(chat));
  }
  return chapterId;
}

test("MVP 1 — a canon series designs, writes, checks, and remembers a chapter", async () => {
  await withTempCwd(async () => {
    await seedSeries();
    const chat = createFakeChat(canonResponses());

    const designed = await designSeries({
      seriesId: SERIES,
      brief: "A hotel with a floor that only exists at night.",
      config: config(),
      confirmedPaidRequest: true,
      chat,
    });
    assert.equal(designed.characterCount, 2);
    assert.equal(designed.arcCount, 1);
    assert.equal(designed.chapterCardCount, 2);

    const chapterId = await runCanonChapter(1, chat);

    const chapter = await readStageArtifact<CanonChapterArtifact>(SERIES, chapterId, "canon-write");
    assert.ok(chapter?.canonTextHash, "the chapter has a hash every variant will bind to");
    assert.match(chapter!.canonicalText, /three seventeen/i);

    // Memory landed in structured state, not just in prose.
    const events = await loadEvents(SERIES);
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].facts[0].value, "03:17");

    const characters = await loadCharacters(SERIES);
    const maria = characters.characters.find((character) => character.id === "maria-torres");
    assert.equal(maria?.state.emotionalState, "shaken");
    assert.equal(maria?.state.knowledge.length, 1);
    assert.equal(maria?.state.knowledge[0].sourceEventId, events.events[0].id);

    const bible = await loadBible(SERIES);
    assert.equal(bible.fixedFacts.length, 2, "the extractor appended one fixed fact to the seeded one");
    assert.equal((await loadWorldState(SERIES)).asOfChapter, 1);
  });
});

test("MVP 1 — chapter 2 sees chapter 1's state and events, but not its prose", async () => {
  await withTempCwd(async () => {
    await seedSeries();
    const chat = createFakeChat(canonResponses());
    await designSeries({
      seriesId: SERIES,
      brief: "A hotel with a floor that only exists at night.",
      config: config(),
      confirmedPaidRequest: true,
      chat,
    });
    await runCanonChapter(1, chat);

    const chapterTwo = chapterIdFor(2);
    const channel = await loadStoryChannel(SERIES);
    await createStory(channel, { id: chapterTwo, title: "Chapter 2", kind: "canon" });
    await runSingleStage(SERIES, chapterTwo, "chapter-plan", deps(chat));
    await runSingleStage(SERIES, chapterTwo, "canon-context", deps(chat));

    const context = await readStageArtifact<ContextReport>(SERIES, chapterTwo, "canon-context");
    assert.ok(context, "the built context is persisted as an artifact for the debugger");

    // This is the whole promise of story memory.
    assert.match(context!.text, /maria-torres/, "carries the character's state");
    assert.match(context!.text, /Diego rode the elevator/, "carries what María KNOWS");
    assert.match(context!.text, /03:17|Diego enters the elevator/, "carries the retrieved event");
    assert.doesNotMatch(
      context!.text,
      /night auditor's desk faced the elevator/,
      "must NOT carry chapter 1's raw prose",
    );
    assert.ok(context!.estimatedTokens <= context!.budgetTokens, "and it fits the budget");
    assert.ok(context!.blocks.length > 0 && context!.retrieved.length > 0, "the debugger has something to show");
  });
});

test("MVP 2 — an approved canon chapter becomes an es-MX variant through the existing pipeline", async () => {
  await withTempCwd(async () => {
    await seedSeries();
    const chat = createFakeChat(canonResponses());
    await designSeries({
      seriesId: SERIES,
      brief: "A hotel with a floor that only exists at night.",
      config: config(),
      confirmedPaidRequest: true,
      chat,
    });
    const chapterId = await runCanonChapter(1, chat);
    // The canon scene plan: generated once, reused by every locale.
    await runSingleStage(SERIES, chapterId, "scenes", deps(chat));

    await saveStoryChannel(CHANNEL, {
      language: "es",
      locale: "es-MX",
      niche: "horror",
      mode: "manual",
      canonSeriesId: SERIES,
      localeNotes: {
        audience: "Latin America",
        spokenStyle: "natural storytelling",
        formality: "neutral",
        avoid: ["Spain-specific slang"],
        alignmentExemptions: [],
      },
    });

    const variant = await createPublicationVariant({ seriesId: SERIES, chapterId, channelId: CHANNEL });
    assert.equal(variant.kind, "variant");
    assert.equal(variant.canonRef?.chapterId, chapterId);
    assert.equal(variant.config.locale, "es-MX");

    // The projections that let four untouched stages run on a variant.
    assert.ok(await readStageArtifact(CHANNEL, variant.id, "idea"));
    assert.ok(await readStageArtifact(CHANNEL, variant.id, "hook"));
    assert.ok(await readStageArtifact(CHANNEL, variant.id, "bible"));
    assert.ok(await readStageArtifact(CHANNEL, variant.id, "scenes"), "the canon scene plan came across");

    const localizeChat = createFakeChat({
      ...canonResponses(),
      "audio-fiction writer": {
        text: "El ascensor se abrió a las tres y diecisiete y Diego entró. Las puertas se cerraron sobre un piso que no existía.",
        notes: ["restructured for natural Spanish rhythm"],
      },
      "script doctor": {
        text: "El ascensor se abrió a las tres y diecisiete. Diego entró, y las puertas se cerraron sobre un piso que no existía.",
        notes: ["smoothed for narration"],
      },
    });

    await runSingleStage(CHANNEL, variant.id, "localize", deps(localizeChat));
    const script = await readStageArtifact<ScriptArtifact>(CHANNEL, variant.id, "sections");
    assert.ok(script?.fullText.includes("ascensor"), "localize writes the same artifact the sections stage writes");

    await runSingleStage(CHANNEL, variant.id, "naturalize", deps(localizeChat));
    await runSingleStage(CHANNEL, variant.id, "canon-alignment", deps(localizeChat));

    const alignment = await readStageArtifact<{ passed: boolean; checkedFacts: number }>(
      CHANNEL,
      variant.id,
      "canon-alignment",
    );
    assert.equal(alignment?.passed, true, "the Spanish narration preserves 03:17 as 'las tres y diecisiete'");
    assert.equal(alignment?.checkedFacts, 1);

    // One canon, many publications — and the link is live, not stored.
    const links = await listSeriesVariants(SERIES, [CHANNEL]);
    assert.equal(links.length, 1);
    assert.equal(links[0].state, "fresh");
    assert.equal(links[0].locale, "es-MX");
  });
});

test("MVP 2 — a localization that alters a canon value is caught and cannot pass", async () => {
  await withTempCwd(async () => {
    await seedSeries();
    const chat = createFakeChat(canonResponses());
    await designSeries({
      seriesId: SERIES,
      brief: "A hotel with a floor that only exists at night.",
      config: config(),
      confirmedPaidRequest: true,
      chat,
    });
    const chapterId = await runCanonChapter(1, chat);
    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX", canonSeriesId: SERIES, mode: "manual" });
    const variant = await createPublicationVariant({ seriesId: SERIES, chapterId, channelId: CHANNEL });

    // The localizer moves the clock hand, and keeps moving it on every retry.
    const drifting = createFakeChat({
      ...canonResponses(),
      "audio-fiction writer": { text: "El ascensor se abrió a las tres y media y Diego entró.", notes: [] },
      "script doctor": { text: "El ascensor se abrió a las tres y media. Diego entró.", notes: [] },
    });
    await runSingleStage(CHANNEL, variant.id, "localize", deps(drifting));
    await runSingleStage(CHANNEL, variant.id, "naturalize", deps(drifting));

    await assert.rejects(
      () => runSingleStage(CHANNEL, variant.id, "canon-alignment", deps(drifting)),
      /alignment failed|03:17/i,
      "canon is never adjusted to match a localization",
    );

    const story = await loadStory(CHANNEL, variant.id);
    assert.equal(story.stages["canon-alignment"]?.status, "failed");
    const report = await readStageArtifact<{ passed: boolean; gaveUpReason: string | null }>(
      CHANNEL,
      variant.id,
      "canon-alignment",
    );
    assert.equal(report?.passed, false);
    assert.match(String(report?.gaveUpReason), /converging|attempts/i, "a non-converging loop stops instead of spinning");
  });
});

test("the original story pipeline is untouched by any of this", async () => {
  await withTempCwd(async () => {
    // An ordinary channel story still selects the original stage list and
    // never sees a canon or localization stage.
    const channel = await saveStoryChannel("plain-channel", { language: "es", locale: "es-MX" });
    const story = await createStory(channel, { id: "story-001", title: "Una noche" });
    assert.equal(story.kind, "original");
    assert.equal(story.canonRef, undefined);

    const { stagesForKind } = await import("../src/story-factory/types.ts");
    const stages = stagesForKind(story.kind);
    assert.equal(stages.includes("localize"), false);
    assert.equal(stages.includes("canon-write"), false);
    assert.equal(stages[0], "idea");

    // And a stage from another kind is refused rather than attempted.
    await assert.rejects(
      () => runStoryPipeline("plain-channel", "story-001", deps(createFakeChat({}))),
      /No fake response matches/,
      "it starts at idea, the original pipeline's first stage",
    );
  });
});
