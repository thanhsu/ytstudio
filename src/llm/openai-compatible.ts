import { buildScriptPrompt } from "../script-prompt.ts";
import { chatJson, type OpenAiCompatibleConfig } from "./chat.ts";
import { parseScriptGeneration } from "./parse.ts";
import type { LlmProvider, ScriptGenerationRequest, ScriptGenerationResult } from "./types.ts";

export type { OpenAiCompatibleConfig } from "./chat.ts";

/**
 * Script generation over the shared transport. Prompt building and parsing stay
 * here rather than moving into `chatJson`: what a request says and how its answer
 * is read belong to the caller, and only the wire mechanics are shared.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    name: "openai-compatible",
    async generate(request: ScriptGenerationRequest, signal?: AbortSignal): Promise<ScriptGenerationResult> {
      const content = await chatJson(config, buildScriptPrompt(request.brief), {
        confirmedPaidRequest: request.confirmedPaidRequest,
        signal,
      });

      return {
        provider: "openai-compatible",
        model: config.model,
        ...parseScriptGeneration(content, request.projectId),
      };
    },
  };
}
