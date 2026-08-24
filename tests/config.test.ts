import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStudioConfig, saveStudioConfig } from "../src/config.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-config-"));
  try {
    process.chdir(root);
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("loads defaults when studio config is missing", async () => {
  await withTempCwd(async () => {
    const config = await loadStudioConfig();

    assert.equal(config.script.model, "local-template");
    assert.equal(config.translation.defaultTarget, "vi");
    assert.equal(config.asr.provider, "disabled");
    assert.equal(config.asr.language, "zh");
    assert.equal(config.tts.openai.model, "gpt-4o-mini-tts");
    assert.equal(config.render.shortsWidth, 1080);
  });
});

test("normalizes saved config and rejects invalid enum values", async () => {
  await withTempCwd(async () => {
    const saved = await saveStudioConfig({
      script: { provider: "dry-run", model: "template-v2" },
      translation: {
        provider: "openai",
        model: "gpt-4.1-mini",
        defaultTarget: "en-au",
        defaultGenre: "fantasy-system",
      },
      asr: {
        provider: "faster-whisper",
        executablePath: "tools/faster-whisper.exe",
        model: "medium",
        modelPath: "",
        language: "zh",
      },
      tts: {
        defaultProvider: "vietnamese-local",
        openai: { model: "tts-model", voice: "verse", apiKeyEnv: "OPENAI_API_KEY" },
        piper: { executablePath: "tools/piper.exe", modelPath: "voices/en.onnx", voice: "en" },
        vietnameseLocal: { pythonPath: "py", appPath: "tools/tts/app.py", voice: "vi-voice" },
      },
      render: { ffmpegPath: "tools/ffmpeg.exe", ffprobePath: "tools/ffprobe.exe", shortsWidth: 720, shortsHeight: 1280 },
    });

    assert.equal(saved.translation.provider, "openai");
    assert.equal(saved.asr.provider, "faster-whisper");
    assert.equal(saved.asr.model, "medium");
    assert.equal(saved.tts.defaultProvider, "vietnamese-local");
    assert.equal(saved.render.shortsHeight, 1280);
    assert.match(await readFile("studio.config.json", "utf8"), /template-v2/);

    await writeFile(
      "studio.config.json",
      JSON.stringify({ translation: { provider: "unsafe-provider" }, asr: { provider: "cloud-unsafe" }, render: { shortsWidth: -1 } }),
      "utf8",
    );
    const reloaded = await loadStudioConfig();
    assert.equal(reloaded.translation.provider, "prompt-only");
    assert.equal(reloaded.asr.provider, "disabled");
    assert.equal(reloaded.render.shortsWidth, 1080);
  });
});

test("studio config carries long-form output dimensions", async () => {
  await withTempCwd(async () => {
    const config = await loadStudioConfig();

    assert.equal(config.render.longformWidth, 1920);
    assert.equal(config.render.longformHeight, 1080);
  });
});

test("studio config carries script model settings", async () => {
  await withTempCwd(async () => {
    const config = await loadStudioConfig();

    assert.equal(config.script.provider, "dry-run");
    assert.equal(config.script.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(config.script.paid, false);
    assert.equal(config.script.temperature, 0.8);
    assert.equal(config.script.maxOutputTokens, 4000);
  });
});

test("a zero temperature is preserved rather than replaced by the default", async () => {
  await withTempCwd(async () => {
    const saved = await saveStudioConfig({ script: { provider: "openai-compatible", temperature: 0 } });

    assert.equal(saved.script.provider, "openai-compatible");
    assert.equal(saved.script.temperature, 0);
  });
});

test("an unrecognized script provider survives the load so the studio can show and repair it", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ script: { provider: "openai_compatible" } }), "utf8");

    // Loading must never fail: every unrelated stage reads this config, and the
    // Config screen is the only in-studio repair path. The value is also kept as
    // written rather than rewritten to "dry-run", which is what let a typo
    // generate template output and report success.
    const config = await loadStudioConfig();
    assert.equal(config.script.provider, "openai_compatible");
    assert.equal(config.asr.provider, "disabled");
    assert.equal(config.render.shortsWidth, 1080);
  });
});

test("saving an unrecognized script provider is refused by name and writes nothing", async () => {
  await withTempCwd(async () => {
    await assert.rejects(() => saveStudioConfig({ script: { provider: "openai_compatible" } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /openai_compatible/);
      assert.match(error.message, /dry-run/);
      assert.match(error.message, /openai-compatible/);
      return true;
    });

    await assert.rejects(() => readFile("studio.config.json", "utf8"), /ENOENT/);
  });
});

test("an absent or empty script provider still defaults to the template", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ script: { model: "template-v2" } }), "utf8");
    assert.equal((await loadStudioConfig()).script.provider, "dry-run");

    await writeFile("studio.config.json", JSON.stringify({ script: { provider: "" } }), "utf8");
    assert.equal((await loadStudioConfig()).script.provider, "dry-run");
  });
});

test("a lenient enum elsewhere is unchanged by the strict script provider", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ translation: { provider: "unsafe-provider" } }), "utf8");

    assert.equal((await loadStudioConfig()).translation.provider, "prompt-only");
  });
});

test("the story factory, google tts, and images blocks default and normalize", async () => {
  await withTempCwd(async () => {
    const defaults = await loadStudioConfig();
    assert.equal(defaults.storyFactory.enabled, false);
    assert.equal(defaults.storyFactory.models.planner.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(defaults.storyFactory.models.writer.paid, false);
    assert.deepEqual(defaults.storyFactory.llmPricing, []);
    assert.equal(defaults.storyFactory.duplicateSimilarityThreshold, 0.6);
    assert.equal(defaults.storyFactory.defaultMaxCostPerStoryUsd, 5);
    assert.equal(defaults.tts.google.apiKeyEnv, "GOOGLE_TTS_API_KEY");
    assert.equal(defaults.tts.google.audioEncoding, "MP3");
    assert.equal(defaults.tts.google.chunkMaxChars, 4500);
    assert.equal(defaults.tts.google.pricing.economy, 4);
    assert.deepEqual(defaults.tts.google.tierVoicePrefixes.standard, ["Neural2", "Wavenet"]);
    assert.equal(defaults.images.provider, "disabled");
    assert.equal(defaults.images.gemini.apiKeyEnv, "GEMINI_API_KEY");

    await writeFile(
      "studio.config.json",
      JSON.stringify({
        storyFactory: {
          enabled: true,
          models: { writer: { model: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY", paid: true } },
          llmPricing: [
            { modelPattern: "gpt-5-mini", inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
            { modelPattern: "", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
            { modelPattern: "bad", inputUsdPerMTok: -1, outputUsdPerMTok: 1 },
          ],
          duplicateSimilarityThreshold: 3,
        },
        tts: { defaultProvider: "google", google: { chunkMaxChars: 9000, audioEncoding: "OGG" } },
        images: { provider: "gemini", gemini: { model: "custom-image-model" } },
      }),
      "utf8",
    );

    const loaded = await loadStudioConfig();
    assert.equal(loaded.storyFactory.enabled, true);
    assert.equal(loaded.storyFactory.models.writer.model, "gpt-5-mini");
    assert.equal(loaded.storyFactory.models.writer.paid, true);
    // Malformed pricing rows are dropped; the valid one survives.
    assert.deepEqual(loaded.storyFactory.llmPricing, [
      { modelPattern: "gpt-5-mini", inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
    ]);
    // Out-of-range values fall back rather than surviving.
    assert.equal(loaded.storyFactory.duplicateSimilarityThreshold, 0.6);
    assert.equal(loaded.tts.defaultProvider, "google");
    // Google's synthesize limit is 5000 bytes; a request past it is clamped back to the default.
    assert.equal(loaded.tts.google.chunkMaxChars, 4500);
    assert.equal(loaded.tts.google.audioEncoding, "MP3");
    assert.equal(loaded.images.provider, "gemini");
    assert.equal(loaded.images.gemini.model, "custom-image-model");
  });
});

test("the sources block defaults, and rejects entries that are not usable strings", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-config-sources-"));
  try {
    process.chdir(root);

    const defaults = await loadStudioConfig();
    assert.equal(defaults.sources.ytDlpPath, "");
    assert.deepEqual(defaults.sources.ytDlpArgs, []);
    assert.equal(defaults.sources.format, "bv*+ba/b");
    assert.deepEqual(defaults.sources.subtitleLanguages, ["en"]);
    assert.equal(defaults.sources.defaultSearchPlatform, "youtube");
    assert.equal(defaults.sources.searchLimit, 8);
    assert.equal(defaults.sources.searchPrefixes.youtube, "ytsearch");
    assert.equal(defaults.sources.searchPrefixes.bilibili, "bilisearch");
    assert.equal(defaults.sources.searchPrefixes.tiktok, "");
    assert.equal(defaults.sources.searchPrefixes.douyin, "");
    assert.equal(defaults.sources.searchPrefixes.facebook, "");

    await writeFile(
      "studio.config.json",
      JSON.stringify({
        sources: {
          ytDlpPath: "tools/yt-dlp.exe",
          subtitleLanguages: ["vi", "", 7],
          ytDlpArgs: "nope",
          defaultSearchPlatform: "douyin",
          searchLimit: 12,
          searchPrefixes: { bilibili: "custombili", youtube: "", tiktok: "customtiktok", douyin: "customdouyin", facebook: "customfacebook" },
        },
      }),
      "utf8",
    );
    const loaded = await loadStudioConfig();
    assert.equal(loaded.sources.ytDlpPath, "tools/yt-dlp.exe");
    assert.deepEqual(loaded.sources.subtitleLanguages, ["vi"]);
    assert.deepEqual(loaded.sources.ytDlpArgs, []);
    assert.equal(loaded.sources.defaultSearchPlatform, "douyin");
    assert.equal(loaded.sources.searchLimit, 12);
    assert.equal(loaded.sources.searchPrefixes.youtube, "ytsearch");
    assert.equal(loaded.sources.searchPrefixes.bilibili, "custombili");
    assert.equal(loaded.sources.searchPrefixes.tiktok, "customtiktok");
    assert.equal(loaded.sources.searchPrefixes.douyin, "customdouyin");
    assert.equal(loaded.sources.searchPrefixes.facebook, "customfacebook");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
