import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STUDIO_CONFIG, normalizeStudioConfig } from "../src/config.ts";
import { createConfiguredImageProvider, createGeminiImageProvider } from "../src/images/gemini.ts";
import type { ImageRequest } from "../src/images/types.ts";

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

function imageRequest(outputPath: string, overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    prompt: "abandoned hospital corridor at night, cinematic horror",
    aspectRatio: "16:9",
    outputPath,
    confirmedPaidRequest: true,
    ...overrides,
  };
}

test("image generation is blocked without paid confirmation, before any request", async () => {
  const fakeFetch = createFakeFetch({});
  const provider = createGeminiImageProvider({ apiKey: "k", apiKeyEnv: "GEMINI_API_KEY", fetch: fakeFetch });
  await assert.rejects(
    () => provider.generate(imageRequest("out.png", { confirmedPaidRequest: false })),
    /confirmed paid/,
  );
  assert.equal(fakeFetch.calls.length, 0);
});

test("a missing key names the environment variable", async () => {
  const provider = createGeminiImageProvider({ apiKey: "", apiKeyEnv: "GEMINI_API_KEY" });
  await assert.rejects(() => provider.generate(imageRequest("out.png")), /GEMINI_API_KEY/);
});

test("inline image data decodes to the output path and the key travels as a header", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-gemini-"));
  try {
    const outputPath = join(root, "scene.png");
    const fakeFetch = createFakeFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "Here is your image." },
              { inlineData: { mimeType: "image/png", data: Buffer.from([7, 8, 9]).toString("base64") } },
            ],
          },
        },
      ],
    });
    const provider = createGeminiImageProvider({
      apiKey: "secret-key",
      apiKeyEnv: "GEMINI_API_KEY",
      model: "gemini-2.5-flash-image",
      fetch: fakeFetch,
    });

    const artifact = await provider.generate(imageRequest(outputPath));

    assert.equal(artifact.mimeType, "image/png");
    assert.deepEqual([...(await readFile(outputPath))], [7, 8, 9]);
    const call = fakeFetch.calls[0];
    assert.match(call.url, /models\/gemini-2\.5-flash-image:generateContent$/);
    assert.ok(!call.url.includes("secret-key"));
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "secret-key");
    const body = JSON.parse(String(call.init?.body));
    assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
    assert.equal(body.generationConfig.imageConfig.aspectRatio, "16:9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a text-only refusal throws a classified error, never a placeholder file", async () => {
  const fakeFetch = createFakeFetch({
    candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "I cannot generate that." }] } }],
  });
  const provider = createGeminiImageProvider({ apiKey: "k", apiKeyEnv: "GEMINI_API_KEY", fetch: fakeFetch });
  await assert.rejects(() => provider.generate(imageRequest("never-written.png")), /finishReason SAFETY/);
});

test("a non-ok response is thrown with a redacted excerpt", async () => {
  const fakeFetch = createFakeFetch('{"error":"Authorization: Bearer sk-live-LEAK"}', 429);
  const provider = createGeminiImageProvider({ apiKey: "k", apiKeyEnv: "GEMINI_API_KEY", fetch: fakeFetch });
  await assert.rejects(
    () => provider.generate(imageRequest("out.png")),
    (error: unknown) => /429/.test(String(error)) && !/sk-live-LEAK/.test(String(error)),
  );
});

test("the configured provider refuses to run while images are disabled, naming the setting", () => {
  const config = normalizeStudioConfig(DEFAULT_STUDIO_CONFIG);
  assert.throws(() => createConfiguredImageProvider(config), /images\.provider/);

  const enabled = normalizeStudioConfig({ ...DEFAULT_STUDIO_CONFIG, images: { provider: "gemini" } });
  process.env.GEMINI_API_KEY = "test";
  try {
    assert.equal(createConfiguredImageProvider(enabled).name, "gemini");
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
