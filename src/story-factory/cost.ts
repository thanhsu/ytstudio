import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StudioConfig } from "../config.ts";
import type { ChatUsage } from "../llm/chat.ts";
import { channelStoryFactoryPath, storyPath } from "./paths.ts";
import type { ChannelCosts, StoryCost, TtsQualityTier } from "./types.ts";

/**
 * Persisted production-cost ledger. Estimates are computed from operator-owned
 * pricing config (provider prices drift, so nothing here is hardcoded as exact)
 * and recorded per story plus aggregated per channel, so the budget guard and
 * the dashboard read real numbers instead of recomputing them.
 */

export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;

  constructor(spentUsd: number, limitUsd: number) {
    super(
      `Story budget exhausted: $${spentUsd.toFixed(4)} spent of the $${limitUsd.toFixed(2)} limit. ` +
        "Raise budget.maxCostPerStoryUsd on the story or channel, or run remaining stages manually.",
    );
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

export type LlmPricingEntry = StudioConfig["storyFactory"]["llmPricing"][number];

/** First modelPattern substring match wins; no match records 0 (usage is still logged). */
export function estimateLlmCost(usage: ChatUsage | null, model: string, pricing: LlmPricingEntry[]): number {
  if (!usage) {
    return 0;
  }
  const entry = pricing.find((candidate) => model.includes(candidate.modelPattern));
  if (!entry) {
    return 0;
  }
  return round6(
    (usage.promptTokens / 1_000_000) * entry.inputUsdPerMTok +
      (usage.completionTokens / 1_000_000) * entry.outputUsdPerMTok,
  );
}

export type GoogleTtsCostEstimate = {
  currency: "USD";
  characterCount: number;
  tier: TtsQualityTier;
  totalUsd: number;
  isApproximate: true;
};

export function estimateGoogleTtsCost(
  characterCount: number,
  tier: TtsQualityTier,
  pricing: StudioConfig["tts"]["google"]["pricing"],
): GoogleTtsCostEstimate {
  return {
    currency: "USD",
    characterCount,
    tier,
    totalUsd: round6((characterCount / 1_000_000) * pricing[tier]),
    isApproximate: true,
  };
}

export type CostKind = "llm" | "tts" | "image";

const STORY_COST_FILE = "cost.json";
const CHANNEL_COSTS_FILE = "costs.json";

export function emptyStoryCost(): StoryCost {
  return { version: 1, llmUsd: 0, ttsUsd: 0, imageUsd: 0, totalUsd: 0, updatedAt: new Date(0).toISOString() };
}

export async function loadStoryCost(channelId: string, storyId: string): Promise<StoryCost> {
  const value = await readOptionalJson(storyPath(channelId, storyId, STORY_COST_FILE));
  return normalizeStoryCost(value);
}

export async function loadChannelCosts(channelId: string): Promise<ChannelCosts> {
  const value = await readOptionalJson(channelStoryFactoryPath(channelId, CHANNEL_COSTS_FILE));
  return normalizeChannelCosts(value);
}

/** Record one spend against a story and fold it into the channel aggregate. */
export async function addStoryCost(
  channelId: string,
  storyId: string,
  spend: { kind: CostKind; usd: number },
): Promise<StoryCost> {
  const now = new Date().toISOString();
  const cost = await loadStoryCost(channelId, storyId);
  if (spend.kind === "llm") cost.llmUsd = round6(cost.llmUsd + spend.usd);
  if (spend.kind === "tts") cost.ttsUsd = round6(cost.ttsUsd + spend.usd);
  if (spend.kind === "image") cost.imageUsd = round6(cost.imageUsd + spend.usd);
  cost.totalUsd = round6(cost.llmUsd + cost.ttsUsd + cost.imageUsd);
  cost.updatedAt = now;
  await writeJsonFile(storyPath(channelId, storyId, STORY_COST_FILE), cost);

  const channel = await loadChannelCosts(channelId);
  if (spend.kind === "llm") channel.byKind.llm = round6(channel.byKind.llm + spend.usd);
  if (spend.kind === "tts") channel.byKind.tts = round6(channel.byKind.tts + spend.usd);
  if (spend.kind === "image") channel.byKind.image = round6(channel.byKind.image + spend.usd);
  channel.totalUsd = round6(channel.byKind.llm + channel.byKind.tts + channel.byKind.image);
  channel.byStory[storyId] = cost.totalUsd;
  channel.updatedAt = now;
  await writeJsonFile(channelStoryFactoryPath(channelId, CHANNEL_COSTS_FILE), channel);

  return cost;
}

/**
 * Throws BudgetExceededError when the spend so far plus the next estimated
 * spend would pass the limit. A limit of 0 means unlimited.
 */
export async function assertWithinBudget(
  channelId: string,
  storyId: string,
  limitUsd: number,
  nextEstimateUsd: number,
): Promise<void> {
  if (limitUsd <= 0) {
    return;
  }
  const cost = await loadStoryCost(channelId, storyId);
  if (cost.totalUsd + nextEstimateUsd > limitUsd) {
    throw new BudgetExceededError(cost.totalUsd, limitUsd);
  }
}

function normalizeStoryCost(value: unknown): StoryCost {
  const candidate = value && typeof value === "object" ? (value as Partial<StoryCost>) : {};
  const llmUsd = nonNegative(candidate.llmUsd);
  const ttsUsd = nonNegative(candidate.ttsUsd);
  const imageUsd = nonNegative(candidate.imageUsd);
  return {
    version: 1,
    llmUsd,
    ttsUsd,
    imageUsd,
    totalUsd: round6(llmUsd + ttsUsd + imageUsd),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeChannelCosts(value: unknown): ChannelCosts {
  const candidate = value && typeof value === "object" ? (value as Partial<ChannelCosts>) : {};
  const byKindCandidate =
    candidate.byKind && typeof candidate.byKind === "object" ? candidate.byKind : ({} as ChannelCosts["byKind"]);
  const byKind = {
    llm: nonNegative(byKindCandidate.llm),
    tts: nonNegative(byKindCandidate.tts),
    image: nonNegative(byKindCandidate.image),
  };
  const byStory: Record<string, number> = {};
  if (candidate.byStory && typeof candidate.byStory === "object") {
    for (const [key, entry] of Object.entries(candidate.byStory)) {
      const amount = Number(entry);
      if (Number.isFinite(amount) && amount >= 0) {
        byStory[key] = amount;
      }
    }
  }
  return {
    version: 1,
    totalUsd: round6(byKind.llm + byKind.tts + byKind.image),
    byKind,
    byStory,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
