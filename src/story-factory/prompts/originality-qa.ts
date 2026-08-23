import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const ORIGINALITY_PROMPT_NAME = "story.originality-qa";
export const ORIGINALITY_PROMPT_VERSION = "originality-qa-v1";

export function buildOriginalityMessages(
  context: StoryPromptContext,
  options: { logline: string; fullText: string },
): ChatMessage[] {
  const system = `You are the final editorial reviewer before production. Judge originality and content safety; you do not rewrite anything.

${renderStoryContext(context)}

Review for:
- Resemblance to famous books, films, games, well-known creepypastas, or franchises; trademarked or franchise names.
- Real people presented as characters; real crimes presented as fact.
- Content-safety problems: sexual content, minors in danger beyond implied peril, hate content, crime instructions, gratuitous graphic gore beyond the genre's norm.

${JSON_ONLY_RULE}
Fields:
- "score": number 0-1, how original and publishable the story reads (1 = fully original).
- "issues": array of short English strings, one per originality concern — empty when clean.
- "safetyIssues": array of short English strings, one per safety concern — empty when clean.
- "publishable": boolean — false when any issue or safetyIssue requires a change before publishing.`;

  const user = `Logline: ${options.logline}

Full script:
${options.fullText}

Review it now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
