import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const CONTINUITY_PROMPT_NAME = "story.continuity-qa";
export const CONTINUITY_PROMPT_VERSION = "continuity-qa-v1";

export function buildContinuityMessages(
  context: StoryPromptContext,
  options: { bibleContext: string; numberedScript: string },
): ChatMessage[] {
  const system = `You are a continuity checker for serialized fiction. Compare the full script against its story bible and find contradictions a listener would notice.

${renderStoryContext(context)}

Check for: character name or age changes, location inconsistencies, timeline errors, objects appearing where they cannot be, supernatural-rule violations, forgotten established facts, plot contradictions, and open questions the ending forgot.

${JSON_ONLY_RULE}
Fields:
- "issues": array of { "severity": "minor"|"major", "sectionIndex": number, "description": string, "suggestion": string } — empty array when the script is clean. Descriptions and suggestions in English.
- "pass": boolean — false when ANY major issue exists.`;

  const user = `Story bible:
${options.bibleContext}

Script (sections numbered):
${options.numberedScript}

Report continuity now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
