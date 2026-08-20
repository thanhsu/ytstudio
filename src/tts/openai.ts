import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { probeDuration } from "../media.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { saveTtsArtifact, ttsCacheKey } from "./cache.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "./types.ts";

export type OpenAiCostInput = {
  text: string;
  durationSeconds: number;
};

export type OpenAiCostEstimate = {
  currency: "USD";
  inputTextUsd: number;
  outputAudioUsd: number;
  totalUsd: number;
  isApproximate: true;
};

export type OpenAiConfig = {
  apiKey: string;
  fetch?: typeof fetch;
  model?: string;
  endpoint?: string;
  probeDuration?: (filePath: string) => Promise<number>;
};

export const OPENAI_SPEECH_PRICING = {
  inputTextUsdPerMillionChars: 0.6,
  outputAudioUsdPerMinute: 0.015,
};

export function estimateOpenAiSpeechCost(input: OpenAiCostInput): OpenAiCostEstimate {
  const inputTextUsd = (input.text.length / 1_000_000) * OPENAI_SPEECH_PRICING.inputTextUsdPerMillionChars;
  const outputAudioUsd = (input.durationSeconds / 60) * OPENAI_SPEECH_PRICING.outputAudioUsdPerMinute;
  return {
    currency: "USD",
    inputTextUsd,
    outputAudioUsd,
    totalUsd: inputTextUsd + outputAudioUsd,
    isApproximate: true,
  };
}

export function createOpenAiProvider(config: OpenAiConfig): TtsProvider {
  return {
    name: "openai",
    async generate(request: TtsRequest): Promise<TtsArtifact> {
      if (!request.confirmedPaidRequest) {
        throw new Error("OpenAI speech generation requires explicit confirmed paid request.");
      }
      if (!config.apiKey) {
        throw new Error("OPENAI_API_KEY is required for OpenAI speech generation.");
      }

      const cacheKey = ttsCacheKey({ ...request, provider: "openai" });
      const relativePath = `workspace/voice/${cacheKey}.${request.format}`;
      const outputPath = resolveProjectPath(request.projectId, relativePath);
      await mkdir(dirname(outputPath), { recursive: true });

      const response = await (config.fetch ?? fetch)(config.endpoint ?? "https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model ?? "gpt-4o-mini-tts",
          voice: request.voice,
          input: request.text,
          instructions: request.instructions || undefined,
          speed: request.speed,
          response_format: request.format,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI speech request failed with status ${response.status}: ${redact(body)}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(outputPath, bytes);

      const durationSeconds = await (config.probeDuration ?? probeDuration)(outputPath);
      const artifact: TtsArtifact = {
        provider: "openai",
        cacheKey,
        relativePath,
        durationSeconds,
        createdAt: new Date().toISOString(),
        metadata: {
          voice: request.voice,
          format: request.format,
          speed: request.speed,
          model: config.model ?? "gpt-4o-mini-tts",
        },
      };
      await saveTtsArtifact(request.projectId, artifact);
      return artifact;
    },
  };
}

function redact(value: string): string {
  return value.replace(/(authorization|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^"'\s]+/gi, "$1$2[redacted]");
}
