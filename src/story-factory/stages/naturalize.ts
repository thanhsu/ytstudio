import { optionalStringArray, parseJsonObject, requireText } from "../../llm/parse.ts";
import { buildNaturalizeMessages, NATURALIZE_PROMPT_NAME, NATURALIZE_PROMPT_VERSION } from "../prompts/naturalize.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { NaturalizedScript, Provenance, ScriptArtifact } from "../types.ts";
import { readSectionFile } from "./sections.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

export type ParsedNaturalization = { text: string; notes: string[] };

export function parseNaturalization(raw: string): ParsedNaturalization {
  const payload = parseJsonObject(raw);
  return {
    text: requireText(payload.text, "text"),
    notes: optionalStringArray(payload.notes, "notes"),
  };
}

/**
 * Naturalization runs per section: a 30-minute script in one response would
 * fight output-token limits, and a truncated rewrite is worse than none. The
 * plot must survive untouched — this stage only changes how the text sounds.
 */
export async function runNaturalizeStage(ctx: StageContext): Promise<NaturalizedScript> {
  const script = await readStageArtifact<ScriptArtifact>(ctx.channelId, ctx.storyId, "sections");
  if (!script) {
    throw new Error("Naturalization needs a completed script.");
  }
  const naturalizedSections: string[] = [];
  const perSection: Array<{ index: number; text: string }> = [];
  const changes: Array<{ sectionIndex: number; note: string }> = [];
  let provenance: Provenance = {
    provider: "openai-compatible",
    model: ctx.config.storyFactory.models.qa.model,
    promptVersion: NATURALIZE_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };
  for (const entry of script.sections) {
    const section = await readSectionFile(ctx.channelId, ctx.storyId, entry.index);
    if (!section) {
      throw new Error(`Section ${entry.index} is missing from disk; rerun the sections stage.`);
    }
    await ctx.update?.(`Naturalizing section ${entry.index} of ${script.sections.length}...`);
    const result = await llmStage(
      ctx,
      "naturalize",
      NATURALIZE_PROMPT_NAME,
      `${NATURALIZE_PROMPT_VERSION}#${entry.index}`,
      buildNaturalizeMessages(promptContext(ctx), { sectionIndex: entry.index, sectionText: section.text }),
      parseNaturalization,
    );
    naturalizedSections.push(result.value.text.trim());
    perSection.push({ index: entry.index, text: result.value.text.trim() });
    for (const note of result.value.notes) {
      changes.push({ sectionIndex: entry.index, note });
    }
    provenance = result.provenance;
  }
  const artifact: NaturalizedScript = {
    version: 1,
    fullText: naturalizedSections.join("\n\n"),
    sections: perSection,
    changes,
    locale: ctx.story.config.locale,
    provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "naturalize", artifact);
  return artifact;
}
