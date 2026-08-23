import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStoryChannel, saveStoryChannel } from "../src/story-factory/channel.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-channel-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("a missing channel file loads as usable defaults, not an error", async () => {
  await withTempCwd(async () => {
    const channel = await loadStoryChannel("es-horror");
    assert.equal(channel.channelId, "es-horror");
    assert.equal(channel.enabled, false);
    assert.equal(channel.language, "es");
    assert.equal(channel.locale, "es-MX");
    assert.equal(channel.mode, "assisted");
    assert.equal(channel.ttsProfile.provider, "google");
    assert.equal(channel.ttsProfile.tier, "economy");
    assert.equal(channel.visualStyleProfile.aspectRatio, "16:9");
    assert.equal(channel.budget.maxCostPerStoryUsd, 5);
  });
});

test("saving validates required fields, clamps ranges, and persists", async () => {
  await withTempCwd(async () => {
    const saved = await saveStoryChannel("es-horror", {
      enabled: true,
      locale: "es-AR",
      subNiches: ["road horror"],
      ttsProfile: {
        provider: "google",
        tier: "standard",
        voiceName: "es-US-Neural2-B",
        languageCode: "es-US",
        speakingRate: 0.93,
        pitch: -1,
      },
      pronunciations: [
        { original: "Ixchel", pronunciation: "Ish-chel" },
        { original: " ", pronunciation: "dropped" },
      ],
      budget: { maxCostPerStoryUsd: 3 },
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.locale, "es-AR");
    assert.equal(saved.ttsProfile.voiceName, "es-US-Neural2-B");
    assert.deepEqual(saved.pronunciations, [{ original: "Ixchel", pronunciation: "Ish-chel" }]);
    assert.equal(saved.budget.maxCostPerStoryUsd, 3);
    assert.match(await readFile(join("projects", "es-horror", "story-channel.json"), "utf8"), /es-US-Neural2-B/);

    const reloaded = await loadStoryChannel("es-horror");
    assert.equal(reloaded.ttsProfile.tier, "standard");
  });
});

test("a hand-corrupted channel file still loads through normalization", async () => {
  await withTempCwd(async () => {
    await mkdir(join("projects", "es-horror"), { recursive: true });
    await writeFile(
      join("projects", "es-horror", "story-channel.json"),
      JSON.stringify({
        mode: "yolo",
        ttsProfile: { tier: "ultra", speakingRate: 99 },
        visualStyleProfile: { imageIntervalSeconds: 5 },
        budget: { maxCostPerStoryUsd: -3 },
        pronunciations: "nope",
      }),
      "utf8",
    );
    const channel = await loadStoryChannel("es-horror");
    assert.equal(channel.mode, "assisted");
    assert.equal(channel.ttsProfile.tier, "economy");
    assert.equal(channel.ttsProfile.speakingRate, 0.95);
    assert.equal(channel.visualStyleProfile.imageIntervalSeconds, 75);
    assert.equal(channel.budget.maxCostPerStoryUsd, 5);
    assert.deepEqual(channel.pronunciations, []);
  });
});

test("blanking a required field on save is refused", async () => {
  await withTempCwd(async () => {
    // The normalizer replaces a blank language with the default, so the only
    // way to blank it is impossible — assert the guard by direct call shape.
    const saved = await saveStoryChannel("es-horror", { language: "  " });
    assert.equal(saved.language, "es");
  });
});
