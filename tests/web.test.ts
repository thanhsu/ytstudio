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
  assert.match(script, /#sources/);
  assert.match(script, /#config/);
  assert.match(script, /Copyright Check/);
  assert.match(script, /Upload Asset/);
  assert.match(script, /Uploaded assets/);
  assert.match(script, /saveAssetMetadata/);
  assert.match(script, /usagePurpose/);
  assert.match(script, /rightsConfirmed/);
  assert.match(script, /Export/);
});

test("translation stage exposes the human subtitle segment editor", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Create Edit Manifest/);
  assert.match(script, /Remove cue numbers/);
  assert.match(script, /Apply Keep\/Remove Decisions/);
  assert.match(script, /Export Clean SRT \+ CSV/);
  assert.match(script, /edit-manifest\/remove-list/);
  assert.match(script, /edit-manifest\/export/);
  assert.match(script, /Subtitle cue decisions/);
  assert.match(script, /aria-live/);
  assert.match(script, /confirm\("Replace the existing edit manifest/);
  assert.match(script, /replace: true/);
  assert.match(styles, /\.segment-editor-table/);
  assert.match(styles, /\.decision-remove/);
});

test("render stage exposes the subtitle-driven cut", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Render Cut/);
  assert.match(script, /projectApiUrl\("edit-render"\)/);
  assert.match(script, /EDIT_RENDER_GATE_LABELS/);
  assert.match(script, /source-media-missing/);
  assert.match(script, /edit-manifest-keeps-no-cues/);
  assert.match(script, /"voice", "captions", "render", "cut"/);
  assert.match(styles, /\.cut-toolbar/);
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

test("the studio follows job progress over the project event stream", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /new EventSource/);
  assert.match(script, /addEventListener\("job"/);
  assert.match(script, /ensureProjectEventStream/);
  // Slow routes answer 202 with a job, not a finished artifact.
  assert.match(script, /reportedAsJob/);
  assert.match(script, /202/);
  // The batch runner must not report background work as finished.
  assert.match(script, /running in the background/);
});

test("the script stage shows the model that produced the script and gates paid generation", async () => {
  const html = await readFile("src/web/index.html", "utf8");
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(html, /id="paid-script-dialog"/);
  assert.match(html, /id="confirm-paid-script"/);
  assert.match(script, /paidScriptDialog/);
  assert.match(script, /requestScript/);
  assert.match(script, /Script model/);
  assert.match(script, /scriptModelSummary/);
  // The label reads the persisted provenance, never the live configuration.
  assert.match(script, /snapshot\.metadata\?\.generator/);
  assert.match(script, /No script generated yet/);
  assert.doesNotMatch(script, /"Script model": `\$\{appState\.config/);
});

test("the paid script dialog is raised only for a hosted model, never for the offline template", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /function paidScriptModelConfigured/);
  assert.match(script, /appState\.config\?\.script\?\.provider === "openai-compatible"/);
  assert.match(script, /if \(!confirmedPaidRequest && paidScriptModelConfigured\(\)\)/);
  assert.match(script, /step\.id === "script" && paidScriptModelConfigured\(\)/);
  assert.doesNotMatch(script, /appState\.config\?\.script\?\.paid\)/);
});

test("number inputs holding machine-produced fractional values accept any step", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  // step defaults to "1", which makes native validation reject a fractional
  // value and silently block the form submit.
  assert.match(script, /"sourceStartSeconds", String\(segment\.sourceStartSeconds\), "number", "", "any"/);
  assert.match(script, /"sourceDurationSeconds", String\(segment\.sourceDurationSeconds\), "number", "", "any"/);
  assert.match(script, /"watermarkOpacity",[^\n]*"number", "", "any"/);
  assert.match(script, /"script\.temperature",[^\n]*"number", "", "any"/);
  // Operator-typed rather than machine-produced, but the copyright risk
  // threshold sits at about 5 seconds, so 4.5 is a realistic entry.
  assert.match(script, /"longestClipSeconds", "5", "number", "", "any"/);
});

test("the config screen lists an unrecognized script provider instead of hiding it", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /function scriptProviderOptions/);
  assert.match(script, /unrecognized — pick a valid provider/);
  assert.match(script, /scriptProviderOptions\(config\.script\.provider\)/);
});

test("the config screen exposes source search settings", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /Default source search/);
  assert.match(script, /sources\.defaultSearchPlatform/);
  assert.match(script, /Source search limit/);
  assert.match(script, /sources\.searchLimit/);
  assert.match(script, /YouTube search prefix/);
  assert.match(script, /sources\.searchPrefixes\.youtube/);
  assert.match(script, /Bilibili search prefix/);
  assert.match(script, /sources\.searchPrefixes\.bilibili/);
  assert.match(script, /TikTok search prefix/);
  assert.match(script, /sources\.searchPrefixes\.tiktok/);
  assert.match(script, /Douyin search prefix/);
  assert.match(script, /sources\.searchPrefixes\.douyin/);
});

test("the sources screen exposes paste, rights, score, download, and delete", async () => {
  const html = await readFile("src/web/index.html", "utf8");
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(html, /id="open-sources"/);
  assert.match(script, /"\/api\/sources"/);
  assert.match(script, /Add Source/);
  assert.match(script, /Score/);
  assert.match(script, /Download/);
  assert.match(script, /third-party-fair-use/);
  assert.match(script, /startSourceJob\(candidate\.id, "download"\)/);
  assert.match(script, /startSourceJob\(candidate\.id, "score"\)/);
  assert.match(script, /deleteSource\(candidate\.id/);
  assert.match(script, /Declare rights before downloading/);
  assert.match(styles, /\.source-list/);
});

test("the sources screen exposes keyword search before tracking a source", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Search Sources/);
  assert.match(script, /\/api\/sources\/search/);
  assert.match(script, /Track Source/);
  assert.match(script, /thumbnailUrl/);
  assert.match(script, /source-thumbnail/);
  assert.match(script, /sourceSearchResults/);
  assert.match(script, /source-search-results/);
  assert.match(script, /bilibili/);
  assert.match(script, /tiktok/);
  assert.match(script, /douyin/);
  assert.match(script, /URL-only unless search prefix is configured/);
  assert.match(styles, /\.source-search-results/);
  assert.match(styles, /\.source-result-card/);
  assert.match(styles, /\.source-thumbnail/);
});

test("the sources screen can filter and triage keyword search results", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Include keywords/);
  assert.match(script, /Exclude keywords/);
  assert.match(script, /Max views/);
  assert.match(script, /Hide likely official/);
  assert.match(script, /sourceSearchFilters\.query/);
  assert.match(script, /sourceSearchFilters\.platform/);
  assert.match(script, /sourceSearchFilters\.limit/);
  assert.match(script, /maxViews: Number\(values\.maxViews\) > 0 \? values\.maxViews : ""/);
  assert.match(script, /filterSourceSearchResults/);
  assert.match(script, /triageSourceSearchResult/);
  assert.match(script, /review-friendly/);
  assert.match(script, /likely official/);
  assert.match(styles, /\.source-triage/);
  assert.match(styles, /\.source-triage-risk/);
}
);

test("the sources screen exposes editable Bilibili query expansion", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Expand Bilibili\/Douyin query/);
  assert.match(script, /Expanded queries/);
  assert.match(script, /buildSourceSearchQueries/);
  assert.match(script, /牧神记/);
  assert.match(script, /Tales of Herding Gods/);
  assert.match(script, /matchedQuery/);
  assert.match(script, /dedupeSourceSearchResults/);
  assert.match(script, /Promise\.all/);
  assert.match(styles, /\.source-search-toolbar/);
  assert.match(styles, /\.source-query-preview/);
});

test("the sources screen refuses to imply that declaring rights clears a project gate", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /Declaring rights permits the download only/);
  assert.match(script, /copyright/i);
});

test("the sources screen shows why a score was given, never the number alone", async () => {
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(script, /score\.reason/);
  assert.match(script, /score\.risks/);
  assert.match(script, /score\.angle/);
});
