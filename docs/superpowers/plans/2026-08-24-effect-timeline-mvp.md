# Effect Timeline MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated, per-segment visual effects to the existing `VisualMappingSegment` path and render them through FFmpeg without introducing a second timeline model.

**Architecture:** Store a complete, versioned `SegmentEffects` value on each `VisualMappingSegment` in `workspace/editing/visual-mapping.json`. Extend the existing visual-mapping PATCH route for partial effect updates and add a reset route; both use the existing mapping save/status path. Pass normalized effects from visual mapping into both renderer entry paths, include them in the render artifact source hash, and expose them in the existing Clip Inspector.

**Tech Stack:** TypeScript, Node.js built-in test runner, vanilla browser UI, FFmpeg filter graphs, local JSON project storage.

**Spec:** `docs/superpowers/specs/2026-08-24-effect-timeline-mvp-design.md`

## Global Constraints

- Keep the app local-first and store generated outputs under the ignored project workspace.
- Use TypeScript/Node and FFmpeg; do not add a frontend framework or runtime dependency for this MVP.
- Preserve human approval for visual mapping, copyright, and final render.
- Do not implement copyright detection bypass, watermark removal, automatic clip harvesting, or third-party footage reupload automation.
- Effects belong to `VisualMappingSegment`; do not modify or persist effects in `src/production/*` or `ProductionProject` in this MVP.
- Preserve existing mappings whose segments have no `effects` field by normalizing them to neutral defaults.
- Keep `libx264` as the render encoder; NVENC is out of scope.
- Use TDD: add a focused failing test before each implementation change.

## File Map

- Create: `src/visual-effects.ts` — `SegmentEffects`, defaults, normalization, partial patching, validation, summaries, and watermark eligibility.
- Modify: `src/visual-mapping.ts` — attach normalized effects to `VisualMappingSegment`, normalize loaded/generated mappings, and validate effect values and watermark references using the asset-manifest asset type.
- Modify: `src/assets.ts` — REQUIRED, not conditional: `AssetRecord` currently has only `rightsConfirmed: boolean` and no `role`. Add optional `role?: "logo"` and `rightsStatus?: "owned" | "licensed" | "generated" | "user-confirmed" | "unknown"`, normalize legacy manifests (missing `rightsStatus` becomes `"user-confirmed"` when `rightsConfirmed` is true, else `"unknown"`), and extend `AssetMetadataUpdate` plus the existing asset metadata endpoint and assets UI so an operator can mark a logo `owned`/`licensed`/`generated`. Without this, no asset can ever be watermark-eligible, because `user-confirmed` is intentionally rejected.
- Modify: `src/server.ts:947-1010` — extend the existing visual-mapping PATCH and add the reset endpoint; do not add timeline routes.
- Modify: `src/workflow.ts:305-340` — pass `segment.effects` and resolved watermark asset data into `RenderVisualSegment`.
- Modify: `src/render.ts` — generate effect filters in both render paths, preserve segment duration, and include normalized effects in the render source hash.
- Create: `src/effects-render.ts` — pure FFmpeg effect-chain and watermark-filter helpers.
- Modify: `src/web/app.js` — effects inspector, save/reset actions through visual-mapping routes, eligible-logo filtering, and non-default timeline summaries.
- Modify: `src/web/styles.css` — compact effect summary and field-level validation styling if needed.
- Modify: `tests/visual-mapping.test.ts` — defaults, patching, validation, migration, watermark eligibility, and mapping persistence behavior.
- Modify: `tests/server.test.ts` — visual-mapping PATCH/reset and stale-state behavior.
- Modify: `tests/render.test.ts` — filter chains, duration, speed, fade, and render hashing.
- Create: `tests/effects-render.test.ts` — focused pure filter-builder coverage.
- Modify: `tests/web.test.ts` — inspector controls, route usage, summaries, and eligible-logo selector behavior.

### Task 1: Add the Effects Contract to Visual Mapping

**Files:**
- Create: `src/visual-effects.ts`
- Modify: `src/visual-mapping.ts`
- Modify: `src/assets.ts` — mandatory (see File Map): add `role`/`rightsStatus` to `AssetRecord`, legacy-manifest normalization, and metadata-update support so logos can be marked rights-eligible
- Test: `tests/visual-mapping.test.ts`
- Test: `tests/assets.test.ts` — role/rights normalization and metadata updates

**Interfaces:**
- Produces `SegmentEffects` with `version: 1`, speed `0.5..2.0`, zoom `"none" | "slow-in" | "slow-out"`, transitions `"cut" | "fade"`, color controls, blur, and optional watermark.
- Produces `DEFAULT_SEGMENT_EFFECTS`.
- Produces `normalizeSegmentEffects(value: unknown): SegmentEffects`.
- Produces `patchSegmentEffects(current: SegmentEffects | undefined, patch: unknown): SegmentEffects`.
- Produces `validateSegmentEffects(value: unknown, assets?: AssetRecord[]): { valid: boolean; errors: string[] }`.
- Produces `isEligibleWatermarkAsset(asset: AssetRecord): boolean`, using the asset-manifest asset type accepted by `validateVisualMapping` rather than a production-model type.
- `VisualMappingSegment` gains `effects?: SegmentEffects`; all generated and loaded mappings expose a complete normalized value to callers.

- [ ] **Step 1: Write failing mapping-domain tests**

```ts
test("normalizes a legacy visual-mapping segment to neutral effects", () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  assert.deepEqual(mapping.segments[0].effects, DEFAULT_SEGMENT_EFFECTS);
});

test("patches nested color and watermark fields without losing defaults", () => {
  const effects = patchSegmentEffects(undefined, {
    speed: 1.25,
    color: { contrast: 1.2 },
  });
  assert.equal(effects.speed, 1.25);
  assert.equal(effects.color.contrast, 1.2);
  assert.equal(effects.color.saturation, 1);
  assert.equal(effects.transitionIn, "cut");
});

test("accepts only eligible logo assets for persistent watermarks", () => {
  assert.equal(isEligibleWatermarkAsset({ role: "logo", rightsStatus: "licensed" } as AssetRecord), true);
  assert.equal(isEligibleWatermarkAsset({ role: "source-clip", rightsStatus: "licensed" } as AssetRecord), false);
  assert.equal(isEligibleWatermarkAsset({ role: "logo", rightsStatus: "user-confirmed" } as AssetRecord), false);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/visual-mapping.test.ts --test-name-pattern="effects|watermark"`

Expected: FAIL because `VisualMappingSegment` has no effects contract or helpers.

- [ ] **Step 3: Implement defaults, normalization, partial patching, and validation**

Define the exact spec unions and ranges. Return fresh complete objects; merge nested `color` and `watermark` patches; reject unsupported versions, unknown enum values, non-finite numbers, invalid ranges, missing watermark assets, non-logo assets, and rights statuses other than `owned`, `licensed`, or `generated`. Do not silently clamp invalid persisted effect values.

- [ ] **Step 4: Normalize generated and loaded visual mappings**

Add effects to generated segments and normalize missing effects when loading or validating an existing mapping. Keep the complete normalized value in the saved mapping so PATCH and reset persist one canonical representation. Do not add a production-project adapter or touch `src/production/*`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test tests/visual-mapping.test.ts && npm run typecheck`

Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/visual-effects.ts src/visual-mapping.ts src/assets.ts tests/visual-mapping.test.ts
git commit -m "feat: add effects to visual mapping segments"
```

### Task 2: Make Visual-Mapping Persistence Canonical

**Files:**
- Modify: `src/visual-mapping.ts`
- Modify: `src/server.ts` only for shared validation/error handling needed by the existing mapping mutation path
- Test: `tests/visual-mapping.test.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Existing `saveVisualMapping(projectId, mapping)` persists complete normalized effects under `workspace/editing/visual-mapping.json`.
- Existing mapping mutation behavior remains: a successful edit sets `mapping.status = "draft"`, saves the mapping, and leaves approvals manual.
- Produces no `ProductionProject` persistence or production-store invalidation path.

- [ ] **Step 1: Write failing persistence tests**

```ts
test("save and reload preserves normalized visual-mapping effects", async () => {
  const mapping = generateVisualMapping(buildNarrationScenes(captions), []);
  mapping.segments[0].effects = patchSegmentEffects(mapping.segments[0].effects, { speed: 1.5 });
  await saveVisualMapping("sample-project", mapping);
  const reloaded = await loadVisualMapping("sample-project");
  assert.equal(reloaded?.segments[0].effects?.speed, 1.5);
  assert.equal(reloaded?.segments[0].effects?.color.saturation, 1);
});

test("mapping edits mark the mapping draft so the existing workflow gate becomes stale", async () => {
  // Use the existing visual-mapping PATCH fixture and assert the returned mapping is draft.
  const response = await patchMapping("scene-001", { effects: { speed: 1.25 } });
  assert.equal(response.mapping.status, "draft");
});
```

- [ ] **Step 2: Run the focused tests and verify the current path is incomplete**

Run: `node --test tests/visual-mapping.test.ts tests/server.test.ts --test-name-pattern="mapping|effects"`

Expected: FAIL because the current save/load path does not normalize effects and the PATCH handler does not apply an effects patch.

- [ ] **Step 3: Add canonical normalization at mapping persistence boundaries**

Ensure generation, load/validation, and save all use the same complete effects shape. Preserve unrelated visual-mapping fields and the existing `draft` status transition. Keep the existing approval and render gate flow; do not invent a separate project-state mutation API.

- [ ] **Step 4: Run focused persistence tests**

Run: `node --test tests/visual-mapping.test.ts tests/server.test.ts --test-name-pattern="mapping|effects"`

Expected: PASS for canonical save/reload and draft-state behavior.

- [ ] **Step 5: Commit**

```bash
git add src/visual-mapping.ts src/server.ts tests/visual-mapping.test.ts tests/server.test.ts
git commit -m "feat: persist normalized visual mapping effects"
```

### Task 3: Extend the Existing Visual-Mapping API

**Files:**
- Modify: `src/server.ts:967-993`
- Test: `tests/server.test.ts`

**Interfaces:**
- Existing `PATCH /api/projects/:projectId/visual-mapping/segments/:segmentId` accepts existing mapping fields plus a partial `effects` patch and returns `{ ok: true, segment, mapping }` with normalized effects.
- New `POST /api/projects/:projectId/visual-mapping/segments/:segmentId/effects/reset` replaces effects with `DEFAULT_SEGMENT_EFFECTS` and returns `{ ok: true, segment, mapping }`.
- There are no `/timeline/segments` routes.

- [ ] **Step 1: Write failing HTTP tests**

```ts
test("visual-mapping PATCH persists a partial effects patch and reset restores defaults", async () => {
  const patched = await requestJson(project.url, "PATCH", "/api/projects/sample-project/visual-mapping/segments/scene-001", {
    fitMode: "contain",
    effects: { speed: 1.25, color: { contrast: 1.2 } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.segment.effects.speed, 1.25);
  assert.equal(patched.body.segment.effects.color.contrast, 1.2);
  assert.equal(patched.body.segment.effects.color.saturation, 1);
  assert.equal(patched.body.mapping.status, "draft");

  const reset = await requestJson(project.url, "POST", "/api/projects/sample-project/visual-mapping/segments/scene-001/effects/reset", {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.segment.effects.speed, 1);
});

test("visual-mapping effects PATCH rejects invalid values and missing resources", async () => {
  assert.equal((await requestJson(project.url, "PATCH", "/api/projects/sample-project/visual-mapping/segments/scene-001", { effects: { speed: 9 } })).status, 400);
  assert.equal((await requestJson(project.url, "PATCH", "/api/projects/sample-project/visual-mapping/segments/missing", { effects: { speed: 1 } })).status, 404);
  assert.equal((await requestJson(project.url, "POST", "/api/projects/sample-project/visual-mapping/segments/missing/effects/reset", {})).status, 404);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/server.test.ts --test-name-pattern="visual-mapping.*effects|effects.*PATCH"`

Expected: FAIL because the existing PATCH ignores `effects` and the reset route is not registered.

- [ ] **Step 3: Extend the existing PATCH handler**

When `body.effects` is present, call `patchSegmentEffects(segment.effects, body.effects)`, validate against the loaded asset manifest, and assign the complete normalized value. Preserve the existing asset/fit/source/audio updates, missing-resource responses, `mapping.status = "draft"`, and `saveVisualMapping` call. Return field-specific `400` errors without leaking paths.

- [ ] **Step 4: Add the reset route beside the existing mapping PATCH route**

Match `visual-mapping/segments/:segmentId/effects/reset`, load the mapping and manifest, replace the segment effects with a fresh `DEFAULT_SEGMENT_EFFECTS`, set mapping status to draft, save, and return the same response shape. Do not add or retain alternate timeline routes.

- [ ] **Step 5: Verify stale propagation through the existing mapping path**

Assert that changing or resetting effects makes the visual mapping draft and causes the normal render gate to require mapping approval again. Do not add a production-project hash or separate invalidation mechanism.

- [ ] **Step 6: Run focused server tests**

Run: `node --test tests/server.test.ts --test-name-pattern="visual-mapping.*effects|effects.*PATCH"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: add visual mapping effects API"
```

### Task 4: Build Pure FFmpeg Effect Filters

**Files:**
- Create: `src/effects-render.ts`
- Modify: `src/render.ts` for shared types and integration points
- Test: `tests/effects-render.test.ts`
- Modify: `tests/render.test.ts`

**Interfaces:**
- Produces `buildSegmentEffectFilter(inputLabel: string, outputLabel: string, effects: SegmentEffects, dimensions: { width: number; height: number }, duration: number, mediaType: "image" | "video"): string`.
- Produces watermark overlay arguments using `AssetRecord`, fixed 24-pixel edge margins, and unique input labels/indexes.
- `buildShortsRenderArgs` and `buildSegmentArgs` consume the same effect semantics.

- [ ] **Step 1: Write failing filter tests**

```ts
test("neutral effects produce a null filter", () => {
  assert.equal(buildSegmentEffectFilter("[v0]", "[v1]", DEFAULT_SEGMENT_EFFECTS, { width: 1080, height: 1920 }, 8, "image"), "[v0]null[v1]");
});

test("grayscale multiplies saturation and supplies one effective saturation control", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", {
    ...DEFAULT_SEGMENT_EFFECTS,
    color: { brightness: 0.1, contrast: 1.2, saturation: 0.8, grayscale: 0.4 },
  }, { width: 1080, height: 1920 }, 8, "image");
  assert.match(filter, /hue=s=0\.48/);
  assert.doesNotMatch(filter, /hue=s=0\.6/);
  assert.equal((filter.match(/hue=/g) ?? []).length, 1);
});

test("fade edges are inside the segment and capped at half its duration", () => {
  const filter = buildSegmentEffectFilter("[v0]", "[v1]", {
    ...DEFAULT_SEGMENT_EFFECTS, transitionIn: "fade", transitionOut: "fade",
  }, { width: 1080, height: 1920 }, 0.6, "image");
  assert.match(filter, /fade=t=in:st=0:d=0\.3/);
  assert.match(filter, /fade=t=out:st=0\.3:d=0\.3/);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test tests/effects-render.test.ts`

Expected: FAIL because the effect filter helper does not exist.

- [ ] **Step 3: Implement deterministic visual filter generation**

Apply effects after fit/crop and before trim/concat preparation. Use one saturation control with `effectiveSaturation = saturation * (1 - grayscale)`; for `saturation: 0.8` and `grayscale: 0.4`, emit `0.48`. Add brightness/contrast, full-frame blur, and zoom filters only when non-default. Preserve labels and reject invalid effects before generating filters.

- [ ] **Step 4: Implement exact fade semantics**

`cut` emits no edge filter. `transitionIn: "fade"` fades from black within the segment; `transitionOut: "fade"` fades to black within the segment. Use a fixed renderer fade constant capped at half the segment duration. Do not overlap adjacent segments or use cross-segment transitions; applying both adjacent edge fades intentionally leaves the black interval created by the two independent fades.

- [ ] **Step 5: Implement watermark overlay generation**

Resolve the configured `assetId` from the asset manifest, require `isEligibleWatermarkAsset(asset)`, add the logo input, adjust alpha for opacity, scale relative to video width, and overlay with a fixed 24-pixel margin. Escape paths with the existing FFmpeg helpers and allocate unique input indexes.

- [ ] **Step 6: Run focused filter tests**

Run: `node --test tests/effects-render.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/effects-render.ts src/render.ts tests/effects-render.test.ts tests/render.test.ts
git commit -m "feat: generate ffmpeg filters for visual effects"
```

### Task 5: Integrate Effects Into Render Inputs and Artifact Hashing

**Files:**
- Modify: `src/workflow.ts:305-340`
- Modify: `src/render.ts`
- Modify: `tests/render.test.ts`

**Interfaces:**
- `RenderVisualSegment` carries `effects: SegmentEffects` and the resolved watermark asset data needed by the renderer.
- `buildShortsRenderArgs` applies the effect chain to mapped image/video segments.
- `buildSegmentArgs` applies the same chain for the per-segment render path before concat.
- The render artifact source hash at `src/render.ts` includes the complete normalized `effects` for every visual segment.

- [ ] **Step 1: Write failing render-input and hash tests**

```ts
test("image speed is a no-op and video speed uses a bounded source slice", () => {
  const imageArgs = buildShortsRenderArgs({ ...sampleRenderInput(), visualSegments: [{ ...imageSegment, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 2 } }] });
  assert.doesNotMatch(imageArgs.join(";"), /setpts=PTS\/2/);

  const videoArgs = buildShortsRenderArgs({ ...sampleRenderInput(), visualSegments: [{ ...videoSegment, endSeconds: 10, sourceDurationSeconds: 10, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 2 } }] });
  assert.match(videoArgs.join(";"), /-t.*5/);
  assert.match(videoArgs.join(";"), /setpts=PTS\/2/);
  assert.match(videoArgs.join(";"), /fill/);
});

test("normalized visual effects change the render artifact source hash", async () => {
  const first = await renderDraft({ ...sampleRenderInput(), visualSegments: [{ ...imageSegment, effects: DEFAULT_SEGMENT_EFFECTS }] });
  const second = await renderDraft({ ...sampleRenderInput(), visualSegments: [{ ...imageSegment, effects: { ...DEFAULT_SEGMENT_EFFECTS, blur: 4 } }] });
  assert.notEqual(first.sourceHash, second.sourceHash);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/render.test.ts --test-name-pattern="speed|hash|effect"`

Expected: FAIL because workflow drops effects, speed is not media-type-aware, and the render hash does not include effects.

- [ ] **Step 3: Pass normalized mapping effects through the workflow adapter**

In `renderDraftProject`, map each `VisualMappingSegment.effects` into `RenderVisualSegment`, defaulting legacy mappings to `DEFAULT_SEGMENT_EFFECTS`, and resolve watermark assets from the same project asset manifest after validation. Keep mapped source audio muted.

- [ ] **Step 4: Implement media-type-aware speed and source slicing**

For image segments, treat speed as a no-op and do not emit `setpts` for speed. For video segments, cap the input source slice before speed processing at `Math.min(5, segment duration, sourceDurationSeconds)`; apply `setpts=PTS/<speed>` to that bounded slice. Keep the segment’s narration allocation unchanged and fill any shortened remainder with the existing `color=c=#111827` fallback. Apply the same rules in `buildShortsRenderArgs` and `buildSegmentArgs`.

- [ ] **Step 5: Preserve exact segment duration in both render paths**

Trim and pad each processed segment to its existing narration duration. Apply fade filters within that duration, never overlap neighboring segments, and keep concat preparation stream-compatible. Test both a single-pass render and the multi-segment per-segment concat path.

- [ ] **Step 6: Add effects to the render artifact source hash**

At the existing `sha256(JSON.stringify(...))` input in `src/render.ts`, include each visual segment’s complete normalized `effects` alongside title, duration, paths, and existing segment fields. Do not create a production-project hash. Confirm that a mapping PATCH changes the next render hash through the existing visual-mapping path.

- [ ] **Step 7: Run render tests and typecheck**

Run: `node --test tests/render.test.ts tests/effects-render.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/workflow.ts src/render.ts tests/render.test.ts
git commit -m "feat: render visual mapping effects and hash them"
```

### Task 6: Add Effects Inspector and Timeline Indicators

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `tests/web.test.ts`

**Interfaces:**
- UI reads `segment.effects` and displays normalized values in the existing visual-mapping inspector.
- Save calls `PATCH /api/projects/:projectId/visual-mapping/segments/:segmentId` with a partial `effects` object.
- Reset calls `POST /api/projects/:projectId/visual-mapping/segments/:segmentId/effects/reset`.
- The watermark selector lists only client-side eligible logo assets; server validation remains authoritative.

- [ ] **Step 1: Write failing web contract tests**

```ts
test("visual mapping inspector exposes effect controls and uses the mapping PATCH/reset routes", async () => {
  const script = await readWebScripts();
  assert.match(script, /Save effects/);
  assert.match(script, /Reset effects/);
  assert.match(script, /visual-mapping\\/segments/);
  assert.match(script, /effects\\/reset/);
  assert.match(script, /transitionIn/);
  assert.match(script, /transitionOut/);
  assert.doesNotMatch(script, /timeline\\/segments/);
});

test("watermark selector filters to eligible logos and timeline shows non-default summaries", async () => {
  const script = await readWebScripts();
  assert.match(script, /role.*logo|logo.*role/);
  assert.match(script, /owned|licensed|generated/);
  assert.match(script, /effect summary|effects/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test tests/web.test.ts --test-name-pattern="effect|watermark"`

Expected: FAIL because the inspector has no effect controls or effect actions.

- [ ] **Step 3: Add normalized inspector controls**

Extend the existing mapping inspector with speed, zoom, both transitions, brightness, contrast, saturation, grayscale, blur, watermark asset, position, scale, and opacity. Populate missing legacy values from neutral defaults and use `step="any"` for fractional machine-produced values.

- [ ] **Step 4: Filter the watermark selector client-side**

Before rendering the selector, filter assets to `role: "logo"` and rights status `owned`, `licensed`, or `generated`; exclude all other roles and rights statuses. Keep the currently persisted ineligible value visible as an error rather than silently replacing it, and rely on server validation for enforcement.

- [ ] **Step 5: Add save/reset handlers through the existing mapping route**

Serialize nested color and watermark values, PATCH the selected visual-mapping segment, or POST the reset endpoint, refresh the project snapshot, and retain the selected segment. Show field-level/API validation errors and state clearly that saving does not approve mapping or rendering.

- [ ] **Step 6: Add timeline summaries and styles**

Show a compact summary only when effects differ from defaults, such as `1.25x · zoom-in · blur`. Keep the monitor a source/segment monitor and do not claim frame-accurate browser preview before a new render.

- [ ] **Step 7: Run web tests**

Run: `node --test tests/web.test.ts --test-name-pattern="effect|watermark"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: add visual mapping effects inspector"
```

### Task 7: Add Compatibility, Safety, and End-to-End Regression Coverage

**Files:**
- Modify: `tests/visual-mapping.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/render.test.ts`
- Modify: `tests/effects-render.test.ts`
- Modify: `tests/web.test.ts`

- [ ] **Step 1: Add legacy mapping regression coverage**

Load a mapping whose segments lack `effects`, assert normalization to defaults, assert neutral effects produce a `null` filter, and assert the render arguments remain unchanged in filter terms.

- [ ] **Step 2: Add combined-effect coverage**

Assert a segment combining zoom, color, grayscale, blur, watermark, and a fade produces one valid filter graph with unique labels and no duplicate input indexes. Assert grayscale uses `saturation * (1 - grayscale)` and no second saturation control.

- [ ] **Step 3: Add speed and duration safety coverage**

Assert image speed is a no-op; assert a video with a five-second source cap and speed `2.0` consumes at most five seconds before speed, produces the shorter processed slice, and fills its unchanged narration allocation with the existing fallback background. Assert fades are capped at half short segment durations and never overlap segments.

- [ ] **Step 4: Add validation and API safety coverage**

Assert NaN, Infinity, out-of-range values, unsupported versions, unknown transition values, invalid watermark role/rights, missing watermark assets, missing segments, and missing projects are rejected before FFmpeg execution. Assert both PATCH and reset set mapping status to draft and require the existing approval path again.

- [ ] **Step 5: Run the complete verification suite**

Run: `npm run typecheck && npm test`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests
git commit -m "test: cover visual mapping effects compatibility and safety"
```

### Task 8: Final Review and Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the operator workflow**

Document how to select a visual-mapping segment, edit effects, save, reset, regenerate the draft, and re-approve before final render. State that the monitor is not frame-accurate until a new draft is rendered.

- [ ] **Step 2: Document supported effect limits**

List speed `0.5..2.0`, image speed no-op behavior, five-second pre-speed video source cap, color ranges, full-frame blur, fade-from/to-black semantics, watermark rights requirements, and deferred region blur/NVENC behavior.

- [ ] **Step 3: Run final checks**

Run: `npm run typecheck && npm test`

Expected: PASS with documentation matching the implementation.

- [ ] **Step 4: Review the diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors, no generated project outputs staged, and only the intended implementation, tests, and documentation files changed.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document visual mapping effects MVP"
```

## Verification Checklist

- [ ] Legacy mappings render with neutral effects and no behavior change.
- [ ] Every effect value is range-checked before render.
- [ ] Image speed is a no-op; video speed is applied after the five-second source slice cap and fills any remainder with the existing fallback background.
- [ ] Grayscale uses `effectiveSaturation = saturation * (1 - grayscale)` in one saturation control.
- [ ] Fades are from/to black within segment duration with a fixed duration capped at half the segment; segments never overlap.
- [ ] Watermarks require eligible logo assets in both client filtering and server validation.
- [ ] Asset manifest supports `role`/`rightsStatus`, legacy manifests normalize safely, and the assets UI can mark a logo `owned`/`licensed`/`generated`.
- [ ] PATCH/reset use the visual-mapping routes and invalidate through the existing mapping approval path.
- [ ] Normalized effects are included in the render artifact source hash.
- [ ] No `src/production/*` files or `ProductionProject` persistence are part of the MVP.
- [ ] FFmpeg filter labels and input indexes remain unique.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
