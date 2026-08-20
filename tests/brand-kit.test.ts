import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateThumbnailBrief,
  loadBrandKit,
  saveBrandAsset,
  saveBrandKit,
} from "../src/brand-kit.ts";
import { createSeriesProject } from "../src/series.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-brand-kit-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function createReviewSeries(): Promise<void> {
  await createSeriesProject({
    id: "muc-than-ky",
    title: "Muc Than Ky Review",
    show: "Tales of Herding Gods",
    workflowType: "review-recap",
    audience: "EU donghua viewers",
    language: "English",
  });
}

test("brand kit stores channel identity assets and generates thumbnail briefs", async () => {
  await withTempCwd(async () => {
    await createReviewSeries();

    const kit = await saveBrandKit("muc-than-ky", {
      channelName: "Arc Lantern",
      handle: "@ArcLantern",
      logoRoundPath: "brand/assets/logo-round.png",
      logoTextPath: "brand/assets/logo-text.png",
      watermarkPath: "brand/assets/watermark.png",
      primaryColor: "#f4c430",
      secondaryColor: "#1b1f2a",
      accentColor: "#e5484d",
      fontStyle: "bold condensed sans",
      thumbnailPreset: "character-focus",
      titleStyle: "clear curiosity with show name",
      thumbnailStyle: "large readable text, 3 words max",
      watermarkOpacity: 0.24,
      safeTextRules: ["No tiny text", "Keep faces unobstructed"],
      cta: "Subscribe for the next arc",
    });

    assert.equal(kit.channelName, "Arc Lantern");
    assert.equal(kit.thumbnailPreset, "character-focus");
    assert.equal((await loadBrandKit("muc-than-ky")).primaryColor, "#f4c430");

    const asset = await saveBrandAsset("muc-than-ky", {
      filename: "logo.png",
      bytes: Buffer.from("fake-png"),
      mimeType: "image/png",
      assetType: "logo-round",
    });
    assert.equal(asset.assetType, "logo-round");
    assert.match(await readFile(join("projects", "muc-than-ky", asset.relativePath), "utf8"), /fake-png/);

    const brief = await generateThumbnailBrief("muc-than-ky", {
      workflowType: "review-recap",
      videoTitle: "Why Qin Mu feels different",
      episodeLabel: "EP01-05",
      hook: "Qin Mu is not a normal cultivation MC",
    });

    assert.equal(brief.channelName, "Arc Lantern");
    assert.equal(brief.textLines.length, 3);
    assert.match(brief.prompt, /#f4c430/);
    assert.match(brief.prompt, /watermark/i);
  });
});

test("brand kit API saves kit, accepts uploads and creates thumbnail brief", async () => {
  await withTempCwd(async () => {
    await createReviewSeries();
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const headers = { "content-type": "application/json", origin: running.url };
      const saved = await fetch(`${running.url}/api/series/muc-than-ky/brand-kit`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          channelName: "Arc Lantern",
          handle: "@ArcLantern",
          primaryColor: "#f4c430",
          secondaryColor: "#1b1f2a",
          accentColor: "#e5484d",
          fontStyle: "bold condensed sans",
          thumbnailPreset: "story-arc",
          titleStyle: "clear curiosity",
          thumbnailStyle: "large readable text",
          safeTextRules: ["Max three words"],
          cta: "Follow for the next batch",
        }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).brandKit.handle, "@ArcLantern");

      const form = new FormData();
      form.append("assetType", "watermark");
      form.append("file", new Blob(["watermark"], { type: "image/png" }), "wm.png");
      const uploaded = await fetch(`${running.url}/api/series/muc-than-ky/brand-kit/assets`, {
        method: "POST",
        headers: { origin: running.url },
        body: form,
      });
      assert.equal(uploaded.status, 200);
      assert.match((await uploaded.json()).asset.relativePath, /brand\/assets\//);

      const brief = await fetch(`${running.url}/api/series/muc-than-ky/brand-kit/thumbnail-brief`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workflowType: "audio-story",
          videoTitle: "Ashes Under the Moon Gate",
          episodeLabel: "Chapter 1",
          hook: "A courier hears a forbidden bell",
        }),
      });
      assert.equal(brief.status, 200);
      assert.equal((await brief.json()).thumbnailBrief.workflowType, "audio-story");

      const loaded = await fetch(`${running.url}/api/series/muc-than-ky/brand-kit`);
      assert.equal((await loaded.json()).brandKit.channelName, "Arc Lantern");
    } finally {
      await running.close();
    }
  });
});
