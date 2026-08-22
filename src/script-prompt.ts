import type { VideoBrief } from "./types.ts";

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const RUNTIME_TARGET: Record<VideoBrief["format"], string> = {
  shorts: "about 75 seconds",
  longform: "about 7 minutes",
};

export function buildScriptPrompt(brief: VideoBrief): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(brief) },
  ];
}

const SYSTEM_PROMPT = `You write scripts for a YouTube review channel.

Write original commentary, analysis, and opinion. Do not recap or retell the
source episode scene by scene: the value of the video must come from the
argument, not from replaying the original footage. Reference specific moments
only to support a point you are making about them.

Answer with a single JSON object and nothing else. No markdown fence, no
commentary before or after. The object has exactly these fields:

{
  "script": "markdown with '## Hook', '## Context', '## Main Points', '## Closing' sections",
  "metadata": {
    "titles": ["three to five title options, each under 100 characters"],
    "description": "two or three sentences for the video description",
    "hashtags": ["four to six hashtags, each starting with #"],
    "pinnedComment": "one question that invites debate"
  },
  "scenePlan": [
    {
      "label": "short scene name",
      "durationSeconds": 8,
      "purpose": "what this scene achieves",
      "visualDirection": "what is on screen"
    }
  ]
}

Every durationSeconds must be a positive number, and the scene durations
together should roughly match the runtime target. Write the script in the
requested language.`;

function userPrompt(brief: VideoBrief): string {
  const lines = [
    `Show: ${brief.show}`,
    `Topic: ${brief.topic}`,
    `Format: ${brief.format}`,
    `Runtime target: ${RUNTIME_TARGET[brief.format]}`,
    `Target audience: ${brief.audience}`,
    `Language: ${brief.language}`,
  ];
  if (brief.notes.trim()) {
    lines.push(`Creator notes: ${brief.notes.trim()}`);
  }
  return lines.join("\n");
}
