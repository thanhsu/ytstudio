# Hyperframes Story Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Hyperframes render engine for AI Audio Story Factory videos, with audio-derived visual prompts and unchanged export/publish compatibility.

**Architecture:** Keep FFmpeg as the default renderer. Add a pure audio-to-visual-cues artifact, a pure Hyperframes composition generator, and a small CLI adapter that writes `workspace/render/hyperframes/` then returns the same render artifact contract plus additive hash/engine fields.

**Tech Stack:** Node >=22.6, TypeScript, vanilla JS UI, `node --test`, pinned `hyperframes@0.8.13`, existing `runProcess`, existing JSON artifact store.

**Spec:** `docs/superpowers/specs/2026-08-25-hyperframes-story-render-design.md`

## Global Constraints

- Keep the app local-first; no Hyperframes cloud or AWS Lambda rendering.
- Keep FFmpeg as default render engine and fallback configuration.
- Hyperframes uses FFmpeg internally and is an approved exception to the project rule "Use FFmpeg for rendering".
- Do not add copyright bypass, watermark removal, Content ID evasion, mass reupload, or source-harvesting automation.
- Hyperframes must not run before media approval.
- Final approval must be invalidated when render engine or output MP4 bytes change.
- HTTP requests must never accept executable paths or arbitrary command args.
- All story-derived text written into HTML must be escaped.
- Use generated project output folders under ignored story workspaces.

---

## File Structure

- Modify `package.json` and `package-lock.json` to pin `hyperframes@0.8.13` as a dev dependency.
- Modify `src/config.ts` for render engine config, defaults, normalization, and exported type.
- Modify `src/story-factory/types.ts` for `VisualPromptArtifact`, render engine names, and additive render artifact fields if the existing type lives there.
- Create `src/story-factory/visual-prompts.ts` for deterministic cue generation.
- Create `src/story-factory/hyperframes-composition.ts` for HTML, frame notes, manifest, and escaping.
- Create `src/story-factory/hyperframes-renderer.ts` for workspace writing, CLI execution, timeout, and output verification.
- Modify `src/story-factory/render-story.ts` only where shared render dispatch/types belong; preserve existing FFmpeg functions.
- Modify `src/story-factory/pipeline.ts` to generate visual prompts for Hyperframes, dispatch render engine, compute `outputSha256`, and write additive render artifact fields.
- Modify `src/web/screens/config.js` and `src/web/screens/story-factory.js` for engine config and Video tab status.
- Modify tests under `tests/` with focused unit and route/UI checks.
- Add an implementation report after verification at `docs/implementation-reports/2026-08-25-hyperframes-story-render.md`.

---

### Task 0: Hyperframes Runtime Preflight

**Files:**
- Modify: `docs/implementation-reports/2026-08-25-hyperframes-story-render.md` only if the implementation report already exists; otherwise record findings in Task 4 notes before code.
- Test: manual command output captured in the implementation report.

**Interfaces:**
- Produces: confirmed Hyperframes CLI output path for `hyperframes@0.8.13`
- Produces: confirmed `runProcess` abort behavior for a direct child process

- [ ] **Step 1: Verify package shape before implementation**

Run:

```bash
npm view hyperframes@0.8.13 version bin --json
```

Expected:

```json
{
  "version": "0.8.13",
  "bin": {
    "hyperframes": "bin/hyperframes.mjs"
  }
}
```

- [ ] **Step 2: Inspect `runProcess` abort wiring**

Read `src/process.ts` and confirm `spawn()` receives the provided `AbortSignal`:

```ts
const child = spawn(command, args, {
  signal: options.signal,
});
```

If `signal` is absent, add a small test and implementation in Task 4 before relying on render timeouts.

- [ ] **Step 3: Confirm abort leaves no direct child process behind**

In Task 4's failing test, the fake child should write its PID to a file, hang, then the test should abort and assert `process.kill(pid, 0)` fails after a short delay. This proves timeout does not only reject a promise while leaving a direct child running.

- [ ] **Step 4: Confirm real Hyperframes output path**

After Task 1 installs `hyperframes@0.8.13` but before implementing Task 4, create a temporary minimal composition outside `projects/` and run the pinned CLI through `node ./node_modules/hyperframes/bin/hyperframes.mjs render`.

Record the output directory and filename. Use that confirmed value in `hyperframes-renderer.ts` tests and implementation instead of assuming `dist/story.mp4`.

---

### Task 1: Render Config And Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `type StoryRenderEngine = "ffmpeg" | "hyperframes"`
- Produces: `StudioConfig["render"].storyEngine`
- Produces: `StudioConfig["render"].hyperframesCommand`
- Produces: `StudioConfig["render"].hyperframesArgs`
- Produces: `StudioConfig["render"].hyperframesTimeoutMinutes`

- [ ] **Step 1: Write failing config tests**

Add tests that assert defaults, normalization, and malformed fallback:

```ts
test("render config defaults to ffmpeg and pinned local Hyperframes CLI", async () => {
  const config = await loadStudioConfig(missingPath);
  assert.equal(config.render.storyEngine, "ffmpeg");
  assert.equal(config.render.hyperframesCommand, "node");
  assert.deepEqual(config.render.hyperframesArgs, ["./node_modules/hyperframes/bin/hyperframes.mjs"]);
  assert.equal(config.render.hyperframesTimeoutMinutes, 90);
});

test("render config accepts hyperframes and normalizes malformed values", async () => {
  await writeFile(path, JSON.stringify({
    render: {
      storyEngine: "hyperframes",
      hyperframesCommand: "node",
      hyperframesArgs: ["./node_modules/hyperframes/bin/hyperframes.mjs"],
      hyperframesTimeoutMinutes: 15,
    },
  }), "utf8");
  const config = await loadStudioConfig(path);
  assert.equal(config.render.storyEngine, "hyperframes");
  assert.deepEqual(config.render.hyperframesArgs, ["./node_modules/hyperframes/bin/hyperframes.mjs"]);
  assert.equal(config.render.hyperframesTimeoutMinutes, 15);

  await writeFile(path, JSON.stringify({
    render: { storyEngine: "bad", hyperframesArgs: "npx hyperframes", hyperframesTimeoutMinutes: -1 },
  }), "utf8");
  const repaired = await loadStudioConfig(path);
  assert.equal(repaired.render.storyEngine, "ffmpeg");
  assert.deepEqual(repaired.render.hyperframesArgs, ["./node_modules/hyperframes/bin/hyperframes.mjs"]);
  assert.equal(repaired.render.hyperframesTimeoutMinutes, 90);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/config.test.ts`

Expected: fails because the new render config fields do not exist yet.

- [ ] **Step 3: Add the pinned dependency**

Run: `npm install --save-dev hyperframes@0.8.13`

Verify `package.json` has:

```json
"devDependencies": {
  "hyperframes": "^0.8.13"
}
```

- [ ] **Step 4: Implement config fields**

In `src/config.ts`, add:

```ts
export const STORY_RENDER_ENGINES = ["ffmpeg", "hyperframes"] as const;
export type StoryRenderEngine = (typeof STORY_RENDER_ENGINES)[number];
```

Extend `StudioConfig.render`, `DEFAULT_STUDIO_CONFIG.render`, and `normalizeStudioConfig()`:

```ts
storyEngine: enumValue(candidate.render?.storyEngine, STORY_RENDER_ENGINES, DEFAULT_STUDIO_CONFIG.render.storyEngine),
hyperframesCommand: stringValue(candidate.render?.hyperframesCommand, DEFAULT_STUDIO_CONFIG.render.hyperframesCommand),
hyperframesArgs: stringArrayValue(candidate.render?.hyperframesArgs, DEFAULT_STUDIO_CONFIG.render.hyperframesArgs),
hyperframesTimeoutMinutes: rangeValue(
  candidate.render?.hyperframesTimeoutMinutes,
  DEFAULT_STUDIO_CONFIG.render.hyperframesTimeoutMinutes,
  1,
  360,
),
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/config.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.ts tests/config.test.ts
git commit -m "feat: add Hyperframes render config"
```

---

### Task 2: Audio-Derived Visual Prompt Artifact

**Files:**
- Modify: `src/story-factory/types.ts`
- Create: `src/story-factory/visual-prompts.ts`
- Test: `tests/story-visual-prompts.test.ts`

**Interfaces:**
- Consumes: scenes with `sceneId`, `startSeconds`, `endSeconds`
- Consumes: approved text or caption text
- Produces: `buildVisualPromptArtifact(input): VisualPromptArtifact`
- Produces: `buildVisualPromptSourceHash(input): string`
- Produces: `VisualPromptArtifact.cues[]`

- [ ] **Step 1: Write failing visual prompt tests**

```ts
test("buildVisualPromptArtifact creates one cue per scene from source text", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 30,
    text: "The door opened slowly. A cold voice whispered from the hallway.",
    scenes: [
      { sceneId: "SC-001", startSeconds: 0, endSeconds: 10 },
      { sceneId: "SC-002", startSeconds: 10, endSeconds: 30 },
    ],
  });
  assert.equal(artifact.version, 1);
  assert.equal(artifact.sourceHash, "abc");
  assert.equal(artifact.cues.length, 2);
  assert.equal(artifact.cues[0].sceneId, "SC-001");
  assert.ok(artifact.cues[0].visualPrompt.includes("door"));
  assert.ok(["mysterious", "tense", "calm", "reveal", "action"].includes(artifact.cues[0].mood));
});

test("overlay text only uses words present in the source text", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 8,
    text: "Never open the red door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
  });
  const sourceWords = new Set("never open the red door".split(" "));
  for (const word of artifact.cues[0].overlayText.toLowerCase().split(/\s+/)) {
    assert.equal(sourceWords.has(word), true);
  }
});

test("cue timing is clamped to narration duration", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 12,
    text: "A short scene",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 99 }],
  });
  assert.equal(artifact.cues[0].endSeconds, 12);
});

test("source hash changes when approved text or scene timing changes", () => {
  const first = buildVisualPromptSourceHash({
    naturalizedText: "Never open the red door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
    ttsChunks: [{ index: 0, startSeconds: 0, endSeconds: 8 }],
    captions: [{ startSeconds: 0, endSeconds: 8, text: "Never open the red door" }],
  });
  const second = buildVisualPromptSourceHash({
    naturalizedText: "Never open the blue door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
    ttsChunks: [{ index: 0, startSeconds: 0, endSeconds: 8 }],
    captions: [{ startSeconds: 0, endSeconds: 8, text: "Never open the red door" }],
  });
  assert.notEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/story-visual-prompts.test.ts`

Expected: fails because the module does not exist.

- [ ] **Step 3: Add types**

Add to `src/story-factory/types.ts`:

```ts
export type VisualPromptMood = "calm" | "tense" | "mysterious" | "reveal" | "action";
export type VisualPromptMotion = "slow-push" | "slow-pull" | "drift-left" | "drift-right" | "hold";

export type VisualPromptCue = {
  sceneId: string;
  startSeconds: number;
  endSeconds: number;
  narrationExcerpt: string;
  visualPrompt: string;
  mood: VisualPromptMood;
  captionEmphasis: string[];
  motion: VisualPromptMotion;
  overlayText: string;
};

export type VisualPromptArtifact = {
  version: 1;
  sourceHash: string;
  cues: VisualPromptCue[];
};
```

- [ ] **Step 4: Implement deterministic cue generation**

Create `src/story-factory/visual-prompts.ts` with:

```ts
const MOOD_KEYWORDS = [
  ["action", /\b(run|fight|escape|chase|attack|scream)\b/i],
  ["tense", /\b(afraid|fear|danger|blood|shadow|locked)\b/i],
  ["mysterious", /\b(whisper|door|hallway|unknown|secret|vanished)\b/i],
  ["reveal", /\b(realized|revealed|truth|saw|found)\b/i],
] as const;

export function buildVisualPromptArtifact(input: BuildVisualPromptInput): VisualPromptArtifact {
  const chunks = splitTextForScenes(input.text, input.scenes.length);
  return {
    version: 1,
    sourceHash: input.sourceHash,
    cues: input.scenes.map((scene, index) => {
      const excerpt = clampWords(chunks[index] ?? input.text, 32);
      const mood = pickMood(excerpt);
      return {
        sceneId: scene.sceneId,
        startSeconds: Math.max(0, Math.min(scene.startSeconds, input.durationSeconds)),
        endSeconds: Math.max(0, Math.min(scene.endSeconds, input.durationSeconds)),
        narrationExcerpt: excerpt,
        visualPrompt: `${mood} cinematic frame based on: ${excerpt}`,
        mood,
        captionEmphasis: pickEmphasisWords(excerpt),
        motion: pickMotion(index, mood),
        overlayText: pickOverlayText(excerpt),
      };
    }),
  };
}
```

Keep helpers pure and deterministic.

`buildVisualPromptSourceHash()` must hash canonical JSON containing naturalized text, scene timings, TTS chunk timings, and caption payload. Do not hash generated prompt text; the source hash identifies the approved audio/script inputs.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/story-visual-prompts.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/story-factory/types.ts src/story-factory/visual-prompts.ts tests/story-visual-prompts.test.ts
git commit -m "feat: derive story visual prompts from audio text"
```

---

### Task 3: Hyperframes Composition Generator

**Files:**
- Create: `src/story-factory/hyperframes-composition.ts`
- Test: `tests/hyperframes-composition.test.ts`

**Interfaces:**
- Consumes: `VisualPromptArtifact`
- Consumes: scene image paths, narration path, BGM/SFX, dimensions, duration
- Produces: `buildHyperframesComposition(input): { html: string; frame: string; manifest: object }`
- Produces: `escapeHtml(value: string): string`
- Produces: `detectHyperframesVersion(packageJsonPath): Promise<string | null>`

- [ ] **Step 1: Write failing composition tests**

```ts
test("composition writes root timing, scene clips, narration, and escaped text", () => {
  const result = buildHyperframesComposition({
    compositionId: "story",
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    narrationRelativePath: "assets/narration.m4a",
    cues: [{
      sceneId: "SC-001",
      startSeconds: 0,
      endSeconds: 12,
      narrationExcerpt: "<script>alert(1)</script>",
      visualPrompt: "mysterious hallway",
      mood: "mysterious",
      captionEmphasis: ["hallway"],
      motion: "slow-push",
      overlayText: "<hello>",
    }],
    imagesBySceneId: new Map([["SC-001", "assets/image-000.png"]]),
    bgmTracks: [],
    sfxEvents: [],
  });
  assert.match(result.html, /data-composition-id="story"/);
  assert.match(result.html, /data-width="1920"/);
  assert.match(result.html, /class="clip scene-clip motion-slow-push"/);
  assert.match(result.html, /src="assets\/narration\.m4a"/);
  assert.ok(!result.html.includes("<script>alert"));
  assert.match(result.html, /&lt;hello&gt;/);
});

test("manifest records engine and source hashes", () => {
  const result = buildHyperframesComposition(baseInput({ sourceHash: "hash-1" }));
  assert.equal(result.manifest.engine, "hyperframes");
  assert.equal(result.manifest.sourceHash, "hash-1");
  assert.equal(result.manifest.hyperframesVersion, "0.8.13");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/hyperframes-composition.test.ts`

Expected: fails because the module does not exist.

- [ ] **Step 3: Implement escaping and composition output**

Use plain string builders with explicit escaping:

```ts
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

Generate HTML with:

```html
<div id="stage" data-composition-id="story" data-start="0" data-width="1920" data-height="1080" data-duration="12">
  <img class="clip scene-clip motion-slow-push" data-start="0" data-duration="12" data-track-index="0" src="assets/image-000.png" alt="">
  <div class="clip overlay mood-mysterious" data-start="0" data-duration="12" data-track-index="1">&lt;hello&gt;</div>
  <audio data-start="0" data-duration="12" data-track-index="10" src="assets/narration.m4a"></audio>
</div>
```

Read `node_modules/hyperframes/package.json` when available and pass the version into the manifest. If the package file is absent in tests, use `null` and keep the render path working.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/hyperframes-composition.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/story-factory/hyperframes-composition.ts tests/hyperframes-composition.test.ts
git commit -m "feat: generate Hyperframes story compositions"
```

---

### Task 4: Hyperframes CLI Renderer

**Files:**
- Create: `src/story-factory/hyperframes-renderer.ts`
- Modify: `src/story-factory/render-story.ts`
- Test: `tests/hyperframes-renderer.test.ts`

**Interfaces:**
- Consumes: `renderHyperframesStoryVideo(options)`
- Produces: `HyperframesRenderResult`
- Uses: existing `runProcess(command, args, { signal, cwd })`

- [ ] **Step 1: Write failing renderer tests**

```ts
test("renderer writes composition files and invokes configured command without npx", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-render-"));
  const callsPath = join(root, "calls.jsonl");
  const fakeCli = await makeFakeExecutable(`
import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
await mkdir("dist", { recursive: true });
await writeFile(join("dist", "story.mp4"), "video-bytes");
`);
  const result = await renderHyperframesStoryVideo({
    workspacePath: root,
    command: process.execPath,
    args: [fakeCli],
    timeoutMinutes: 1,
    composition: baseComposition(),
    outputFileName: "story.mp4",
  });
  assert.equal(result.engine, "hyperframes");
  assert.match(result.videoPath, /story\.mp4$/);
  const calls = await readFile(callsPath, "utf8");
  assert.ok(!calls.includes("npx"));
});

test("renderer aborts a hung Hyperframes process", async () => {
  const pidPath = join(root, "pid.txt");
  const fakeCli = await makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(pidPath)}, String(process.pid), "utf8");
await new Promise(() => {});
`);
  await assert.rejects(() => renderHyperframesStoryVideo({
    workspacePath: root,
    command: process.execPath,
    args: [fakeCli],
    timeoutMinutes: 0.001,
    composition: baseComposition(),
    outputFileName: "story.mp4",
  }), /timed out|aborted/i);
  const pid = Number(await readFile(pidPath, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0));
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/hyperframes-renderer.test.ts`

Expected: fails because the renderer does not exist.

- [ ] **Step 3: Implement workspace writing and timeout**

Create:

```ts
export async function renderHyperframesStoryVideo(options: RenderHyperframesOptions): Promise<HyperframesRenderResult> {
  await mkdir(options.workspacePath, { recursive: true });
  await writeFile(join(options.workspacePath, "index.html"), options.composition.html, "utf8");
  await writeFile(join(options.workspacePath, "frame.md"), options.composition.frame, "utf8");
  await writeFile(join(options.workspacePath, "manifest.json"), JSON.stringify(options.composition.manifest, null, 2), "utf8");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMinutes * 60_000));
  try {
    await runProcess(options.command, [...options.args, "render"], { cwd: options.workspacePath, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  const outputPath = join(options.workspacePath, "dist", options.outputFileName);
  await stat(outputPath);
  return { engine: "hyperframes", videoPath: outputPath, compositionPath: join(options.workspacePath, "index.html") };
}
```

Use the real output path discovered in Task 0 Step 4. Keep that path centralized in this adapter so future Hyperframes CLI changes touch one file.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/hyperframes-renderer.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/story-factory/hyperframes-renderer.ts src/story-factory/render-story.ts tests/hyperframes-renderer.test.ts
git commit -m "feat: add Hyperframes story renderer adapter"
```

---

### Task 5: Pipeline Dispatch And Approval Hash Safety

**Files:**
- Modify: `src/story-factory/pipeline.ts`
- Modify: `src/story-factory/types.ts`
- Test: `tests/story-pipeline.test.ts`
- Test: `tests/story-project.test.ts`

**Interfaces:**
- Consumes: `config.render.storyEngine`
- Consumes: `buildVisualPromptArtifact`
- Consumes: `renderHyperframesStoryVideo`
- Produces: render artifact with `engine`, `outputSha256`, `compositionPath`

- [ ] **Step 1: Write failing pipeline tests**

```ts
test("hyperframes render writes engine and output hash into render artifact", async () => {
  await withStory(async ({ deps, config }) => {
    config.render.storyEngine = "hyperframes";
    config.render.hyperframesCommand = process.execPath;
    config.render.hyperframesArgs = [fakeHyperframesCli];
    config.render.hyperframesTimeoutMinutes = 1;
    await runStoryPipeline("es-horror", "story-001", { ...deps, config });
    const artifact = await readStageArtifact<RenderStageArtifact>("es-horror", "story-001", "render");
    assert.equal(artifact?.engine, "hyperframes");
    assert.match(artifact?.outputSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(artifact?.compositionPath ?? "", /workspace\/render\/hyperframes\/index\.html/);
  });
});

test("changing output hash invalidates final approval", async () => {
  await writeStageArtifact("es-horror", "story-001", "render", {
    version: 1,
    videoPath: "stories/story-001/workspace/render/story.mp4",
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    engine: "ffmpeg",
    outputSha256: "a".repeat(64),
  });
  await approveStoryStage("es-horror", "story-001", "final", "approved");
  await writeStageArtifact("es-horror", "story-001", "render", {
    version: 1,
    videoPath: "stories/story-001/workspace/render/story.mp4",
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    engine: "hyperframes",
    outputSha256: "b".repeat(64),
  });
  const story = await loadStory("es-horror", "story-001");
  assert.equal(isApprovalCurrent(story, "final"), false);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/story-pipeline.test.ts tests/story-project.test.ts`

Expected: fails because render artifact lacks the additive fields and dispatch.

- [ ] **Step 3: Implement SHA-256 helper**

Use Node crypto:

```ts
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}
```

- [ ] **Step 4: Implement render dispatch**

Inside `runRenderStage()`:

```ts
if (ctx.config.render.storyEngine === "hyperframes") {
  const sourceHash = buildVisualPromptSourceHash({
    naturalizedText: approvedText,
    scenes: scaledScenes,
    ttsChunks: tts.chunks.map((chunk) => ({ index: chunk.index, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds })),
    captions,
  });
  const visualPrompts = buildVisualPromptArtifact({ sourceHash, durationSeconds: actualDuration, text: approvedText, scenes: scaledScenes });
  await writeStageArtifact(ctx.channelId, ctx.storyId, "visual-prompts", visualPrompts);
  const composition = buildHyperframesComposition(...);
  const result = await renderHyperframesStoryVideo(...);
  const outputSha256 = await sha256File(result.videoPath);
  await writeStageArtifact(ctx.channelId, ctx.storyId, "render", {
    version: 1,
    videoPath: storyRelativePath(ctx.storyId, "workspace", "render", "story.mp4"),
    durationSeconds: actualDuration,
    width,
    height,
    engine: "hyperframes",
    outputSha256,
    compositionPath: storyRelativePath(ctx.storyId, "workspace", "render", "hyperframes", "index.html"),
  });
  return;
}
```

Keep the existing FFmpeg branch and add `engine: "ffmpeg"` plus `outputSha256` there too.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/story-pipeline.test.ts tests/story-project.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/story-factory/pipeline.ts src/story-factory/types.ts tests/story-pipeline.test.ts tests/story-project.test.ts
git commit -m "feat: dispatch Story Factory renders to Hyperframes"
```

---

### Task 6: Config UI And Story Video Tab

**Files:**
- Modify: `src/web/screens/config.js`
- Modify: `src/web/screens/story-factory.js`
- Modify: `src/web/styles.css`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `config.render.storyEngine`
- Consumes: render artifact fields `engine`, `outputSha256`, `compositionPath`
- Produces: operator-visible engine controls and render status

- [ ] **Step 1: Write failing UI tests**

```ts
test("config screen exposes Hyperframes render engine controls", async () => {
  const script = await readFile("src/web/screens/config.js", "utf8");
  for (const marker of ["storyEngine", "hyperframesCommand", "hyperframesArgs", "hyperframesTimeoutMinutes", "Hyperframes"]) {
    assert.match(script, new RegExp(marker));
  }
});

test("Story Factory video tab displays render engine and composition path", async () => {
  const script = await readFile("src/web/screens/story-factory.js", "utf8");
  for (const marker of ["compositionPath", "outputSha256", "Render engine", "Hyperframes composition"]) {
    assert.match(script, new RegExp(marker));
  }
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/web.test.ts`

Expected: fails because UI markers are missing.

- [ ] **Step 3: Add config controls**

In the render config section, add:

```js
selectField("Story render engine", "render.storyEngine", config.render.storyEngine, [
  ["ffmpeg", "FFmpeg"],
  ["hyperframes", "Hyperframes"],
]),
field("Hyperframes command", "render.hyperframesCommand", config.render.hyperframesCommand),
field("Hyperframes args", "render.hyperframesArgs", (config.render.hyperframesArgs ?? []).join(" ")),
field("Hyperframes timeout minutes", "render.hyperframesTimeoutMinutes", config.render.hyperframesTimeoutMinutes, "number"),
```

When saving, split args conservatively on whitespace only in the config UI path and show this as a known limitation in the field help/status text. The default local CLI path contains no spaces; quoted paths with spaces are intentionally deferred until a stronger parser is added.

- [ ] **Step 4: Add Video tab metadata**

In `renderStoryVideoTab()`, display:

```js
kv("Render engine", data.engine || "ffmpeg");
kv("Output SHA-256", data.outputSha256 || "not recorded");
if (data.compositionPath) {
  link("Hyperframes composition", fileUrl(channelId, data.compositionPath));
}
```

Label composition links as inspection artifacts, not playback preview.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/web.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/screens/config.js src/web/screens/story-factory.js src/web/styles.css tests/web.test.ts
git commit -m "feat: expose Hyperframes render controls in Studio"
```

---

### Task 7: Verification And Implementation Report

**Files:**
- Create: `docs/implementation-reports/2026-08-25-hyperframes-story-render.md`

**Interfaces:**
- Consumes: all earlier tasks
- Produces: verification evidence and residual risks

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test -- --runInBand
npm run typecheck
```

If `node --test` does not accept `--runInBand`, run `npm test` and record the actual command used.

- [ ] **Step 2: Run package audit-light checks**

Run:

```bash
npm ls hyperframes
git status --short
```

Expected: `hyperframes@0.8.13` installed, working tree clean except the report until committed.

- [ ] **Step 3: Optional local smoke render**

If Hyperframes can run locally without downloading unexpected large assets, create a tiny story fixture with two generated images and short local audio, then run the Hyperframes renderer. Record the command and output path. If Chrome/Hyperframes setup blocks, record the exact redacted error and keep fake CLI tests as the deterministic gate.

- [ ] **Step 4: Write implementation report**

Include:

```md
# Hyperframes Story Render Implementation Report

## Summary

Implemented optional Hyperframes rendering for Story Factory with audio-derived visual prompts, config controls, approval-safe render hashes, and FFmpeg default fallback.

## Verification

- `npm test ...`: pass/fail with count
- `npm run typecheck`: pass/fail
- `npm ls hyperframes`: version
- smoke render: result or reason skipped

## Approval Safety

Explain how `engine` and `outputSha256` change the render artifact hash and invalidate stale final approvals.

## Residual Risks

List Hyperframes runtime/Chrome setup risk and long-render performance risk.
```

- [ ] **Step 5: Commit report**

```bash
git add docs/implementation-reports/2026-08-25-hyperframes-story-render.md
git commit -m "docs: report Hyperframes story render implementation"
```

---

## Self-Review Checklist

- [ ] Every spec requirement maps to a task.
- [ ] FFmpeg remains default.
- [ ] Hyperframes never runs before media approval.
- [ ] Final approval changes when output MP4 hash changes.
- [ ] HTML text escaping has tests.
- [ ] Windows avoids direct `npx` spawn.
- [ ] Generated composition files live under ignored story workspace.
- [ ] No cloud render path or copyright bypass behavior is introduced.
