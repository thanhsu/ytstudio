import { sha256 } from "../project-state.ts";
import { escalationEndpoint } from "../story-factory/stage-llm.ts";
import { llmStage, type StageContext } from "../story-factory/stages/context.ts";
import { assembleScriptArtifact, writeSectionFile } from "../story-factory/stages/sections.ts";
import { readStageArtifact, writeStageArtifact } from "../story-factory/story-project.ts";
import type { SectionArtifact } from "../story-factory/types.ts";
import { buildChapterContext } from "./chapter-context.ts";
import { activeKnowledge, arcForChapter, cardForChapter, loadArcs, loadBible, loadCharacters, loadThreads, openThreads, overdueThreads } from "./entities.ts";
import { loadEvents } from "./events.ts";
import { applyMemoryDelta } from "./memory-apply.ts";
import { ContextGapError, parseChapter, parseChapterPlan, parseContinuityReport, parseMemoryDelta } from "./parse.ts";
import {
  CANON_PROMPTS,
  buildChapterPlanMessages,
  buildChapterWriteMessages,
  buildContinuityMessages,
  buildMemoryExtractMessages,
} from "./prompts.ts";
import { chapterNumberFrom, loadCanonSeries } from "./series.ts";
import type {
  CanonChapterArtifact,
  CanonChapterPlan,
  CanonContinuityAttempt,
  CanonContinuityReport,
  CanonMemoryDelta,
  CanonSeries,
  ContextReport,
} from "./types.ts";

/**
 * The canon chapter stages. A canon chapter is a StoryProject with
 * kind "canon", so these run through the existing pipeline and inherit
 * StageRun bookkeeping, resumability, cost, the AI log, and jobs.
 *
 * `ctx.channelId` is the SERIES id here: a canon series is a channel project
 * whose stories are its chapters.
 */

export class CanonSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonSetupError";
  }
}

async function requireSeries(ctx: StageContext): Promise<CanonSeries> {
  const series = await loadCanonSeries(ctx.channelId);
  if (!series) {
    throw new CanonSetupError(
      `Project ${ctx.channelId} is not a canon series (story-series.json is missing). Create the series first.`,
    );
  }
  return series;
}

function requireChapterNumber(ctx: StageContext): number {
  const chapterNumber = chapterNumberFrom(ctx.storyId);
  if (chapterNumber === null) {
    throw new CanonSetupError(
      `Story id ${ctx.storyId} is not a canon chapter id. Canon chapters are named chapter-001, chapter-002, and so on.`,
    );
  }
  return chapterNumber;
}

// ---------------------------------------------------------------------------
// chapter-plan
// ---------------------------------------------------------------------------

export async function runChapterPlanStage(ctx: StageContext): Promise<CanonChapterPlan> {
  const series = await requireSeries(ctx);
  const chapterNumber = requireChapterNumber(ctx);
  const arcs = await loadArcs(ctx.channelId);
  const arc = arcForChapter(arcs, chapterNumber);
  if (!arc) {
    throw new CanonSetupError(
      `No arc covers chapter ${chapterNumber}. Plan the series arcs before writing chapters.`,
    );
  }
  const card = cardForChapter(arcs, chapterNumber);

  const cardText = card
    ? [
        `Goal: ${card.goal}`,
        `Main events: ${card.mainEvents.join("; ") || "(none given)"}`,
        `Characters: ${card.characters.join(", ") || "(arc cast)"}`,
        `Locations: ${card.locations.join(", ") || "(arc locations)"}`,
        `Required clues: ${card.requiredClues.join("; ") || "(none)"}`,
        `Ending hook: ${card.endingHook}`,
        `Arc progress: ${card.arcProgress}`,
      ].join("\n")
    : `Goal: advance the arc "${arc.title}" toward: ${arc.goal}`;

  const result = await llmStage(
    ctx,
    "chapter-plan",
    CANON_PROMPTS.chapterPlan.name,
    CANON_PROMPTS.chapterPlan.version,
    buildChapterPlanMessages(series, {
      chapterNumber,
      arcTitle: arc.title,
      arcGoal: arc.goal,
      card: cardText,
      // Arc-level embargoes and card-level ones both apply; the writer sees the
      // union, because either alone would let a twist out early.
      mustNotReveal: [...new Set([...arc.mustNotRevealYet, ...(card?.mustNotReveal ?? [])])],
    }),
    parseChapterPlan,
  );

  const plan: CanonChapterPlan = {
    version: 1,
    seriesId: ctx.channelId,
    chapterNumber,
    arcId: arc.id,
    title: result.value.title,
    goal: result.value.goal,
    beats: result.value.beats,
    characters: result.value.characters,
    locations: result.value.locations,
    requiredClues: result.value.requiredClues,
    mustNotReveal: [...new Set([...arc.mustNotRevealYet, ...result.value.mustNotReveal])],
    endingHook: result.value.endingHook,
    targetWords: result.value.targetWords,
    provenance: result.provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "chapter-plan", plan);
  return plan;
}

// ---------------------------------------------------------------------------
// canon-context
// ---------------------------------------------------------------------------

export async function runCanonContextStage(ctx: StageContext): Promise<ContextReport> {
  const chapterNumber = requireChapterNumber(ctx);
  const plan = await readStageArtifact<CanonChapterPlan>(ctx.channelId, ctx.storyId, "chapter-plan");
  if (!plan) {
    throw new Error("The context stage needs a completed chapter plan.");
  }
  const report = await buildChapterContext({
    seriesId: ctx.channelId,
    chapterNumber,
    plan,
    config: ctx.config,
  });
  await writeStageArtifact(ctx.channelId, ctx.storyId, "canon-context", report);
  return report;
}

// ---------------------------------------------------------------------------
// canon-write
// ---------------------------------------------------------------------------

export async function runCanonWriteStage(ctx: StageContext): Promise<CanonChapterArtifact> {
  const series = await requireSeries(ctx);
  const chapterNumber = requireChapterNumber(ctx);
  const plan = await readStageArtifact<CanonChapterPlan>(ctx.channelId, ctx.storyId, "chapter-plan");
  const context = await readStageArtifact<ContextReport>(ctx.channelId, ctx.storyId, "canon-context");
  if (!plan || !context) {
    throw new Error("Writing a chapter needs a completed plan and a built context.");
  }

  let result;
  try {
    result = await llmStage(
      ctx,
      "canon-write",
      CANON_PROMPTS.chapterWrite.name,
      CANON_PROMPTS.chapterWrite.version,
      buildChapterWriteMessages(series, plan, context.text),
      parseChapter,
    );
  } catch (error: unknown) {
    if (error instanceof ContextGapError) {
      // Retry ONCE with the gap named, so retrieval can widen for it. Beyond
      // that the chapter parks for a human: a second blind regeneration would
      // just pay again for the same refusal.
      const widened = `${context.text}\n\nThe writer previously reported missing context: ${error.missing.join("; ")}. If the canon above still does not contain it, report the gap again rather than inventing it.`;
      result = await llmStage(
        ctx,
        "canon-write",
        CANON_PROMPTS.chapterWrite.name,
        `${CANON_PROMPTS.chapterWrite.version}#gap-retry`,
        buildChapterWriteMessages(series, plan, widened),
        parseChapter,
      );
    } else {
      throw error;
    }
  }

  const canonicalText = result.value.text.trim();
  const artifact: CanonChapterArtifact = {
    version: 1,
    seriesId: ctx.channelId,
    chapterNumber,
    arcId: plan.arcId,
    title: result.value.title,
    canonicalText,
    summary: result.value.summary,
    wordCount: canonicalText.split(/\s+/).filter(Boolean).length,
    canonTextHash: sha256(canonicalText),
    provenance: result.provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "canon-write", artifact);

  // Also write the section artifacts the story factory's downstream stages
  // read. That is what lets `scenes` and `images` run on a canon chapter with
  // no branching at all — the shared visuals every locale reuses.
  const section: SectionArtifact = {
    version: 1,
    index: 1,
    title: artifact.title,
    text: canonicalText,
    wordCount: artifact.wordCount,
    bibleUpdates: {},
    provenance: result.provenance,
  };
  await writeSectionFile(ctx.channelId, ctx.storyId, section);
  await writeStageArtifact(ctx.channelId, ctx.storyId, "sections", assembleScriptArtifact([section]));
  return artifact;
}

// ---------------------------------------------------------------------------
// canon-continuity
// ---------------------------------------------------------------------------

export async function runCanonContinuityStage(ctx: StageContext): Promise<CanonContinuityReport> {
  const series = await requireSeries(ctx);
  const chapterNumber = requireChapterNumber(ctx);
  const context = await readStageArtifact<ContextReport>(ctx.channelId, ctx.storyId, "canon-context");
  const written = await readStageArtifact<CanonChapterArtifact>(ctx.channelId, ctx.storyId, "canon-write");
  const plan = await readStageArtifact<CanonChapterPlan>(ctx.channelId, ctx.storyId, "chapter-plan");
  if (!written || !context || !plan) {
    throw new Error("The continuity check needs a written chapter, its plan, and its context.");
  }
  // Rebound as non-null so the rewrite loop below can reassign it without the
  // declared type dragging `null` through every inference.
  let chapter: CanonChapterArtifact = written;

  const [arcs, threads] = await Promise.all([loadArcs(ctx.channelId), loadThreads(ctx.channelId)]);
  const threadLines = [
    ...openThreads(threads).map((thread) => `${thread.title} (open since chapter ${thread.introducedChapter})`),
    ...overdueThreads(threads, arcs, chapterNumber).map(
      (thread) => `OVERDUE: ${thread.title} should have been resolved in arc ${thread.requiredResolutionArc}`,
    ),
  ];

  const maxAttempts = Math.min(
    ctx.config.storyFactory.canon.maxAttemptsPerChapter,
    ctx.config.storyFactory.canon.escalateAfterAttempts + 2,
  );
  const attempts: CanonContinuityAttempt[] = [];
  let report: Omit<CanonContinuityReport, "attempts" | "gaveUpReason"> | null = null;
  let gaveUpReason: string | null = null;
  let previousIssueCount = Number.POSITIVE_INFINITY;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const escalated =
      attempt > ctx.config.storyFactory.canon.escalateAfterAttempts
        ? escalationEndpoint(ctx.config, "canon-write", ctx.confirmedPaidRequest)
        : null;

    const checked = await llmStage(
      ctx,
      "canon-continuity",
      CANON_PROMPTS.continuity.name,
      `${CANON_PROMPTS.continuity.version}#${attempt}`,
      buildContinuityMessages(series, {
        chapterNumber,
        chapterText: chapter.canonicalText,
        assembledContext: context.text,
        openThreads: threadLines,
      }),
      parseContinuityReport,
    );
    report = checked.value;
    attempts.push({
      n: attempt,
      model: checked.provenance.model,
      issueCount: checked.value.issues.length,
      costUsd: checked.costUsd,
      at: checked.provenance.generatedAt,
    });

    if (checked.value.passed) break;

    const errors = checked.value.issues.filter((issue) => issue.severity === "ERROR");
    // No-progress rule: an attempt that did not strictly shrink the issue set
    // is not converging, and another rewrite would just pay again for the same
    // output. Loops that only count attempts spin here.
    if (errors.length >= previousIssueCount) {
      gaveUpReason = `continuity stopped converging at attempt ${attempt} (${errors.length} errors)`;
      break;
    }
    previousIssueCount = errors.length;

    if (attempt === maxAttempts) {
      gaveUpReason = `continuity still failing after ${maxAttempts} attempts`;
      break;
    }

    // Rewrite the chapter with the issues named, escalating the model once the
    // configured number of local attempts is used up.
    const rewriteContext = `${context.text}

The previous draft was rejected by continuity review. Fix exactly these problems and change nothing else:
${errors.map((issue) => `- [${issue.type}] ${issue.description} (canon says: ${issue.canonReference})`).join("\n")}`;

    const rewritten = await llmStage(
      ctx,
      "canon-write",
      CANON_PROMPTS.chapterWrite.name,
      `${CANON_PROMPTS.chapterWrite.version}#fix${attempt}`,
      buildChapterWriteMessages(series, plan, rewriteContext),
      parseChapter,
      escalated ?? undefined,
    );
    const canonicalText = rewritten.value.text.trim();
    chapter = {
      ...chapter,
      title: rewritten.value.title,
      canonicalText,
      summary: rewritten.value.summary,
      wordCount: canonicalText.split(/\s+/).filter(Boolean).length,
      canonTextHash: sha256(canonicalText),
      provenance: rewritten.provenance,
    };
    await writeStageArtifact(ctx.channelId, ctx.storyId, "canon-write", chapter);
    const section: SectionArtifact = {
      version: 1,
      index: 1,
      title: chapter.title,
      text: canonicalText,
      wordCount: chapter.wordCount,
      bibleUpdates: {},
      provenance: rewritten.provenance,
    };
    await writeSectionFile(ctx.channelId, ctx.storyId, section);
    await writeStageArtifact(ctx.channelId, ctx.storyId, "sections", assembleScriptArtifact([section]));
  }

  const final: CanonContinuityReport = {
    version: 1,
    passed: report?.passed === true,
    issues: report?.issues ?? [],
    attempts,
    gaveUpReason,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "canon-continuity", final);
  if (!final.passed) {
    throw new CanonContinuityFailedError(final);
  }
  return final;
}

export class CanonContinuityFailedError extends Error {
  readonly report: CanonContinuityReport;

  constructor(report: CanonContinuityReport) {
    const errors = report.issues.filter((issue) => issue.severity === "ERROR");
    super(
      `Continuity check failed with ${errors.length} error(s): ${errors.map((issue) => issue.description).join(" | ")}` +
        (report.gaveUpReason ? ` (${report.gaveUpReason})` : ""),
    );
    this.name = "CanonContinuityFailedError";
    this.report = report;
  }
}

// ---------------------------------------------------------------------------
// memory-extract / memory-apply
// ---------------------------------------------------------------------------

export async function runMemoryExtractStage(ctx: StageContext): Promise<CanonMemoryDelta> {
  const series = await requireSeries(ctx);
  const chapterNumber = requireChapterNumber(ctx);
  const chapter = await readStageArtifact<CanonChapterArtifact>(ctx.channelId, ctx.storyId, "canon-write");
  if (!chapter) {
    throw new Error("Memory extraction needs an approved chapter.");
  }
  const [characters, bible] = await Promise.all([loadCharacters(ctx.channelId), loadBible(ctx.channelId)]);

  const result = await llmStage(
    ctx,
    "memory-extract",
    CANON_PROMPTS.memoryExtract.name,
    CANON_PROMPTS.memoryExtract.version,
    buildMemoryExtractMessages(series, {
      chapterNumber,
      chapterText: chapter.canonicalText,
      characterIds: characters.characters.map((character) => character.id),
      locationIds: bible.locations.map((location) => location.id),
    }),
    (raw) => parseMemoryDelta(raw, chapterNumber),
  );
  const delta = { ...result.value, provenance: result.provenance };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "memory-extract", delta);
  return delta;
}

export async function runMemoryApplyStage(ctx: StageContext): Promise<void> {
  const chapterNumber = requireChapterNumber(ctx);
  const delta = await readStageArtifact<CanonMemoryDelta>(ctx.channelId, ctx.storyId, "memory-extract");
  const chapter = await readStageArtifact<CanonChapterArtifact>(ctx.channelId, ctx.storyId, "canon-write");
  if (!delta || !chapter) {
    throw new Error("Applying memory needs an extracted delta and the chapter it came from.");
  }
  const report = await applyMemoryDelta({
    seriesId: ctx.channelId,
    chapterNumber,
    delta,
    chapterSummary: chapter.summary,
  });
  await writeStageArtifact(ctx.channelId, ctx.storyId, "memory-apply", report);
}

/** Character ids currently alive, for the chapter planner's cast checks. */
export async function livingCast(seriesId: string, chapterNumber: number): Promise<string[]> {
  const characters = await loadCharacters(seriesId);
  return characters.characters
    .filter(
      (character) =>
        character.deceasedSinceChapter === null || character.deceasedSinceChapter >= chapterNumber,
    )
    .map((character) => character.id);
}

export { activeKnowledge, loadEvents };
