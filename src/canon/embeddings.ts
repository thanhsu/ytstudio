import type { StudioConfig } from "../config.ts";

/**
 * Optional embedding support for story memory.
 *
 * "disabled" is the default and returns null rather than throwing, because
 * keyword+structured retrieval is the primary path: every caller must work
 * without vectors, so there is nothing here to fail loudly about.
 *
 * Embeddings can cost real money, and the paid-request guard lives on the chat
 * transport, not here — so this module applies the same rule itself. Without
 * it, embedding spend would be invisible to both the confirmation prompt and
 * the budget ledger.
 */

export type EmbeddingRequest = {
  texts: string[];
  confirmedPaidRequest: boolean;
  signal?: AbortSignal;
};

export type EmbeddingResult = {
  model: string;
  /** One vector per input text, in order. */
  vectors: number[][];
  /** Characters submitted, for the cost ledger. */
  chars: number;
};

export type EmbeddingProvider = {
  name: string;
  model: string;
  embed: (request: EmbeddingRequest) => Promise<EmbeddingResult>;
};

export type FetchLike = typeof fetch;

export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

/**
 * Null when embeddings are disabled or unconfigured — never a throw. A caller
 * that gets null retrieves on keywords, which is the documented default.
 */
export function createEmbeddingProvider(
  config: StudioConfig,
  fetchImpl: FetchLike = fetch,
): EmbeddingProvider | null {
  const settings = config.storyFactory.embeddings;
  if (settings.provider === "disabled" || !settings.model.trim()) {
    return null;
  }
  if (settings.provider === "ollama") {
    return ollamaProvider(settings, fetchImpl);
  }
  return openAiCompatibleProvider(settings, fetchImpl);
}

type EmbeddingSettings = StudioConfig["storyFactory"]["embeddings"];

function assertSpendAllowed(settings: EmbeddingSettings, request: EmbeddingRequest): void {
  if (settings.paid && !request.confirmedPaidRequest) {
    throw new EmbeddingConfigError(
      "Embedding this batch calls a paid API. Confirm the paid request before indexing story memory.",
    );
  }
  if (settings.apiKeyEnv && !process.env[settings.apiKeyEnv]) {
    throw new EmbeddingConfigError(
      `Embedding provider needs ${settings.apiKeyEnv} in the environment.`,
    );
  }
}

function ollamaProvider(settings: EmbeddingSettings, fetchImpl: FetchLike): EmbeddingProvider {
  return {
    name: "ollama",
    model: settings.model,
    embed: async (request) => {
      assertSpendAllowed(settings, request);
      const vectors: number[][] = [];
      // Ollama's embeddings endpoint takes one prompt per call.
      for (const text of request.texts) {
        const response = await fetchImpl(`${trimSlash(settings.baseUrl)}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: settings.model, prompt: text }),
          signal: request.signal,
        });
        if (!response.ok) {
          throw new Error(`Ollama embeddings failed with status ${response.status}.`);
        }
        const payload = (await response.json()) as { embedding?: unknown };
        vectors.push(numberArray(payload.embedding, "embedding"));
      }
      return { model: settings.model, vectors, chars: totalChars(request.texts) };
    },
  };
}

function openAiCompatibleProvider(settings: EmbeddingSettings, fetchImpl: FetchLike): EmbeddingProvider {
  return {
    name: "openai-compatible",
    model: settings.model,
    embed: async (request) => {
      assertSpendAllowed(settings, request);
      const apiKey = settings.apiKeyEnv ? (process.env[settings.apiKeyEnv] ?? "") : "";
      const response = await fetchImpl(`${trimSlash(settings.baseUrl)}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: settings.model, input: request.texts }),
        signal: request.signal,
      });
      if (!response.ok) {
        throw new Error(`Embeddings request failed with status ${response.status}.`);
      }
      const payload = (await response.json()) as { data?: Array<{ embedding?: unknown; index?: number }> };
      if (!Array.isArray(payload.data)) {
        throw new Error("Embeddings response had no data array.");
      }
      // The spec allows results out of order; index is authoritative.
      const ordered = [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      return {
        model: settings.model,
        vectors: ordered.map((entry) => numberArray(entry.embedding, "data[].embedding")),
        chars: totalChars(request.texts),
      };
    },
  };
}

export function estimateEmbeddingCostUsd(chars: number, usdPerMTok: number): number {
  if (usdPerMTok <= 0) return 0;
  // ~4 characters per token, the same heuristic the context builder uses.
  const tokens = chars / 4;
  return (tokens / 1_000_000) * usdPerMTok;
}

function numberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Embeddings response field ${field} was not a non-empty array.`);
  }
  return value.map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number)) {
      throw new Error(`Embeddings response field ${field} contained a non-numeric value.`);
    }
    return number;
  });
}

function totalChars(texts: string[]): number {
  return texts.reduce((sum, text) => sum + text.length, 0);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
