import { redact } from "../redact.ts";
import { buildScriptPrompt } from "../script-prompt.ts";
import { parseScriptGeneration } from "./parse.ts";
import type { LlmProvider, ScriptGenerationRequest, ScriptGenerationResult } from "./types.ts";

export type OpenAiCompatibleConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  // The environment variable the key was read from, so a missing key can point
  // at the exact variable to set rather than at "an API key".
  apiKeyEnv: string;
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
      // A configured key that is not in the environment is a mistake whether or
      // not the endpoint is marked paid: sending an unauthenticated request to a
      // hosted endpoint only turns it into a 401 further downstream.
      if (!config.apiKey && (config.apiKeyEnv || config.paid)) {
        throw new Error(missingApiKeyMessage(config));
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
        // A cancelled request must stay identifiable as a cancellation, not be
        // relabeled as "server unreachable" — the two have different remedies.
        if (signal?.aborted || isAbortError(error)) {
          throw error;
        }
        throw new Error(`Could not reach the model server at ${endpoint}: ${messageOf(error)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Model request to ${endpoint} failed with status ${response.status}: ${truncate(redact(body))}`,
        );
      }

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch (error: unknown) {
        throw new Error(`Model response from ${endpoint} was not valid JSON: ${messageOf(error)}`);
      }

      // A 200 carrying {"error":{...}} is a real shape from several LM Studio and
      // vLLM front-ends. Calling every one of these "an empty response" discarded
      // the only text that said what actually went wrong.
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error(
          `Model ${config.model} at ${endpoint} returned no usable message content: ${truncate(redact(describePayload(payload)))}`,
        );
      }

      return {
        provider: "openai-compatible",
        model: config.model,
        ...parseScriptGeneration(content, request.projectId),
      };
    },
  };
}

// Thrown messages are persisted to the job file, pushed through SSE, and dropped
// into the status bar, so an unbounded upstream body cannot travel with them.
const MAX_UPSTREAM_EXCERPT = 400;

function truncate(value: string): string {
  const collapsed = value.trim();
  if (!collapsed) {
    return "(empty body)";
  }
  return collapsed.length > MAX_UPSTREAM_EXCERPT
    ? `${collapsed.slice(0, MAX_UPSTREAM_EXCERPT)}… (truncated)`
    : collapsed;
}

function describePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    return String(payload);
  }
}

function missingApiKeyMessage(config: OpenAiCompatibleConfig): string {
  if (config.apiKeyEnv) {
    return `No API key: the ${config.apiKeyEnv} environment variable named by script.apiKeyEnv is empty. Set it in the shell that starts the studio, or clear script.apiKeyEnv for an endpoint that needs no key.`;
  }
  return "An API key is required for the configured paid model provider. Set script.apiKeyEnv to the name of the environment variable that holds it.";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
