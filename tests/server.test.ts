import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-server-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await writeFile(
      join("projects", "sample-project", "brief.json"),
      JSON.stringify({
        id: "sample-project",
        topic: "Why Qin Mu feels different",
        show: "Tales of Herding Gods",
        format: "shorts",
        audience: "EU donghua viewers",
        language: "English",
        notes: "",
        createdAt: "2026-08-20T00:00:00.000Z",
      }),
      "utf8",
    );
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("server binds to loopback by default", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      assert.equal(running.address.address, "127.0.0.1");
    } finally {
      await running.close();
    }
  });
});

test("paid voice route requires request confirmation", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/voice`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ provider: "openai", confirmedPaidRequest: false }),
      });

      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "paid-confirmation-required");
    } finally {
      await running.close();
    }
  });
});

test("render route reports unmet approval gates", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/render`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });

      assert.equal(response.status, 409);
      assert.deepEqual((await response.json()).details.reasons, [
        "script-approval-missing",
        "copyright-approval-missing",
      ]);
    } finally {
      await running.close();
    }
  });
});

test("config route loads and persists studio model settings", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const initial = await fetch(`${running.url}/api/config`);
      assert.equal(initial.status, 200);
      assert.equal((await initial.json()).config.tts.openai.model, "gpt-4o-mini-tts");

      const response = await fetch(`${running.url}/api/config`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          script: { model: "review-template-v2" },
          translation: { provider: "gemini", model: "gemini-2.5-flash", defaultTarget: "vi" },
          tts: {
            defaultProvider: "vietnamese-local",
            vietnameseLocal: { appPath: "D:/tools/tts/app.py", pythonPath: "py", voice: "vi-demo" },
          },
          render: { ffmpegPath: "D:/tools/ffmpeg.exe" },
        }),
      });

      assert.equal(response.status, 200);
      const saved = (await response.json()).config;
      assert.equal(saved.script.model, "review-template-v2");
      assert.equal(saved.translation.provider, "gemini");
      assert.equal(saved.tts.vietnameseLocal.voice, "vi-demo");
      assert.match(await readFile("studio.config.json", "utf8"), /gemini-2\.5-flash/);
    } finally {
      await running.close();
    }
  });
});

test("subtitle upload route imports source SRT through the API", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob(["1\n00:00:00,000 --> 00:00:02,000\n你好\n"], { type: "application/x-subrip" }),
        "source.srt",
      );

      const response = await fetch(`${running.url}/api/projects/sample-project/subtitles/source`, {
        method: "POST",
        headers: { origin: running.url },
        body: form,
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.artifact.cueCount, 1);
      assert.match(body.artifact.relativePath, /workspace\/subtitles\/source-/);
    } finally {
      await running.close();
    }
  });
});

test("project brief can be created from the studio API", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-server-create-"));
  try {
    process.chdir(root);
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "new-ui-project",
          topic: "A normal drama recap angle",
          show: "Sample Show",
          format: "shorts",
          audience: "Vietnamese review viewers",
          language: "Vietnamese",
          notes: "Created in UI",
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.brief.id, "new-ui-project");
      assert.match(await readFile(join("projects", "new-ui-project", "brief.json"), "utf8"), /Sample Show/);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("copyright and asset actions run from the studio API", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const copyright = await fetch(`${running.url}/api/projects/sample-project/copyright-check`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          commentaryPercent: 75,
          footagePercent: 10,
          longestClipSeconds: 4,
          usesFullScene: false,
          thumbnailFromCopyrightFrame: false,
          clipsHaveCommentaryPurpose: true,
        }),
      });
      assert.equal(copyright.status, 200);
      assert.equal((await copyright.json()).check.risk, "low");

      const form = new FormData();
      form.append("rightsConfirmed", "true");
      form.append("usagePurpose", "Generated background for review intro");
      form.append("mediaType", "image");
      form.append("file", new Blob(["fake-png"], { type: "image/png" }), "asset.png");

      const asset = await fetch(`${running.url}/api/projects/sample-project/assets`, {
        method: "POST",
        headers: { origin: running.url },
        body: form,
      });
      assert.equal(asset.status, 200);
      const body = await asset.json();
      assert.equal(body.asset.rightsConfirmed, true);
      assert.match(body.asset.relativePath, /assets\/images\//);
    } finally {
      await running.close();
    }
  });
});

test("batch review API builds episode analysis and story arc", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-server-batch-ai-"));
  try {
    process.chdir(root);
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await fetch(`${running.url}/api/series`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "muc-than-ky",
          title: "Muc Than Ky",
          show: "Tales of Herding Gods",
          audience: "EU",
          language: "English",
        }),
      });
      await fetch(`${running.url}/api/series/muc-than-ky/review-projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "ep01-02",
          title: "Tales of Herding Gods",
          sourceRange: "Episodes 01-02",
          episodeNumbers: [1, 2],
          targetDurationMinutes: 20,
          spoilerMode: "donghua-only",
        }),
      });
      for (const episodeNumber of [1, 2]) {
        const sourceDir = join(
          "projects",
          "muc-than-ky",
          "review-projects",
          "ep01-02",
          "sources",
          `ep${String(episodeNumber).padStart(3, "0")}`,
        );
        await mkdir(sourceDir, { recursive: true });
        await writeFile(
          join(sourceDir, "scenes.json"),
          JSON.stringify([
            {
              episode: episodeNumber,
              sceneId: `EP0${episodeNumber}-SC001`,
              startMs: 0,
              endMs: 4000,
              dialogue: `Episode ${episodeNumber} reveals the danger around Qin Mu.`,
              characters: ["Qin Mu"],
              visualSummary: `Episode ${episodeNumber} reveals the danger.`,
              importance: 0.82,
              tags: ["conflict"],
              sourceCueIds: ["1"],
              keyframes: [],
            },
          ]),
          "utf8",
        );
        const projectRaw = JSON.parse(await readFile(join("projects", "muc-than-ky", "review-projects", "ep01-02", "batch.json"), "utf8"));
        projectRaw.episodes[episodeNumber - 1].sceneMapPath = `review-projects/ep01-02/sources/ep${String(episodeNumber).padStart(3, "0")}/scenes.json`;
        projectRaw.episodes[episodeNumber - 1].status = "scene-ready";
        await writeFile(join("projects", "muc-than-ky", "review-projects", "ep01-02", "batch.json"), JSON.stringify(projectRaw), "utf8");
      }

      const analysisResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/episodes/1/analysis`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(analysisResponse.status, 200);
      assert.equal((await analysisResponse.json()).analysis.episodeNumber, 1);

      await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/episodes/2/analysis`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      const storyResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/story-arc`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(storyResponse.status, 200);
      const storyBody = await storyResponse.json();
      assert.equal(storyBody.storyArc.storyArcPath, "review-projects/ep01-02/story-arc.json");

      const scriptResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/script`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(scriptResponse.status, 200);
      const scriptBody = await scriptResponse.json();
      assert.equal(scriptBody.script.segments[0].segmentId, "SEG-001");

      const segmentResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/script/segments/SEG-001`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ narration: "A sharper editor-approved hook for this batch." }),
      });
      assert.equal(segmentResponse.status, 200);
      assert.equal((await segmentResponse.json()).script.segments[0].revision, 2);

      const editingResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/editing-plan`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(editingResponse.status, 200);

      const exportResponse = await fetch(`${running.url}/api/series/muc-than-ky/review-projects/ep01-02/export`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(exportResponse.status, 200);
      assert.match((await exportResponse.json()).exported.voiceOverSrtPath, /voice-over\.srt/);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
