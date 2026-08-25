import type { StudioConfig } from "../config.ts";
import { roleEndpoint } from "../story-factory/stage-llm.ts";
import { buildContextOrThrow, listBlock, proseBlock } from "./context-builder.ts";
import { activeKnowledge, arcForChapter, loadArcs, loadBible, loadCharacters, loadThreads, loadWorldState, openThreads } from "./entities.ts";
import { loadEvents } from "./events.ts";
import { loadMemoryRecords, loadMemoryVectors, retrieve } from "./memory.ts";
import { loadCanonSeries } from "./series.ts";
import type { CanonChapterPlan, CanonCharacter, ContextReport } from "./types.ts";

/**
 * Assembles the chapter context: which canon a chapter's writer actually sees.
 *
 * The selection rules matter more than the assembly. Character and world state
 * grow linearly with the series, so the context is bounded by SELECTING the
 * cast the chapter plan names rather than dumping every character — that
 * selection, not the token budget, is what keeps chapter 40 the same size as
 * chapter 4.
 */

export type BuildChapterContextOptions = {
  seriesId: string;
  chapterNumber: number;
  plan: CanonChapterPlan;
  config: StudioConfig;
  /** Injected for tests; absent means keyword-only retrieval. */
  queryVector?: number[] | null;
  embeddingModel?: string;
};

export async function buildChapterContext(options: BuildChapterContextOptions): Promise<ContextReport> {
  const { seriesId, chapterNumber, plan, config } = options;
  const [series, bible, characters, worldState, arcs, threads, ledger, memory] = await Promise.all([
    loadCanonSeries(seriesId),
    loadBible(seriesId),
    loadCharacters(seriesId),
    loadWorldState(seriesId),
    loadArcs(seriesId),
    loadThreads(seriesId),
    loadEvents(seriesId),
    loadMemoryRecords(seriesId),
  ]);
  const arc = arcForChapter(arcs, chapterNumber);

  // The cast this chapter needs, not the cast the series has.
  const planned = new Set(plan.characters);
  const relevantCharacters = characters.characters.filter((character) => planned.has(character.id));
  // A chapter plan that names nobody still needs someone; fall back to the
  // living cast rather than shipping an empty roster.
  const cast =
    relevantCharacters.length > 0
      ? relevantCharacters
      : characters.characters.filter(
          (character) => character.deceasedSinceChapter === null || character.deceasedSinceChapter >= chapterNumber,
        );

  const relevantThreads = openThreads(threads).filter(
    (thread) =>
      thread.relatedCharacters.some((id) => planned.has(id)) ||
      !thread.requiredResolutionArc ||
      thread.requiredResolutionArc === arc?.id,
  );

  // The retrieval query comes from the PLAN, because the chapter does not exist
  // yet. Beats plus cast plus locations plus open-thread titles is everything
  // known about it in advance.
  const query = [
    plan.goal,
    ...plan.beats,
    ...plan.characters,
    ...plan.locations,
    ...relevantThreads.map((thread) => thread.title),
  ].join(" ");

  const vectors = options.queryVector ? await loadMemoryVectors(seriesId) : undefined;
  const retrieved = retrieve(memory.records, {
    query,
    currentChapter: chapterNumber,
    filter: {
      characters: plan.characters,
      locations: plan.locations,
      threads: relevantThreads.map((thread) => thread.id),
      // The immediately preceding chapters are always candidates, so a chapter
      // never loses the thread of what just happened.
      recentChapters: [chapterNumber - 1, chapterNumber - 2, chapterNumber - 3].filter((n) => n > 0),
    },
    topKPerClass: config.storyFactory.canon.retrievalTopKPerClass,
    weights: config.storyFactory.canon.retrievalWeights,
    queryVector: options.queryVector ?? null,
    vectors,
    embeddingModel: options.embeddingModel,
  });

  const previousSummary = memory.records.find(
    (record) => record.entityType === "chapter-summary" && record.chapterNumber === chapterNumber - 1,
  );

  const blocks = [
    proseBlock(
      "series-rules",
      "Series canon (authoritative — never contradict this):",
      [
        series ? `Premise: ${bible.premise || series.title}` : `Premise: ${bible.premise}`,
        bible.setting ? `Setting: ${bible.setting}` : "",
        bible.worldRules.length ? `World rules:\n${bible.worldRules.map((rule) => `  - ${rule.text}`).join("\n")}` : "",
        bible.fixedFacts.length
          ? `Established facts:\n${bible.fixedFacts.map((fact) => `  - ${fact.text}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      { priority: 100, dropRank: 0, required: true },
    ),
    proseBlock(
      "current-arc",
      "Current arc:",
      arc
        ? [
            `${arc.title} (chapters ${arc.startChapter}-${arc.targetEndChapter}): ${arc.goal}`,
            arc.mustNotRevealYet.length
              ? `MUST NOT be revealed yet: ${arc.mustNotRevealYet.join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "",
      { priority: 100, dropRank: 1, required: true },
    ),
    listBlock("character-state", "Characters in this chapter:", cast.map(renderCharacter), {
      priority: 95,
      dropRank: 0,
      // Never ship a chapter with no cast at all; one character is the floor.
      minItems: Math.min(1, cast.length),
    }),
    proseBlock(
      "world-state",
      "World state right now:",
      [
        worldState.currentStoryTime ? `Time: ${worldState.currentStoryTime}` : "",
        worldState.currentDate ? `Date: ${worldState.currentDate}` : "",
        worldState.activeThreats.length ? `Active threats: ${worldState.activeThreats.join("; ")}` : "",
        Object.entries(worldState.locations)
          .map(([id, condition]) => `  - ${id}: ${condition}`)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n"),
      { priority: 95, dropRank: 1 },
    ),
    listBlock(
      "plot-threads",
      "Open plot threads (do not silently drop these):",
      relevantThreads.map((thread) => `${thread.title} — ${thread.status}, open since chapter ${thread.introducedChapter}`),
      { priority: 95, dropRank: 2 },
    ),
    listBlock(
      "relevant-events",
      "Relevant past events:",
      retrieved
        .filter((entry) => entry.record.entityType === "event")
        .map((entry) => `Chapter ${entry.record.chapterNumber}: ${entry.record.text}`),
      { priority: 80, dropRank: 0 },
    ),
    proseBlock("previous-chapter", "The previous chapter ended with:", previousSummary?.text ?? "", {
      priority: 80,
      dropRank: 1,
    }),
    listBlock(
      "extra-memories",
      "Other possibly relevant canon:",
      retrieved
        .filter((entry) => entry.record.entityType !== "event")
        .map((entry) => entry.record.text),
      { priority: 50, dropRank: 0 },
    ),
  ];

  void ledger;
  return buildContextOrThrow(
    seriesId,
    chapterNumber,
    {
      blocks,
      budgetTokens: config.storyFactory.canon.contextTokenBudget,
      endpoint: safeWriterEndpoint(config),
    },
    retrieved,
  );
}

/**
 * The writer's endpoint, when one is configured. An unconfigured writer is not
 * this stage's error to raise — the write stage reports it with a far better
 * message — so the context simply builds against its configured budget.
 */
function safeWriterEndpoint(config: StudioConfig): { contextWindowTokens: number; maxOutputTokens: number } | undefined {
  try {
    const endpoint = roleEndpoint(config, "writer");
    return { contextWindowTokens: endpoint.contextWindowTokens, maxOutputTokens: endpoint.maxOutputTokens };
  } catch {
    return undefined;
  }
}

function renderCharacter(character: CanonCharacter): string {
  const knowledge = activeKnowledge(character);
  const parts = [`${character.name} (${character.id})`];
  if (character.role) parts.push(character.role);
  if (character.staticProfile.appearance) parts.push(character.staticProfile.appearance);
  if (character.state.currentLocation) parts.push(`at ${character.state.currentLocation}`);
  if (character.state.emotionalState) parts.push(character.state.emotionalState);
  if (character.state.health.length) parts.push(`health: ${character.state.health.join(", ")}`);
  if (character.state.inventory.length) parts.push(`carrying: ${character.state.inventory.join(", ")}`);
  if (character.deceasedSinceChapter !== null) parts.push(`DEAD since chapter ${character.deceasedSinceChapter}`);
  // Knowledge is the field continuity errors actually come from: a character
  // referring to something no scene told them. The rolled-up summary covers
  // everything older than the retained window so this stays bounded.
  if (character.state.knowledgeSummary) parts.push(`knows (summary): ${character.state.knowledgeSummary}`);
  if (knowledge.length) {
    parts.push(`knows: ${knowledge.map((entry) => entry.fact).join("; ")}`);
  } else if (!character.state.knowledgeSummary) {
    parts.push("knows: nothing established yet");
  }
  if (character.state.goals.length) parts.push(`wants: ${character.state.goals.join("; ")}`);
  return parts.join(" | ");
}
