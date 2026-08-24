import type { StudioConfig } from "../../config.ts";
import type { ChatMessage } from "../../llm/chat.ts";
import type { ImageProvider } from "../../images/types.ts";
import type { TtsProvider } from "../../tts/types.ts";
import type { StoryPromptContext } from "../prompts/context.ts";
import type { PromptOverrides } from "../prompt-overrides.ts";
import { runLlmCall, stageEndpoint, type ChatFn, type LlmCallResult } from "../stage-llm.ts";
import type { BibleArtifact, StoryChannelConfig, StoryProject, StoryStageId } from "../types.ts";

/** Everything a stage function receives; providers are injectable for tests. */
export type StageContext = {
  channelId: string;
  storyId: string;
  channel: StoryChannelConfig;
  story: StoryProject;
  config: StudioConfig;
  chat?: ChatFn;
  ttsProvider?: TtsProvider;
  imageProvider?: ImageProvider;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  probeDuration?: (filePath: string) => Promise<number>;
  confirmedPaidRequest: boolean;
  signal?: AbortSignal;
  update?: (message: string) => Promise<void>;
  promptOverrides?: PromptOverrides;
};

export function promptContext(ctx: StageContext): StoryPromptContext {
  return {
    language: ctx.story.config.language,
    locale: ctx.story.config.locale,
    niche: ctx.story.config.niche,
    subNiche: ctx.story.config.subNiche,
    tone: ctx.story.config.tone,
    promptStyle: ctx.channel.promptStyle,
    targetDurationMinutes: ctx.story.config.targetDurationMinutes,
  };
}

/** One LLM call on behalf of a stage: endpoint by role, pricing from config, logged and costed. */
export async function llmStage<T>(
  ctx: StageContext,
  stage: StoryStageId,
  promptName: string,
  promptVersion: string,
  messages: ChatMessage[],
  parse: (raw: string) => T,
): Promise<LlmCallResult<T>> {
  return runLlmCall({
    channelId: ctx.channelId,
    storyId: ctx.storyId,
    stage,
    promptName,
    promptVersion,
    endpoint: stageEndpoint(ctx.config, stage),
    messages,
    parse,
    pricing: ctx.config.storyFactory.llmPricing,
    confirmedPaidRequest: ctx.confirmedPaidRequest,
    chat: ctx.chat,
    signal: ctx.signal,
  });
}

export function renderBibleContext(bible: BibleArtifact): string {
  const lines: string[] = [`Setting: ${bible.setting}`];
  if (bible.characters.length > 0) {
    lines.push("Characters:");
    for (const character of bible.characters) {
      lines.push(`- ${character.name} (${character.role}): ${character.description} Arc: ${character.arc}`);
    }
  }
  pushList(lines, "Locations", bible.locations.map((location) => `${location.name}: ${location.description}`));
  pushList(lines, "Timeline", bible.timeline);
  pushList(lines, "Supernatural rules", bible.supernaturalRules);
  pushList(lines, "Known facts", bible.knownFacts);
  pushList(lines, "Open questions", bible.openQuestions);
  pushList(lines, "Ending constraints", bible.endingConstraints);
  return lines.join("\n");
}

export function renderBibleVisualContext(bible: BibleArtifact): string {
  const lines: string[] = [`Setting: ${bible.setting}`];
  if (bible.characters.length > 0) {
    lines.push("Characters:");
    for (const character of bible.characters) {
      lines.push(`- ${character.name}: ${character.description}`);
    }
  }
  pushList(lines, "Locations", bible.locations.map((location) => `${location.name}: ${location.description}`));
  return lines.join("\n");
}

export function renderNumberedScript(sections: Array<{ index: number; text: string }>): string {
  return sections.map((section) => `[Section ${section.index}]\n${section.text}`).join("\n\n");
}

function pushList(lines: string[], label: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`${label}:`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}
