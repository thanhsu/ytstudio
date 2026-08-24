# Review: Effect Timeline MVP Implementation Plan (2026-08-24)

Reviewed document: `docs/superpowers/plans/2026-08-24-effect-timeline-mvp.md`
Spec of record: `docs/superpowers/specs/2026-08-24-effect-timeline-mvp-design.md`
(the REVISED version — see also
`docs/superpowers/reviews/2026-08-24-effect-timeline-mvp-design-review.md`).

Reviewer verdict: **the plan was written against the pre-revision spec. Its
TDD structure, per-task commits, and verification checklist are good, but
three architecture decisions settled in the revised spec are reversed in the
plan. Tasks 1–3 must be rewritten and Tasks 4–6 corrected before execution.**

## Blocking contradictions with the revised spec

### 1. Wrong model: plan attaches effects to `EditSegment` / production contract

The Architecture line, Task 1 (modifying `src/production/types.ts`,
`validate.ts`, `adapters.ts`), Task 2 (hashing the production project), and
Task 3 are all built on `ProductionProject`. The revised spec explicitly chose
option (b): effects live in **`VisualMappingSegment`**
(`src/visual-mapping.ts:10`) — the model the live editor and renderer actually
consume — and states "does not update `ProductionProject` in this MVP" and
"Effects are versioned with the visual-mapping data, not with
`ProductionProject`".

**Required fix:** rewrite Tasks 1–3 around `src/visual-mapping.ts` (and a new
effects domain module if desired), `tests/visual-mapping.test.ts`, and the
visual-mapping persistence path. Do not touch `src/production/*` in this MVP.

### 2. Wrong API routes

Task 3 registers `PATCH /api/projects/:projectId/timeline/segments/:segmentId/effects`.
The revised spec keeps the **existing** route
`PATCH /api/projects/:projectId/visual-mapping/segments/:segmentId`
(`src/server.ts:967`) as the single editor route, extended to accept a partial
`effects` patch, plus one new route
`POST /api/projects/:projectId/visual-mapping/segments/:segmentId/effects/reset`.
Task 6's UI should save effects through the same mapping PATCH handler.

### 3. Dissolve must be removed, not implemented

Task 5 Step 5 says "Implement dissolve only through the existing
xfade-capable path". No xfade path exists — multi-segment renders concatenate
pre-rendered segments with the concat demuxer and `-c copy`
(`src/render.ts:218-234`). The revised spec defers dissolve entirely and
narrows the transition enum to `"cut" | "fade"`.

**Required fix:** drop dissolve everywhere (enum, UI, tests). Implement the
fade semantics from the revised spec: fade from/to black inside the segment's
existing duration; first/last segment fades to/from black; adjacent segments
never overlap; fade duration is a fixed renderer constant capped at half the
segment duration.

## Technical corrections

### 4. Grayscale test contradicts the spec formula

Task 4's test expects `hue=s=0.6` for `saturation: 0.8, grayscale: 0.4`. The
revised spec defines `effectiveSaturation = saturation × (1 − grayscale)` =
**0.48**, supplied to a single saturation control. The plan's test both gets
the number wrong (0.6 ignores the saturation input) and splits saturation
across `eq=` and `hue=` — exactly the ambiguity the spec resolved. Fix the
expected filter to the spec formula.

### 5. Missing speed semantics

Task 4 Step 3 applies `setpts=PTS/speed` unconditionally. The revised spec
requires: speed is a **no-op / disabled for image segments**, and the
five-second video cap applies to the **source slice before speed processing**
(speed 2.0 → at most 5s of source producing 2.5s of output, remainder filled
by the existing fallback background). State both explicitly in Tasks 4–5 and
add tests for them.

### 6. Effects belong in the render source hash, not a production-project hash

Task 2 adds effects to a "production-project hash". The revised spec requires
the **render artifact source hash** — currently computed from
title/duration/paths/visualSegments at `src/render.ts:193-201` — to include
the complete normalized `effects` for every visual segment. Staleness should
propagate through the same path the existing visual-mapping segment PATCH
already uses; no new production-store invalidation path is needed.

## Minor issues

7. File map names `tests/web-render.test.ts`; the actual file is
   `tests/web.test.ts`. Name it exactly.
8. `isEligibleWatermarkAsset(asset: ProductionAsset)` — under the
   mapping-first model, the correct input type is the asset-manifest asset
   type that `validateVisualMapping` already consumes (`src/server.ts:956`),
   not necessarily `ProductionAsset`.
9. Task 6: the watermark asset selector should list only rights-eligible logo
   assets client-side, in addition to server-side validation.

## Keep as-is

- TDD structure: focused failing test before each change; per-task commits.
- The neutral-effects test asserting a `null` filter (guarantees legacy
  renders are byte-identical in filter terms).
- Task 7 coverage: NaN/Infinity/out-of-range rejection, unique filter labels,
  no duplicate input indexes, legacy-project regression.
- Global constraints (approval gates preserved, no copyright bypass, libx264
  only).
- Task 8 documentation and final verification steps.
