import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenAiProvider, estimateOpenAiSpeechCost } from "../src/tts/openai.ts";
import { sampleTtsRequest } from "./helpers.ts";

type FakeFetch = typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> };

function createFakeFetch(): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as FakeFetch;
  fakeFetch.calls = calls;
  return fakeFetch;
}

test("OpenAI generation is blocked without explicit confirmation", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiProvider({ apiKey: "test", fetch: fakeFetch });

  await assert.rejects(
    () => provider.generate({ ...sampleTtsRequest(), provider: "openai", confirmedPaidRequest: false }),
    /confirm/i,
  );
  assert.equal(fakeFetch.calls.length, 0);
});

test("cost estimate includes text and projected audio", () => {
  const estimate = estimateOpenAiSpeechCost({ text: "A short narration", durationSeconds: 75 });

  assert.equal(estimate.currency, "USD");
  assert.ok(estimate.totalUsd > 0);
  assert.equal(estimate.isApproximate, true);
});

test("OpenAI provider writes confirmed response bytes", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const fakeFetch = createFakeFetch();
    const provider = createOpenAiProvider({
      apiKey: "test",
      fetch: fakeFetch,
      probeDuration: async () => 2,
    });
    const artifact = await provider.generate({
      ...sampleTtsRequest(),
      provider: "openai",
      voice: "alloy",
      format: "mp3",
      confirmedPaidRequest: true,
    });

    assert.equal(artifact.provider, "openai");
    assert.equal(artifact.durationSeconds, 2);
    assert.equal(fakeFetch.calls.length, 1);
    assert.match(String(fakeFetch.calls[0].url), /audio\/speech/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
