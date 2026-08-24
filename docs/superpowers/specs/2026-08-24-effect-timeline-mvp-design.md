# Effect Timeline MVP Design

## Goal

Add a human-editable, per-segment post-production effect layer to the existing
production timeline. The MVP must let an operator preview and save bounded
visual effects, then render them through FFmpeg without introducing a second
timeline model or bypassing existing approval and copyright gates.

## Scope

### Included

- Versioned `effects` data embedded in each `VisualMappingSegment`.
- Per-segment controls for:
  - speed from `0.5` to `2.0`;
  - slow zoom in, slow zoom out, or none;
  - cut or fade transition in/out;
  - brightness, contrast, saturation, and grayscale;
  - full-segment blur;
  - licensed/owned/generated logo watermark with position, scale, and opacity.
- Timeline inspector UI for the selected segment.
- PATCH API for saving visual-mapping and effect edits, plus resetting effects
  to defaults.
- FFmpeg filter generation for mapped image/video segments.
- Validation, artifact hashing, stale render invalidation, and regression tests.

### Explicitly deferred

- Region/keyframe blur and draggable blur masks.
- Per-segment source-audio speed changes or audio pitch correction. Existing
  source audio remains muted for mapped visual assets.
- Arbitrary custom FFmpeg expressions.
- Large transition libraries, motion tracking, LUT import, grain/noise, and
  GPU-specific tuning UI.
- Dissolve/cross-fade transitions. The current multi-segment renderer prepares
  segments independently and joins them with concat stream copy; an xfade
  redesign and its overlap-time policy are deferred.
- Copyrighted source acquisition or automatic reuse of third-party footage.

## Existing Boundaries

The current production model is stored as a versioned `ProductionProject` with
an `EditTimeline` and `EditSegment`, but it is a standalone contract persisted
under `workspace/production/production-project.json`; the current editor and
renderer do not consume it. The live editor selects and saves
`VisualMappingSegment` values, and render input is built from visual mapping.
Therefore this MVP explicitly chooses option (b): attach effects to
`VisualMappingSegment`, the model already edited and rendered today. This is
the pragmatic MVP boundary because it avoids first wiring the unused
production contract into `src/server.ts` and `src/render.ts`; the production
contract can mirror these effects in a later integration. The Story Factory
has separate zoom/fade/BGM behavior; this MVP extends the live visual-mapping
path and does not duplicate Story Factory stages.

## Data Model

`VisualMappingSegment` gains an optional effects property normalized to
defaults. The render adapter passes this property through to both render
argument builders:

```ts
type SegmentEffects = {
  version: 1;
  speed: number; // 0.5..2.0, default 1
  zoom: "none" | "slow-in" | "slow-out";
  transitionIn: "cut" | "fade";
  transitionOut: "cut" | "fade";
  color: {
    brightness: number; // -1..1, default 0
    contrast: number; // 0..2, default 1
    saturation: number; // 0..2, default 1
    grayscale: number; // 0..1, default 0
  };
  blur: number; // 0..40, default 0
  watermark?: {
    assetId: string;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale: number; // 0.05..0.5 relative to video width, default 0.12
    opacity: number; // 0..1, default 0.2
  };
};
```

Existing projects without `effects` normalize to these defaults and remain
valid. Invalid persisted effects are rejected with field-specific validation
errors rather than silently clamped. PATCH input may be partial, but the
server saves a complete normalized `SegmentEffects` value inside the visual
mapping. Effects are versioned with the visual-mapping data, not with
`ProductionProject`.

## Rendering Design

The renderer builds one filter chain per visual segment before concatenating
segments. The same effect chain must be applied in both render paths:
`buildShortsRenderArgs` for the single-pass path and `buildSegmentArgs` for
the per-segment path used before multi-segment concat. The chain order is:

1. fit/crop or contain;
2. speed adjustment with `setpts=PTS/<speed>` for video only;
3. zoompan-style motion for still images, or bounded scale/crop motion for
   video;
4. color controls using FFmpeg `eq`/`hue` filters. Grayscale is continuous:
   `effectiveSaturation = saturation * (1 - grayscale)`, then the effective
   value is supplied to the saturation control (so grayscale 1 is monochrome
   regardless of the saturation input);
5. full-frame blur when requested;
6. watermark overlay when configured;
7. per-segment transition edge handling;
8. trim, setpts, and concat preparation.

The implementation must preserve exact segment duration on the output
timeline. The existing five-second video cap applies to the source slice read
for a segment, not to the segment's output allocation: at most five seconds of
source video may be consumed before speed processing. A speed change changes
how much output that bounded source slice produces, not the segment's
allocated narration duration; if it is shorter than the segment, the renderer
fills the remainder with the existing fallback background behavior. The
output segment remains within its narration allocation and never gains extra
time from speed. Speed is disabled and treated as a no-op for image segments,
because `setpts` cannot change the duration of a looped still image.

`cut` has no edge filter. `fade` means fade from black on `transitionIn` and
fade to black on `transitionOut`, within the segment's existing duration. On
the first segment, `transitionIn: fade` starts from black; on the last
segment, `transitionOut: fade` ends at black. Adjacent segments do not
cross-fade or overlap: segment N's `transitionOut` and segment N+1's
`transitionIn` are applied independently, so choosing both creates a black
interval between them while preserving both segment allocations. Choosing
only one affects only that segment edge. Fade duration is a fixed renderer
constant capped so it cannot exceed half of the segment duration.

Watermark assets are resolved through the project asset manifest. Only assets
with `role: "logo"` and rights status `owned`, `licensed`, or `generated` may
be used. Excluding `user-confirmed` is intentional for persistent logo
watermarks: this MVP requires a stronger rights status than an operator's
confirmation. The logo is overlaid with an alpha-adjusted input and a fixed
margin of 24 pixels from the selected edge.

`libx264` remains the default encoder for this MVP. NVENC is intentionally not
part of this design; it will be a separate backend capability after filter
correctness and cross-platform fallback are established.

## API and State

Add routes under the existing project API:

- `PATCH /api/projects/:projectId/visual-mapping/segments/:segmentId`
  - remains the single route for the live editor;
  - accepts the existing visual-mapping fields plus a partial `effects` patch;
  - returns the normalized visual-mapping segment and mapping/state;
  - returns `400` for validation errors and `404` for missing project/segment.
- `POST /api/projects/:projectId/visual-mapping/segments/:segmentId/effects/reset`
  - replaces that visual-mapping segment's effects with defaults;
  - returns the normalized segment and updated mapping/state.

Saving effects marks the visual mapping draft/stale as appropriate, changes the
render source hash, and invalidates dependent render artifacts and approvals
using the existing project state invalidation path. The render hash input must
include the complete normalized `effects` value for every `visualSegment`, in
addition to the existing title, duration, paths, and visual-segment fields;
otherwise changing an effect would incorrectly reuse a stale render. The API
does not auto-approve mapping or rendering and does not update
`ProductionProject` in this MVP.

## UI Design

Extend the existing Clip Inspector with an `Effects` section:

- select controls for zoom and transitions;
- numeric inputs for speed, brightness, contrast, saturation, grayscale, and
  blur;
- watermark asset selector, position, scale, opacity;
- `Save effects` and `Reset effects` actions;
- a compact read-only effect summary on each timeline clip when non-default
  effects exist;
- validation errors shown beside the relevant field.

The current monitor remains a source/segment monitor for the MVP. It may show a
textual effect summary, but it does not claim to be a frame-accurate browser
preview until the rendered draft is regenerated.

## Error Handling and Safety

- Validate finite numbers and all ranges at the API/domain boundary.
- Reject unknown effect enum values and unsupported effect versions.
- Reject watermark asset IDs that are absent, non-logo, or rights-ineligible.
- Refuse rendering when effects are invalid rather than emitting a partially
  processed video.
- Escape all paths and text using existing FFmpeg helper conventions.
- Keep generated previews/renders under the ignored project workspace.
- Preserve the existing copyright checklist and manual approval gates.

## Testing Strategy

- Unit tests for defaults, normalization, range validation, migration, and
  watermark eligibility.
- Renderer tests asserting filter chains for speed, zoom, color, blur,
  watermark, and transition combinations, plus duration-preserving behavior.
- API tests for PATCH/reset, missing resources, invalid values, and stale
  artifact invalidation.
- Web contract tests for the inspector controls, reset/save actions, and
  non-default timeline summaries.
- Full `npm run typecheck` and `npm test` before completion.

## Acceptance Criteria

1. An existing project with no effects still renders unchanged after
   normalization.
2. An operator can select a timeline segment, change effects, save them, and
   see the values after reload.
3. A saved effect change on a `VisualMappingSegment` changes the render hash,
   marks the previous render stale, and requires the normal visual-mapping and
   render approval path again; the hash includes normalized effects.
4. The renderer produces valid filter arguments for every supported effect
   individually and in combination without invalid durations.
5. Watermarks cannot reference unapproved or non-logo assets; `user-confirmed`
   is intentionally rejected for logo watermarks.
6. No existing test fails, and the full test suite and typecheck pass.
