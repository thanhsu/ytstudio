import { parseJsonObject, requireArray, requireObject, requireStringArray, requireText } from "../../llm/parse.ts";
import { buildMetadataMessages, METADATA_PROMPT_NAME, METADATA_PROMPT_VERSION } from "../prompts/metadata.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { HookArtifact, IdeaArtifact, StoryMetadataArtifact } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

export function parseMetadata(raw: string): Omit<StoryMetadataArtifact, "version" | "language" | "provenance"> {
  const payload = parseJsonObject(raw);
  const titles = requireArray(payload.titles, "titles").map((entry, index) => {
    const value = requireObject(entry, `titles[${index}]`);
    const score = Number(value.score);
    return {
      title: requireText(value.title, `titles[${index}].title`),
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
      rationale: requireText(value.rationale, `titles[${index}].rationale`),
    };
  });
  if (titles.length < 5) {
    throw new Error("Model response field titles must contain at least 5 candidates.");
  }
  const thumbnailText = requireText(payload.thumbnailText, "thumbnailText");
  const wordCount = thumbnailText.trim().split(/\s+/).length;
  if (wordCount > 5) {
    throw new Error("Model response field thumbnailText must be 2-5 words for mobile readability.");
  }
  return {
    titles,
    chosenTitle: requireText(payload.chosenTitle, "chosenTitle"),
    description: requireText(payload.description, "description"),
    tags: requireStringArray(payload.tags, "tags"),
    thumbnailText,
    thumbnailConcept: requireText(payload.thumbnailConcept, "thumbnailConcept"),
  };
}

export async function runMetadataStage(ctx: StageContext): Promise<StoryMetadataArtifact> {
  const idea = await readStageArtifact<IdeaArtifact>(ctx.channelId, ctx.storyId, "idea");
  const hook = await readStageArtifact<HookArtifact>(ctx.channelId, ctx.storyId, "hook");
  if (!idea || !hook) {
    throw new Error("Metadata generation needs a completed idea and hook.");
  }
  const result = await llmStage(
    ctx,
    "metadata",
    METADATA_PROMPT_NAME,
    METADATA_PROMPT_VERSION,
    buildMetadataMessages(promptContext(ctx), {
      logline: idea.logline,
      hookText: hook.hookText,
      synopsis: idea.premise,
    }),
    parseMetadata,
  );
  const artifact: StoryMetadataArtifact = {
    version: 1,
    ...result.value,
    language: ctx.story.config.language,
    provenance: result.provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "metadata", artifact);
  return artifact;
}
