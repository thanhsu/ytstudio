import assert from "node:assert/strict";
import test from "node:test";
import { anthropicChat } from "../src/llm/anthropic.ts";
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
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-haiku-latest",
    apiKey: "sk-ant-test",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    paid: true,
    temperature: 0.7,
    maxOutputTokens: 2000,
    fetch: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"ok":true}' }],
          usage: { input_tokens: 40, output_tokens: 10 },
        }),
      ),
    ...overrides,
  };
}

test("the request maps system messages, roles, and generation params", async () => {
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const result = await anthropicChat(
    config({
      fetch: async (url, init) => {
        sentUrl = String(url);
        sentInit = init;
        return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );

  assert.equal(sentUrl, "https://api.anthropic.com/v1/messages");
  const headers = sentInit?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(String(sentInit?.body));
  assert.equal(body.model, "claude-3-5-haiku-latest");
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.system, "You are terse.\n\nReply in JSON.");
  assert.deepEqual(body.messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "how are you" },
  ]);
  assert.equal(result.content, "ok");
});

test("a trailing slash on the base url does not double the path separator", async () => {
  let sentUrl = "";
  await anthropicChat(
    config({
      baseUrl: "https://api.anthropic.com/",
      fetch: async (url) => {
        sentUrl = String(url);
        return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );
  assert.equal(sentUrl, "https://api.anthropic.com/v1/messages");
});

test("multiple text blocks are concatenated and usage is mapped", async () => {
  const result = await anthropicChat(
    config({
      fetch: async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
            usage: { input_tokens: 100, output_tokens: 25 },
          }),
        ),
    }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );

  assert.equal(result.content, "part one part two");
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 25, totalTokens: 125 });
});

test("usage absent in the response reports null rather than a guess", async () => {
  const result = await anthropicChat(
    config({ fetch: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] })) }),
    MESSAGES,
    { confirmedPaidRequest: true },
  );
  assert.equal(result.usage, null);
});

test("empty text content is treated as no usable content, redacted and truncated", async () => {
  await assert.rejects(
    () =>
      anthropicChat(
        config({
          fetch: async () =>
            new Response(
              JSON.stringify({ content: [{ type: "text", text: "" }], apiKeyDebug: "Authorization: Bearer sk-ant-test-LEAK" }),
            ),
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    (error: unknown) => {
      const message = String(error);
      return /no usable message content/.test(message) && !/sk-ant-test-LEAK/.test(message);
    },
  );
});

test("an api error status is thrown with a redacted, truncated excerpt", async () => {
  await assert.rejects(
    () =>
      anthropicChat(
        config({
          fetch: async () =>
            new Response(`{"error":{"message":"Authorization: Bearer sk-ant-leak ${"x".repeat(600)}"}}`, {
              status: 401,
            }),
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    (error: unknown) => {
      const message = String(error);
      return /401/.test(message) && /\[redacted\]/.test(message) && !/sk-ant-leak/.test(message) && message.length < 800;
    },
  );
});

test("a paid model without confirmation is refused before any request leaves", async () => {
  let called = false;
  await assert.rejects(
    () =>
      anthropicChat(
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
    () => anthropicChat(config({ apiKey: "" }), MESSAGES, { confirmedPaidRequest: true }),
    /ANTHROPIC_API_KEY/,
  );
});

test("an abort is rethrown as an abort, not relabelled as an unreachable server", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      anthropicChat(
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
      anthropicChat(
        config({
          fetch: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
        MESSAGES,
        { confirmedPaidRequest: true },
      ),
    /api\.anthropic\.com\/v1\/messages/,
  );
});
