import type { LlmEndpointConfig } from "../config.ts";
import type { ContextBlockReport, ContextReport, RetrievalScore } from "./types.ts";

/**
 * The story context builder.
 *
 * The whole architecture rests on one claim: chapter 40 stays continuous with
 * chapter 3 without re-reading it. That only holds if the assembled context is
 * BOUNDED and RELEVANT, and the obvious design fails at both:
 *
 * - Character and world state grow linearly with the series. If they sit in a
 *   priority band the budget may not shrink, the context becomes state-only
 *   around chapter 15-20 and then overflows with nothing left to drop.
 * - Dropping whole blocks by priority alone is too coarse. Overflowing by 200
 *   tokens should shed three events, not the entire retrieved-events section.
 *
 * So blocks here are item-level: each carries a priority, a tie-breaking drop
 * rank, a minimum it will not shrink below, and whether it may be dropped at
 * all. Trimming removes items from the cheapest block first and only drops a
 * block once it has reached its floor.
 */

/** ~4 characters per token, with a margin: the estimate under-counts on the
 * JSON-heavy, name-dense text a story context is made of, and under-counting
 * is the dangerous direction. */
const CHARS_PER_TOKEN = 4;
const ESTIMATE_SAFETY_FACTOR = 1.15;

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * ESTIMATE_SAFETY_FACTOR);
}

export type ContextBlock = {
  name: string;
  /** Higher survives longer. */
  priority: number;
  /** Breaks ties within a priority; higher is dropped first. */
  dropRank: number;
  /** A required block never drops — the builder raises instead. */
  required: boolean;
  /** Items are shed one at a time, never below this count. */
  minItems: number;
  /** Rendered ahead of the items, e.g. "Characters in this chapter:". */
  heading: string;
  items: string[];
};

export type BuildContextOptions = {
  blocks: ContextBlock[];
  /** The configured ceiling for an assembled chapter context. */
  budgetTokens: number;
  /** The writer's endpoint, so the model's own window can cap the budget. */
  endpoint?: Pick<LlmEndpointConfig, "contextWindowTokens" | "maxOutputTokens">;
  /** Reserved head-room inside the model window, for the system prompt. */
  reserveTokens?: number;
};

export class ContextBudgetError extends Error {
  readonly requiredTokens: number;
  readonly budgetTokens: number;
  readonly report: ContextReport;

  constructor(requiredTokens: number, budgetTokens: number, report: ContextReport) {
    super(
      `The required context needs ${requiredTokens} tokens but the budget is ${budgetTokens}. ` +
        "Raise storyFactory.canon.contextTokenBudget, point the writer at a model with a larger " +
        "context window, or shorten the story bible.",
    );
    this.name = "ContextBudgetError";
    this.requiredTokens = requiredTokens;
    this.budgetTokens = budgetTokens;
    this.report = report;
  }
}

/**
 * The budget actually available: the configured ceiling, capped by what the
 * model can physically accept. A local 8k model silently truncates the FRONT of
 * an over-long prompt — which is where the canon rules live — so the cap has to
 * be enforced here, before the call, rather than discovered in bad output.
 */
export function effectiveBudget(options: BuildContextOptions): number {
  const window = options.endpoint?.contextWindowTokens ?? 0;
  if (window <= 0) {
    return options.budgetTokens;
  }
  const reserve = options.reserveTokens ?? 512;
  const room = window - (options.endpoint?.maxOutputTokens ?? 0) - reserve;
  return Math.max(0, Math.min(options.budgetTokens, room));
}

export type BuiltContext = {
  text: string;
  blocks: ContextBlockReport[];
  estimatedTokens: number;
  budgetTokens: number;
};

/**
 * Assemble the blocks into a prompt body that fits the budget.
 *
 * Trim order is a total order over `(priority asc, dropRank desc, name)`. It is
 * total on purpose: with priority alone, two blocks sharing a priority would be
 * shed in whatever order the caller happened to list them, which is not a
 * design and would make the context debugger's output irreproducible.
 */
export function buildContext(options: BuildContextOptions): BuiltContext {
  const budgetTokens = effectiveBudget(options);
  const working = options.blocks.map((block) => ({
    block,
    kept: block.items.length,
    dropped: false,
  }));

  const render = () =>
    working
      .filter((entry) => !entry.dropped && entry.kept > 0)
      .map((entry) => renderBlock(entry.block, entry.kept))
      .join("\n\n");

  // Cheapest-to-lose first: lowest priority, then highest dropRank.
  const trimOrder = [...working].sort(
    (left, right) =>
      left.block.priority - right.block.priority ||
      right.block.dropRank - left.block.dropRank ||
      left.block.name.localeCompare(right.block.name),
  );

  let text = render();
  let estimated = estimateTokens(text);

  for (const entry of trimOrder) {
    if (estimated <= budgetTokens) break;
    if (entry.block.required) continue;
    // Shed items one at a time down to the floor before dropping the block, so
    // a small overflow costs a few events rather than a whole section.
    while (estimated > budgetTokens && entry.kept > entry.block.minItems) {
      entry.kept -= 1;
      text = render();
      estimated = estimateTokens(text);
    }
    if (estimated > budgetTokens && entry.kept <= entry.block.minItems) {
      entry.dropped = true;
      text = render();
      estimated = estimateTokens(text);
    }
  }

  const blocks: ContextBlockReport[] = working.map((entry) => ({
    name: entry.block.name,
    priority: entry.block.priority,
    dropRank: entry.block.dropRank,
    estimatedTokens: estimateTokens(renderBlock(entry.block, entry.dropped ? 0 : entry.kept)),
    included: !entry.dropped && entry.kept > 0,
    itemsKept: entry.dropped ? 0 : entry.kept,
    itemsOffered: entry.block.items.length,
  }));

  return { text, blocks, estimatedTokens: estimated, budgetTokens };
}

/**
 * Build, and refuse to proceed when even the required blocks do not fit.
 * Failing here is the point: the alternative is a prompt the provider silently
 * truncates from the front, which loses the canon rules and produces
 * confidently wrong prose with no error anywhere.
 */
export function buildContextOrThrow(
  seriesId: string,
  chapterNumber: number,
  options: BuildContextOptions,
  retrieved: RetrievalScore[],
): ContextReport {
  const built = buildContext(options);
  const report: ContextReport = {
    version: 1,
    seriesId,
    chapterNumber,
    blocks: built.blocks,
    retrieved,
    estimatedTokens: built.estimatedTokens,
    budgetTokens: built.budgetTokens,
    actualPromptTokens: null,
    text: built.text,
    builtAt: new Date().toISOString(),
  };
  if (built.estimatedTokens > built.budgetTokens) {
    throw new ContextBudgetError(built.estimatedTokens, built.budgetTokens, report);
  }
  return report;
}

function renderBlock(block: ContextBlock, kept: number): string {
  if (kept <= 0) return "";
  const items = block.items.slice(0, kept);
  const omitted = block.items.length - items.length;
  const lines = items.map((item) => `- ${item}`);
  if (omitted > 0) {
    // Tell the model the list was cut. Silently truncating invites it to treat
    // a partial list as exhaustive and "resolve" a thread it cannot see.
    lines.push(`- (${omitted} older entries omitted for length)`);
  }
  return `${block.heading}\n${lines.join("\n")}`;
}

/** Convenience for a block whose content is prose rather than a list. */
export function proseBlock(
  name: string,
  heading: string,
  text: string,
  options: { priority: number; dropRank: number; required?: boolean },
): ContextBlock {
  const trimmed = text.trim();
  return {
    name,
    priority: options.priority,
    dropRank: options.dropRank,
    required: options.required ?? false,
    // Prose is one indivisible item: it is dropped whole or kept whole.
    minItems: 0,
    heading,
    items: trimmed ? [trimmed] : [],
  };
}

export function listBlock(
  name: string,
  heading: string,
  items: string[],
  options: { priority: number; dropRank: number; required?: boolean; minItems?: number },
): ContextBlock {
  return {
    name,
    priority: options.priority,
    dropRank: options.dropRank,
    required: options.required ?? false,
    minItems: options.minItems ?? 0,
    heading,
    items: items.filter((item) => item.trim().length > 0),
  };
}
