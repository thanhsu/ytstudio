import type { ChatMessage } from "../../llm/chat.ts";
import { JSON_ONLY_RULE, renderStoryContext, type StoryPromptContext } from "./context.ts";

export const OUTLINE_PROMPT_NAME = "story.outline";
export const OUTLINE_PROMPT_VERSION = "outline-v1";

export function buildOutlineMessages(
  context: StoryPromptContext,
  options: { logline: string; premise: string; hookText: string; sectionCount: number; targetWordsPerSection: number },
): ChatMessage[] {
  const system = `You outline audio stories so a writer can produce them section by section without losing the thread.

${renderStoryContext(context)}

Structure guidance (adapt, do not force): cold open (the hook), setup, first anomaly, escalation, midpoint revelation, major threat, twist, climax, aftermath, final sting. Tension must ratchet upward; every section ends on a reason to keep listening.

${JSON_ONLY_RULE}
Fields:
- "sections": an array of EXACTLY ${options.sectionCount} objects, in story order, each with:
  - "title": short working title (story language)
  - "goal": what this section accomplishes in the story (story language)
  - "beats": 3-6 concrete story beats (story language)
  - "targetWords": around ${options.targetWordsPerSection}, as a number.
Section 1 must open with the hook.`;

  const user = `Logline: ${options.logline}

Premise:
${options.premise}

Hook (section 1 opens with this):
${options.hookText}

Outline the story now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
