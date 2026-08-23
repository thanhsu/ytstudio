import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addStoryCost,
  assertWithinBudget,
  BudgetExceededError,
  estimateGoogleTtsCost,
  estimateLlmCost,
  loadChannelCosts,
  loadStoryCost,
} from "../src/story-factory/cost.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-cost-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

const PRICING = [
  { modelPattern: "gpt-5-mini", inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
  { modelPattern: "gpt-5", inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
];

test("llm cost uses the first matching model pattern", () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 };
  assert.equal(estimateLlmCost(usage, "gpt-5-mini-2026", PRICING), 0.25 + 1);
  assert.equal(estimateLlmCost(usage, "gpt-5-turbo", PRICING), 1.25 + 5);
});

test("llm cost is zero when usage is missing or no pattern matches", () => {
  const usage = { promptTokens: 100, completionTokens: 100, totalTokens: 200 };
  assert.equal(estimateLlmCost(null, "gpt-5-mini", PRICING), 0);
  assert.equal(estimateLlmCost(usage, "local-llama", PRICING), 0);
  assert.equal(estimateLlmCost(usage, "gpt-5-mini", []), 0);
});

test("google tts cost scales with characters and tier and is marked approximate", () => {
  const pricing = { economy: 4, standard: 16, premium: 30 };
  const estimate = estimateGoogleTtsCost(250_000, "economy", pricing);
  assert.equal(estimate.totalUsd, 1);
  assert.equal(estimate.isApproximate, true);
  assert.equal(estimateGoogleTtsCost(250_000, "standard", pricing).totalUsd, 4);
});

test("story spends accumulate per kind and roll up into the channel ledger", async () => {
  await withTempCwd(async () => {
    await addStoryCost("es-horror", "story-001", { kind: "llm", usd: 0.12 });
    await addStoryCost("es-horror", "story-001", { kind: "tts", usd: 0.5 });
    await addStoryCost("es-horror", "story-002", { kind: "image", usd: 0.078 });

    const story = await loadStoryCost("es-horror", "story-001");
    assert.equal(story.llmUsd, 0.12);
    assert.equal(story.ttsUsd, 0.5);
    assert.equal(story.totalUsd, 0.62);

    const channel = await loadChannelCosts("es-horror");
    assert.equal(channel.byKind.llm, 0.12);
    assert.equal(channel.byKind.image, 0.078);
    assert.equal(channel.totalUsd, 0.698);
    assert.equal(channel.byStory["story-001"], 0.62);
    assert.equal(channel.byStory["story-002"], 0.078);
  });
});

test("a missing ledger reads as zeros rather than failing", async () => {
  await withTempCwd(async () => {
    const story = await loadStoryCost("es-horror", "story-404");
    assert.equal(story.totalUsd, 0);
    const channel = await loadChannelCosts("es-horror");
    assert.equal(channel.totalUsd, 0);
  });
});

test("the budget guard pauses before the spend, not after it", async () => {
  await withTempCwd(async () => {
    await addStoryCost("es-horror", "story-001", { kind: "llm", usd: 4.9 });

    // Within budget: 4.9 + 0.05 <= 5.
    await assertWithinBudget("es-horror", "story-001", 5, 0.05);

    // The next estimated spend would cross the line — refuse before spending.
    await assert.rejects(
      () => assertWithinBudget("es-horror", "story-001", 5, 0.2),
      (error: unknown) => {
        assert.ok(error instanceof BudgetExceededError);
        assert.match(error.message, /maxCostPerStoryUsd/);
        return true;
      },
    );

    // A limit of zero means unlimited.
    await assertWithinBudget("es-horror", "story-001", 0, 100);
  });
});
