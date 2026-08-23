import { interpolate } from "./template.ts";

/**
 * The channel/story framing every prompt starts from. Headings and field names
 * stay in English verbatim (the JSON contract), while all creative output is
 * demanded in the story's language — the multilingual pattern proven by
 * script-prompt.ts.
 */

export type StoryPromptContext = {
  language: string;
  locale: string;
  niche: string;
  subNiche: string;
  tone: string;
  promptStyle: string;
  targetDurationMinutes: number;
};

const CONTEXT_TEMPLATE = `Channel context:
- Content language: {{language}} (locale {{locale}}). ALL creative text you produce must be written in this language, natural to native listeners of this locale. Avoid country-specific slang; stay neutral for the wider {{language}} audience.
- Niche: {{niche}}. Sub-niche: {{subNiche}}.
- Tone: {{tone}}.
- House style: {{promptStyle}}
- Target listening length: about {{targetDurationMinutes}} minutes of narration.

Hard rules:
- 100% original fiction. Never retell a known book, film, game, creepypasta, or franchise; never use trademarked names or franchise characters.
- Fictional supernatural stories only: no real murder cases presented as fact, no instructions for crimes, no sexual content, no content endangering minors, no hate content, no excessive graphic gore.
- Write for LISTENING: conversational, cinematic, suspenseful, simple vocabulary, short and medium sentences, no exposition dumps.`;

export function renderStoryContext(context: StoryPromptContext): string {
  return interpolate(CONTEXT_TEMPLATE, {
    language: context.language,
    locale: context.locale,
    niche: context.niche,
    subNiche: context.subNiche || "(channel's choice)",
    tone: context.tone,
    promptStyle: context.promptStyle,
    targetDurationMinutes: String(context.targetDurationMinutes),
  });
}

export const JSON_ONLY_RULE =
  "Respond with a single JSON object and nothing else. Use exactly the field names specified; JSON structure and field names are always in English, creative content is always in the story language.";
