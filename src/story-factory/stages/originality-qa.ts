import { optionalStringArray, parseJsonObject } from "../../llm/parse.ts";
import { StoryContentError } from "../errors.ts";
import { estimateJaccard, minhashSignature } from "../fingerprint.ts";
import { loadChannelFingerprintIndex, upsertStoryFingerprints } from "../fingerprint-index.ts";
import {
  buildOriginalityMessages,
  ORIGINALITY_PROMPT_NAME,
  ORIGINALITY_PROMPT_VERSION,
} from "../prompts/originality-qa.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { IdeaArtifact, NaturalizedScript, OriginalityReport } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

export type ParsedOriginality = {
  score: number;
  issues: string[];
  safetyIssues: string[];
  publishable: boolean;
};

export function parseOriginality(raw: string): ParsedOriginality {
  const payload = parseJsonObject(raw);
  const score = Number(payload.score);
  return {
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
    issues: optionalStringArray(payload.issues, "issues"),
    safetyIssues: optionalStringArray(payload.safetyIssues, "safetyIssues"),
    publishable: payload.publishable === true,
  };
}

/**
 * Two independent checks merged into one verdict: a local fingerprint
 * comparison against the channel's published stories (no model can forget
 * those) and a model review for franchise resemblance and content safety.
 */
export async function runOriginalityStage(ctx: StageContext): Promise<OriginalityReport> {
  const idea = await readStageArtifact<IdeaArtifact>(ctx.channelId, ctx.storyId, "idea");
  const naturalized = await readStageArtifact<NaturalizedScript>(ctx.channelId, ctx.storyId, "naturalize");
  if (!idea || !naturalized) {
    throw new Error("Originality QA needs a completed idea and naturalized script.");
  }

  const threshold = ctx.config.storyFactory.duplicateSimilarityThreshold;
  const scriptSignature = minhashSignature(naturalized.fullText);
  const index = await loadChannelFingerprintIndex(ctx.channelId);
  const similarity = index.entries
    .filter((entry) => entry.storyId !== ctx.storyId && (entry.scriptSignature?.length ?? 0) > 0)
    .map((entry) => ({
      storyId: entry.storyId,
      jaccard: estimateJaccard(scriptSignature, entry.scriptSignature ?? []),
    }))
    .sort((a, b) => b.jaccard - a.jaccard)
    .slice(0, 3);
  const duplicateFlagged = similarity.some((entry) => entry.jaccard >= threshold);

  const result = await llmStage(
    ctx,
    "originality-qa",
    ORIGINALITY_PROMPT_NAME,
    ORIGINALITY_PROMPT_VERSION,
    buildOriginalityMessages(promptContext(ctx), { logline: idea.logline, fullText: naturalized.fullText }),
    parseOriginality,
  );

  const report: OriginalityReport = {
    version: 1,
    score: result.value.score,
    similarity,
    safetyIssues: result.value.safetyIssues,
    publishable:
      result.value.publishable &&
      result.value.issues.length === 0 &&
      result.value.safetyIssues.length === 0 &&
      !duplicateFlagged,
    provenance: result.provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "originality-qa", report);
  await upsertStoryFingerprints(ctx.channelId, {
    version: 1,
    storyId: ctx.storyId,
    title: ctx.story.title,
    logline: idea.logline,
    ideaSignature: minhashSignature(`${idea.logline} ${idea.premise}`),
    scriptSignature,
  });

  if (!report.publishable) {
    const reasons = [
      ...result.value.issues,
      ...result.value.safetyIssues,
      ...(duplicateFlagged ? [`script too similar to ${similarity[0]?.storyId}`] : []),
    ];
    throw new StoryContentError(
      `Originality/safety QA blocked publishing: ${reasons.slice(0, 3).join("; ") || "see originality-report.json"}. ` +
        "Edit or regenerate the flagged material.",
    );
  }
  return report;
}
