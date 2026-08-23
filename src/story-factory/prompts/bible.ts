import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const BIBLE_PROMPT_NAME = "story.bible";
export const BIBLE_PROMPT_VERSION = "bible-v1";

export function buildBibleMessages(
  context: StoryPromptContext,
  options: { premise: string; outlineSummary: string },
): ChatMessage[] {
  const system = `You build the story bible: the single source of truth that keeps names, ages, places, timelines, and supernatural rules consistent across every section a writer produces.

${renderStoryContext(context)}

${JSON_ONLY_RULE}
Fields (names/labels in the story language unless noted):
- "setting": 2-4 sentences on place, era, and atmosphere.
- "characters": array of { "name", "role", "description", "arc" } — every named character, with age and one distinguishing detail in the description.
- "timeline": array of strings, the story's key events in order.
- "locations": array of { "name", "description" }.
- "supernaturalRules": array of strings — what the strange element can and cannot do. These rules must never be contradicted.
- "knownFacts": array of strings — facts established for the reader that later sections must respect.
- "openQuestions": array of strings — mysteries the story raises and must resolve or deliberately leave open.
- "endingConstraints": array of strings — what must be true at the end for the story to land.`;

  const user = `Premise:
${options.premise}

Outline:
${options.outlineSummary}

Build the story bible now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
