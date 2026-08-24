import { redact } from "../redact.ts";
import {
  assertChatRequestAllowed,
  describePayload,
  fetchChatEndpoint,
  messageOf,
  truncate,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatUsage,
  type OpenAiCompatibleConfig,
} from "./chat.ts";

/**
 * Native Anthropic Messages API transport. Takes the same
 * `OpenAiCompatibleConfig` as the OpenAI-compatible transport so a story
 * factory role can switch to it by changing `provider`, `baseUrl`, and
 * `model` — never a different config shape. System messages have no role slot
 * in the Anthropic wire format, so they are pulled out of the message list and
 * joined into the top-level `system` field; only user/assistant turns remain
 * in `messages`.
 */
export async function anthropicChat(
  config: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  assertChatRequestAllowed(config, options);

  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const conversation = messages
    .filter((message): message is ChatMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({ role: message.role, content: message.content }));

  const response = await fetchChatEndpoint(
    config.fetch ?? fetch,
    endpoint,
    {
      method: "POST",
      signal: options.signal,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxOutputTokens,
        temperature: config.temperature,
        system,
        messages: conversation,
      }),
    },
    options.signal,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Model request to ${endpoint} failed with status ${response.status}: ${truncate(redact(body))}`);
  }

  let payload: AnthropicResponse;
  try {
    payload = (await response.json()) as AnthropicResponse;
  } catch (error: unknown) {
    throw new Error(`Model response from ${endpoint} was not valid JSON: ${messageOf(error)}`);
  }

  const text = (payload.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");

  if (!text.trim()) {
    throw new Error(
      `Model ${config.model} at ${endpoint} returned no usable message content: ${truncate(redact(describePayload(payload)))}`,
    );
  }

  return { content: text, usage: normalizeUsage(payload.usage) };
}

type AnthropicResponse = {
  content?: Array<{ type?: unknown; text?: unknown }>;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
};

function normalizeUsage(usage: AnthropicResponse["usage"]): ChatUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const promptTokens = Number(usage.input_tokens);
  const completionTokens = Number(usage.output_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
