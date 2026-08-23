import { parseJsonObject, requireArray, requireObject, requireStringArray, requireText } from "../../llm/parse.ts";
import { buildOutlineMessages, OUTLINE_PROMPT_NAME, OUTLINE_PROMPT_VERSION } from "../prompts/outline.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { HookArtifact, IdeaArtifact, OutlineArtifact, OutlineSection } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

/** Narration pacing assumption used to size sections and estimate durations. */
export const WORDS_PER_MINUTE = 150;

export function planSectionCount(targetDurationMinutes: number): number {
  return Math.min(12, Math.max(3, Math.ceil(targetDurationMinutes / 5)));
}

export function parseOutline(raw: string): OutlineSection[] {
  const payload = parseJsonObject(raw);
  const sections = requireArray(payload.sections, "sections").map((entry, index) => {
    const value = requireObject(entry, `sections[${index}]`);
    const targetWords = Math.round(Number(value.targetWords));
    return {
      index: index + 1,
      title: requireText(value.title, `sections[${index}].title`),
      goal: requireText(value.goal, `sections[${index}].goal`),
      beats: requireStringArray(value.beats, `sections[${index}].beats`),
      targetWords: Number.isFinite(targetWords) && targetWords > 50 ? targetWords : 600,
    };
  });
  if (sections.length < 2) {
    throw new Error("Model response field sections must contain at least 2 sections.");
  }
  return sections;
}

export async function runOutlineStage(ctx: StageContext): Promise<OutlineArtifact> {
  const idea = await readStageArtifact<IdeaArtifact>(ctx.channelId, ctx.storyId, "idea");
  const hook = await readStageArtifact<HookArtifact>(ctx.channelId, ctx.storyId, "hook");
  if (!idea || !hook) {
    throw new Error("The outline stage needs a completed idea and hook.");
  }
  const minutes = ctx.story.config.targetDurationMinutes;
  const sectionCount = planSectionCount(minutes);
  const targetWordsPerSection = Math.round((minutes * WORDS_PER_MINUTE) / sectionCount);
  const result = await llmStage(
    ctx,
    "outline",
    OUTLINE_PROMPT_NAME,
    OUTLINE_PROMPT_VERSION,
    buildOutlineMessages(promptContext(ctx), {
      logline: idea.logline,
      premise: idea.premise,
      hookText: hook.hookText,
      sectionCount,
      targetWordsPerSection,
    }),
    parseOutline,
  );
  const artifact: OutlineArtifact = { version: 1, sections: result.value, provenance: result.provenance };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "outline", artifact);
  return artifact;
}
