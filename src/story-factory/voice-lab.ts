import type { StudioConfig } from "../config.ts";
import { createGoogleTtsProvider, listGoogleVoices, voiceTier, type GoogleTtsConfig } from "../tts/google.ts";
import type { TtsArtifact, TtsProvider } from "../tts/types.ts";
import { estimateGoogleTtsCost } from "./cost.ts";
import type { StoryTtsProfile, TtsQualityTier } from "./types.ts";

/**
 * The Voice Lab lets the operator hear 5-10 candidate voices reading the same
 * sample before choosing a channel narrator. Samples go through the normal TTS
 * cache, so replaying a voice costs nothing.
 */

export const MAX_SAMPLE_CHARS = 500;

export const DEFAULT_SAMPLE_TEXT =
  "A las 3:17 de la madrugada, el ascensor del hospital se abrió solo. No había nadie adentro. " +
  "Pero la cámara de seguridad mostraba a una niña parada detrás de mí.";

export type VoiceLabVoice = {
  name: string;
  languageCodes: string[];
  ssmlGender: string;
  naturalSampleRateHertz: number;
  tier: TtsQualityTier | "unknown";
};

export function googleTtsConfigFromStudio(config: StudioConfig, fetchImpl?: typeof fetch): GoogleTtsConfig {
  return {
    apiKey: config.tts.google.apiKeyEnv ? (process.env[config.tts.google.apiKeyEnv] ?? "") : "",
    apiKeyEnv: config.tts.google.apiKeyEnv,
    baseUrl: config.tts.google.baseUrl,
    fetch: fetchImpl,
  };
}

export async function listVoiceLabVoices(
  languageCode: string,
  config: StudioConfig,
  options: { fetch?: typeof fetch } = {},
): Promise<VoiceLabVoice[]> {
  const voices = await listGoogleVoices(languageCode, googleTtsConfigFromStudio(config, options.fetch));
  return voices.map((voice) => ({
    ...voice,
    tier: voiceTier(voice.name, config.tts.google.tierVoicePrefixes),
  }));
}

export type VoiceSampleResult = {
  artifact: TtsArtifact;
  estimatedCostUsd: number;
};

export async function generateVoiceSample(
  channelId: string,
  profile: StoryTtsProfile,
  sampleText: string,
  config: StudioConfig,
  options: { provider?: TtsProvider; signal?: AbortSignal } = {},
): Promise<VoiceSampleResult> {
  const text = sampleText.trim() || DEFAULT_SAMPLE_TEXT;
  if (text.length > MAX_SAMPLE_CHARS) {
    throw new Error(`Voice Lab samples are capped at ${MAX_SAMPLE_CHARS} characters; this one is ${text.length}.`);
  }
  const provider = options.provider ?? createGoogleTtsProvider(googleTtsConfigFromStudio(config));
  const artifact = await provider.generate(
    {
      projectId: channelId,
      provider: "google",
      text,
      voice: profile.voiceName,
      format: config.tts.google.audioEncoding === "LINEAR16" ? "wav" : "mp3",
      speed: profile.speakingRate,
      instructions: "",
      confirmedPaidRequest: true,
      languageCode: profile.languageCode,
      pitch: profile.pitch,
    },
    options.signal,
  );
  return {
    artifact,
    estimatedCostUsd: estimateGoogleTtsCost(text.length, profile.tier, config.tts.google.pricing).totalUsd,
  };
}
