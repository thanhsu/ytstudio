import { buildScriptPrompt } from "../script-prompt.ts";
import { parseScriptGeneration } from "./parse.ts";
import type { LlmProvider, ScriptGenerationRequest, ScriptGenerationResult } from "./types.ts";

export type OpenAiCompatibleConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  paid: boolean;
  temperature: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/**
 * One adapter for every server speaking /v1/chat/completions: Ollama, LM Studio,
 * llama.cpp, vLLM, OpenAI, DeepSeek, Groq, and OpenRouter. Moving between them
 * is a change of baseUrl and key, not of code.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    name: "openai-compatible",
    async generate(request: ScriptGenerationRequest, signal?: AbortSignal): Promise<ScriptGenerationResult> {
      if (config.paid && !request.confirmedPaidRequest) {
        throw new Error("This model is marked paid and requires an explicit confirmed paid request.");
      }
      if (config.paid && !config.apiKey) {
        throw new Error("An API key is required for the configured paid model provider.");
      }

      const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      let response: Response;
      try {
        response = await (config.fetch ?? fetch)(endpoint, {
          method: "POST",
          signal,
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: buildScriptPrompt(request.brief),
            temperature: config.temperature,
            max_tokens: config.maxOutputTokens,
            response_format: { type: "json_object" },
          }),
        });
      } catch (error: unknown) {
        throw new Error(`Could not reach the model server at ${endpoint}: ${messageOf(error)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Model request failed with status ${response.status}: ${redact(body)}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Model returned an empty response.");
      }

      return {
        provider: "openai-compatible",
        model: config.model,
        ...parseScriptGeneration(content, request.projectId),
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string): string {
  return value.replace(/(authorization|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^"'\s]+/gi, "$1$2[redacted]");
}
