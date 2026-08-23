import {
  optionalStringArray,
  parseJsonObject,
  requireArray,
  requireObject,
  requireText,
} from "../../llm/parse.ts";
import { buildBibleMessages, BIBLE_PROMPT_NAME, BIBLE_PROMPT_VERSION } from "../prompts/bible.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { BibleArtifact, BibleUpdates, IdeaArtifact, OutlineArtifact } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

export function parseBible(raw: string): Omit<BibleArtifact, "version" | "provenance"> {
  const payload = parseJsonObject(raw);
  return {
    setting: requireText(payload.setting, "setting"),
    characters: requireArray(payload.characters, "characters").map((entry, index) => {
      const value = requireObject(entry, `characters[${index}]`);
      return {
        name: requireText(value.name, `characters[${index}].name`),
        role: requireText(value.role, `characters[${index}].role`),
        description: requireText(value.description, `characters[${index}].description`),
        arc: requireText(value.arc, `characters[${index}].arc`),
      };
    }),
    timeline: optionalStringArray(payload.timeline, "timeline"),
    locations: requireArray(payload.locations, "locations").map((entry, index) => {
      const value = requireObject(entry, `locations[${index}]`);
      return {
        name: requireText(value.name, `locations[${index}].name`),
        description: requireText(value.description, `locations[${index}].description`),
      };
    }),
    supernaturalRules: optionalStringArray(payload.supernaturalRules, "supernaturalRules"),
    knownFacts: optionalStringArray(payload.knownFacts, "knownFacts"),
    openQuestions: optionalStringArray(payload.openQuestions, "openQuestions"),
    endingConstraints: optionalStringArray(payload.endingConstraints, "endingConstraints"),
  };
}

/** Fold a section's declared updates into the bible, appending without duplicates. */
export function applyBibleUpdates(bible: BibleArtifact, updates: BibleUpdates): BibleArtifact {
  return {
    ...bible,
    timeline: appendUnique(bible.timeline, updates.timeline),
    knownFacts: appendUnique(bible.knownFacts, updates.knownFacts),
    openQuestions: appendUnique(bible.openQuestions, updates.openQuestions),
    supernaturalRules: appendUnique(bible.supernaturalRules, updates.supernaturalRules),
  };
}

function appendUnique(existing: string[], additions?: string[]): string[] {
  if (!additions || additions.length === 0) return existing;
  const seen = new Set(existing.map((item) => item.trim().toLowerCase()));
  const merged = [...existing];
  for (const item of additions) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      merged.push(trimmed);
    }
  }
  return merged;
}

export async function runBibleStage(ctx: StageContext): Promise<BibleArtifact> {
  const idea = await readStageArtifact<IdeaArtifact>(ctx.channelId, ctx.storyId, "idea");
  const outline = await readStageArtifact<OutlineArtifact>(ctx.channelId, ctx.storyId, "outline");
  if (!idea || !outline) {
    throw new Error("The bible stage needs a completed idea and outline.");
  }
  const outlineSummary = outline.sections
    .map((section) => `${section.index}. ${section.title} — ${section.goal}`)
    .join("\n");
  const result = await llmStage(
    ctx,
    "bible",
    BIBLE_PROMPT_NAME,
    BIBLE_PROMPT_VERSION,
    buildBibleMessages(promptContext(ctx), { premise: idea.premise, outlineSummary }),
    parseBible,
  );
  const artifact: BibleArtifact = { version: 1, ...result.value, provenance: result.provenance };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "bible", artifact);
  return artifact;
}
