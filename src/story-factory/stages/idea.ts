import { optionalStringArray, parseJsonObject, requireText } from "../../llm/parse.ts";
import { StoryContentError } from "../errors.ts";
import { checkDuplicate, minhashSignature } from "../fingerprint.ts";
import { loadChannelFingerprintIndex, upsertStoryFingerprints } from "../fingerprint-index.ts";
import { buildIdeaMessages, IDEA_PROMPT_NAME, IDEA_PROMPT_VERSION } from "../prompts/idea.ts";
import { writeStageArtifact } from "../story-project.ts";
import type { IdeaArtifact } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";
import { resolvePromptVersion } from "../prompt-overrides.ts";
import { ideaDirective, loadPerformanceProfile } from "../performance.ts";

export type ParsedIdea = {
  logline: string;
  premise: string;
  themes: string[];
  whyItWorks: string;
};

export function parseIdea(raw: string): ParsedIdea {
  const payload = parseJsonObject(raw);
  return {
    logline: requireText(payload.logline, "logline"),
    premise: requireText(payload.premise, "premise"),
    themes: optionalStringArray(payload.themes, "themes"),
    whyItWorks: requireText(payload.whyItWorks, "whyItWorks"),
  };
}

export async function runIdeaStage(ctx: StageContext): Promise<IdeaArtifact> {
  const index = await loadChannelFingerprintIndex(ctx.channelId);
  const priorEntries = index.entries.filter((entry) => entry.storyId !== ctx.storyId);
  const avoidPremises = priorEntries.slice(-20).map((entry) => entry.logline).filter(Boolean);
  const threshold = ctx.config.storyFactory.duplicateSimilarityThreshold;
  const performance = await loadPerformanceProfile(ctx.channelId);
  const candidates = priorEntries
    .filter((entry) => entry.ideaSignature.length > 0)
    .map((entry) => ({ storyId: entry.storyId, signature: entry.ideaSignature }));

  let parsed: ParsedIdea;
  let duplicateCheck = checkDuplicate("", [], threshold);
  // One automatic regeneration with the collisions named; a second collision is
  // the operator's call, not an endless paid loop.
  for (let attempt = 0; ; attempt += 1) {
    const result = await llmStage(
      ctx,
      "idea",
      IDEA_PROMPT_NAME,
      resolvePromptVersion(ctx.promptOverrides, IDEA_PROMPT_NAME, IDEA_PROMPT_VERSION),
      buildIdeaMessages(promptContext(ctx), {
        avoidPremises:
          attempt === 0
            ? avoidPremises
            : [...avoidPremises, `REJECTED as too similar on the last attempt: ${duplicateCheck.nearest[0]?.storyId ?? ""}`],
        performance: performance?.provenThemes.length
          ? { provenThemes: performance.provenThemes, directive: ideaDirective(ctx.storyId) }
          : undefined,
      }, ctx.promptOverrides),
      parseIdea,
    );
    parsed = result.value;
    duplicateCheck = checkDuplicate(`${parsed.logline} ${parsed.premise}`, candidates, threshold);
    if (!duplicateCheck.flagged) {
      const artifact: IdeaArtifact = { version: 1, ...parsed, duplicateCheck, provenance: result.provenance };
      await writeStageArtifact(ctx.channelId, ctx.storyId, "idea", artifact);
      await upsertStoryFingerprints(ctx.channelId, {
        version: 1,
        storyId: ctx.storyId,
        title: ctx.story.title,
        logline: parsed.logline,
        ideaSignature: minhashSignature(`${parsed.logline} ${parsed.premise}`),
      });
      return artifact;
    }
    if (attempt >= 1) {
      const nearest = duplicateCheck.nearest[0];
      throw new StoryContentError(
        `The generated idea is too similar to ${nearest?.storyId ?? "an existing story"} ` +
          `(similarity ${nearest ? nearest.similarity.toFixed(2) : "?"}, threshold ${threshold}). ` +
          "Regenerate the idea, change the sub-niche, or raise storyFactory.duplicateSimilarityThreshold.",
      );
    }
  }
}
