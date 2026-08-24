# Shared Production Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, validated `ProductionProject` artifact plus Review and Audio Story adapters without changing the current UI or renderers.

**Architecture:** Keep workflow-specific artifacts as the source of truth for now. Pure adapters convert explicit workflow inputs into a shared production contract; a small filesystem store persists that contract under `workspace/production/`. Shared Edit/Render/Publish migration is intentionally deferred.

**Tech Stack:** TypeScript, Node.js 22+, native `node --test`, local filesystem, existing SHA-256 helper pattern.

**Spec:** `docs/superpowers/specs/2026-08-24-production-contract-design.md`

## Global Constraints

- Do not modify `src/web`, FFmpeg render code, Story Factory pipeline stages, or existing project-state approval behavior.
- Do not add npm dependencies.
- Contract files use relative paths only; reject absolute paths and traversal segments.
- Contract version is exactly `1`; unsupported versions fail clearly.
- `rightsStatus` is provenance and never replaces existing copyright or asset approval gates.
- Every production function added in this plan has a test written and observed failing before implementation.
- Generated contract artifacts remain under ignored `projects/<id>/workspace/production/`.

## File map

- Create `src/production/types.ts`: versioned contract and adapter input types.
- Create `src/production/validate.ts`: pure structural, path, timeline, and asset-reference validation.
- Create `src/production/adapters.ts`: pure Review and Audio Story normalization.
- Create `src/production/store.ts`: load/save the persisted contract artifact.
- Create `tests/production-contract.test.ts`: contract, validation, adapter, hash, and persistence tests.

### Task 1: Define the ProductionProject contract and validator

**Files:**
- Create: `src/production/types.ts`
- Create: `src/production/validate.ts`
- Test: `tests/production-contract.test.ts`

**Interfaces:**

`src/production/types.ts` exports:

```ts
export type ProductionWorkflowType = "review-recap" | "audio-story" | "subtitle-render" | "licensed-source";
export type ProductionFormat = "shorts" | "longform";
export type ProductionAssetRole =
  | "source-clip" | "generated-background" | "story-image" | "cover"
  | "diagram" | "caption-card" | "music" | "logo";
export type ProductionMediaType = "image" | "video" | "audio";
export type RightsStatus = "owned" | "licensed" | "user-confirmed" | "generated" | "unknown";

export type ContentArtifact = {
  title: string;
  summary: string;
  sourceHash: string;
  scriptPath?: string;
  sourcePaths: string[];
};

export type NarrationTrack = {
  relativePath: string;
  format: "wav" | "mp3";
  durationSeconds: number;
  sourceHash: string;
};

export type CaptionTrack = {
  relativePath: string;
  format: "srt";
  cueCount: number;
  sourceHash: string;
};

export type ProductionAsset = {
  id: string;
  relativePath: string;
  mediaType: ProductionMediaType;
  role: ProductionAssetRole;
  durationSeconds?: number;
  sourceStartSeconds?: number;
  sourceHash: string;
  rightsStatus: RightsStatus;
  usagePurpose: string;
};

export type EditSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  narrationText?: string;
  assetId?: string;
  fitMode: "cover" | "contain";
  sourceStartSeconds?: number;
  muteSourceAudio: boolean;
};

export type EditTimeline = { version: 1; durationSeconds: number; segments: EditSegment[] };

export type PublishMetadata = {
  title: string;
  description: string;
  tags: string[];
  language: string;
  thumbnailAssetId?: string;
};

export type ProductionProject = {
  version: 1;
  projectId: string;
  workflowType: ProductionWorkflowType;
  format: ProductionFormat;
  content: ContentArtifact;
  narration?: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  timeline: EditTimeline;
  publish: PublishMetadata;
};
```

`validate.ts` exports:

```ts
export function validateProductionProject(project: ProductionProject): { valid: boolean; errors: string[] };
export function assertValidProductionProject(project: unknown): asserts project is ProductionProject;
```

- [ ] **Step 1: Write failing tests**

Add tests that construct a minimal valid project and assert:

```ts
test("accepts a valid version-one production project", () => {
  assert.deepEqual(validateProductionProject(validProject()), { valid: true, errors: [] });
});

test("rejects unsupported production versions", () => {
  const result = validateProductionProject({ ...validProject(), version: 2 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /unsupported production project version/i);
});

test("rejects absolute and traversal paths", () => {
  const project = validProject();
  project.narration = { ...project.narration!, relativePath: "C:/outside/audio.wav" };
  const result = validateProductionProject(project);
  assert.match(result.errors.join("; "), /relative path/i);
});

test("rejects invalid timeline ranges, overlap, missing assets, and long source clips", () => {
  const project = validProject();
  project.timeline.segments = [
    { ...project.timeline.segments[0], endSeconds: 7 },
    { id: "overlap", startSeconds: 6, endSeconds: 9, assetId: "clip-1", fitMode: "cover", muteSourceAudio: true },
  ];
  project.assets[0].mediaType = "video";
  project.assets[0].durationSeconds = 10;
  project.timeline.segments[0].sourceStartSeconds = 0;
  const result = validateProductionProject(project);
  assert.match(result.errors.join("; "), /overlap|five-second|duration/i);
});

test("allows intentional gaps and assetless generated-background segments", () => {
  const project = validProject();
  project.timeline.segments = [{ id: "gap-end", startSeconds: 5, endSeconds: 8, fitMode: "cover", muteSourceAudio: true }];
  assert.equal(validateProductionProject(project).valid, true);
});
```

Use a local `validProject()` fixture in the test file; do not add test helpers to production.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/production-contract.test.ts`

Expected: FAIL because `src/production/validate.ts` and the contract types do not exist.

- [ ] **Step 3: Implement the minimal contract and validator**

Implement explicit checks for:

- `version === 1`, recognized workflow and format values;
- non-empty project id, title, language, asset ids, and hashes;
- all `relativePath` values being non-empty, non-absolute, and free of `..` path segments;
- finite non-negative duration values;
- timeline segment `startSeconds < endSeconds <= durationSeconds`;
- no overlapping segments after sorting by start time;
- every `assetId` resolving to an asset in the project;
- video source duration never exceeding five seconds;
- unique asset ids and segment ids.

Return all discovered errors in stable order. `assertValidProductionProject` throws one readable error containing the joined errors.

- [ ] **Step 4: Run the focused test and full typecheck**

Run: `node --test tests/production-contract.test.ts && npm run typecheck`

Expected: all focused tests pass and typecheck is clean.

- [ ] **Step 5: Commit**

```powershell
git add src/production/types.ts src/production/validate.ts tests/production-contract.test.ts
git commit -m "feat: define and validate production contract"
```

### Task 2: Add deterministic adapters for Review and Audio Story

**Files:**
- Create: `src/production/adapters.ts`
- Modify: `tests/production-contract.test.ts`

**Interfaces:**

Export input types and pure functions:

```ts
export type ReviewProductionInput = {
  projectId: string;
  format: ProductionFormat;
  title: string;
  summary: string;
  scriptPath?: string;
  sourcePaths?: string[];
  scriptHash: string;
  narration?: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  timeline: EditTimeline;
  publish: PublishMetadata;
};

export type AudioStoryProductionInput = {
  projectId: string;
  format: ProductionFormat;
  title: string;
  logline: string;
  storyPath?: string;
  narration: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  segments: Array<Pick<EditSegment, "id" | "startSeconds" | "endSeconds" | "narrationText" | "assetId" | "fitMode" | "sourceStartSeconds" | "muteSourceAudio">>;
  durationSeconds: number;
  publish: PublishMetadata;
};

export function normalizeReviewProject(input: ReviewProductionInput): ProductionProject;
export function normalizeAudioStoryProject(input: AudioStoryProductionInput): ProductionProject;
```

Both functions must:

- set `version: 1` and the correct workflow type;
- create `content.sourceHash` from the supplied script hash for Review;
- create `content.sourceHash` from the story path/title/logline/narration source hash for Audio Story using stable JSON and SHA-256;
- default missing `sourcePaths` to `[]`;
- copy arrays instead of retaining mutable input references;
- validate before returning and throw on invalid output.

- [ ] **Step 1: Write failing adapter tests**

Add tests that assert:

```ts
test("normalizes review input into the shared production contract", () => {
  const result = normalizeReviewProject(reviewInput());
  assert.equal(result.workflowType, "review-recap");
  assert.equal(result.content.sourceHash, "script-hash");
  assert.equal(result.assets[0].role, "source-clip");
});

test("normalizes audio story narration and scenes into the shared timeline", () => {
  const result = normalizeAudioStoryProject(audioStoryInput());
  assert.equal(result.workflowType, "audio-story");
  assert.equal(result.content.summary, "A haunted train arrives at dawn.");
  assert.equal(result.timeline.durationSeconds, 12);
  assert.equal(result.timeline.segments[0].assetId, "scene-001");
});

test("changing audio-story inputs changes the content source hash", () => {
  const first = normalizeAudioStoryProject(audioStoryInput());
  const second = normalizeAudioStoryProject({ ...audioStoryInput(), logline: "A different train arrives." });
  assert.notEqual(first.content.sourceHash, second.content.sourceHash);
});

test("adapters reject invalid output instead of emitting an unsafe contract", () => {
  assert.throws(() => normalizeReviewProject({ ...reviewInput(), timeline: { ...reviewInput().timeline, durationSeconds: -1 } }), /invalid production project/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/production-contract.test.ts`

Expected: FAIL because the adapter exports do not exist.

- [ ] **Step 3: Implement adapters and stable hashing**

Use `createHash("sha256")` over stable JSON with explicit field order. Do not include timestamps, provider configuration, or random ids in the hash. Return fresh arrays and objects so later editor changes cannot mutate the adapter input.

- [ ] **Step 4: Run focused tests, full tests, and typecheck**

Run: `node --test tests/production-contract.test.ts && npm test && npm run typecheck`

Expected: all tests pass and typecheck is clean.

- [ ] **Step 5: Commit**

```powershell
git add src/production/adapters.ts tests/production-contract.test.ts
git commit -m "feat: normalize review and audio story production inputs"
```

### Task 3: Persist and load the normalized artifact

**Files:**
- Create: `src/production/store.ts`
- Modify: `tests/production-contract.test.ts`

**Interfaces:**

```ts
export const PRODUCTION_PROJECT_RELATIVE_PATH = "workspace/production/production-project.json";

export async function saveProductionProject(project: ProductionProject): Promise<void>;
export async function loadProductionProject(projectId: string): Promise<ProductionProject>;
export async function loadProductionProjectOrNull(projectId: string): Promise<ProductionProject | null>;
```

The store resolves paths through `resolveProjectPath(projectId, ...)`, creates the parent directory, writes JSON with a trailing newline, and uses a temporary file plus rename like `project-state.ts`. Save validates first. Load parses JSON, validates the result, and reports the artifact path when malformed. Missing files return `null` only from the `OrNull` function; the strict loader throws an `ENOENT`-style error.

- [ ] **Step 1: Write failing persistence tests**

Add a temporary project-root setup following the existing `tests/project-state.test.ts` helpers and assert:

```ts
test("saves and loads a production project under workspace production", async () => {
  const project = validProject();
  await saveProductionProject(project);
  assert.deepEqual(await loadProductionProject(project.projectId), project);
  assert.equal(await loadProductionProjectOrNull("missing-project"), null);
});

test("refuses to save invalid production projects", async () => {
  await assert.rejects(() => saveProductionProject({ ...validProject(), version: 2 } as never), /unsupported production project version/i);
});

test("refuses malformed persisted contract versions", async () => {
  const project = validProject();
  await saveProductionProject(project);
  const path = resolveProjectPath(project.projectId, PRODUCTION_PROJECT_RELATIVE_PATH);
  await writeFile(path, JSON.stringify({ ...project, version: 99 }), "utf8");
  await assert.rejects(() => loadProductionProject(project.projectId), /unsupported production project version/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/production-contract.test.ts`

Expected: FAIL because `src/production/store.ts` does not exist.

- [ ] **Step 3: Implement the filesystem store**

Use existing project-path and atomic-write conventions. Do not expose a static HTTP route for this artifact; the existing server must continue to protect project files.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: all tests pass and typecheck is clean.

- [ ] **Step 5: Commit**

```powershell
git add src/production/store.ts tests/production-contract.test.ts
git commit -m "feat: persist normalized production projects"
```

### Task 4: Document the implementation boundary and verify integration safety

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCT-PLAN.md`
- Modify: `tests/production-contract.test.ts` only if a missing compatibility assertion is discovered

- [ ] **Step 1: Add documentation tests or assertions only where behavior is observable**

Do not test Markdown text. Confirm the existing server test still proves project files are not exposed and add one contract test that saving the artifact does not create or alter `project-state.json` approvals.

- [ ] **Step 2: Update documentation**

Add a short “Production Contract” section to README and Product Plan stating:

- Review and Audio Story now have a shared normalized artifact boundary.
- The contract is persisted under `workspace/production/`.
- Current renderers remain unchanged in this slice.
- Future Edit/Render migration will consume the contract while retaining human approval gates.

- [ ] **Step 3: Run final verification**

Run:

```powershell
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, typecheck succeeds, and there is no whitespace error.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/PRODUCT-PLAN.md tests/production-contract.test.ts
git commit -m "docs: record shared production contract boundary"
```

## Explicitly deferred

- Migrating `renderDraftProject()` or `renderEditedCutProject()`.
- Migrating Story Factory render/export to the generic project state.
- Adding editor UI for `EditTimeline`.
- Adding automatic YouTube publishing.
- Adding subtitle and licensed-source adapters.
