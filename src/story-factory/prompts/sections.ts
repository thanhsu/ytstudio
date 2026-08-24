import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";
import { renderList, renderOptionalBlock } from "./template.ts";
import { resolvePromptSystem, type PromptOverrides } from "../prompt-overrides.ts";

export const SECTION_PROMPT_NAME = "story.section";
export const SECTION_PROMPT_VERSION = "section-v1";
export const SECTION_SYSTEM_TEMPLATE = `You write one section of a long-form audio story. Other sections are written separately; the story bible below is the single source of truth — never contradict it.

{{context}}

Writing rules:
- Prose narration only: no headings, no scene labels, no camera directions, no lists.
- First person or close third person, consistent with the previous section.
- {{openingRule}}
- End the section on a beat that pulls the listener forward{{endingRule}}.
- Aim for {{targetWords}} words (within 20%).

{{jsonRule}}
Fields:
- "title": the section's final title (story language).
- "text": the full section narration (story language).
- "bibleUpdates": an object with optional arrays "timeline", "knownFacts", "openQuestions", "supernaturalRules" — ONLY genuinely new entries this section establishes; empty arrays or omitted keys when nothing changed.`;

export type SectionPromptInput = {
  sectionIndex: number;
  sectionCount: number;
  title: string;
  goal: string;
  beats: string[];
  targetWords: number;
  /** Relevant bible slices, already rendered as text blocks. */
  bibleContext: string;
  /** The last ~150 words of the previous section, for seamless continuation. */
  previousTail: string;
  /** Section 1 only: the approved hook the section must open with. */
  hookText: string;
};

export function buildSectionMessages(context: StoryPromptContext, input: SectionPromptInput, overrides?: PromptOverrides): ChatMessage[] {
  const system = resolvePromptSystem(overrides, SECTION_PROMPT_NAME, SECTION_SYSTEM_TEMPLATE, SECTION_PROMPT_VERSION, {
    context: renderStoryContext(context),
    openingRule: input.sectionIndex === 1 ? "This is the FIRST section: open with the hook text verbatim, then flow into the story." : "Continue seamlessly from the previous section's ending — do not recap it.",
    endingRule: input.sectionIndex === input.sectionCount ? ", or, as this is the FINAL section, land the ending and honor every ending constraint" : "",
    targetWords: String(input.targetWords),
    jsonRule: JSON_ONLY_RULE,
  }).system;

  const user = `Section ${input.sectionIndex} of ${input.sectionCount}: ${input.title}
Goal: ${input.goal}
Beats:
${renderList(input.beats)}

Story bible (source of truth):
${input.bibleContext}

${renderOptionalBlock("Hook to open with, verbatim", input.sectionIndex === 1 ? input.hookText : "")}${renderOptionalBlock(
    "End of the previous section",
    input.previousTail,
  )}Write section ${input.sectionIndex} now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
