import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STUDIO_CONFIG, normalizeStudioConfig } from "../src/config.ts";
import {
  DEFAULT_SAMPLE_TEXT,
  generateVoiceSample,
  listVoiceLabVoices,
  MAX_SAMPLE_CHARS,
} from "../src/story-factory/voice-lab.ts";
import type { StoryTtsProfile } from "../src/story-factory/types.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "../src/tts/types.ts";

const PROFILE: StoryTtsProfile = {
  provider: "google",
  tier: "economy",
  voiceName: "es-US-Standard-A",
  languageCode: "es-US",
  speakingRate: 0.95,
  pitch: 0,
};

function studioConfig() {
  return normalizeStudioConfig(DEFAULT_STUDIO_CONFIG);
}

function stubProvider(): TtsProvider & { requests: TtsRequest[] } {
  const requests: TtsRequest[] = [];
  return {
    name: "google",
    requests,
    async generate(request: TtsRequest): Promise<TtsArtifact> {
      requests.push(request);
      return {
        provider: "google",
        cacheKey: "sample-key",
        relativePath: "workspace/voice/sample-key.mp3",
        durationSeconds: 9.5,
        createdAt: new Date().toISOString(),
        metadata: {},
      };
    },
  };
}

test("voice listing decorates each voice with its configured tier", async () => {
  const config = studioConfig();
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        voices: [
          { name: "es-US-Standard-A", languageCodes: ["es-US"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24000 },
          { name: "es-US-Neural2-B", languageCodes: ["es-US"], ssmlGender: "MALE", naturalSampleRateHertz: 24000 },
        ],
      }),
    )) as typeof fetch;

  process.env.GOOGLE_TTS_API_KEY = "test-key";
  try {
    const voices = await listVoiceLabVoices("es-US", config, { fetch: fakeFetch });
    assert.equal(voices.length, 2);
    assert.equal(voices[0].tier, "economy");
    assert.equal(voices[1].tier, "standard");
  } finally {
    delete process.env.GOOGLE_TTS_API_KEY;
  }
});

test("a sample uses the profile settings and reports an estimated cost", async () => {
  const provider = stubProvider();
  const result = await generateVoiceSample("es-horror", PROFILE, "Una prueba corta.", studioConfig(), { provider });

  assert.equal(provider.requests.length, 1);
  const request = provider.requests[0];
  assert.equal(request.projectId, "es-horror");
  assert.equal(request.voice, "es-US-Standard-A");
  assert.equal(request.languageCode, "es-US");
  assert.equal(request.speed, 0.95);
  assert.equal(result.artifact.durationSeconds, 9.5);
  // 17 chars at $4/1M ≈ $0.000068 — tiny but nonzero and approximate.
  assert.ok(result.estimatedCostUsd > 0);
});

test("a blank sample falls back to the shared Spanish horror sample text", async () => {
  const provider = stubProvider();
  await generateVoiceSample("es-horror", PROFILE, "   ", studioConfig(), { provider });
  assert.equal(provider.requests[0].text, DEFAULT_SAMPLE_TEXT);
});

test("oversized sample text is refused with the cap named", async () => {
  const provider = stubProvider();
  await assert.rejects(
    () => generateVoiceSample("es-horror", PROFILE, "x".repeat(MAX_SAMPLE_CHARS + 1), studioConfig(), { provider }),
    new RegExp(String(MAX_SAMPLE_CHARS)),
  );
  assert.equal(provider.requests.length, 0);
});
