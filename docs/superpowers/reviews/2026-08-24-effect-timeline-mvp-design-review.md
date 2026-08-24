# Review: Effect Timeline MVP Design (2026-08-24)

Reviewed document: `docs/superpowers/specs/2026-08-24-effect-timeline-mvp-design.md`
Reviewer verdict: **data model, validation, and testing sections are solid; one
architectural premise is wrong and two renderer assumptions do not match the
current pipeline. Revise the spec before writing the implementation plan.**

## Blocking issues

### 1. Effects are attached to a model that nothing renders yet

The spec embeds `effects` in `EditSegment` (`src/production/types.ts:49`) and
adds `PATCH /api/projects/:projectId/timeline/segments/:segmentId/effects`.
But the live editing and rendering path does not use the production contract:

- The Clip Inspector edits **visual mapping segments**, not `EditSegment`
  (`src/web/app.js:1745`, `src/web/app.js:1791`), saved via
  `PATCH /api/projects/:projectId/visual-mapping/segments/:id`
  (`src/server.ts:967`).
- Render input is built from visual mapping, and the render artifact hash is
  derived from `visualSegments` (`src/render.ts:193-201`).
- `ProductionProject` is a standalone contract persisted at
  `workspace/production/production-project.json` (`src/production/store.ts:7`).
  Neither `src/server.ts` nor `src/render.ts` imports anything from
  `src/production/`.

Therefore the claim "Saving effects updates the production project hash and
invalidates dependent artifacts using the existing project state invalidation
path" has no existing mechanism behind it. Acceptance criteria 2 and 3 cannot
be implemented as written.

**Required fix — choose one explicitly in the spec:**

- (a) Add a prerequisite work item that wires the production contract into the
  editor and render path first (large; must be declared in scope), **or**
- (b) Attach effects to `VisualMappingSegment` — the model that is actually
  edited and rendered today — and mirror into the production contract later.

### 2. Dissolve transitions are not representable in the current pipeline

Multi-segment renders pre-render each segment and concatenate with the concat
demuxer using `-c copy` (`src/render.ts:218-234`). A cross-fade needs frame
overlap, `xfade`, and a full re-encode of the joined timeline — a different
concat design — plus a definition of which segment donates the overlap time.
The spec hedges ("only where they can be represented safely") but still ships
`dissolve` in the enum and UI.

**Required fix:** either move `dissolve` to the deferred list (per-segment fade
to/from black is achievable now), or specify the xfade-based concat redesign.
Also define the interaction between segment N's `transitionIn` and segment
N−1's `transitionOut`.

### 3. Speed conflicts with the 5-second video clip cap and is a no-op for images

The pipeline caps video clips at 5 seconds:
`clipDuration = Math.min(5, ...)` (`src/render.ts:120`, `src/render.ts:245`)
and validation rejects longer clips (`src/visual-mapping.ts:64`). The spec
never mentions this cap. At speed 2.0, does the operator get 10s of source
compressed into 5s of output, or 5s of source producing 2.5s of output plus
fill? Does the cap apply to source duration or output duration?

For still images, `setpts=PTS/<speed>` has no visible effect.

**Required fix:** specify cap semantics (source vs output) under speed change,
and state explicitly that speed is disabled or a no-op for image segments.

## Non-blocking issues

4. **Render hash must include effects.** The artifact hash currently covers
   title/duration/paths/visualSegments only (`src/render.ts:193-201`). Without
   adding effects to the hash input, stale-render detection (acceptance
   criterion 3) silently fails. Add an explicit line about hash composition.
5. **Rights list omits `user-confirmed`.** `RightsStatus` includes
   `user-confirmed` (`src/production/types.ts:13`) but the watermark gate
   allows only `owned | licensed | generated`. If this stricter gate for logos
   is intentional, state it as a decision; otherwise user-confirmed logos are
   blocked unintentionally.
6. **Grayscale overlaps saturation.** Continuous grayscale (0..1) and
   saturation (0..2) interact ambiguously. Specify the formula (e.g. effective
   saturation = `saturation × (1 − grayscale)`) or make grayscale a boolean so
   filter-chain tests are unambiguous.
7. **Two render paths need the filter chain.** Single-segment renders go
   through `buildShortsRenderArgs` filter_complex directly; multi-segment
   renders go through per-segment `buildSegmentArgs`. The spec describes one
   chain; state that both paths receive it.

## Strengths (keep as-is)

- Versioned `effects` with normalize-to-defaults for existing projects.
- Reject-with-field-errors instead of silent clamping; partial PATCH with full
  normalized persistence.
- Duration-preservation principle for speed (matches existing fill behavior).
- Watermark gated by asset role and rights status.
- NVENC excluded from the MVP; region/keyframe blur deferred.
- Testing strategy and acceptance criteria are concrete and measurable.
