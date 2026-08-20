# Local Web Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser studio that turns an approved review script into cached voice, captions, approved visual assets, and a vertical FFmpeg draft.

**Architecture:** Keep domain logic in focused TypeScript services shared by CLI commands and a loopback-only Node HTTP server. Store authored files under each project, generated artifacts under ignored `workspace/`, use provider adapters for Piper and OpenAI, and serve a vanilla browser interface organized as an approval-gated production pipeline.

**Tech Stack:** Node.js 22+, TypeScript with native type stripping, `node:test`, Node HTTP/SSE, vanilla HTML/CSS/JavaScript, Busboy, Piper, FFmpeg/FFprobe, OpenAI Speech API through native `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-20-local-web-studio-design.md`

## Global Constraints

- Bind the web server to `127.0.0.1` by default.
- Keep all project data under `projects/<project-id>/`.
- Keep replaceable output under ignored `projects/<project-id>/workspace/`.
- Never expose or persist `OPENAI_API_KEY`.
- Never call OpenAI without an explicit per-request confirmation.
- Never fall back from Piper to OpenAI.
- Never search for or download third-party footage.
- Require current script, asset, and copyright approvals before rendering.
- Invoke child processes with executable plus argument arrays, never shell-built commands.
- Write a failing automated test before each production behavior.

## File Map

- `src/project-paths.ts`: validate project identifiers and confine resolved paths.
- `src/project-state.ts`: persist approvals, artifacts, hashes, and stale state.
- `src/narration.ts`: extract spoken text from the generated Markdown format.
- `src/captions.ts`: segment narration, allocate timing, and write SRT.
- `src/process.ts`: safely invoke and cancel external executables.
- `src/media.ts`: probe duration and dependency availability.
- `src/tts/types.ts`: provider-neutral TTS contracts and cache metadata.
- `src/tts/cache.ts`: deterministic cache keys and artifact lookup.
- `src/tts/piper.ts`: local Piper provider.
- `src/tts/openai.ts`: paid provider, estimator, and confirmation gate.
- `src/assets.ts`: asset manifest and validated media ingestion.
- `src/render.ts`: render gates, FFmpeg arguments, and render metadata.
- `src/jobs.ts`: one mutating job per project with persistent status and cancellation.
- `src/server.ts`: loopback HTTP API, static files, uploads, and SSE.
- `src/web/index.html`: application shell.
- `src/web/styles.css`: responsive production-pipeline UI.
- `src/web/app.js`: browser state, API calls, approvals, jobs, and preview.
- `tests/helpers.ts`: temporary projects and fake executable helpers.
- `tests/*.test.ts`: focused unit and integration coverage.

---

### Task 1: Safe Project Paths and State

**Files:**
- Create: `src/project-paths.ts`
- Create: `src/project-state.ts`
- Create: `tests/project-state.test.ts`
- Modify: `src/fs.ts`
- Modify: `src/types.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `validateProjectId(projectId: string): string`
- Produces: `resolveProjectPath(projectId: string, ...segments: string[]): string`
- Produces: `sha256(value: string | Buffer): string`
- Produces: `loadProjectState(projectId: string): Promise<ProjectState>`
- Produces: `approveStage(projectId: string, stage: ApprovalStage, sourceHash: string, note?: string): Promise<ProjectState>`
- Produces: `setArtifact(projectId: string, artifact: ArtifactRecord): Promise<ProjectState>`
- Produces: `derivePipelineStatus(state: ProjectState, currentHashes: SourceHashes): PipelineStatus`

- [x] **Step 1: Write path-confinement and stale-state tests**

```typescript
test("project paths reject traversal", () => {
  assert.throws(() => resolveProjectPath("../outside", "brief.json"), /project id/i);
  assert.throws(() => resolveProjectPath("valid-project", "..", "secret"), /outside projects/i);
});

test("changed script hash invalidates script-dependent artifacts", () => {
  const status = derivePipelineStatus(stateWithApprovedScript("old-hash"), {
    script: "new-hash",
    copyright: "copyright-hash",
    assets: "assets-hash",
  });
  assert.equal(status.script, "stale");
  assert.equal(status.voice, "stale");
  assert.equal(status.captions, "stale");
  assert.equal(status.render, "blocked");
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/project-state.test.ts`

Expected: FAIL because `project-paths.ts` and `project-state.ts` do not exist.

- [x] **Step 3: Implement the project contracts and persistence**

```typescript
export type ApprovalStage = "script" | "assets" | "copyright";
export type StageApproval = { sourceHash: string; approvedAt: string; note: string };
export type ArtifactKind = "voice" | "captions" | "render";
export type ArtifactRecord = {
  kind: ArtifactKind;
  sourceHash: string;
  relativePath: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
};
export type ProjectState = {
  version: 1;
  approvals: Partial<Record<ApprovalStage, StageApproval>>;
  artifacts: Partial<Record<ArtifactKind, ArtifactRecord>>;
};
```

Use `resolve(PROJECTS_DIR, projectId, ...segments)` and verify the result begins with the resolved project root plus the platform separator. Save state atomically through a temporary sibling file followed by `rename`.

- [x] **Step 4: Ignore generated project workspaces**

Add `projects/*/workspace/` while preserving the existing broad project ignore behavior. Ensure `.superpowers/` remains ignored.

- [x] **Step 5: Run focused and existing tests**

Run: `node --test tests/project-state.test.ts tests/script.test.ts tests/copyright.test.ts`

Expected: PASS.

- [x] **Step 6: Commit the task**

```bash
git add .gitignore src/fs.ts src/types.ts src/project-paths.ts src/project-state.ts tests/project-state.test.ts
git commit -m "feat: add project state and approval tracking"
```

---

### Task 2: Narration and Free Caption Timing

**Files:**
- Create: `src/narration.ts`
- Create: `src/captions.ts`
- Create: `tests/narration.test.ts`
- Create: `tests/captions.test.ts`

**Interfaces:**
- Consumes: `resolveProjectPath`, `sha256`
- Produces: `extractNarration(markdown: string): NarrationDocument`
- Produces: `buildCaptions(text: string, durationSeconds: number): CaptionCue[]`
- Produces: `toSrt(cues: CaptionCue[]): string`
- Produces: `saveCaptions(projectId: string, narration: NarrationDocument, durationSeconds: number): Promise<CaptionArtifact>`

- [x] **Step 1: Write narration extraction tests**

```typescript
test("extracts only spoken review sections", () => {
  const narration = extractNarration(`# Title

Format: shorts
Runtime target: 75 seconds

## Hook

Qin Mu breaks the usual cultivation pattern.

## Main Points

1. His confidence hides uncertainty.
`);
  assert.equal(narration.text, "Qin Mu breaks the usual cultivation pattern.\n\nHis confidence hides uncertainty.");
  assert.equal(narration.wordCount, 12);
});
```

- [x] **Step 2: Run narration test and verify RED**

Run: `node --test tests/narration.test.ts`

Expected: FAIL because `extractNarration` is missing.

- [x] **Step 3: Implement deterministic narration extraction**

Skip the title, `Format`, `Target audience`, `Language`, and `Runtime target` lines. Preserve paragraph boundaries below spoken section headings, remove ordered-list markers, normalize whitespace, and hash the final text.

- [x] **Step 4: Write caption allocation tests**

```typescript
test("caption cues cover the audio without overlap", () => {
  const cues = buildCaptions("One short sentence. A second sentence with more words.", 8);
  assert.equal(cues[0].startSeconds, 0);
  assert.equal(cues.at(-1)?.endSeconds, 8);
  assert.ok(cues.every((cue, index) => index === 0 || cue.startSeconds >= cues[index - 1].endSeconds));
  assert.ok(cues[1].endSeconds - cues[1].startSeconds > cues[0].endSeconds - cues[0].startSeconds);
});

test("writes valid SRT timestamps", () => {
  assert.match(toSrt([{ index: 1, text: "Hello", startSeconds: 0, endSeconds: 1.25 }]), /00:00:01,250/);
});
```

- [x] **Step 5: Run caption tests and verify RED**

Run: `node --test tests/captions.test.ts`

Expected: FAIL because caption functions are missing.

- [x] **Step 6: Implement phrase segmentation and proportional timing**

Split first on sentence boundaries, then split long sentences into phrases of at most 9 words. Allocate the measured duration by cue word count, enforce a 0.8-second minimum while preserving total duration, round to milliseconds, and force the final cue to end exactly at audio duration.

- [x] **Step 7: Run narration and caption tests**

Run: `node --test tests/narration.test.ts tests/captions.test.ts`

Expected: PASS.

- [x] **Step 8: Commit the task**

```bash
git add src/narration.ts src/captions.ts tests/narration.test.ts tests/captions.test.ts
git commit -m "feat: extract narration and build captions"
```

---

### Task 3: Process Runner, Media Probe, and TTS Cache

**Files:**
- Create: `src/process.ts`
- Create: `src/media.ts`
- Create: `src/tts/types.ts`
- Create: `src/tts/cache.ts`
- Create: `tests/process.test.ts`
- Create: `tests/tts-cache.test.ts`
- Create: `tests/helpers.ts`

**Interfaces:**
- Produces: `runProcess(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>`
- Produces: `probeDuration(filePath: string, ffprobePath?: string): Promise<number>`
- Produces: `checkExecutable(command: string, versionArgs: string[]): Promise<ToolStatus>`
- Produces: `TtsRequest`, `TtsArtifact`, and `TtsProvider`
- Produces: `ttsCacheKey(request: TtsRequest): string`
- Produces: `findCachedVoice(projectId: string, key: string): Promise<TtsArtifact | null>`
- Produces test helpers: `makeFakeExecutable(source: string): Promise<string>`, `makeRecordingExecutable(recordPath: string): Promise<string>`, `sampleTtsRequest(): TtsRequest`, `sampleAsset: AssetRecord`, `sampleRenderInput(): RenderInput`, `readyRenderInput(): RenderGateInput`, `stateWithApprovedScript(hash: string): ProjectState`, `createSampleProject(root: string): Promise<VideoBrief>`, and `fakeTools: WorkflowDependencies`

- [ ] **Step 1: Write process and cache tests**

```typescript
test("process runner preserves argument boundaries", async () => {
  const executable = await makeFakeExecutable(`console.log(JSON.stringify(process.argv.slice(2)))`);
  const result = await runProcess(process.execPath, [executable, "one value", "& unsafe"]);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ["one value", "& unsafe"]);
});

test("TTS cache keys change with paid request settings", () => {
  const base = sampleTtsRequest();
  assert.notEqual(ttsCacheKey(base), ttsCacheKey({ ...base, voice: "cedar" }));
  assert.notEqual(ttsCacheKey(base), ttsCacheKey({ ...base, text: `${base.text}!` }));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/process.test.ts tests/tts-cache.test.ts`

Expected: FAIL because process and cache modules are missing.

- [ ] **Step 3: Implement safe child-process execution**

Use `spawn(command, args, { shell: false })`, collect bounded stdout/stderr, support `AbortSignal`, and return exit code and duration. Reject non-zero exits with a typed `ProcessError` containing sanitized stderr.

- [ ] **Step 4: Implement media probing and cache records**

Invoke FFprobe with `-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1`. Store cache records beside generated audio and validate that the referenced audio file still exists before returning a hit.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/process.test.ts tests/tts-cache.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the task**

```bash
git add src/process.ts src/media.ts src/tts tests/process.test.ts tests/tts-cache.test.ts tests/helpers.ts
git commit -m "feat: add media process and TTS cache services"
```

---

### Task 4: Piper and Confirmed OpenAI Speech

**Files:**
- Create: `src/tts/piper.ts`
- Create: `src/tts/openai.ts`
- Create: `tests/piper.test.ts`
- Create: `tests/openai-tts.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `TtsProvider`, `runProcess`, `probeDuration`, `ttsCacheKey`
- Produces: `createPiperProvider(config: PiperConfig): TtsProvider`
- Produces: `estimateOpenAiSpeechCost(input: OpenAiCostInput): OpenAiCostEstimate`
- Produces: `createOpenAiProvider(config: OpenAiConfig): TtsProvider`

- [ ] **Step 1: Write Piper invocation tests**

```typescript
test("Piper writes a local draft without network fallback", async () => {
  const fakePiper = await makeRecordingExecutable(recordPath);
  const provider = createPiperProvider({ executable: process.execPath, prefixArgs: [fakePiper], modelPath });
  const artifact = await provider.generate(sampleTtsRequest());
  assert.equal(artifact.provider, "piper");
  assert.match(await readFile(recordPath, "utf8"), /--model/);
});
```

- [ ] **Step 2: Run Piper test and verify RED**

Run: `node --test tests/piper.test.ts`

Expected: FAIL because the Piper provider is missing.

- [ ] **Step 3: Implement Piper provider**

Pass narration through stdin and invoke Piper with `--model`, `--output_file`, and optional speaker arguments. Validate executable and model first. Return a `TtsArtifact` after probing duration; propagate local failure without any alternate provider call.

- [ ] **Step 4: Write OpenAI estimator and confirmation tests**

```typescript
test("OpenAI generation is blocked without explicit confirmation", async () => {
  const provider = createOpenAiProvider({ apiKey: "test", fetch: fakeFetch });
  await assert.rejects(() => provider.generate({ ...sampleTtsRequest(), confirmedPaidRequest: false }), /confirm/i);
  assert.equal(fakeFetch.calls.length, 0);
});

test("cost estimate includes text and projected audio", () => {
  const estimate = estimateOpenAiSpeechCost({ text: "A short narration", durationSeconds: 75 });
  assert.equal(estimate.currency, "USD");
  assert.ok(estimate.totalUsd > 0);
  assert.equal(estimate.isApproximate, true);
});
```

- [ ] **Step 5: Run OpenAI tests and verify RED**

Run: `node --test tests/openai-tts.test.ts`

Expected: FAIL because estimator and provider are missing.

- [ ] **Step 6: Implement paid provider with injected fetch**

POST to `https://api.openai.com/v1/audio/speech` with `model`, `voice`, `input`, `instructions`, `speed`, and `response_format`. Require `confirmedPaidRequest === true`, redact authorization data from errors, and write the response bytes only after a successful status. Keep pricing in an exported configuration object with input-text and output-audio rates.

- [ ] **Step 7: Document environment variables**

Add `OPENAI_API_KEY`, `PIPER_PATH`, `PIPER_MODEL_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH` with empty safe defaults and explanatory comments.

- [ ] **Step 8: Run focused tests**

Run: `node --test tests/piper.test.ts tests/openai-tts.test.ts`

Expected: PASS with no network access.

- [ ] **Step 9: Commit the task**

```bash
git add .env.example src/tts/piper.ts src/tts/openai.ts tests/piper.test.ts tests/openai-tts.test.ts
git commit -m "feat: add local and confirmed paid TTS providers"
```

---

### Task 5: Asset Manifest and Render Gates

**Files:**
- Create: `src/assets.ts`
- Create: `src/render.ts`
- Create: `tests/assets.test.ts`
- Create: `tests/render.test.ts`

**Interfaces:**
- Produces: `saveAsset(projectId: string, upload: AssetUpload): Promise<AssetRecord>`
- Produces: `validateAssetManifest(manifest: AssetManifest): AssetValidation`
- Produces: `evaluateRenderGate(input: RenderGateInput): RenderGateResult`
- Produces: `buildShortsRenderArgs(input: RenderInput): string[]`
- Produces: `renderDraft(input: RenderInput, signal?: AbortSignal): Promise<RenderArtifact>`

- [ ] **Step 1: Write asset validation tests**

```typescript
test("asset without rights confirmation blocks use", () => {
  const validation = validateAssetManifest({ version: 1, assets: [{ ...sampleAsset, rightsConfirmed: false }] });
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /rights/i);
});

test("asset destination remains inside project assets", async () => {
  await assert.rejects(() => saveAsset(projectId, { filename: "../../escape.mp4", stream, mediaType: "video" }), /filename/i);
});
```

- [ ] **Step 2: Run asset tests and verify RED**

Run: `node --test tests/assets.test.ts`

Expected: FAIL because asset services are missing.

- [ ] **Step 3: Implement streaming asset ingestion and manifest validation**

Generate stored filenames from a UUID plus validated extension. Permit `.png`, `.jpg`, `.jpeg`, `.webp`, `.mp4`, `.mov`, and `.webm`; cap configured upload size; require non-empty usage purpose and rights confirmation before an asset becomes renderable.

- [ ] **Step 4: Write render gate and command tests**

```typescript
test("render is blocked by stale copyright approval", () => {
  const result = evaluateRenderGate({ ...readyRenderInput(), copyrightApprovalCurrent: false });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("copyright-approval-stale"));
});

test("shorts render targets vertical H264 MP4", () => {
  const args = buildShortsRenderArgs(sampleRenderInput());
  assert.ok(args.includes("1080x1920"));
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.equal(args.at(-1), sampleRenderInput().outputPath);
});
```

- [ ] **Step 5: Run render tests and verify RED**

Run: `node --test tests/render.test.ts`

Expected: FAIL because render services are missing.

- [ ] **Step 6: Implement render gates and FFmpeg argument construction**

Create a generated gradient/color background, title and closing cards, voice input, SRT subtitles, and optional manifest assets. Use `-filter_complex` through an argument value, not shell quoting. Refuse unsupported long-form briefs in this MVP and record render metadata after success.

- [ ] **Step 7: Run focused tests**

Run: `node --test tests/assets.test.ts tests/render.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the task**

```bash
git add src/assets.ts src/render.ts tests/assets.test.ts tests/render.test.ts
git commit -m "feat: validate assets and render vertical drafts"
```

---

### Task 6: Persistent Project Jobs

**Files:**
- Create: `src/jobs.ts`
- Create: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `resolveProjectPath`, `runProcess`
- Produces: `ProjectJobManager`
- Produces: `start(projectId: string, kind: JobKind, operation: JobOperation): Promise<JobRecord>`
- Produces: `cancel(projectId: string, jobId: string): Promise<JobRecord>`
- Produces: `subscribe(projectId: string, listener: JobListener): () => void`

- [ ] **Step 1: Write serialization, progress, and cancellation tests**

```typescript
test("only one mutating job runs per project", async () => {
  const manager = new ProjectJobManager(tempProjectsDir);
  await manager.start("sample-project", "voice", blockingOperation);
  await assert.rejects(() => manager.start("sample-project", "render", fastOperation), /already running/i);
});

test("cancelling a job aborts its operation", async () => {
  const job = await manager.start("sample-project", "render", operationWatchingSignal);
  const cancelled = await manager.cancel("sample-project", job.id);
  assert.equal(cancelled.status, "cancelled");
});
```

- [ ] **Step 2: Run job tests and verify RED**

Run: `node --test tests/jobs.test.ts`

Expected: FAIL because `ProjectJobManager` is missing.

- [ ] **Step 3: Implement persisted job state and subscriptions**

Persist each job under `workspace/jobs/<job-id>.json`, keep an in-memory `AbortController` only while running, emit immutable snapshots to subscribers, and recover prior `running` jobs as `failed` with an interrupted-process message on startup.

- [ ] **Step 4: Run job tests**

Run: `node --test tests/jobs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the task**

```bash
git add src/jobs.ts tests/jobs.test.ts
git commit -m "feat: orchestrate persistent project jobs"
```

---

### Task 7: Loopback HTTP API and SSE

**Files:**
- Create: `src/server.ts`
- Create: `tests/server.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: all domain services from Tasks 1-6
- Produces: `createStudioServer(options: StudioServerOptions): http.Server`
- Produces routes: `GET /api/projects`, `GET /api/projects/:id`, `PUT /api/projects/:id/script`, `POST /api/projects/:id/approvals/:stage`, `POST /api/projects/:id/voice`, `POST /api/projects/:id/assets`, `POST /api/projects/:id/captions`, `POST /api/projects/:id/render`, `POST /api/projects/:id/jobs/:jobId/cancel`, `GET /api/projects/:id/events`

- [ ] **Step 1: Add Busboy dependency**

Run: `npm install busboy && npm install --save-dev @types/busboy`

Expected: `package.json` and lockfile contain pinned compatible dependencies.

- [ ] **Step 2: Write API security and workflow tests**

```typescript
test("server binds to loopback by default", async () => {
  const running = await startTestServer();
  assert.equal(running.address.address, "127.0.0.1");
});

test("paid voice route requires request confirmation", async () => {
  const response = await api.post(`/api/projects/${projectId}/voice`, {
    provider: "openai",
    confirmedPaidRequest: false,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "paid-confirmation-required");
});

test("render route reports unmet approval gates", async () => {
  const response = await api.post(`/api/projects/${projectId}/render`, {});
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).details.reasons, ["script-approval-missing", "copyright-approval-missing"]);
});
```

- [ ] **Step 3: Run server tests and verify RED**

Run: `node --test tests/server.test.ts`

Expected: FAIL because the server is missing.

- [ ] **Step 4: Implement JSON routes, upload streaming, and error envelopes**

Use `{ code, message, action?, details? }` for expected API errors. Enforce JSON and upload size limits, same-origin checks for mutating requests, and project path validation before reading any file. Use Busboy streams directly into `saveAsset`.

- [ ] **Step 5: Implement SSE job progress**

Send `event: snapshot` with serialized current job state, then `event: job` for updates. Send a comment heartbeat every 15 seconds and unsubscribe on connection close.

- [ ] **Step 6: Add server scripts and type coverage**

Add `"studio": "node src/server.ts"` and include browser JavaScript only as static files; keep TypeScript checks on `src/**/*.ts` and `tests/**/*.ts`.

- [ ] **Step 7: Run API and full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 8: Commit the task**

```bash
git add package.json package-lock.json tsconfig.json src/server.ts tests/server.test.ts
git commit -m "feat: expose local studio API and job events"
```

---

### Task 8: Production-Pipeline Web Interface

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/styles.css`
- Create: `src/web/app.js`
- Create: `tests/web.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: Task 7 HTTP routes and SSE events
- Produces: project list, stage navigation, script editor, voice controls, asset form, copyright approval, render controls, audio/video preview

- [ ] **Step 1: Write static shell and route tests**

```typescript
test("web shell exposes the complete approval pipeline", async () => {
  const html = await readFile("src/web/index.html", "utf8");
  for (const stage of ["Brief", "Script", "Voice", "Assets", "Copyright", "Render"]) {
    assert.match(html, new RegExp(stage));
  }
  assert.match(html, /aria-live="polite"/);
});

test("server serves the studio shell without exposing project files", async () => {
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/projects/sample-project/brief.json`)).status, 404);
});
```

- [ ] **Step 2: Run web tests and verify RED**

Run: `node --test tests/web.test.ts`

Expected: FAIL because the web files are missing.

- [ ] **Step 3: Implement accessible application shell and responsive styles**

Create a project sidebar, ordered stage rail, focused stage workspace, preview panel, and status/log region. Use native buttons, forms, progress elements, dialogs, audio, and video elements. Ensure keyboard focus states, readable contrast, 320px reflow, and reduced-motion support.

- [ ] **Step 4: Implement browser state and API interactions**

Keep one `appState` object with selected project, project snapshot, active stage, and current job. Render from state; use delegated events; escape project content before inserting it; connect one `EventSource` per selected project and close it when switching.

- [ ] **Step 5: Implement paid confirmation dialog**

Fetch or calculate the server-provided estimate first, show model, voice, word count, duration, and USD estimate, then send `confirmedPaidRequest: true` only from the dialog's confirm action. Never persist confirmation in browser storage.

- [ ] **Step 6: Run web and full tests**

Run: `node --test tests/web.test.ts tests/server.test.ts && npm test`

Expected: PASS.

- [ ] **Step 7: Manually inspect the local UI**

Run: `npm run studio`

Open: `http://127.0.0.1:4317`

Verify desktop and narrow layouts, stage statuses, script save/approval, disabled paid action without estimate confirmation, upload validation, SSE progress, and media previews.

- [ ] **Step 8: Commit the task**

```bash
git add src/web src/server.ts tests/web.test.ts
git commit -m "feat: add production pipeline web studio"
```

---

### Task 9: Shared CLI Workflow, Sample Smoke Test, and Docs

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Create: `tests/smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: narration, TTS, captions, render, and project-state services
- Produces CLI commands: `studio`, `generate-voice`, `prepare-captions`, `render-draft`

- [ ] **Step 1: Write CLI/service smoke test**

```typescript
test("sample project completes the free draft pipeline", async () => {
  const project = await createSampleProject(tempProjectsDir);
  await approveCurrentScript(project.id);
  const voice = await generateVoice({ projectId: project.id, provider: "piper", dependencies: fakeTools });
  const captions = await prepareCaptions(project.id, voice);
  await approveEmptyAssetManifest(project.id);
  await approveCurrentCopyrightCheck(project.id);
  const render = await renderDraft({ projectId: project.id, dependencies: fakeTools });
  assert.equal(voice.provider, "piper");
  assert.ok(captions.relativePath.endsWith(".srt"));
  assert.ok(render.relativePath.endsWith(".mp4"));
});
```

- [ ] **Step 2: Run smoke test and verify RED**

Run: `node --test tests/smoke.test.ts`

Expected: FAIL because shared workflow functions and CLI commands are not wired.

- [ ] **Step 3: Refactor CLI to call shared services**

Add:

```text
generate-voice --project <id> --provider <piper|openai> [--voice <name>] [--confirm-paid true]
prepare-captions --project <id>
render-draft --project <id>
studio [--port 4317]
```

Preserve existing commands. Print cache hits, artifact paths, render gate failures, and paid estimates clearly. Require `--confirm-paid true` for the OpenAI CLI path.

- [ ] **Step 4: Update documentation**

Document prerequisites, Piper model setup, FFmpeg setup, `.env` variables, `npm run studio`, free draft workflow, optional paid final voice, cache behavior, approval gates, asset rights requirements, and troubleshooting. Correct npm argument forwarding examples by placing `--` before command flags where required by the current environment.

- [ ] **Step 5: Run smoke and complete validation**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run sample`

Expected: all tests and type checks pass; sample files are generated without network calls.

- [ ] **Step 6: Verify a real local draft when dependencies are available**

Run: `npm run cli -- generate-voice -- --project tales-herding-gods-qin-mu --provider piper`

Run: `npm run cli -- prepare-captions -- --project tales-herding-gods-qin-mu`

Run: `npm run cli -- render-draft -- --project tales-herding-gods-qin-mu`

Expected: current cached voice, SRT, and vertical MP4 appear under `projects/tales-herding-gods-qin-mu/workspace/`. If Piper or FFmpeg is unavailable, verify the command reports the exact missing prerequisite without invoking OpenAI.

- [ ] **Step 7: Commit the task**

```bash
git add src/cli.ts README.md package.json tests/smoke.test.ts
git commit -m "feat: complete local review studio workflow"
```

---

## Final Verification

- [ ] Run `npm test` and confirm every test passes without network access.
- [ ] Run `npx tsc --noEmit` and confirm zero TypeScript errors.
- [ ] Run `npm run sample` and confirm the existing sample remains compatible.
- [ ] Start `npm run studio` and confirm it binds only to `127.0.0.1`.
- [ ] Confirm a Piper failure never produces an OpenAI request.
- [ ] Confirm an OpenAI request cannot start without request-specific confirmation.
- [ ] Confirm modifying `script.md` marks voice, captions, and render stale.
- [ ] Confirm missing rights purpose or confirmation blocks selected assets.
- [ ] Confirm blocked copyright risk prevents rendering.
- [ ] Confirm project and generated paths cannot escape `projects/`.
- [ ] Confirm generated output remains ignored by Git.
