import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const METADATA_PROMPT_NAME = "story.metadata";
export const METADATA_PROMPT_VERSION = "metadata-v1";

export function buildMetadataMessages(
  context: StoryPromptContext,
  options: { logline: string; hookText: string; synopsis: string },
): ChatMessage[] {
  const system = `You write YouTube metadata for an original audio story. Honest packaging: curiosity without misleading clickbait, no all-caps titles, no fake claims.

${renderStoryContext(context)}

${JSON_ONLY_RULE}
Fields (story language unless noted):
- "titles": array of AT LEAST 5 objects { "title", "score": 0-1, "rationale": English }, scored on curiosity, clarity, relevance, click potential, and spam risk.
- "chosenTitle": the best title from the list.
- "description": 2-4 short paragraphs — a teaser that never spoils the ending, then a fictional-story disclaimer sentence in the story language.
- "tags": 10-20 search tags, lowercase.
- "thumbnailText": 2-5 words for the thumbnail overlay, punchy, in the story language.
- "thumbnailConcept": one English sentence describing the thumbnail background image (one focal point, no text in the image).`;

  const user = `Logline: ${options.logline}

Hook:
${options.hookText}

Synopsis:
${options.synopsis}

Write the metadata now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
