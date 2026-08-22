import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

test("web shell exposes the complete approval pipeline", async () => {
  const html = await readFile("src/web/index.html", "utf8");

  for (const stage of ["Workflow", "Brief", "Script", "Subtitles", "ASR", "Voice", "Assets", "Copyright", "Render", "Config"]) {
    assert.match(html, new RegExp(stage));
  }
  assert.match(html, /id="workflow-board"/);
  assert.match(html, /id="open-series"/);
  assert.match(html, /id="series-panel"/);
  assert.match(html, /id="open-config"/);
  assert.match(html, /aria-live="polite"/);
});

test("web app exposes UI controls for media, ASR, captions, and render actions", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  for (const route of [
    "media",
    "media/audio",
    "asr",
    "subtitles/source",
    "subtitles/translation-prompt",
    "captions",
    "voice",
    "assets",
    "copyright-check",
    "render",
  ]) {
    assert.match(script, new RegExp(route.replace("/", "\\/")));
  }
  assert.match(script, /uploadProjectFile/);
  assert.match(script, /Build Translation Prompt/);
  assert.match(script, /Create Project/);
  assert.match(script, /Workflow type/);
  assert.match(script, /Run available tasks/);
  assert.match(script, /parallelGroup/);
  assert.match(script, /workflow.steps/);
  assert.match(script, /Series Manager/);
  assert.match(script, /Generate episode plan/);
  assert.match(script, /Generate mapping/);
  assert.match(script, /Approve mapping/);
  assert.match(script, /visual-mapping/);
  assert.match(script, /render-editor/);
  assert.match(script, /render-monitor/);
  assert.match(script, /timeline-ruler/);
  assert.match(script, /timeline-clip/);
  assert.match(script, /render-inspector/);
  assert.match(script, /selectMappingScene/);
  assert.match(script, /Perform task/);
  assert.match(script, /Create Batch Review/);
  assert.match(script, /Generate Story Arc/);
  assert.match(script, /Generate Review Script/);
  assert.match(script, /Generate Editing Plan/);
  assert.match(script, /Export Review Package/);
  assert.match(script, /Story Bible/);
  assert.match(script, /Generate Story Outline/);
  assert.match(script, /Generate Chapter/);
  assert.match(script, /Continuity Check/);
  assert.match(script, /Export Audio Story/);
  assert.match(script, /Brand Kit/);
  assert.match(script, /Save Brand Kit/);
  assert.match(script, /Upload Brand Asset/);
  assert.match(script, /Generate Thumbnail Brief/);
  assert.match(script, /uploadReviewEpisodeFile/);
  assert.match(script, /reviewProjectApiUrl/);
  assert.equal(script.includes("/api/series"), true);
  assert.match(script, /#series/);
  assert.match(script, /Copyright Check/);
  assert.match(script, /Upload Asset/);
  assert.match(script, /Uploaded assets/);
  assert.match(script, /saveAssetMetadata/);
  assert.match(script, /usagePurpose/);
  assert.match(script, /rightsConfirmed/);
  assert.match(script, /Export/);
});

test("server serves the studio shell without exposing project files", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-web-"));

  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await writeFile(join("projects", "sample-project", "brief.json"), "{}", "utf8");

    const running = await startStudioServer(createStudioServer({ staticRoot: previousCwd }), { port: 0 });
    try {
      assert.equal((await fetch(`${running.url}/`)).status, 200);
      assert.equal((await fetch(`${running.url}/projects/sample-project/brief.json`)).status, 404);
      const presets = await (await fetch(`${running.url}/api/translation-presets`)).json();
      assert.equal(presets.presets.some((preset: { language: string }) => preset.language === "vi"), true);
      const workflows = await (await fetch(`${running.url}/api/workflow-templates`)).json();
      assert.equal(workflows.templates.some((template: { type: string }) => template.type === "audio-story"), true);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("the studio offers an explicit script approval and never auto-approves gates", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /Approve Script/);
  assert.match(script, /script\/approve/);
  // The batch runner generates artifacts; approvals stay with the operator.
  assert.doesNotMatch(script, /assets: "assets\/approve"/);
  assert.match(script, /APPROVAL_STEP_IDS/);
});

test("the render stage explains which gates still block a draft", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /renderGate/);
  assert.match(script, /RENDER_GATE_LABELS/);
});
