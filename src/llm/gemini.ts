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
 * Native Gemini generateContent transport. Takes the same
 * `OpenAiCompatibleConfig` as the OpenAI-compatible transport so a story
 * factory role can switch to it by changing `provider`, `baseUrl`, and
 * `model` — never a different config shape. System messages have no role slot
 * in the Gemini wire format, so they are pulled out of the message list into
 * `systemInstruction`; the remaining turns map assistant -> "model" since
 * Gemini has no "assistant" role.
 */
export async function geminiChat(
  config: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  assertChatRequestAllowed(config, options);

  const endpoint = `${config.baseUrl}/models/${config.model}:generateContent`;
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const response = await fetchChatEndpoint(
    config.fetch ?? fetch,
    endpoint,
    {
      method: "POST",
      signal: options.signal,
      headers: {
        "x-goog-api-key": config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: "application/json",
        },
      }),
    },
    options.signal,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Model request to ${endpoint} failed with status ${response.status}: ${truncate(redact(body))}`);
  }

  let payload: GeminiResponse;
  try {
    payload = (await response.json()) as GeminiResponse;
  } catch (error: unknown) {
    throw new Error(`Model response from ${endpoint} was not valid JSON: ${messageOf(error)}`);
  }

  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");

  if (!text.trim()) {
    throw new Error(
      `Model ${config.model} at ${endpoint} returned no usable message content: ${truncate(redact(describePayload(payload)))}`,
    );
  }

  return { content: text, usage: normalizeUsage(payload.usageMetadata) };
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
};

function normalizeUsage(usage: GeminiResponse["usageMetadata"]): ChatUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const promptTokens = Number(usage.promptTokenCount);
  const completionTokens = Number(usage.candidatesTokenCount);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }
  const total = Number(usage.totalTokenCount);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(total) ? total : promptTokens + completionTokens,
  };
}
