import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE } from "./context.ts";
import { renderList, renderOptionalBlock } from "./template.ts";

export const LOCALIZE_PROMPT_NAME = "story.localize";
export const LOCALIZE_PROMPT_VERSION = "localize-v1";

export type LocalizePromptInput = {
  language: string;
  locale: string;
  audience: string;
  spokenStyle: string;
  formality: string;
  avoid: string[];
  promptStyle: string;
  /** Canon values this passage must preserve exactly, in meaning. */
  typedFacts: string;
  /** Character names as the canon spells them. */
  characterNames: string[];
  /** Channel pronunciations, so the localizer spells names TTS-friendly. */
  pronunciations: Array<{ original: string; pronunciation: string }>;
  sectionIndex: number;
  sectionCount: number;
  sourceText: string;
  /** Set on a remediation pass: the alignment failures to fix. */
  fixes: string[];
};

/**
 * Localization is not translation. The model may rewrite structure, idiom, and
 * rhythm freely; it may not touch anything the story asserts. The distinction
 * is spelled out as two explicit lists because a model given only "translate
 * faithfully" produces stilted calques, and one given only "adapt freely"
 * quietly moves a clock hand and breaks canon.
 */
export function buildLocalizeMessages(input: LocalizePromptInput): ChatMessage[] {
  const system = `You are a native ${input.language} (${input.locale}) audio-fiction writer. You are given one section of a chapter written in the series' canonical language, and you produce the version that will be read aloud to a ${input.locale} audience.

This is NOT translation. Write what a ${input.language} storyteller would have written, not what a translator would produce.

Audience: ${input.audience || `native ${input.language} listeners`}
Spoken style: ${input.spokenStyle}
Formality: ${input.formality}
House style: ${input.promptStyle}

You MAY change:
- sentence structure, length, and order within a passage
- idioms, imagery, and figures of speech
- dialogue wording and register
- narration rhythm and punctuation, for natural speech and TTS pauses
- anything that would sound translated, calqued, or culturally off

You MUST NOT change:
- events, or the order they happen in
- times, dates, ages, counts, or any other number the story states
- clues, revelations, or what is still hidden
- character identity, names, or relationships
- what any character knows, and when they learned it
- world rules or established facts
- injuries and deaths
- important objects and where they are

Write only prose narration: no headings, no scene labels, no stage directions, no lists.

${JSON_ONLY_RULE}
Fields:
- "text": the localized narration for this section, in ${input.language}.
- "notes": array of short English strings describing the kinds of adaptation you made.`;

  const user = `Section ${input.sectionIndex} of ${input.sectionCount}.

Canon values this passage must still state (in ${input.language}, however a narrator would say them):
${input.typedFacts}

Character names, spelled as the canon spells them:
${renderList(input.characterNames)}
${renderOptionalBlock(
    "Preferred spellings for narration (use these so the voice pronounces them correctly)",
    input.pronunciations.map((entry) => `${entry.original} -> ${entry.pronunciation}`).join("\n"),
  )}${renderOptionalBlock("Avoid", input.avoid.join("\n"))}${renderOptionalBlock(
    "This section was rejected by canon alignment. Fix exactly these and change nothing else",
    input.fixes.join("\n"),
  )}
Source section:
${input.sourceText}

Write the ${input.locale} version now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
