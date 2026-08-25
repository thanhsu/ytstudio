import type { StudioConfig } from "../config.ts";
import { runLlmCall, roleEndpoint, type ChatFn } from "../story-factory/stage-llm.ts";
import { updateArcs, updateBible, updateCharacters, updateWorldState } from "./entities.ts";
import { parseSeriesArcs, parseSeriesBible, parseSeriesCharacters } from "./parse.ts";
import {
  CANON_PROMPTS,
  buildSeriesArcsMessages,
  buildSeriesBibleMessages,
  buildSeriesCharactersMessages,
} from "./prompts.ts";
import { loadCanonSeries } from "./series.ts";
import { slugId } from "./store.ts";
import type { CanonBible, CanonSeries } from "./types.ts";

/**
 * Series design: bible, then cast, then arcs.
 *
 * Three calls rather than one. A single "design my series" prompt has to invent
 * the world, the people, and forty chapters of structure in one response, and
 * the result is uniformly shallow and hits output limits. Each call here also
 * sees the output of the previous one, so the cast is designed for the world
 * that exists and the arcs are designed for the cast that exists.
 *
 * These run on the `architect` role — rare, expensive, worth a strong model —
 * while the per-chapter work runs on cheap or local ones.
 */

export type DesignSeriesOptions = {
  seriesId: string;
  brief: string;
  config: StudioConfig;
  confirmedPaidRequest: boolean;
  chat?: ChatFn;
  signal?: AbortSignal;
  update?: (message: string) => Promise<void>;
};

export type DesignSeriesResult = {
  bible: CanonBible;
  characterCount: number;
  arcCount: number;
  chapterCardCount: number;
};

export async function designSeries(options: DesignSeriesOptions): Promise<DesignSeriesResult> {
  const series = await loadCanonSeries(options.seriesId);
  if (!series) {
    throw new Error(`Project ${options.seriesId} is not a canon series. Create the series first.`);
  }
  const endpoint = roleEndpoint(options.config, "architect");

  // --- Bible -------------------------------------------------------------
  await options.update?.("Designing the story bible...");
  const bibleResult = await architectCall(
    options,
    series,
    endpoint,
    CANON_PROMPTS.seriesBible,
    buildSeriesBibleMessages(series, options.brief),
    parseSeriesBible,
  );

  const bible = await updateBible(options.seriesId, (current) => ({
    ...current,
    premise: bibleResult.value.premise,
    setting: bibleResult.value.setting,
    worldRules: bibleResult.value.worldRules.map((text, index) => ({
      id: slugId(text, `rule-${index + 1}`),
      text,
      establishedInChapter: 0,
    })),
    fixedFacts: bibleResult.value.fixedFacts.map((text, index) => ({
      id: slugId(text, `fact-${index + 1}`),
      text,
      establishedInChapter: 0,
    })),
    locations: bibleResult.value.locations.map((location, index) => ({
      id: slugId(location.name, `location-${index + 1}`),
      name: location.name,
      description: location.description,
    })),
    importantObjects: bibleResult.value.importantObjects.map((object, index) => ({
      id: slugId(object.name, `object-${index + 1}`),
      name: object.name,
      description: object.description,
      status: object.status,
    })),
    mysteries: bibleResult.value.mysteries.map((mystery, index) => ({
      id: slugId(mystery.question, `mystery-${index + 1}`),
      question: mystery.question,
      status: "OPEN" as const,
      answer: mystery.answer,
      revealedInChapter: null,
    })),
    endingConstraints: bibleResult.value.endingConstraints,
    provenance: bibleResult.provenance,
  }));

  // --- Cast --------------------------------------------------------------
  await options.update?.("Defining the cast...");
  const bibleSummary = renderBibleSummary(bible);
  const castResult = await architectCall(
    options,
    series,
    endpoint,
    CANON_PROMPTS.seriesCharacters,
    buildSeriesCharactersMessages(series, bibleSummary),
    parseSeriesCharacters,
  );
  const characters = await updateCharacters(options.seriesId, (current) => ({
    ...current,
    characters: castResult.value,
  }));

  // --- Arcs --------------------------------------------------------------
  await options.update?.("Planning the arcs...");
  const castSummary = characters.characters
    .map((character) => `- ${character.id}: ${character.name}, ${character.role}`)
    .join("\n");
  const arcsResult = await architectCall(
    options,
    series,
    endpoint,
    CANON_PROMPTS.seriesArcs,
    buildSeriesArcsMessages(series, bibleSummary, castSummary),
    parseSeriesArcs,
  );
  const arcs = await updateArcs(options.seriesId, (current) => ({ ...current, arcs: arcsResult.value }));

  // The world starts where the bible says it starts, before chapter one.
  await updateWorldState(options.seriesId, (current) => ({
    ...current,
    locations: Object.fromEntries(bible.locations.map((location) => [location.id, location.description])),
    unresolvedMysteries: bible.mysteries.filter((mystery) => mystery.status === "OPEN").map((mystery) => mystery.id),
    asOfChapter: 0,
  }));

  return {
    bible,
    characterCount: characters.characters.length,
    arcCount: arcs.arcs.length,
    chapterCardCount: arcs.arcs.reduce((sum, arc) => sum + arc.chapterCards.length, 0),
  };
}

/**
 * Series design runs before any chapter exists, so it cannot use the story
 * stage helper — that logs and costs against a story. It calls runLlmCall
 * directly with the series id in both slots, the same shape compilation.ts uses
 * for a sibling entity, so the spend still lands on the series' ledger.
 */
async function architectCall<T>(
  options: DesignSeriesOptions,
  series: CanonSeries,
  endpoint: ReturnType<typeof roleEndpoint>,
  prompt: { name: string; version: string },
  messages: Parameters<typeof runLlmCall<T>>[0]["messages"],
  parse: (raw: string) => T,
) {
  void series;
  return runLlmCall<T>({
    channelId: options.seriesId,
    storyId: "series-design",
    stage: "chapter-plan",
    promptName: prompt.name,
    promptVersion: prompt.version,
    endpoint,
    messages,
    parse,
    pricing: options.config.storyFactory.llmPricing,
    confirmedPaidRequest: options.confirmedPaidRequest,
    chat: options.chat,
    signal: options.signal,
  });
}

export function renderBibleSummary(bible: CanonBible): string {
  return [
    `Premise: ${bible.premise}`,
    `Setting: ${bible.setting}`,
    bible.worldRules.length ? `World rules:\n${bible.worldRules.map((rule) => `- ${rule.text}`).join("\n")}` : "",
    bible.fixedFacts.length ? `Established facts:\n${bible.fixedFacts.map((fact) => `- ${fact.text}`).join("\n")}` : "",
    bible.locations.length
      ? `Locations:\n${bible.locations.map((location) => `- ${location.id}: ${location.name} — ${location.description}`).join("\n")}`
      : "",
    bible.mysteries.length
      ? `Mysteries (answers are for planning only, never revealed early):\n${bible.mysteries
          .map((mystery) => `- ${mystery.id}: ${mystery.question} => ${mystery.answer}`)
          .join("\n")}`
      : "",
    bible.endingConstraints.length ? `Ending constraints:\n${bible.endingConstraints.map((entry) => `- ${entry}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
