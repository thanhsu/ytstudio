import { readFile } from "node:fs/promises";
import { loadEvents, typedFactsForChapter } from "../../canon/events.ts";
import { loadCharacters } from "../../canon/entities.ts";
import { renderTypedFacts } from "../../canon/prompts.ts";
import { canonChapterPath } from "../../canon/variant.ts";
import { optionalStringArray, parseJsonObject, requireText } from "../../llm/parse.ts";
import { buildLocalizeMessages, LOCALIZE_PROMPT_NAME, LOCALIZE_PROMPT_VERSION } from "../prompts/localize.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { LocalizedReport, LocalizeSectionAttempt } from "../../canon/types.ts";
import type { CanonChapterArtifact } from "../../canon/types.ts";
import type { Provenance, SectionArtifact } from "../types.ts";
import { assembleScriptArtifact, readSectionFile, writeSectionFile } from "./sections.ts";
import { llmStage, type StageContext } from "./context.ts";

/**
 * Localization: one canon chapter becomes one channel's narration.
 *
 * It writes exactly the artifacts the `sections` stage writes — the per-section
 * files and script.json — so `naturalize`, `section-edit`, `scenes`, and
 * `metadata` run on a variant with no change at all. That equivalence is the
 * whole reason a variant costs a stage rather than a second pipeline.
 */

export type ParsedLocalization = { text: string; notes: string[] };

export function parseLocalization(raw: string): ParsedLocalization {
  const payload = parseJsonObject(raw);
  return {
    text: requireText(payload.text, "text"),
    notes: optionalStringArray(payload.notes, "notes"),
  };
}

/**
 * Canon prose is split into localization units at paragraph boundaries. A whole
 * chapter in one response fights output-token limits, and a truncated
 * localization is worse than none — the same reason naturalize runs per
 * section.
 */
export function splitIntoSections(text: string, targetWords = 700): string[] {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];
  const sections: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const paragraph of paragraphs) {
    const paragraphWords = paragraph.split(/\s+/).length;
    if (words > 0 && words + paragraphWords > targetWords) {
      sections.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(paragraph);
    words += paragraphWords;
  }
  if (current.length > 0) sections.push(current.join("\n\n"));
  return sections;
}

export type LocalizeOptions = {
  /** Remediation: re-localize only these section indices. */
  onlySections?: number[];
  /** Alignment failures, keyed by section index, for a remediation pass. */
  fixes?: Map<number, string[]>;
  /** Override endpoint, used when escalating after repeated failures. */
  endpoint?: Parameters<typeof llmStage>[6];
};

export async function runLocalizeStage(ctx: StageContext, options: LocalizeOptions = {}): Promise<LocalizedReport> {
  const canonRef = ctx.story.canonRef;
  if (!canonRef) {
    // A variant with no resolvable canon must fail loudly. Falling back to the
    // original pipeline here would generate a brand-new English story on top of
    // what was supposed to be a localization.
    throw new Error(
      `Story ${ctx.storyId} is marked as a localization variant but has no canonRef. Recreate it from a canon chapter.`,
    );
  }

  const chapter = await readCanonChapter(canonRef.seriesId, canonRef.chapterId);
  const [ledger, characters] = await Promise.all([
    loadEvents(canonRef.seriesId),
    loadCharacters(canonRef.seriesId),
  ]);
  const facts = typedFactsForChapter(ledger.events, canonRef.chapterNumber);

  const sources = splitIntoSections(chapter.canonicalText);
  if (sources.length === 0) {
    throw new Error("The canon chapter has no text to localize.");
  }

  const existing = await readStageArtifact<LocalizedReport>(ctx.channelId, ctx.storyId, "localize");
  const attemptsByIndex = new Map<number, LocalizeSectionAttempt>(
    (existing?.sections ?? []).map((entry) => [entry.sectionIndex, entry]),
  );

  const sections: SectionArtifact[] = [];
  let provenance: Provenance = {
    provider: "openai-compatible",
    model: "",
    promptVersion: LOCALIZE_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };

  for (const [offset, sourceText] of sources.entries()) {
    const index = offset + 1;
    const shouldRun = !options.onlySections || options.onlySections.includes(index);
    if (!shouldRun) {
      // Untouched sections keep their existing localization. A remediation pass
      // must never re-localize prose that alignment already accepted.
      const kept = await readSectionFile(ctx.channelId, ctx.storyId, index);
      if (kept) {
        sections.push(kept);
        continue;
      }
    }

    await ctx.update?.(`Localizing section ${index} of ${sources.length}...`);
    const previousAttempt = attemptsByIndex.get(index);
    const result = await llmStage(
      ctx,
      "localize",
      LOCALIZE_PROMPT_NAME,
      `${LOCALIZE_PROMPT_VERSION}#${index}`,
      buildLocalizeMessages({
        language: ctx.story.config.language,
        locale: ctx.story.config.locale,
        audience: ctx.channel.localeNotes.audience,
        spokenStyle: ctx.channel.localeNotes.spokenStyle,
        formality: ctx.channel.localeNotes.formality,
        avoid: ctx.channel.localeNotes.avoid,
        promptStyle: ctx.channel.promptStyle,
        typedFacts: renderTypedFacts(facts),
        characterNames: characters.characters.map((character) => character.name),
        pronunciations: ctx.channel.pronunciations,
        sectionIndex: index,
        sectionCount: sources.length,
        sourceText,
        fixes: options.fixes?.get(index) ?? [],
      }),
      parseLocalization,
      options.endpoint,
    );

    const text = result.value.text.trim();
    const section: SectionArtifact = {
      version: 1,
      index,
      title: `${chapter.title} (${index}/${sources.length})`,
      text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      bibleUpdates: {},
      provenance: result.provenance,
    };
    await writeSectionFile(ctx.channelId, ctx.storyId, section);
    sections.push(section);
    provenance = result.provenance;
    attemptsByIndex.set(index, {
      sectionIndex: index,
      attemptCount: (previousAttempt?.attemptCount ?? 0) + 1,
      model: result.provenance.model,
      costUsd: (previousAttempt?.costUsd ?? 0) + result.costUsd,
      lastIssue: null,
    });
  }

  // The same artifact the sections stage writes, so every downstream stage and
  // the whole dependency graph keep working untouched.
  await writeStageArtifact(ctx.channelId, ctx.storyId, "sections", assembleScriptArtifact(sections));

  const report: LocalizedReport = {
    version: 1,
    seriesId: canonRef.seriesId,
    chapterId: canonRef.chapterId,
    language: ctx.story.config.language,
    locale: ctx.story.config.locale,
    sections: [...attemptsByIndex.values()].sort((left, right) => left.sectionIndex - right.sectionIndex),
    provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "localize", report);
  return report;
}

export async function readCanonChapter(seriesId: string, chapterId: string): Promise<CanonChapterArtifact> {
  const raw = await readFile(canonChapterPath(seriesId, chapterId, "chapter.json"), "utf8");
  const chapter = JSON.parse(raw) as CanonChapterArtifact;
  if (!chapter?.canonicalText?.trim()) {
    throw new Error(`Canon chapter ${chapterId} in series ${seriesId} has no canonical text.`);
  }
  return chapter;
}
