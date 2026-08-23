import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { probeDuration } from "../media.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { redact } from "../redact.ts";
import { findCachedVoice, saveTtsArtifact, ttsCacheKey } from "./cache.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "./types.ts";

/**
 * Google Cloud Text-to-Speech over plain REST. The API key travels in the
 * X-Goog-Api-Key header — never as a ?key= query parameter, which would leak
 * it into thrown endpoint URLs and job records.
 */

export type GoogleTtsConfig = {
  apiKey: string;
  /** The env var the key was read from, so a missing key names the exact variable. */
  apiKeyEnv: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  probeDuration?: (filePath: string) => Promise<number>;
};

const DEFAULT_BASE_URL = "https://texttospeech.googleapis.com/v1";

export function createGoogleTtsProvider(config: GoogleTtsConfig): TtsProvider {
  return {
    name: "google",
    async generate(request: TtsRequest, signal?: AbortSignal): Promise<TtsArtifact> {
      if (!request.confirmedPaidRequest) {
        throw new Error("Google speech generation requires explicit confirmed paid request.");
      }
      if (!config.apiKey) {
        throw new Error(
          `No API key: the ${config.apiKeyEnv || "GOOGLE_TTS_API_KEY"} environment variable named by tts.google.apiKeyEnv is empty. Set it in the shell that starts the studio.`,
        );
      }
      if (!request.languageCode) {
        throw new Error("Google speech generation requires a languageCode (for example es-US).");
      }
      if (!request.voice) {
        throw new Error("Google speech generation requires a voice name (for example es-US-Neural2-B).");
      }

      const cacheKey = ttsCacheKey({ ...request, provider: "google" });

      // Identical text + voice settings reuse the cached bytes instead of
      // paying the synthesize call again — re-renders and single-chunk retries
      // must never regenerate audio that already exists.
      const cached = await findCachedVoice(request.projectId, cacheKey);
      if (cached) {
        return cached;
      }

      const relativePath = `workspace/voice/${cacheKey}.${request.format}`;
      const outputPath = resolveProjectPath(request.projectId, relativePath);
      await mkdir(dirname(outputPath), { recursive: true });

      const endpoint = `${(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/text:synthesize`;
      const response = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": config.apiKey,
        },
        body: JSON.stringify({
          input: { text: request.text },
          voice: {
            languageCode: request.languageCode,
            name: request.voice,
          },
          audioConfig: {
            audioEncoding: request.format === "wav" ? "LINEAR16" : "MP3",
            speakingRate: request.speed,
            pitch: request.pitch ?? 0,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Google speech request failed with status ${response.status}: ${excerpt(redact(body))}`);
      }

      let payload: { audioContent?: unknown };
      try {
        payload = (await response.json()) as { audioContent?: unknown };
      } catch (error: unknown) {
        throw new Error(`Google speech response was not JSON: ${messageOf(error)}`);
      }
      if (typeof payload.audioContent !== "string" || !payload.audioContent) {
        throw new Error(`Google speech response carried no audioContent: ${excerpt(redact(JSON.stringify(payload)))}`);
      }

      await writeFile(outputPath, Buffer.from(payload.audioContent, "base64"));

      const durationSeconds = await (config.probeDuration ?? probeDuration)(outputPath);
      const artifact: TtsArtifact = {
        provider: "google",
        cacheKey,
        relativePath,
        durationSeconds,
        createdAt: new Date().toISOString(),
        metadata: {
          voice: request.voice,
          languageCode: request.languageCode,
          format: request.format,
          speed: request.speed,
          pitch: request.pitch ?? 0,
        },
      };
      await saveTtsArtifact(request.projectId, artifact);
      return artifact;
    },
  };
}

export type GoogleVoice = {
  name: string;
  languageCodes: string[];
  ssmlGender: string;
  naturalSampleRateHertz: number;
};

export async function listGoogleVoices(languageCode: string, config: GoogleTtsConfig): Promise<GoogleVoice[]> {
  if (!config.apiKey) {
    throw new Error(
      `No API key: the ${config.apiKeyEnv || "GOOGLE_TTS_API_KEY"} environment variable named by tts.google.apiKeyEnv is empty. Set it in the shell that starts the studio.`,
    );
  }
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/voices?languageCode=${encodeURIComponent(languageCode)}`;
  const response = await (config.fetch ?? fetch)(url, {
    headers: { "X-Goog-Api-Key": config.apiKey },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google voice list request failed with status ${response.status}: ${excerpt(redact(body))}`);
  }
  let payload: { voices?: unknown };
  try {
    payload = (await response.json()) as { voices?: unknown };
  } catch (error: unknown) {
    throw new Error(`Google voice list response was not JSON: ${messageOf(error)}`);
  }
  if (!Array.isArray(payload.voices)) {
    // An unexpected shape is thrown with an excerpt rather than guessed at, so
    // an API change is diagnosable from the error alone.
    throw new Error(`Google voice list response carried no voices array: ${excerpt(redact(JSON.stringify(payload)))}`);
  }
  return payload.voices
    .filter((voice): voice is Record<string, unknown> => Boolean(voice) && typeof voice === "object")
    .map((voice) => ({
      name: typeof voice.name === "string" ? voice.name : "",
      languageCodes: Array.isArray(voice.languageCodes)
        ? voice.languageCodes.filter((code): code is string => typeof code === "string")
        : [],
      ssmlGender: typeof voice.ssmlGender === "string" ? voice.ssmlGender : "",
      naturalSampleRateHertz: Number(voice.naturalSampleRateHertz) || 0,
    }))
    .filter((voice) => voice.name);
}

/** Which configured tier a Google voice name belongs to, by family substring. */
export function voiceTier(
  voiceName: string,
  tierVoicePrefixes: { economy: string[]; standard: string[]; premium: string[] },
): "economy" | "standard" | "premium" | "unknown" {
  for (const tier of ["premium", "standard", "economy"] as const) {
    if (tierVoicePrefixes[tier].some((family) => family && voiceName.includes(family))) {
      return tier;
    }
  }
  return "unknown";
}

const MAX_EXCERPT = 400;

function excerpt(value: string): string {
  const collapsed = value.trim();
  if (!collapsed) return "(empty body)";
  return collapsed.length > MAX_EXCERPT ? `${collapsed.slice(0, MAX_EXCERPT)}… (truncated)` : collapsed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
