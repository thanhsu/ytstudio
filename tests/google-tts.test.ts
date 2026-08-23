import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoogleTtsProvider, listGoogleVoices, voiceTier } from "../src/tts/google.ts";
import type { TtsRequest } from "../src/tts/types.ts";

type FakeFetch = typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> };

function createFakeFetch(body: unknown, status = 200): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as FakeFetch;
  fakeFetch.calls = calls;
  return fakeFetch;
}

function googleRequest(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return {
    projectId: "es-horror",
    provider: "google",
    text: "El pasillo estaba vacío.",
    voice: "es-US-Neural2-B",
    format: "mp3",
    speed: 0.95,
    instructions: "",
    confirmedPaidRequest: true,
    languageCode: "es-US",
    pitch: -1,
    ...overrides,
  };
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-google-tts-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("generation is blocked without explicit paid confirmation, before any request", async () => {
  const fakeFetch = createFakeFetch({});
  const provider = createGoogleTtsProvider({ apiKey: "k", apiKeyEnv: "GOOGLE_TTS_API_KEY", fetch: fakeFetch });
  await assert.rejects(() => provider.generate(googleRequest({ confirmedPaidRequest: false })), /confirmed paid/);
  assert.equal(fakeFetch.calls.length, 0);
});

test("a missing key names the environment variable", async () => {
  const provider = createGoogleTtsProvider({ apiKey: "", apiKeyEnv: "GOOGLE_TTS_API_KEY" });
  await assert.rejects(() => provider.generate(googleRequest()), /GOOGLE_TTS_API_KEY/);
});

test("a missing languageCode or voice is refused with the remedy named", async () => {
  const provider = createGoogleTtsProvider({ apiKey: "k", apiKeyEnv: "GOOGLE_TTS_API_KEY" });
  await assert.rejects(() => provider.generate(googleRequest({ languageCode: undefined })), /languageCode/);
  await assert.rejects(() => provider.generate(googleRequest({ voice: "" })), /voice name/);
});

test("the request body carries voice, rate, and pitch; the key travels as a header", async () => {
  await withTempCwd(async () => {
    const audio = Buffer.from([1, 2, 3]).toString("base64");
    const fakeFetch = createFakeFetch({ audioContent: audio });
    const provider = createGoogleTtsProvider({
      apiKey: "secret-key",
      apiKeyEnv: "GOOGLE_TTS_API_KEY",
      fetch: fakeFetch,
      probeDuration: async () => 1.4,
    });

    const artifact = await provider.generate(googleRequest());

    assert.equal(fakeFetch.calls.length, 1);
    const call = fakeFetch.calls[0];
    assert.match(call.url, /text:synthesize$/);
    // Never in the URL, where it would leak into thrown messages.
    assert.ok(!call.url.includes("secret-key"));
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["X-Goog-Api-Key"], "secret-key");
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.input.text, "El pasillo estaba vacío.");
    assert.equal(body.voice.name, "es-US-Neural2-B");
    assert.equal(body.voice.languageCode, "es-US");
    assert.equal(body.audioConfig.audioEncoding, "MP3");
    assert.equal(body.audioConfig.speakingRate, 0.95);
    assert.equal(body.audioConfig.pitch, -1);

    assert.equal(artifact.provider, "google");
    assert.equal(artifact.durationSeconds, 1.4);
    const written = await readFile(join("projects", "es-horror", artifact.relativePath.replace(/\//g, "/")));
    assert.deepEqual([...written], [1, 2, 3]);
  });
});

test("an identical request reuses the cached audio instead of paying again", async () => {
  await withTempCwd(async () => {
    const fakeFetch = createFakeFetch({ audioContent: Buffer.from([9]).toString("base64") });
    const provider = createGoogleTtsProvider({
      apiKey: "k",
      apiKeyEnv: "GOOGLE_TTS_API_KEY",
      fetch: fakeFetch,
      probeDuration: async () => 2,
    });

    const first = await provider.generate(googleRequest());
    const second = await provider.generate(googleRequest());

    assert.equal(fakeFetch.calls.length, 1);
    assert.equal(second.cacheKey, first.cacheKey);
  });
});

test("a non-ok response is thrown with a redacted excerpt", async () => {
  const fakeFetch = createFakeFetch('{"error":"Authorization: Bearer sk-live-LEAK"}', 429);
  const provider = createGoogleTtsProvider({ apiKey: "k", apiKeyEnv: "GOOGLE_TTS_API_KEY", fetch: fakeFetch });
  await assert.rejects(
    () => provider.generate(googleRequest()),
    (error: unknown) => {
      const message = String(error);
      return /429/.test(message) && !/sk-live-LEAK/.test(message);
    },
  );
});

test("a 200 without audioContent is an error, never an empty file", async () => {
  const fakeFetch = createFakeFetch({ unexpected: true });
  const provider = createGoogleTtsProvider({ apiKey: "k", apiKeyEnv: "GOOGLE_TTS_API_KEY", fetch: fakeFetch });
  await assert.rejects(() => provider.generate(googleRequest()), /audioContent/);
});

test("the voice catalog parses and an unexpected shape throws with an excerpt", async () => {
  const fakeFetch = createFakeFetch({
    voices: [
      { name: "es-US-Neural2-B", languageCodes: ["es-US"], ssmlGender: "MALE", naturalSampleRateHertz: 24000 },
      { name: "es-US-Standard-A", languageCodes: ["es-US"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24000 },
      { bogus: true },
    ],
  });
  const voices = await listGoogleVoices("es-US", { apiKey: "k", apiKeyEnv: "E", fetch: fakeFetch });
  assert.equal(voices.length, 2);
  assert.equal(voices[0].name, "es-US-Neural2-B");
  assert.match(fakeFetch.calls[0].url, /voices\?languageCode=es-US/);

  const badFetch = createFakeFetch({ nope: [] });
  await assert.rejects(() => listGoogleVoices("es-US", { apiKey: "k", apiKeyEnv: "E", fetch: badFetch }), /voices array/);
});

test("voice names map to configured tiers by family substring", () => {
  const prefixes = { economy: ["Standard"], standard: ["Neural2", "Wavenet"], premium: ["Chirp3", "Studio"] };
  assert.equal(voiceTier("es-US-Standard-A", prefixes), "economy");
  assert.equal(voiceTier("es-US-Neural2-B", prefixes), "standard");
  assert.equal(voiceTier("es-US-Chirp3-HD-Achernar", prefixes), "premium");
  assert.equal(voiceTier("es-US-Mystery-X", prefixes), "unknown");
});
