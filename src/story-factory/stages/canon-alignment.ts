import { alignmentPassed, checkAlignment, checkNames, sectionsToFix } from "../../canon/alignment.ts";
import { loadEvents, typedFactsForChapter } from "../../canon/events.ts";
import { escalationEndpoint } from "../stage-llm.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { AlignmentIssue, CanonAlignmentReport } from "../../canon/types.ts";
import type { NaturalizedScript } from "../types.ts";
import { runLocalizeStage } from "./localize.ts";
import { runNaturalizeStage } from "./naturalize.ts";
import { readSectionFile } from "./sections.ts";
import type { StageContext } from "./context.ts";

/**
 * The canon alignment gate.
 *
 * It runs AFTER naturalize, on the text TTS will actually read, so a naturalizer
 * rewrite cannot smuggle a canon contradiction past it. That is one stage where
 * a check-then-naturalize-then-check-again design needs two.
 *
 * The check itself is deterministic (see canon/alignment.ts): typed values from
 * the canon event records, compared against values parsed out of the narration
 * in the target language. Only that can FAIL. An advisory model pass may add
 * WARNs, which are surfaced and never acted on.
 */

export class CanonAlignmentFailedError extends Error {
  readonly report: CanonAlignmentReport;

  constructor(report: CanonAlignmentReport) {
    const failures = report.issues.filter((issue) => issue.severity === "FAIL");
    super(
      `Canon alignment failed on ${failures.length} value(s): ` +
        failures.map((issue) => `${issue.label} should be ${issue.canonValue}, narration says ${issue.localizedValue}`).join(" | ") +
        (report.gaveUpReason ? ` (${report.gaveUpReason})` : ""),
    );
    this.name = "CanonAlignmentFailedError";
    this.report = report;
  }
}

export async function runCanonAlignmentStage(ctx: StageContext): Promise<CanonAlignmentReport> {
  const canonRef = ctx.story.canonRef;
  if (!canonRef) {
    throw new Error(`Story ${ctx.storyId} has no canonRef, so there is no canon to align it against.`);
  }

  const ledger = await loadEvents(canonRef.seriesId);
  const facts = typedFactsForChapter(ledger.events, canonRef.chapterNumber);
  const knownAnchors = new Set(facts.map((fact) => fact.id));

  const maxAttempts = Math.min(
    ctx.config.storyFactory.canon.maxAttemptsPerChapter,
    ctx.config.storyFactory.canon.escalateAfterAttempts + 2,
  );
  const attempts: CanonAlignmentReport["attempts"] = [];
  let issues: AlignmentIssue[] = [];
  let gaveUpReason: string | null = null;
  let previousFailures = Number.POSITIVE_INFINITY;
  let checkedFacts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const sections = await readNarrationSections(ctx);
    const input = {
      facts,
      sections,
      locale: ctx.story.config.locale,
      exemptions: ctx.channel.localeNotes.alignmentExemptions,
    };
    const outcome = checkAlignment(input);
    issues = [...outcome.issues, ...checkNames(input)];
    checkedFacts = outcome.checkedFacts;
    const failures = issues.filter((issue) => issue.severity === "FAIL");
    attempts.push({ n: attempt, failCount: failures.length, at: new Date().toISOString() });

    if (alignmentPassed(issues)) break;

    // No-progress rule: if a remediation pass did not strictly reduce the
    // failures, it is not converging. Re-localizing again would pay for the
    // same output — and a legitimate divergence the checker cannot see can
    // never be fixed by rewriting, only by an exemption.
    if (failures.length >= previousFailures) {
      gaveUpReason = `alignment stopped converging at attempt ${attempt}; ${failures.length} value(s) still differ. If the difference is intentional, add it to the channel's alignmentExemptions.`;
      break;
    }
    previousFailures = failures.length;

    if (attempt === maxAttempts) {
      gaveUpReason = `alignment still failing after ${maxAttempts} attempts`;
      break;
    }

    // Re-localize ONLY the offending sections, never the whole chapter.
    const targets = sectionsToFix(issues);
    const fixes = new Map<number, string[]>();
    for (const issue of failures) {
      const list = fixes.get(issue.sectionIndex) ?? [];
      list.push(
        `${issue.label} must be ${issue.canonValue} (the narration currently says ${issue.localizedValue}). Keep everything else exactly as it is.`,
      );
      fixes.set(issue.sectionIndex, list);
    }
    await ctx.update?.(`Re-localizing section(s) ${targets.join(", ")} to restore canon values...`);
    const escalated =
      attempt > ctx.config.storyFactory.canon.escalateAfterAttempts
        ? escalationEndpoint(ctx.config, "localize", ctx.confirmedPaidRequest)
        : null;
    await runLocalizeStage(ctx, { onlySections: targets, fixes, endpoint: escalated ?? undefined });
    // Naturalize again so the checked text stays the text TTS will read.
    await runNaturalizeStage(ctx);
  }

  const report: CanonAlignmentReport = {
    version: 1,
    passed: alignmentPassed(issues),
    issues,
    attempts,
    gaveUpReason,
    checkedFacts,
  };
  void knownAnchors;
  await writeStageArtifact(ctx.channelId, ctx.storyId, "canon-alignment", report);
  if (!report.passed) {
    throw new CanonAlignmentFailedError(report);
  }
  return report;
}

/**
 * The narration exactly as TTS will read it, still split by section.
 *
 * The per-section split is what makes targeted remediation possible: a failure
 * has to name one section to re-localize, and checking a joined fullText would
 * throw that mapping away. Naturalize therefore persists its per-section output
 * for precisely this. The localized section files are the fallback for a
 * variant whose naturalize predates that field.
 */
async function readNarrationSections(ctx: StageContext): Promise<Array<{ index: number; text: string }>> {
  const naturalized = await readStageArtifact<NaturalizedScript>(ctx.channelId, ctx.storyId, "naturalize");
  if (naturalized?.sections?.length) {
    return naturalized.sections;
  }
  const sections: Array<{ index: number; text: string }> = [];
  for (let index = 1; index < 500; index += 1) {
    const section = await readSectionFile(ctx.channelId, ctx.storyId, index);
    if (!section) break;
    sections.push({ index, text: section.text });
  }
  if (sections.length === 0) {
    throw new Error("Canon alignment needs localized sections to check.");
  }
  return sections;
}
