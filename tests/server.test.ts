import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, resolveStaticFilePath, startStudioServer } from "../src/server.ts";
import { makeFakeExecutable, sampleCandidate, seedCandidate, writeStudioConfig } from "./helpers.ts";

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

test("project snapshot carries the cut gate beside the draft gate", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const snapshot = await (await fetch(`${running.url}/api/projects/sample-project`)).json();

      assert.equal(snapshot.editRenderGate.allowed, false);
      assert.deepEqual(snapshot.editRenderGate.reasons, [
        "copyright-approval-missing",
        "source-media-missing",
        "edit-manifest-missing",
      ]);
    } finally {
      await running.close();
    }
  });
});

test("cut render route reports its own gates, not the narrated draft gates", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/edit-render`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "edit-render-gates-unmet");
      assert.deepEqual(body.details.reasons, [
        "copyright-approval-missing",
        "source-media-missing",
        "edit-manifest-missing",
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

test("edit manifest API creates, updates, loads, and exports subtitle decisions", async () => {
  await withTempCwd(async () => {
    const subtitleDir = join("projects", "sample-project", "workspace", "subtitles");
    await mkdir(subtitleDir, { recursive: true });
    await writeFile(
      join(subtitleDir, "source.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nKeep\n\n2\n00:00:01,100 --> 00:00:02,000\nRemove\n",
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    const jsonHeaders = { "content-type": "application/json", origin: running.url };
    try {
      const missingResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`);
      assert.equal(missingResponse.status, 404);
      assert.equal((await missingResponse.json()).code, "edit-manifest-missing");

      const missingUpdateResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest/remove-list`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ remove: "1" }),
      });
      assert.equal(missingUpdateResponse.status, 404);
      assert.equal((await missingUpdateResponse.json()).code, "edit-manifest-missing");

      const missingExportResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest/export`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      });
      assert.equal(missingExportResponse.status, 404);
      assert.equal((await missingExportResponse.json()).code, "edit-manifest-missing");

      const missingSourceResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "workspace/subtitles/missing.srt" }),
      });
      assert.equal(missingSourceResponse.status, 404);
      assert.equal((await missingSourceResponse.json()).code, "edit-source-missing");

      const traversalResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "../outside.srt" }),
      });
      assert.equal(traversalResponse.status, 400);
      assert.equal((await traversalResponse.json()).code, "edit-source-invalid");

      await writeFile(join(subtitleDir, "invalid.srt"), "not an srt", "utf8");
      const invalidSrtResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "workspace/subtitles/invalid.srt" }),
      });
      assert.equal(invalidSrtResponse.status, 400);
      assert.equal((await invalidSrtResponse.json()).code, "edit-source-invalid");

      const createResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "workspace/subtitles/source.srt" }),
      });
      assert.equal(createResponse.status, 200);
      assert.equal((await createResponse.json()).manifest.segments.length, 2);

      const invalidResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest/remove-list`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ remove: "3" }),
      });
      assert.equal(invalidResponse.status, 400);
      assert.match((await invalidResponse.json()).message, /outside the available range/);

      const updateResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest/remove-list`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ remove: "2" }),
      });
      assert.equal(updateResponse.status, 200);
      assert.equal((await updateResponse.json()).manifest.segments[1].decision, "remove");

      const conflictResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "workspace/subtitles/source.srt" }),
      });
      assert.equal(conflictResponse.status, 409);
      assert.equal((await conflictResponse.json()).code, "edit-manifest-exists");

      const loadResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`);
      assert.equal(loadResponse.status, 200);
      assert.equal((await loadResponse.json()).manifest.segments[1].decision, "remove");

      const exportResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest/export`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      });
      assert.equal(exportResponse.status, 200);
      const exported = (await exportResponse.json()).exported;
      assert.equal(exported.keptCueCount, 1);
      assert.match(await readFile(join("projects", "sample-project", exported.cleanSrtRelativePath), "utf8"), /Keep/);

      const replaceResponse = await fetch(`${running.url}/api/projects/sample-project/edit-manifest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ source: "workspace/subtitles/source.srt", replace: true }),
      });
      assert.equal(replaceResponse.status, 200);
      assert.equal((await replaceResponse.json()).manifest.segments[1].decision, "keep");
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

      const snapshot = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.equal(snapshot.assetManifest.assets.length, 1);

      const update = await fetch(
        `${running.url}/api/projects/sample-project/assets/${encodeURIComponent(body.asset.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: running.url },
          body: JSON.stringify({
            usagePurpose: "Background behind original review commentary",
            rightsConfirmed: true,
          }),
        },
      );
      assert.equal(update.status, 200);
      assert.equal((await update.json()).asset.usagePurpose, "Background behind original review commentary");
    } finally {
      await running.close();
    }
  });
});

test("asset approval returns a validation error instead of internal error", async () => {
  await withTempCwd(async () => {
    await mkdir(join("projects", "sample-project", "assets"), { recursive: true });
    await writeFile(
      join("projects", "sample-project", "assets", "asset-manifest.json"),
      JSON.stringify({
        version: 1,
        assets: [
          {
            id: "asset-1",
            filename: "visual.jpg",
            relativePath: "assets/images/visual.jpg",
            mediaType: "image",
            mimeType: "image/jpeg",
            sizeBytes: 10,
            rightsConfirmed: true,
            usagePurpose: "",
            createdAt: "2026-08-21T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/assets/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, "asset-manifest-invalid");
      assert.match(body.message, /usage purpose/i);
    } finally {
      await running.close();
    }
  });
});

test("visual mapping API generates, edits, and approves caption-aligned scenes", async () => {
  await withTempCwd(async () => {
    await mkdir(join("projects", "sample-project", "workspace", "captions"), { recursive: true });
    await mkdir(join("projects", "sample-project", "assets"), { recursive: true });
    await writeFile(join("projects", "sample-project", "workspace", "captions", "draft.srt"), "1\n00:00:00,000 --> 00:00:05,000\nQin Mu trains in the village.\n", "utf8");
    await writeFile(join("projects", "sample-project", "project-state.json"), JSON.stringify({
      version: 1, approvals: {}, artifacts: { captions: { kind: "captions", relativePath: "workspace/captions/draft.srt", sourceHash: "x", createdAt: "2026-08-21T00:00:00.000Z" } },
    }), "utf8");
    await writeFile(join("projects", "sample-project", "assets", "asset-manifest.json"), JSON.stringify({ version: 1, assets: [{
      id: "image-1", filename: "village.jpg", relativePath: "assets/images/village.jpg", mediaType: "image", mimeType: "image/jpeg", sizeBytes: 10,
      rightsConfirmed: true, usagePurpose: "Qin Mu village context", createdAt: "2026-08-21T00:00:00.000Z", analysisStatus: "limited", keywords: ["qin", "mu", "village"],
    }] }), "utf8");

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const generated = await fetch(`${running.url}/api/projects/sample-project/visual-mapping/generate`, { method: "POST", headers: { origin: running.url } });
      assert.equal(generated.status, 200);
      assert.equal((await generated.json()).mapping.segments[0].assetId, "image-1");

      const edited = await fetch(`${running.url}/api/projects/sample-project/visual-mapping/segments/scene-001`, {
        method: "PATCH", headers: { "content-type": "application/json", origin: running.url }, body: JSON.stringify({ fitMode: "contain" }),
      });
      assert.equal(edited.status, 200);
      assert.equal((await edited.json()).segment.selectionMode, "manual");

      const approved = await fetch(`${running.url}/api/projects/sample-project/visual-mapping/approve`, { method: "POST", headers: { origin: running.url } });
      assert.equal(approved.status, 200);
      assert.equal((await approved.json()).mapping.status, "approved");
    } finally { await running.close(); }
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

test("static path resolution rejects sibling directories sharing the root prefix", () => {
  assert.equal(resolveStaticFilePath("/srv/studio", "/../../../studio-evil/app.js"), null);
  assert.match(String(resolveStaticFilePath("/srv/studio", "/app.js")), /src[\\/]web[\\/]app\.js$/);
});

test("mutating requests without an Origin header are refused", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects/sample-project/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "same-origin-required");
    } finally {
      await running.close();
    }
  });
});

test("project listing follows the configured projects root", async () => {
  const previousCwd = process.cwd();
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const workingDirectory = await mkdtemp(join(tmpdir(), "yt-server-cwd-"));
  const library = await mkdtemp(join(tmpdir(), "yt-server-library-"));
  try {
    process.chdir(workingDirectory);
    process.env.YT_STUDIO_PROJECTS_DIR = library;
    await mkdir(join(library, "relocated-project"), { recursive: true });
    await writeFile(
      join(library, "relocated-project", "brief.json"),
      JSON.stringify({ id: "relocated-project", topic: "Relocated", format: "shorts" }),
      "utf8",
    );

    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/projects`);
      assert.deepEqual((await response.json()).projects, ["relocated-project"]);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(workingDirectory, { recursive: true, force: true });
    await rm(library, { recursive: true, force: true });
  }
});

async function postJson(running: { url: string }, route: string, body: unknown = {}) {
  return fetch(`${running.url}/api/projects/sample-project/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: running.url },
    body: JSON.stringify(body),
  });
}

function copyrightCheckBody(commentaryPercent: number) {
  return {
    commentaryPercent,
    footagePercent: 10,
    longestClipSeconds: 4,
    usesFullScene: false,
    thumbnailFromCopyrightFrame: false,
    clipsHaveCommentaryPurpose: true,
  };
}

test("script approval is an explicit action rather than a side effect of voice", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const scriptEvents = await fetch(`${running.url}/api/projects/sample-project/events`);
      const script = await postJson(running, "script");
      assert.equal(script.status, 202);
      const scriptJob = (await script.json()).job;
      const scriptFinished = await readEventStreamUntil(
        scriptEvents,
        (payload) => payload.id === scriptJob.id && payload.status !== "running",
      );
      assert.equal(scriptFinished.status, "succeeded");

      const voice = await postJson(running, "voice", { provider: "piper" });
      assert.equal(voice.status, 409);
      assert.deepEqual((await voice.json()).details.reasons, ["script-approval-missing"]);

      const beforeApproval = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.equal(beforeApproval.state.approvals.script, undefined);

      assert.equal((await postJson(running, "script/approve")).status, 200);
      const afterApproval = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.ok(afterApproval.state.approvals.script.sourceHash);
    } finally {
      await running.close();
    }
  });
});

test("render refuses a stale copyright approval without re-approving it", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const scriptEvents = await fetch(`${running.url}/api/projects/sample-project/events`);
      const scriptStarted = await postJson(running, "script");
      const scriptJob = (await scriptStarted.json()).job;
      const scriptFinished = await readEventStreamUntil(
        scriptEvents,
        (payload) => payload.id === scriptJob.id && payload.status !== "running",
      );
      assert.equal(scriptFinished.status, "succeeded");
      await postJson(running, "script/approve");
      await postJson(running, "copyright-check", copyrightCheckBody(75));
      await postJson(running, "copyright/approve");

      const approved = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      const approvedHash = approved.state.approvals.copyright.sourceHash;

      await postJson(running, "copyright-check", copyrightCheckBody(55));

      const render = await postJson(running, "render");
      assert.equal(render.status, 409);
      assert.ok((await render.json()).details.reasons.includes("copyright-approval-stale"));

      const after = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.equal(after.state.approvals.copyright.sourceHash, approvedHash);
    } finally {
      await running.close();
    }
  });
});

test("project snapshot reports what the render gate is waiting on", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const snapshot = await (await fetch(`${running.url}/api/projects/sample-project`)).json();

      assert.equal(snapshot.renderGate.allowed, false);
      assert.ok(snapshot.renderGate.reasons.includes("script-approval-missing"));
    } finally {
      await running.close();
    }
  });
});

async function readEventStreamUntil(
  response: Response,
  matches: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Event stream closed before the expected event.");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (matches(payload)) return payload;
      }
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel();
  }
}

test("slow routes run as jobs and report their outcome over the event stream", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);

      // ASR is disabled by default, so the job fails quickly without external tools.
      const started = await postJson(running, "asr");
      assert.equal(started.status, 202);
      const { job } = await started.json();
      assert.equal(job.kind, "asr");
      assert.equal(job.status, "running");

      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );
      assert.equal(finished.status, "failed");
      assert.match(String(finished.error), /asr/i);
    } finally {
      await running.close();
    }
  });
});

test("a second job is refused while one is still running for the project", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const scriptEvents = await fetch(`${running.url}/api/projects/sample-project/events`);
      const scriptStarted = await postJson(running, "script");
      const scriptJob = (await scriptStarted.json()).job;
      const scriptFinished = await readEventStreamUntil(
        scriptEvents,
        (payload) => payload.id === scriptJob.id && payload.status !== "running",
      );
      assert.equal(scriptFinished.status, "succeeded");
      await postJson(running, "script/approve");
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);

      const first = await postJson(running, "voice", { provider: "piper" });
      assert.equal(first.status, 202);
      const firstJob = (await first.json()).job;

      const second = await postJson(running, "voice", { provider: "piper" });
      assert.equal(second.status, 409);
      assert.equal((await second.json()).code, "job-already-running");

      await readEventStreamUntil(
        events,
        (payload) => payload.id === firstJob.id && payload.status !== "running",
      );
    } finally {
      await running.close();
    }
  });
});

test("script generation runs as a job and writes the project files", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);

      const started = await postJson(running, "script");
      assert.equal(started.status, 202);
      const { job } = await started.json();
      assert.equal(job.kind, "script");

      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );
      assert.equal(finished.status, "succeeded");
      assert.match(await readFile(join("projects", "sample-project", "script.md"), "utf8"), /Hook/);
    } finally {
      await running.close();
    }
  });
});

test("a paid script model is refused without confirmation", async () => {
  await withTempCwd(async () => {
    await writeFile(
      "studio.config.json",
      JSON.stringify({ script: { provider: "openai-compatible", paid: true, apiKeyEnv: "TEST_SCRIPT_KEY" } }),
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await postJson(running, "script");

      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "paid-confirmation-required");
    } finally {
      await running.close();
    }
  });
});

test("the project snapshot reports the model that produced the current script, not the configured one", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);
      const started = await postJson(running, "script");
      const { job } = await started.json();
      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );
      assert.equal(finished.status, "succeeded");

      const generated = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.deepEqual(generated.metadata.generator, { provider: "dry-run", model: "local-template" });

      // Repointing the studio at a hosted model must not relabel the template
      // output that is already on disk and awaiting approval.
      await writeFile(
        "studio.config.json",
        JSON.stringify({ script: { provider: "openai-compatible", model: "qwen2.5:14b" } }),
        "utf8",
      );

      const afterConfigChange = await (await fetch(`${running.url}/api/projects/sample-project`)).json();
      assert.deepEqual(afterConfigChange.metadata.generator, { provider: "dry-run", model: "local-template" });
    } finally {
      await running.close();
    }
  });
});

test("the project snapshot carries no metadata before a script exists", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const snapshot = await (await fetch(`${running.url}/api/projects/sample-project`)).json();

      assert.equal(snapshot.metadata, null);
    } finally {
      await running.close();
    }
  });
});

test("a typo in the script provider fails the job by name instead of generating template output", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ script: { provider: "openai_compatible" } }), "utf8");
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      // Config still loads, so the screen that repairs the value stays reachable.
      const config = await (await fetch(`${running.url}/api/config`)).json();
      assert.equal(config.config.script.provider, "openai_compatible");

      const events = await fetch(`${running.url}/api/projects/sample-project/events`);
      const started = await postJson(running, "script");
      const { job } = await started.json();
      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );

      assert.equal(finished.status, "failed");
      assert.match(String(finished.error), /openai_compatible/);
      await assert.rejects(() => readFile(join("projects", "sample-project", "script.md"), "utf8"), /ENOENT/);
    } finally {
      await running.close();
    }
  });
});

test("a typo in a script setting does not break stages that never touch the script model", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ script: { provider: "openai_compatible" } }), "utf8");
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const snapshot = await fetch(`${running.url}/api/projects/sample-project`);
      const projects = await fetch(`${running.url}/api/projects`);

      assert.equal(snapshot.status, 200);
      assert.equal(projects.status, 200);
    } finally {
      await running.close();
    }
  });
});

test("a paid flag left on the offline template does not demand spend confirmation", async () => {
  await withTempCwd(async () => {
    await writeFile("studio.config.json", JSON.stringify({ script: { provider: "dry-run", paid: true } }), "utf8");
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);
      const started = await postJson(running, "script");

      assert.equal(started.status, 202);
      const { job } = await started.json();
      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );
      assert.equal(finished.status, "succeeded");
    } finally {
      await running.close();
    }
  });
});

async function withSourcesServer(
  run: (running: Awaited<ReturnType<typeof startStudioServer>>) => Promise<void>,
  payload: unknown = { extractor_key: "Youtube", id: "dQw4w9WgXcQ", webpage_url: "https://youtu.be/dQw4w9WgXcQ", title: "Episode 1" },
): Promise<void> {
  await withTempCwd(async () => {
    await writeStudioConfig({
      sources: {
        ytDlpPath: process.execPath,
        ytDlpArgs: [await makeFakeExecutable(`console.log(${JSON.stringify(JSON.stringify(payload))});`)],
      },
    });
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await run(running);
    } finally {
      await running.close();
    }
  });
}

test("the sources routes reject a missing url and list an empty store", async () => {
  await withSourcesServer(async (running) => {
    const listed = await fetch(`${running.url}/api/sources`);
    assert.deepEqual(await listed.json(), { sources: [] });

    const created = await fetch(`${running.url}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: "{}",
    });
    assert.equal(created.status, 400);
    assert.equal((await created.json()).code, "source-url-required");
  });
});

test("a pasted url becomes a candidate, and pasting it again does not duplicate it", async () => {
  await withSourcesServer(async (running) => {
    const post = () => fetch(`${running.url}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    });

    const first = await post();
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.created, true);
    assert.equal(body.candidate.id, "youtube-dqw4w9wgxcq");
    assert.equal(body.candidate.rights, "unknown");

    assert.equal((await (await post()).json()).created, false);
    assert.equal((await (await fetch(`${running.url}/api/sources`)).json()).sources.length, 1);
  });
});

test("source search returns discoverable results without adding candidates", async () => {
  await withSourcesServer(
    async (running) => {
      const response = await fetch(`${running.url}/api/sources/search`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ query: "牧神记", platform: "bilibili", limit: 3 }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results[0].title, "牧神记 EP01");
      assert.equal(body.results[0].url, "https://www.bilibili.com/video/BV1abc");
      assert.equal(body.results[0].viewCount, 12000);
      assert.deepEqual((await (await fetch(`${running.url}/api/sources`)).json()).sources, []);
    },
    {
      extractor_key: "BiliBili",
      id: "BV1abc",
      webpage_url: "https://www.bilibili.com/video/BV1abc",
      title: "牧神记 EP01",
      uploader: "Donghua Channel",
      duration: 1440,
      view_count: 12000,
    },
  );
});

test("reading a candidate that does not exist is a 404, not an empty object", async () => {
  await withSourcesServer(async (running) => {
    const response = await fetch(`${running.url}/api/sources/youtube-missing`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "source-missing");
  });
});

test("the rights route records a declaration and refuses a value it does not recognise", async () => {
  await withSourcesServer(async (running) => {
    await seedCandidate(sampleCandidate("youtube-abc"));

    const bad = await fetch(`${running.url}/api/sources/youtube-abc`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: running.url },
      body: JSON.stringify({ rights: "whatever" }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "source-rights-invalid");

    const good = await fetch(`${running.url}/api/sources/youtube-abc`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: running.url },
      body: JSON.stringify({ rights: "third-party-fair-use", rightsNote: "Review commentary." }),
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).candidate.rights, "third-party-fair-use");
  });
});

test("no route takes an executable path or process arguments from a request body", async () => {
  // Read before any test changes the working directory; a path plus arguments
  // accepted over HTTP would make a same-origin POST arbitrary code execution.
  const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(!/body\.(ytDlpPath|ytDlpArgs|prefixArgs|ffmpegPath|ffprobePath|executablePath)/.test(source));
});

test("downloading is refused until rights are declared", async () => {
  await withSourcesServer(async (running) => {
    await seedCandidate(sampleCandidate("youtube-abc"));

    const response = await fetch(`${running.url}/api/sources/youtube-abc/download`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: "{}",
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /rights/);
  });
});

test("deleting a source is refused while one of its jobs is running, then allowed after cancelling", async () => {
  await withSourcesServer(async (running) => {
    await seedCandidate({ ...sampleCandidate("youtube-abc"), rights: "own", rightsNote: "Mine." });
    const hanging = await makeFakeExecutable("setInterval(() => {}, 1000);");
    await writeStudioConfig({ sources: { ytDlpPath: process.execPath, ytDlpArgs: [hanging] } });

    const started = await fetch(`${running.url}/api/sources/youtube-abc/download`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: "{}",
    });
    assert.equal(started.status, 202);
    const jobId = (await started.json()).job.id;

    const refused = await fetch(`${running.url}/api/sources/youtube-abc`, {
      method: "DELETE",
      headers: { origin: running.url },
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "source-job-running");

    const cancelled = await fetch(`${running.url}/api/sources/youtube-abc/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: JSON.stringify({ jobId }),
    });
    assert.equal(cancelled.status, 200);

    const deleted = await fetch(`${running.url}/api/sources/youtube-abc`, {
      method: "DELETE",
      headers: { origin: running.url },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await (await fetch(`${running.url}/api/sources`)).json()).sources, []);
  });
});

test("static serving covers nested module files under src/web", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-static-"));
  try {
    await mkdir(join(root, "src", "web", "lib"), { recursive: true });
    await writeFile(join(root, "src", "web", "lib", "sample.js"), "export const ok = true;\n");

    const running = await startStudioServer(createStudioServer({ staticRoot: root }), { port: 0 });
    try {
      const hit = await fetch(`${running.url}/lib/sample.js`);
      assert.equal(hit.status, 200);
      assert.match(hit.headers.get("content-type") ?? "", /text\/javascript/);
      assert.equal(await hit.text(), "export const ok = true;\n");

      const miss = await fetch(`${running.url}/lib/missing.js`);
      assert.equal(miss.status, 404);

      const api = await fetch(`${running.url}/api/unknown-route`);
      assert.equal(api.status, 404);
    } finally {
      await running.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
