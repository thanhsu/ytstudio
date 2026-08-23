import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const SCENES_PROMPT_NAME = "story.scenes";
export const SCENES_PROMPT_VERSION = "scenes-v1";

export function buildScenesMessages(
  context: StoryPromptContext,
  options: { sceneCount: number; stylePrompt: string; bibleVisualContext: string; numberedScript: string },
): ChatMessage[] {
  const system = `You extract visual scenes from an audio story for a still-image slideshow. One image covers 45-120 seconds of narration, so scenes are moods and moments, not shot lists.

${renderStoryContext(context)}

Visual continuity: characters, locations, and important objects must be described consistently with the story bible in every prompt (same age, same clothing era, same building). Image prompts are written in English for the image model and must describe NO text, letters, or captions in the image.

${JSON_ONLY_RULE}
Fields:
- "scenes": an array of EXACTLY ${options.sceneCount} objects, in story order, each with:
  - "summary": one sentence, what this stretch of narration covers (English).
  - "imagePrompt": a complete English image prompt for the moment, ending with this style: "${options.stylePrompt}".
  - "continuityRefs": array of bible names (characters/locations/objects) the prompt depends on.`;

  const user = `Story bible visual anchors:
${options.bibleVisualContext}

Script (sections numbered):
${options.numberedScript}

Extract ${options.sceneCount} scenes now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
