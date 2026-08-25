import type { LlmEndpointConfig, StudioConfig } from "../config.ts";
import { anthropicChat } from "../llm/anthropic.ts";
import {
  chatJsonWithUsage,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type OpenAiCompatibleConfig,
} from "../llm/chat.ts";
import { geminiChat } from "../llm/gemini.ts";
import { appendAiLog } from "./ai-log.ts";
import { addStoryCost, estimateLlmCost } from "./cost.ts";
import type { Provenance, StoryStageId } from "./types.ts";

/**
 * The one path every AI stage calls through: pick the endpoint for the stage's
 * role, make the chat call, parse before anything is written, record measured
 * usage and cost, and append the execution to the story's AI log — success or
 * failure. Stages never touch the transport directly.
 */

export type ChatFn = (
  config: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  options: ChatOptions,
) => Promise<ChatResult>;

/**
 * The transport for a configured endpoint's provider. All three take the same
 * `OpenAiCompatibleConfig` shape, so switching a role's provider is a config
 * change, never a call-site change.
 */
function chatFnFor(provider: LlmEndpointConfig["provider"]): ChatFn {
  switch (provider) {
    case "anthropic":
      return anthropicChat;
    case "gemini":
      return geminiChat;
    default:
      return chatJsonWithUsage;
  }
}

export type LlmStageRole = "planner" | "writer" | "qa" | "architect" | "localizer" | "memory";

/**
 * Which configured model runs which stage — cheap models plan and label,
 * stronger models write and check. Editable only here.
 *
 * The canon roles exist so the expensive/rare work (series architecture, arc
 * design) can use a strong paid model while the high-volume work (chapter
 * prose, memory extraction, localization) runs on a small or local one.
 */
export const STAGE_ROLES: Partial<Record<StoryStageId, LlmStageRole>> = {
  idea: "planner",
  hook: "planner",
  outline: "planner",
  bible: "planner",
  scenes: "planner",
  metadata: "planner",
  sections: "writer",
  "continuity-qa": "qa",
  naturalize: "qa",
  "originality-qa": "qa",

  // Canon. Chapter planning is architectural; chapter prose is high-volume.
  "chapter-plan": "architect",
  "canon-write": "writer",
  "canon-continuity": "qa",
  "memory-extract": "memory",

  // Localization is the highest-volume AI work in the system — one call per
  // section per locale per chapter — so it gets its own cheap role.
  localize: "localizer",
  "canon-alignment": "qa",
};

/**
 * The role a stage escalates to when its own model keeps failing QA. Escalation
 * is a role swap, not a separate mechanism: `runLlmCall` already takes the
 * endpoint as a parameter, so retrying with a stronger one is one argument.
 */
export const ESCALATION_ROLES: Partial<Record<LlmStageRole, LlmStageRole>> = {
  writer: "architect",
  localizer: "qa",
  memory: "qa",
  qa: "architect",
};

export function stageEndpoint(config: StudioConfig, stage: StoryStageId): LlmEndpointConfig {
  const role = STAGE_ROLES[stage];
  if (!role) {
    throw new Error(`Stage ${stage} is not an LLM stage.`);
  }
  return roleEndpoint(config, role);
}

/**
 * An "unset" role is one with an empty model, never a missing key — the record
 * is total so every call site stays non-optional. A role configured with no
 * model falls back to its legacy equivalent, which is what keeps a config
 * written before the canon roles existed working unchanged.
 */
const LEGACY_ROLE_FALLBACK: Record<LlmStageRole, LlmStageRole | null> = {
  planner: null,
  writer: null,
  qa: null,
  architect: "planner",
  localizer: "qa",
  memory: "qa",
};

export function roleEndpoint(config: StudioConfig, role: LlmStageRole): LlmEndpointConfig {
  const endpoint = config.storyFactory.models[role];
  if (endpoint.model.trim()) {
    return endpoint;
  }
  const fallbackRole = LEGACY_ROLE_FALLBACK[role];
  if (fallbackRole) {
    const fallback = config.storyFactory.models[fallbackRole];
    if (fallback.model.trim()) {
      return fallback;
    }
  }
  throw new Error(
    `No model configured for the story factory ${role} role. Set storyFactory.models.${role}.model in the studio config.`,
  );
}

/**
 * The endpoint to retry a failing stage on. Returns null when the stage has
 * nowhere stronger to go, so the caller stops instead of looping on the same
 * model. A paid escalation target is refused unless the run was confirmed as
 * paid: the operator authorised the pipeline, not a silent free-to-paid switch.
 */
export function escalationEndpoint(
  config: StudioConfig,
  stage: StoryStageId,
  confirmedPaidRequest: boolean,
): LlmEndpointConfig | null {
  const role = STAGE_ROLES[stage];
  const target = role ? ESCALATION_ROLES[role] : undefined;
  if (!role || !target) return null;
  let endpoint: LlmEndpointConfig;
  try {
    endpoint = roleEndpoint(config, target);
  } catch {
    return null;
  }
  const current = roleEndpoint(config, role);
  if (endpoint.model === current.model && endpoint.baseUrl === current.baseUrl) {
    return null;
  }
  if (endpoint.paid && !confirmedPaidRequest) {
    return null;
  }
  return endpoint;
}

export type LlmCallOptions<T> = {
  channelId: string;
  storyId: string;
  stage: StoryStageId;
  promptName: string;
  promptVersion: string;
  endpoint: LlmEndpointConfig;
  messages: ChatMessage[];
  parse: (raw: string) => T;
  pricing: StudioConfig["storyFactory"]["llmPricing"];
  confirmedPaidRequest: boolean;
  chat?: ChatFn;
  signal?: AbortSignal;
};

export type LlmCallResult<T> = {
  value: T;
  provenance: Provenance;
  costUsd: number;
  /**
   * Measured usage, when the provider reported any. Local servers often do
   * not, hence the null. The canon context builder records the prompt count
   * against its own estimate, which is the only way its chars-per-token
   * heuristic becomes a measured error rather than an assumed one.
   */
  usage: { promptTokens: number; completionTokens: number } | null;
};

export async function runLlmCall<T>(options: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
  const chatConfig: OpenAiCompatibleConfig = {
    baseUrl: options.endpoint.baseUrl,
    model: options.endpoint.model,
    apiKey: options.endpoint.apiKeyEnv ? (process.env[options.endpoint.apiKeyEnv] ?? "") : "",
    apiKeyEnv: options.endpoint.apiKeyEnv,
    paid: options.endpoint.paid,
    temperature: options.endpoint.temperature,
    maxOutputTokens: options.endpoint.maxOutputTokens,
  };
  const chat = options.chat ?? chatFnFor(options.endpoint.provider);
  const startedAt = Date.now();
  let result: ChatResult;
  try {
    result = await chat(chatConfig, options.messages, {
      confirmedPaidRequest: options.confirmedPaidRequest,
      signal: options.signal,
    });
  } catch (error: unknown) {
    await appendAiLog(options.channelId, options.storyId, {
      at: new Date().toISOString(),
      stage: options.stage,
      promptName: options.promptName,
      promptVersion: options.promptVersion,
      provider: options.endpoint.provider,
      model: options.endpoint.model,
      usage: null,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const costUsd = estimateLlmCost(result.usage, options.endpoint.model, options.pricing);
  if (costUsd > 0) {
    await addStoryCost(options.channelId, options.storyId, { kind: "llm", usd: costUsd });
  }
  await appendAiLog(options.channelId, options.storyId, {
    at: new Date().toISOString(),
    stage: options.stage,
    promptName: options.promptName,
    promptVersion: options.promptVersion,
    provider: options.endpoint.provider,
    model: options.endpoint.model,
    usage: result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : null,
    costUsd,
    durationMs: Date.now() - startedAt,
    ok: true,
  });

  // Parsing happens after logging the call but before anything else is
  // written: a response that fails validation leaves no artifact behind.
  const value = options.parse(result.content);
  return {
    value,
    provenance: {
      provider: options.endpoint.provider,
      model: options.endpoint.model,
      promptVersion: options.promptVersion,
      generatedAt: new Date().toISOString(),
    },
    costUsd,
    usage: result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : null,
  };
}
