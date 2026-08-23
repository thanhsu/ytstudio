import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";
import { renderList, renderOptionalBlock } from "./template.ts";

export const IDEA_PROMPT_NAME = "story.idea";
export const IDEA_PROMPT_VERSION = "idea-v1";

export function buildIdeaMessages(
  context: StoryPromptContext,
  options: { avoidPremises: string[] },
): ChatMessage[] {
  const system = `You are the idea generator for an original audio-story channel.

${renderStoryContext(context)}

Invent ONE new story idea for this channel. It must feel fresh against the premises listed as already used. Ground it in an everyday setting the audience recognizes (a job, a road, a building, a routine) and give it one clear supernatural or unexplainable element.

${JSON_ONLY_RULE}
Fields:
- "logline": one sentence that sells the story (story language).
- "premise": 4-7 sentences describing setup, the strange element, and where the tension comes from (story language).
- "themes": 2-4 short theme labels (story language).
- "whyItWorks": 1-3 sentences, in English, on why this fits the niche and holds attention for the target length.`;

  const user = `${renderOptionalBlock(
    "Premises already used on this channel — the new idea must NOT resemble any of these",
    renderList(options.avoidPremises),
  )}Generate the idea now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
