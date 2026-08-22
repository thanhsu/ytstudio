import { loadStudioConfig } from "../config.ts";
import { chatJson } from "../llm/chat.ts";
import { withCandidateLock, requireCandidate } from "./candidates.ts";
import { parseSourceScore } from "./score-parse.ts";
import { buildScorePrompt } from "./score-prompt.ts";
import { saveCandidate, validateSourceId, type SourceCandidate } from "./store.ts";

/**
 * Deliberately not `LlmProvider`: that interface returns a script generation
 * result, while a scorer returns raw model JSON for `parseSourceScore` to
 * validate.
 */
export type SourceScorer = {
  readonly name: string;
  readonly model: string;
  generate(candidate: SourceCandidate, signal?: AbortSignal): Promise<string>;
};

export type ScoreCandidateOptions = {
  scorer?: SourceScorer;
  confirmedPaidRequest?: boolean;
  signal?: AbortSignal;
};

export function createDryRunScorer(): SourceScorer {
  return {
    name: "dry-run",
    model: "local-template",
    async generate(candidate: SourceCandidate): Promise<string> {
      return JSON.stringify({
        value: 50,
        angle: `A first-principles read of ${candidate.title}`,
        hooks: ["Open on the claim the title makes"],
        risks: ["Scored by the dry-run template, which has not read anything"],
        reason: "This is the dry-run scorer, not a model. Configure script.provider for a real judgement.",
      });
    },
  };
}

export async function createConfiguredScorer(): Promise<SourceScorer> {
  const config = await loadStudioConfig();
  if (config.script.provider !== "openai-compatible") {
    return createDryRunScorer();
  }

  const chatConfig = {
    baseUrl: config.script.baseUrl,
    model: config.script.model,
    apiKey: config.script.apiKeyEnv ? process.env[config.script.apiKeyEnv] ?? "" : "",
    apiKeyEnv: config.script.apiKeyEnv,
    paid: config.script.paid,
    temperature: config.script.temperature,
    maxOutputTokens: config.script.maxOutputTokens,
  };

  return {
    name: "openai-compatible",
    model: config.script.model,
    async generate(candidate, signal) {
      return chatJson(chatConfig, buildScorePrompt(candidate), { confirmedPaidRequest: true, signal });
    },
  };
}

/**
 * Scores one candidate on its own merit. Scoring never touches `status`, which
 * belongs to the download lifecycle, and a failed or malformed response leaves
 * the previous score exactly where it was.
 */
export async function scoreCandidate(id: string, options: ScoreCandidateOptions): Promise<SourceCandidate> {
  const safeId = validateSourceId(id);
  const scorer = options.scorer ?? (await createConfiguredScorer());
  const candidate = await requireCandidate(safeId);

  const raw = await scorer.generate(candidate, options.signal);
  const parsed = parseSourceScore(raw);

  return withCandidateLock(safeId, async () => {
    const current = await requireCandidate(safeId);
    const updated: SourceCandidate = {
      ...current,
      score: {
        ...parsed,
        provider: scorer.name,
        model: scorer.model,
        scoredAt: new Date().toISOString(),
      },
    };
    await saveCandidate(updated);
    return updated;
  });
}
