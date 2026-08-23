import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const HOOK_PROMPT_NAME = "story.hook";
export const HOOK_PROMPT_VERSION = "hook-v1";

export function buildHookMessages(
  context: StoryPromptContext,
  options: { logline: string; premise: string },
): ChatMessage[] {
  const system = `You write the opening 15-30 seconds of narration — the hook. The first half minute decides whether a listener stays.

${renderStoryContext(context)}

Hook rules:
- Start INSIDE the strange moment: a concrete time, place, and impossible detail.
- Never open with a greeting, a channel welcome, or "today I will tell you" framing.
- Optimize curiosity, suspense, immediate conflict, and open questions — without promising anything the story does not deliver.
- 40-90 words of spoken narration.

${JSON_ONLY_RULE}
Fields:
- "hookText": the hook narration (story language).
- "altHooks": exactly 2 alternative hooks taking different angles (story language).
- "estimatedSeconds": spoken length of hookText at a calm pace, as a number.`;

  const user = `Logline: ${options.logline}

Premise:
${options.premise}

Write the hook now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
