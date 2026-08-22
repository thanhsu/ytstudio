import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleProvider } from "../src/llm/openai-compatible.ts";
import type { ScriptGenerationRequest } from "../src/llm/types.ts";

type FakeFetch = typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> };

function modelContent(): string {
  return JSON.stringify({
    script: "# Title\n\n## Hook\n\nOriginal commentary.",
    metadata: {
      titles: ["A title"],
      description: "A description.",
      hashtags: ["#review"],
      pinnedComment: "Your take?",
    },
    scenePlan: [
      { label: "Hook", durationSeconds: 8, purpose: "Open strong.", visualDirection: "Title card." },
    ],
  });
}

function createFakeFetch(content = modelContent(), status = 200): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : "upstream failure";
    return new Response(body, { status });
  }) as FakeFetch;
  fakeFetch.calls = calls;
  return fakeFetch;
}

function sampleRequest(overrides: Partial<ScriptGenerationRequest> = {}): ScriptGenerationRequest {
  return {
    projectId: "sample-project",
    brief: {
      id: "sample-project",
      topic: "Why Qin Mu is different",
      show: "Tales of Herding Gods",
      format: "shorts",
      audience: "EU donghua viewers",
      language: "English",
      notes: "",
      createdAt: "2026-08-22T00:00:00.000Z",
    },
    confirmedPaidRequest: false,
    ...overrides,
  };
}

function localConfig(fakeFetch: FakeFetch) {
  return {
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "qwen2.5:14b",
    apiKey: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 4000,
    fetch: fakeFetch,
  };
}

test("a local model call needs no confirmation and sends no authorization", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider(localConfig(fakeFetch));

  const result = await provider.generate(sampleRequest());

  assert.equal(result.model, "qwen2.5:14b");
  assert.equal(result.metadata.projectId, "sample-project");
  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(fakeFetch.calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal((fakeFetch.calls[0].init?.headers as Record<string, string>).Authorization, undefined);
});

test("a paid provider refuses to send anything without confirmation", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "test-key" });

  await assert.rejects(() => provider.generate(sampleRequest()), /confirm/i);
  assert.equal(fakeFetch.calls.length, 0);
});

test("a confirmed paid provider sends the bearer key", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "test-key" });

  await provider.generate(sampleRequest({ confirmedPaidRequest: true }));

  const headers = fakeFetch.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
});

test("a paid provider without a key fails before any request", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "" });

  await assert.rejects(() => provider.generate(sampleRequest({ confirmedPaidRequest: true })), /api key/i);
  assert.equal(fakeFetch.calls.length, 0);
});

test("an unreachable server names the endpoint", async () => {
  const failingFetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as FakeFetch;
  failingFetch.calls = [];
  const provider = createOpenAiCompatibleProvider(localConfig(failingFetch));

  await assert.rejects(() => provider.generate(sampleRequest()), /127\.0\.0\.1:11434/);
});

test("an error status is reported with its code", async () => {
  const provider = createOpenAiCompatibleProvider(localConfig(createFakeFetch(modelContent(), 500)));

  await assert.rejects(() => provider.generate(sampleRequest()), /500/);
});

test("a model answering in prose is rejected", async () => {
  const provider = createOpenAiCompatibleProvider(localConfig(createFakeFetch("Sure! Here you go:")));

  await assert.rejects(() => provider.generate(sampleRequest()), /not JSON/i);
});

test("the abort signal reaches fetch", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider(localConfig(fakeFetch));
  const controller = new AbortController();

  await provider.generate(sampleRequest(), controller.signal);

  assert.equal(fakeFetch.calls[0].init?.signal, controller.signal);
});
