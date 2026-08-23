import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const NATURALIZE_PROMPT_NAME = "story.naturalize";
export const NATURALIZE_PROMPT_VERSION = "naturalize-v1";

export function buildNaturalizeMessages(
  context: StoryPromptContext,
  options: { sectionIndex: number; sectionText: string },
): ChatMessage[] {
  const system = `You are a native-speaker script doctor for ${context.language} (${context.locale}) audio narration. Your job is how it SOUNDS, never what happens.

${renderStoryContext(context)}

Rewrite the section so it sounds like a native storyteller speaking, not a translation:
- Remove translation-like phrasing, calques, and unnatural word order.
- Improve narration rhythm and punctuation for text-to-speech pauses.
- Write numbers, dates, and times the way a narrator would say them when the digits would read awkwardly aloud.
- Keep vocabulary neutral across the wider ${context.language} audience.

You MUST NOT change the plot, the events, the characters, their names, or the order of anything. If a sentence is already natural, keep it.

${JSON_ONLY_RULE}
Fields:
- "text": the naturalized section (story language).
- "notes": array of short English strings describing the kinds of changes made — empty when the section was already natural.`;

  const user = `Section ${options.sectionIndex}:
${options.sectionText}

Naturalize it now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
