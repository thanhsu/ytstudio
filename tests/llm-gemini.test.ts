import assert from "node:assert/strict";
import test from "node:test";
import { geminiChat } from "../src/llm/gemini.ts";
import type { ChatMessage, OpenAiCompatibleConfig } from "../src/llm/chat.ts";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are terse." },
  { role: "system", content: "Reply in JSON." },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "how are you" },
];

function config(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    apiKey: "gm-test-key",
    apiKeyEnv: "GEMINI_API_KEY",
    paid: true,
    temperature: 0.6,
    maxOutputTokens: 3000,
    fetch: async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        }),
      ),
    ...overrides,
  };
}

test("the request maps system instruction, role mapping, and generation config", async () => {
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const result = await geminiChat(
    config({
      fetch: async (url, init) => {
        sentUrl = String(url);
        sentInit = init;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
      },
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );

  assert.equal(sentUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  const headers = sentInit?.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "gm-test-key");

  const body = JSON.parse(String(sentInit?.body));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "You are terse.\n\nReply in JSON." }] });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hello" }] },
    { role: "user", parts: [{ text: "how are you" }] },
  ]);
  assert.equal(body.generationConfig.temperature, 0.6);
  assert.equal(body.generationConfig.maxOutputTokens, 3000);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(result.content, "ok");
});

test("multiple text parts are joined and usage is mapped", async () => {
  const result = await geminiChat(
    config({
      fetch: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "part one " }, { text: "part two" }] } }],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 },
          }),
        ),
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );

  assert.equal(result.content, "part one part two");
  assert.deepEqual(result.usage, { promptTokens: 200, completionTokens: 50, totalTokens: 250 });
});

test("usage absent in the response reports null rather than a guess", async () => {
  const result = await geminiChat(
    config({
      fetch: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })),
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );
  assert.equal(result.usage, null);
});

test("empty text content is treated as no usable content, redacted and truncated", async () => {
  await assert.rejects(
    () =>
      geminiChat(
        config({
          fetch: async () =>
            new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: "" }] } }],
                debug: "Authorization: Bearer gm-test-key-LEAK",
              }),
            ),
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    (error: unknown) => {
      const message = String(error);
      return /no usable message content/.test(message) && !/gm-test-key-LEAK/.test(message);
    },
  );
});

test("an api error status is thrown with a redacted, truncated excerpt", async () => {
  await assert.rejects(
    () =>
      geminiChat(
        config({
          fetch: async () =>
            new Response(`{"error":{"message":"Authorization: Bearer sk-live-leak ${"x".repeat(600)}"}}`, {
              status: 429,
            }),
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    (error: unknown) => {
      const message = String(error);
      return /429/.test(message) && /\[redacted\]/.test(message) && !/sk-live-leak/.test(message) && message.length < 800;
    },
  );
});

test("a paid model without confirmation is refused before any request leaves", async () => {
  let called = false;
  await assert.rejects(
    () =>
      geminiChat(
        config({
          fetch: async () => {
            called = true;
            return new Response("{}");
          },
        }),
        MESSAGES,
        { confirmedPaidRequest: false },
      ),
    /paid/,
  );
  assert.equal(called, false);
});

test("a missing key names the environment variable it should come from", async () => {
  await assert.rejects(
    () => geminiChat(config({ apiKey: "" }), MESSAGES, { confirmedPaidRequest: true }),
    /GEMINI_API_KEY/,
  );
});

test("an abort is rethrown as an abort, not relabelled as an unreachable server", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      geminiChat(
        config({
          fetch: async () => {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          },
        }),
        MESSAGES,
        { confirmedPaidRequest: true, signal: controller.signal },
      ),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("an unreachable server names the endpoint", async () => {
  await assert.rejects(
    () =>
      geminiChat(
        config({
          fetch: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/,
  );
});
