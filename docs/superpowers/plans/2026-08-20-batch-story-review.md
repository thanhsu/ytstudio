# Batch Story Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a batch-review workflow that turns five source episodes into one long-form English story-review package with script and timestamp editing sheet.

**Architecture:** Extend the existing local-first Node/TypeScript app. Store batch review data as JSON artifacts under the existing `projects/` tree, expose HTTP API routes from `src/server.ts`, and add UI panels to the existing vanilla web studio.

**Tech Stack:** Node.js 22+, TypeScript ESM, vanilla HTML/CSS/JS, local JSON/file storage, FFmpeg, existing ASR/TTS/config services.

**Spec:** `docs/superpowers/specs/2026-08-20-batch-story-review-design.md`

## Global Constraints

- Do not build Content ID evasion, watermark removal, automated reupload, or source harvesting.
- Reuse existing project path validation, config, media ingest, ASR, SRT parsing, workflow templates, and UI patterns.
- Keep generated data under ignored `projects/`.
- No database or migration layer in the MVP.
- No automatic final render in this MVP.
- Use TDD for production behavior changes.

---

### Task 1: Review Project Data Model and API

**Files:**
- Create: `src/review-project.ts`
- Create: `tests/review-project.test.ts`
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Produces:
  - `createReviewProject(input: CreateReviewProjectInput): Promise<ReviewProject>`
  - `loadReviewProject(seriesId: string, reviewProjectId: string): Promise<ReviewProject>`
  - `listReviewProjects(seriesId: string): Promise<ReviewProject[]>`
  - `updateReviewProject(seriesId: string, reviewProjectId: string, updates: UpdateReviewProjectInput): Promise<ReviewProject>`
- Consumes:
  - `validateProjectId()` from `src/project-paths.ts`
  - `ensureProjectDir()`, `writeJson()` from `src/fs.ts`

- [ ] **Step 1: Write failing tests for create/load/list**

```ts
test("creates a batch review project under a series folder", async () => {
  const project = await createReviewProject({
    seriesId: "muc-than-ky",
    id: "ep01-05-review",
    title: "Tales of Herding Gods EP01-05",
    sourceRange: "Episodes 01-05",
    episodeNumbers: [1, 2, 3, 4, 5],
    targetLanguage: "English",
    reviewStyle: "story-review",
    targetDurationMinutes: 20,
    spoilerMode: "donghua-only",
  });

  assert.equal(project.episodes.length, 5);
  assert.equal(project.episodes[0].status, "empty");
  assert.deepEqual(await listReviewProjects("muc-than-ky").then((items) => items.map((item) => item.id)), [
    "ep01-05-review",
  ]);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test -- tests/review-project.test.ts --runInBand`

Expected: fail because `src/review-project.ts` does not exist.

- [ ] **Step 3: Implement the data model**

Create `src/review-project.ts` with normalized types, file paths under
`projects/<series-id>/review-projects/<id>/batch.json`, id validation, bounded
duration, and default episode source rows.

- [ ] **Step 4: Add API tests**

Cover:
- `POST /api/series/:seriesId/review-projects`
- `GET /api/series/:seriesId/review-projects`
- `PATCH /api/series/:seriesId/review-projects/:reviewProjectId`

- [ ] **Step 5: Implement API routes**

Add routes in `src/server.ts` using the existing `seriesMatch` branch.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git add src/review-project.ts src/server.ts tests/review-project.test.ts tests/server.test.ts
git commit -m "feat: add batch review project model"
```

Acceptance: API can create and list an `EP01-05` batch without creating one-video episode projects.

---

### Task 2: Multi-Source Import and Transcript Normalization

**Files:**
- Create: `src/transcript.ts`
- Create: `src/review-source.ts`
- Create: `tests/transcript.test.ts`
- Create: `tests/review-source.test.ts`
- Modify: `src/srt.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces:
  - `parseSubtitleToTranscript(input: ParseSubtitleInput): TranscriptSegment[]`
  - `importReviewEpisodeSubtitle(seriesId, reviewProjectId, episodeNumber, sourcePath)`
  - `importReviewEpisodeMedia(seriesId, reviewProjectId, episodeNumber, sourcePath)`
- Consumes:
  - existing `parseSrt()`
  - existing `importMedia()` logic patterns

- [ ] **Step 1: Write failing tests for SRT/VTT/ASS normalization**

Assert that all formats produce `TranscriptSegment[]` with `startMs`, `endMs`,
`cueId`, `episode`, and text.

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test -- tests/transcript.test.ts --runInBand`

- [ ] **Step 3: Implement transcript parser**

Support:
- SRT through existing parser
- VTT by skipping `WEBVTT` header and accepting `.` millisecond timestamps
- ASS by parsing `[Events]` `Dialogue:` lines with format indexes

- [ ] **Step 4: Write failing tests for episode source import**

Assert importing episode 3 subtitle writes
`review-projects/<id>/sources/ep003/source.srt` and
`review-projects/<id>/sources/ep003/transcript.json`, and updates
`batch.json`.

- [ ] **Step 5: Implement source import**

Copy media/subtitle into the review project source folder and update the
matching `EpisodeSource` status to `source-ready` or `transcript-ready`.

- [ ] **Step 6: Add API routes**

Add multipart routes:
- `POST /api/series/:seriesId/review-projects/:reviewProjectId/episodes/:episodeNumber/media`
- `POST /api/series/:seriesId/review-projects/:reviewProjectId/episodes/:episodeNumber/subtitle`

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git add src/transcript.ts src/review-source.ts src/srt.ts src/server.ts tests/transcript.test.ts tests/review-source.test.ts
git commit -m "feat: import batch review episode sources"
```

Acceptance: a batch can store five subtitles and produce normalized transcript JSON for each.

---

### Task 3: Scene Map and Episode Preprocessing Jobs

**Files:**
- Create: `src/scene-map.ts`
- Create: `src/review-jobs.ts`
- Create: `tests/scene-map.test.ts`
- Create: `tests/review-jobs.test.ts`
- Modify: `src/jobs.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces:
  - `buildSceneMap(input: TranscriptSegment[], options): Scene[]`
  - `startReviewJob(scope, taskKind, operation): Promise<JobRecord>`
- Consumes:
  - existing `ProjectJobManager`

- [ ] **Step 1: Write failing scene grouping tests**

Test that transcript gaps larger than a threshold start a new scene, scene ids
are `EP03-SC001`, and timestamps cover source cues.

- [ ] **Step 2: Implement scene grouping**

Group transcript segments by time gap and target scene length. Compute
dialogue, cue ids, empty characters, empty keyframes, and importance from cue
count until AI scoring exists.

- [ ] **Step 3: Write failing job idempotency tests**

Assert rerunning a completed scene-map job with the same idempotency key returns
the stored artifact instead of running the operation twice.

- [ ] **Step 4: Extend jobs carefully**

Add optional `scopeId`, `taskKind`, `episodeNumber`, and `idempotencyKey` while
preserving existing project job behavior.

- [ ] **Step 5: Add API route for preprocess**

Add:
- `POST /api/series/:seriesId/review-projects/:reviewProjectId/episodes/:episodeNumber/scene-map`

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git add src/scene-map.ts src/review-jobs.ts src/jobs.ts src/server.ts tests/scene-map.test.ts tests/review-jobs.test.ts
git commit -m "feat: build batch episode scene maps"
```

Acceptance: each episode can produce `scenes.json`; reruns are idempotent.

---

### Task 4: Episode Analysis and Story Arc

**Files:**
- Create: `src/ai-json.ts`
- Create: `src/episode-analysis.ts`
- Create: `src/story-arc.ts`
- Create: `tests/ai-json.test.ts`
- Create: `tests/episode-analysis.test.ts`
- Create: `tests/story-arc.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Produces:
  - `analyzeEpisode(input: AnalyzeEpisodeInput): EpisodeAnalysis`
  - `mergeStoryArc(input: MergeStoryArcInput): StoryArc`
  - `validateSceneReferences(sceneIds, sceneMap)`
- Consumes:
  - `Scene[]`
  - `ReviewProject`

- [ ] **Step 1: Write failing tests for scene reference validation**

Unknown scene ids must reject analysis/story outputs.

- [ ] **Step 2: Implement structured output helpers**

Add JSON parsing, required field validation, and scene-reference validation.

- [ ] **Step 3: Write failing episode analysis tests**

Use fixture scenes and assert deterministic dry-run analysis includes summary,
keyEvents, recommendedScenes, omittedScenes, and endingHook.

- [ ] **Step 4: Implement dry-run analysis provider**

Create deterministic local provider first. Keep paid/cloud model hooks behind
config for later.

- [ ] **Step 5: Write failing story arc tests**

Assert five episode analyses merge into hook/setup/risingAction/climax/
resolution/nextBatchHook and carry omitted scenes.

- [ ] **Step 6: Implement story merge**

Dry-run merge uses event importance and episode order. It filters repeated or
omitted scenes by reason.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git add src/ai-json.ts src/episode-analysis.ts src/story-arc.ts src/config.ts tests/ai-json.test.ts tests/episode-analysis.test.ts tests/story-arc.test.ts
git commit -m "feat: analyze batch episodes and merge story arcs"
```

Acceptance: batch analysis and story arc generation work without API keys.

---

### Task 5: Review Script, Editing Plan, and Exports

**Files:**
- Create: `src/review-script.ts`
- Create: `src/editing-plan.ts`
- Create: `src/export-package.ts`
- Create: `tests/review-script.test.ts`
- Create: `tests/editing-plan.test.ts`
- Create: `tests/export-package.test.ts`
- Modify: `src/captions.ts` if reusable SRT helpers are needed

**Interfaces:**
- Produces:
  - `generateReviewScript(input): ReviewScript`
  - `regenerateScriptSegment(input): ScriptSegment`
  - `buildEditingPlan(input): EditingPlan`
  - `exportReviewPackage(input): ReviewExport`

- [ ] **Step 1: Write failing script generation tests**

Assert 70/20/10 ratio metadata, 18-25 minute budget, and every segment has at
least one valid source scene.

- [ ] **Step 2: Implement review script generation**

Use dry-run section generator first. Store both JSON and Markdown voice-over
script.

- [ ] **Step 3: Write failing regenerate tests**

Regenerating `SEG-003` updates only that segment and increments `revision`.

- [ ] **Step 4: Implement segment regeneration**

Validate requested section and preserve existing unaffected segments.

- [ ] **Step 5: Write failing editing plan tests**

Assert timestamps are resolved from stored scene maps, not copied from model
text.

- [ ] **Step 6: Implement editing plan**

Map each segment scene to an editing item with asset type and instruction.

- [ ] **Step 7: Write failing export tests**

Assert creation of:
- `voice-over-script.md`
- `review-script.json`
- `editing-plan.json`
- `editing-sheet.csv`
- `voice-over.srt`
- `youtube-metadata.json`

- [ ] **Step 8: Implement exporters**

Use existing caption timing approach for voice-over SRT estimate.

- [ ] **Step 9: Verify and commit**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git add src/review-script.ts src/editing-plan.ts src/export-package.ts src/captions.ts tests/review-script.test.ts tests/editing-plan.test.ts tests/export-package.test.ts
git commit -m "feat: generate batch review scripts and editing sheets"
```

Acceptance: a batch produces all MVP output files without final render.

---

### Task 6: Batch Review UI

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `tests/web.test.ts`

**Interfaces:**
- Consumes all new API routes and outputs from Tasks 1-5.

- [ ] **Step 1: Write failing web shell tests**

Assert the UI includes `Batch Review`, `Create Batch`, `Import Sources`,
`Analyze`, `Story Arc`, `Review Script`, `Editing Sheet`, and `Regenerate
section`.

- [ ] **Step 2: Add Batch Review entry point**

Add a button/panel in Series Manager. Keep existing project sidebar behavior.

- [ ] **Step 3: Add source table**

Show five episode rows with video/subtitle upload controls and preprocess
status.

- [ ] **Step 4: Add analysis and story panels**

Show run buttons, progress/status, and stored summaries.

- [ ] **Step 5: Add script section editor**

Render script segments as editable sections with regenerate buttons.

- [ ] **Step 6: Add editing sheet and export panel**

Show timestamp table and file links for JSON/CSV/SRT/metadata.

- [ ] **Step 7: Verify browser and tests**

Run:

```powershell
npm test -- --runInBand
npm run typecheck
npm run studio
```

Capture a screenshot of `/#series` and the new batch panel.

- [ ] **Step 8: Commit**

```powershell
git add src/web/index.html src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: add batch review studio UI"
```

Acceptance: user can manage the batch workflow from UI without CLI.

---

## Final Verification

Run:

```powershell
npm test -- --runInBand
npm run typecheck
git status --short
```

Manual smoke:

1. Start studio.
2. Open Series Manager.
3. Create `Tales of Herding Gods`.
4. Create batch `EP01-05`.
5. Import five fixture subtitles.
6. Generate scene maps, episode analyses, story arc, script, editing plan, and exports.
7. Confirm output files exist and editing plan scene ids resolve to real timestamps.

## Plan Self-Review

- Spec coverage: all MVP requirements map to Tasks 1-6.
- Context and spoiler risks: covered in Task 4 and config.
- Timestamp risk: Task 5 resolves timestamps from scene maps.
- UI-only requirement: Task 6 exposes the workflow in the browser.
- No final render: explicitly excluded from MVP acceptance.
