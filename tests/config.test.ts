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
