import assert from "node:assert/strict";
import test from "node:test";
import { chatJson, chatJsonWithUsage, type ChatMessage, type OpenAiCompatibleConfig } from "../src/llm/chat.ts";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

function localConfig(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5",
    apiKey: "",
    apiKeyEnv: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 4000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })),
    ...overrides,
  };
}

function paidConfig(overrides: Partial<OpenAiCompatibleConfig> = {}): OpenAiCompatibleConfig {
  return localConfig({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", apiKeyEnv: "OPENAI_API_KEY", paid: true, ...overrides });
}

test("a paid model without confirmation is refused before any request leaves", async () => {
  let called = false;
  const config = paidConfig({
    fetch: async () => {
      called = true;
      return new Response("{}");
    },
  });

  await assert.rejects(() => chatJson(config, MESSAGES, { confirmedPaidRequest: false }), /paid/);
  assert.equal(called, false);
});

test("a missing key names the environment variable it should come from", async () => {
  await assert.rejects(
    () => chatJson(paidConfig({ apiKey: "" }), MESSAGES, { confirmedPaidRequest: true }),
    /OPENAI_API_KEY/,
  );
});

test("a local endpoint with no key and no key variable is not asked for one", async () => {
  assert.equal(await chatJson(localConfig(), MESSAGES, { confirmedPaidRequest: false }), '{"ok":true}');
});

test("an abort is rethrown as an abort, not relabelled as an unreachable server", async () => {
  const controller = new AbortController();
  controller.abort();
  const config = localConfig({
    fetch: async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });

  await assert.rejects(
    () => chatJson(config, MESSAGES, { confirmedPaidRequest: false, signal: controller.signal }),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("an unreachable server names the endpoint", async () => {
  const config = localConfig({
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.rejects(() => chatJson(config, MESSAGES, { confirmedPaidRequest: false }), /11434\/v1\/chat\/completions/);
});

test("a non-ok body is redacted and truncated", async () => {
  const config = localConfig({
    fetch: async () =>
      new Response(`{"error":"Authorization: Bearer sk-live-ABC123DEF ${"x".repeat(600)}"}`, { status: 500 }),
  });

  await assert.rejects(
    () => chatJson(config, MESSAGES, { confirmedPaidRequest: false }),
    (error: unknown) => {
      const message = String(error);
      return /\[redacted\]/.test(message) && !/sk-live-ABC123DEF/.test(message) && message.length < 800;
    },
  );
});

test("a 200 carrying no usable content says so and shows the payload", async () => {
  const config = localConfig({
    fetch: async () => new Response(JSON.stringify({ error: { message: "model not loaded" } })),
  });

  await assert.rejects(
    () => chatJson(config, MESSAGES, { confirmedPaidRequest: false }),
    /model not loaded/,
  );
});

test("the request carries the caller's messages and the returned string is the content", async () => {
  let sent: { messages?: unknown; model?: unknown } = {};
  const config = localConfig({
    fetch: async (_url, init) => {
      sent = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    },
  });

  const raw = await chatJson(config, MESSAGES, { confirmedPaidRequest: false });

  assert.equal(raw, '{"ok":true}');
  assert.deepEqual(sent.messages, MESSAGES);
  assert.equal(sent.model, "qwen2.5");
});

test("token usage is surfaced when the endpoint reports it", async () => {
  const config = localConfig({
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
      ),
  });

  const result = await chatJsonWithUsage(config, MESSAGES, { confirmedPaidRequest: false });

  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });
});

test("a missing usage block reports null usage rather than a guessed count", async () => {
  const result = await chatJsonWithUsage(localConfig(), MESSAGES, { confirmedPaidRequest: false });

  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.usage, null);
});

test("a usage block without a total still totals the two measured counts", async () => {
  const config = localConfig({
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 7, completion_tokens: 5 },
        }),
      ),
  });

  const result = await chatJsonWithUsage(config, MESSAGES, { confirmedPaidRequest: false });
  assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 5, totalTokens: 12 });
});

test("a trailing slash on the base url does not double the path separator", async () => {
  let seen = "";
  const config = localConfig({
    baseUrl: "http://127.0.0.1:11434/v1/",
    fetch: async (url) => {
      seen = String(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    },
  });

  await chatJson(config, MESSAGES, { confirmedPaidRequest: false });
  assert.equal(seen, "http://127.0.0.1:11434/v1/chat/completions");
});
