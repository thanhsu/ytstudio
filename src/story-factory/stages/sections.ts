import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { optionalStringArray, parseJsonObject, requireObject, requireText } from "../../llm/parse.ts";
import { sha256 } from "../../project-state.ts";
import { storyPath } from "../paths.ts";
import { buildSectionMessages, SECTION_PROMPT_NAME, SECTION_PROMPT_VERSION } from "../prompts/sections.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type {
  BibleArtifact,
  BibleUpdates,
  HookArtifact,
  OutlineArtifact,
  ScriptArtifact,
  SectionArtifact,
} from "../types.ts";
import { applyBibleUpdates } from "./bible.ts";
import { llmStage, promptContext, renderBibleContext, type StageContext } from "./context.ts";
import { resolvePromptVersion } from "../prompt-overrides.ts";

export type ParsedSection = {
  title: string;
  text: string;
  bibleUpdates: BibleUpdates;
};

export function parseSection(raw: string): ParsedSection {
  const payload = parseJsonObject(raw);
  const updates =
    payload.bibleUpdates === undefined || payload.bibleUpdates === null
      ? {}
      : requireObject(payload.bibleUpdates, "bibleUpdates");
  return {
    title: requireText(payload.title, "title"),
    text: requireText(payload.text, "text"),
    bibleUpdates: {
      timeline: optionalStringArray(updates.timeline, "bibleUpdates.timeline"),
      knownFacts: optionalStringArray(updates.knownFacts, "bibleUpdates.knownFacts"),
      openQuestions: optionalStringArray(updates.openQuestions, "bibleUpdates.openQuestions"),
      supernaturalRules: optionalStringArray(updates.supernaturalRules, "bibleUpdates.supernaturalRules"),
    },
  };
}

export function sectionFileName(index: number): string {
  return `section-${String(index).padStart(3, "0")}.json`;
}

/** The last ~150 words of a section, handed to the next one for a seamless join. */
export function sectionTail(text: string, words = 150): string {
  const tokens = text.trim().split(/\s+/);
  return tokens.slice(Math.max(0, tokens.length - words)).join(" ");
}

/**
 * Write the story section by section, updating the bible after each one so
 * later sections see what earlier ones established. Sections already on disk
 * are reused (a failure at section 5 never regenerates 1-4); pass
 * regenerateIndex to force exactly one section fresh.
 */
export async function runSectionsStage(
  ctx: StageContext,
  options: { regenerateIndex?: number; regenerateAll?: boolean } = {},
): Promise<ScriptArtifact> {
  const outline = await readStageArtifact<OutlineArtifact>(ctx.channelId, ctx.storyId, "outline");
  const hook = await readStageArtifact<HookArtifact>(ctx.channelId, ctx.storyId, "hook");
  let bible = await readStageArtifact<BibleArtifact>(ctx.channelId, ctx.storyId, "bible");
  if (!outline || !hook || !bible) {
    throw new Error("The sections stage needs a completed outline, hook, and bible.");
  }

  const sections: SectionArtifact[] = [];
  for (const planned of outline.sections) {
    const existing =
      options.regenerateAll || options.regenerateIndex === planned.index
        ? null
        : await readSectionFile(ctx.channelId, ctx.storyId, planned.index);
    if (existing) {
      sections.push(existing);
      continue;
    }

    await ctx.update?.(`Writing section ${planned.index} of ${outline.sections.length}...`);
    const previous = sections[sections.length - 1];
    const result = await llmStage(
      ctx,
      "sections",
      SECTION_PROMPT_NAME,
      `${resolvePromptVersion(ctx.promptOverrides, SECTION_PROMPT_NAME, SECTION_PROMPT_VERSION)}#${planned.index}`,
      buildSectionMessages(promptContext(ctx), {
        sectionIndex: planned.index,
        sectionCount: outline.sections.length,
        title: planned.title,
        goal: planned.goal,
        beats: planned.beats,
        targetWords: planned.targetWords,
        bibleContext: renderBibleContext(bible),
        previousTail: previous ? sectionTail(previous.text) : "",
        hookText: hook.hookText,
      }, ctx.promptOverrides),
      parseSection,
    );
    const section: SectionArtifact = {
      version: 1,
      index: planned.index,
      title: result.value.title,
      text: result.value.text,
      wordCount: result.value.text.trim().split(/\s+/).length,
      bibleUpdates: result.value.bibleUpdates,
      provenance: result.provenance,
    };
    await writeSectionFile(ctx.channelId, ctx.storyId, section);
    sections.push(section);

    // Later sections must see what this one established.
    bible = applyBibleUpdates(bible, section.bibleUpdates);
    await writeStageArtifact(ctx.channelId, ctx.storyId, "bible", bible);
  }

  const script = assembleScriptArtifact(sections);
  await writeStageArtifact(ctx.channelId, ctx.storyId, "sections", script);
  return script;
}

/**
 * Build the script.json artifact from a story's sections. Shared by the
 * generation stage above and by section-edit.ts, so a hand-edit and a fresh
 * generation hash the same fullText/sourceHash the same way.
 */
export function assembleScriptArtifact(sections: SectionArtifact[]): ScriptArtifact {
  const fullText = sections.map((section) => section.text.trim()).join("\n\n");
  return {
    version: 1,
    fullText,
    sections: sections.map((section) => ({ index: section.index, textHash: sha256(section.text) })),
    wordCount: fullText.trim().split(/\s+/).length,
    sourceHash: sha256(fullText),
  };
}

export async function readSectionFile(
  channelId: string,
  storyId: string,
  index: number,
): Promise<SectionArtifact | null> {
  try {
    const raw = await readFile(storyPath(channelId, storyId, "sections", sectionFileName(index)), "utf8");
    const value = JSON.parse(raw) as SectionArtifact;
    return typeof value?.text === "string" && value.text.trim() ? value : null;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeSectionFile(channelId: string, storyId: string, section: SectionArtifact): Promise<void> {
  const path = storyPath(channelId, storyId, "sections", sectionFileName(section.index));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(section, null, 2)}\n`, "utf8");
}
