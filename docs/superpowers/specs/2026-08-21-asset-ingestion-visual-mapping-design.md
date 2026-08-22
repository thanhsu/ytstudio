# Asset Ingestion and Visual Mapping Design

**Date:** 2026-08-21  
**Status:** Approved design, pending implementation  
**Project:** YouTube Review Studio

## Goal

Add a low-cost, local-first workflow that analyzes uploaded assets and automatically maps them to narration scenes. The Render tab presents the proposal so the user only adjusts exceptions before approval and rendering.

## User Outcome

1. Upload image or video assets.
2. Analyze each asset in the background.
3. Build caption-aligned narration scenes.
4. Assign the best available asset to each scene.
5. Review and optionally adjust mappings in the Render tab.
6. Approve the mapping and generate the draft video.

## Product Constraints

- Prefer local and free processing by default.
- Keep explicit approvals for assets, mapping, and final render.
- Mute source-video audio by default.
- Limit continuous source-video excerpts to five seconds.
- Do not place excerpts from the same video directly adjacent.
- Use generated backgrounds when no suitable approved asset exists.
- Exclude OCR and paid AI vision from the MVP.
- Never scrape footage, remove watermarks, or evade copyright controls.

## Scope

Included: FFprobe metadata, embedded subtitle extraction, optional local ASR fallback, deterministic context extraction, caption-aligned scenes, automatic mapping, mapping editor, approval flow, mapping-aware rendering, and stale-state propagation.

Not included: full NLE editing, keyframe OCR, default paid cloud processing, copyrighted-footage scraping, watermark removal, or copyright-detection avoidance.

## Storage Layout

```text
projects/<project-id>/
  asset-manifest.json
  scene-plan.json
  workspace/
    assets/
    captions/
    asset-context/
      <asset-id>.json
      <asset-id>.srt
    editing/
      visual-mapping.json
    renders/
```

The manifest stores UI summary fields. Larger transcripts and detailed analysis remain under the ignored project workspace.

## Asset Manifest Model

```json
{
  "id": "asset-001",
  "fileName": "clip.mp4",
  "path": "workspace/assets/clip.mp4",
  "mediaType": "video",
  "usagePurpose": "supporting footage",
  "rightsStatus": "user-confirmed",
  "analysisStatus": "ready",
  "durationSeconds": 42.8,
  "width": 1920,
  "height": 1080,
  "subtitleSource": "embedded",
  "transcriptPath": "workspace/asset-context/asset-001.srt",
  "contextPath": "workspace/asset-context/asset-001.json",
  "keywords": ["qin mu", "village", "training"],
  "contextSummary": "Qin Mu training near the village.",
  "analysisUpdatedAt": "2026-08-21T00:00:00.000Z"
}
```

Analysis statuses are `pending`, `running`, `ready`, `limited`, and `failed`. A limited result has usable metadata but no reliable transcript context.

## Asset Ingestion Pipeline

After a file is stored and registered, enqueue analysis without blocking upload success. FFprobe collects media type, duration, dimensions, frame rate, audio/subtitle streams, and language tags.

For embedded text subtitles, prefer the project language, then English, then the first supported text stream. Extract and normalize it to SRT. Image-based subtitle streams are not OCR-processed.

If a video has audio but no usable subtitle stream, invoke configured local ASR. If ASR is unavailable or fails, mark the asset `limited` rather than blocking the workflow.

Local deterministic processing derives normalized transcript text, distinctive terms, proper-name candidates, a compact context summary, and searchable tokens. External AI remains an optional future improvement, never a default cost.

## Scene Model

Scenes are generated from narration captions rather than every subtitle line. Adjacent cues are grouped into practical four-to-ten-second segments while respecting scene-plan boundaries where possible.

```json
{
  "id": "scene-003",
  "startSeconds": 14.2,
  "endSeconds": 20.1,
  "section": "Analysis",
  "narration": "Qin Mu feels different because his strength grows from curiosity.",
  "keywords": ["qin mu", "strength", "curiosity"],
  "intent": "analysis"
}
```

Scene generation must be deterministic for identical captions and scene-plan inputs.

## Visual Mapping Model

The generated mapping is stored at `workspace/editing/visual-mapping.json`.

```json
{
  "version": 1,
  "status": "draft",
  "generatedAt": "2026-08-21T00:00:00.000Z",
  "inputFingerprint": "sha256-value",
  "segments": [
    {
      "sceneId": "scene-003",
      "startSeconds": 14.2,
      "endSeconds": 20.1,
      "assetId": "asset-001",
      "confidence": 0.82,
      "reason": "Matched Qin Mu and training context.",
      "fitMode": "cover",
      "sourceStartSeconds": 8.5,
      "sourceDurationSeconds": 5,
      "muteSourceAudio": true,
      "selectionMode": "automatic"
    }
  ]
}
```

Mapping statuses are `draft`, `approved`, and `stale`.

## Automatic Mapping Algorithm

An asset is eligible only when it exists, has a usage purpose, has acceptable rights status, is not currently being analyzed, and uses a renderer-supported media type.

### Initial Scoring

| Signal | Score |
| --- | ---: |
| Scene keyword overlap | +4 per weighted match |
| Usage-purpose match | +5 |
| Transcript/context match | +3 per weighted match |
| Preferred media type for scene intent | +3 |
| Suitable source duration | +2 |
| Limited analysis context | -2 |
| Asset used in previous scene | -8 |
| Same video directly adjacent | Ineligible |

Scores are normalized into a UI confidence value. The UI also displays a short human-readable reason.

Media preferences:

- `hook`: strong still image or short high-confidence video excerpt.
- `context`: establishing imagery and broad contextual footage.
- `analysis`: relevant image, diagram, or short supporting excerpt.
- `closing`: branded or generated background unless a strong match exists.

When no eligible asset exceeds the threshold, use a generated background. Low-confidence third-party footage must not be selected merely to fill the timeline.

Video safety rules:

- Trim automatically to the mapped range.
- Mute source audio by default.
- Cap continuous use at five seconds.
- Never use the same video in adjacent segments.
- Fill remaining scene duration with another eligible asset or generated background.

## Render Tab UI

### Header

Display mapping status, stale warning, mapped/fallback counts, `Generate mapping`, `Regenerate mapping`, `Approve mapping`, and draft-render actions. Rendering is enabled only when workflow requirements are met.

### Scene Rows

Each row displays timeline range, narration excerpt, asset preview and selector, confidence, explanation, fit mode, video source start/duration, mute toggle, and automatic/manual indicator.

Changing a row marks it `manual`, allowing regeneration to preserve it unless the user requests a full reset.

### Asset Context Panel

Show file preview, metadata, usage purpose, rights status, analysis status, transcript source, keywords, context summary, and retry-analysis action.

### Validation

Block approval when an assigned asset is missing, lacks usage purpose or rights status, exceeds the five-second rule, repeats the same video adjacently, or leaves a segment without an asset or fallback.

## Approval and Stale Propagation

- Asset metadata/context changes invalidate asset-manifest approval and visual mapping.
- Script, voice, captions, or scene-plan changes mark mapping `stale`.
- Mapping edits invalidate mapping approval and render approval.
- Regeneration preserves valid manual overrides by default.
- Rendering requires an approved asset manifest and approved non-stale mapping.

The mapping fingerprint includes normalized script/caption timing, voice duration, scene plan, eligible asset metadata, and asset-context versions.

## Renderer Integration

The renderer consumes `visual-mapping.json` rather than a flat asset-path list. For each segment it prepares the selected media or fallback, applies fit mode, trims video, removes source audio, concatenates visuals to the narration timeline, overlays captions, and muxes narration audio.

The render hash includes both mapping content and its input fingerprint, ensuring edits generate a new render artifact.

## API Design

```text
POST  /api/projects/:id/assets/:assetId/analyze
GET   /api/projects/:id/assets/:assetId/context
POST  /api/projects/:id/visual-mapping/generate
GET   /api/projects/:id/visual-mapping
PATCH /api/projects/:id/visual-mapping/segments/:sceneId
POST  /api/projects/:id/visual-mapping/approve
POST  /api/projects/:id/render
```

Long-running analysis and mapping requests should return job information rather than keep HTTP requests open indefinitely.

Expected domain errors include `asset-analysis-failed`, `asset-context-unavailable`, `visual-mapping-missing`, `visual-mapping-invalid`, `visual-mapping-stale`, and `visual-mapping-not-approved`. User-correctable failures must not be returned only as `internal-error`.

## Job Model

Asset analysis jobs expose job ID, asset ID, phase/progress, status, timestamps, sanitized failure message, and retry eligibility. The first implementation may use an in-process queue if job state survives page refreshes and interrupted jobs become retryable.

## Error Handling

- Missing FFmpeg/FFprobe: provide installation or configuration guidance.
- Unsupported media: preserve upload and mark analysis failed clearly.
- Subtitle extraction failure: continue to ASR fallback.
- ASR unavailable: mark analysis limited and continue.
- Corrupt asset: exclude it from mapping and show a repair action.
- Missing generated files: mark dependent mapping/render stale.
- Locked render output: write a versioned output rather than overwrite it.

## Testing Strategy

### Unit Tests

- FFprobe output normalization and subtitle-stream selection.
- Transcript keyword extraction and caption-to-scene grouping.
- Mapping scoring, deterministic tie-breaking, and fallback selection.
- Five-second, rights, purpose, and adjacency constraints.
- Fingerprint calculation, stale propagation, and mapping validation.

### Integration Tests

- Upload schedules analysis and updates manifest state.
- Embedded subtitles produce context files.
- Missing subtitles invoke configured ASR fallback.
- Missing ASR produces a limited non-blocking result.
- Mapping uses only approved eligible assets.
- Manual edits invalidate approval.
- Script or asset changes mark mapping stale.
- Approved mapping reaches the renderer.

### Render Smoke Test

Use small local fixtures containing an image, short video, narration audio, and SRT captions. Verify output duration, dimensions, audio stream, captions, muted source audio, and maximum source-video excerpt length.

## Delivery Sequence

1. Extend asset and mapping schemas.
2. Add focused schema and validation tests.
3. Implement FFprobe asset analysis.
4. Add subtitle extraction and local ASR adapter.
5. Implement deterministic context extraction.
6. Generate caption-aligned narration scenes.
7. Implement mapper and stale fingerprints.
8. Add mapping API and approval workflow.
9. Build Render-tab mapping editor.
10. Integrate mapping into FFmpeg rendering.

Each stage remains usable when local ASR is not installed.

## Success Criteria

- Uploaded videos are analyzed without blocking upload.
- Embedded subtitles are extracted when available.
- Local ASR is attempted only when needed and configured.
- Asset context is visible and editable in the studio.
- A usable automatic mapping is generated for narration scenes.
- Mapping adjustments do not require manual JSON editing.
- Rendering consumes the approved mapping.
- Source clips remain muted and no longer than five continuous seconds.
- Script, captions, voice, or asset changes correctly mark mappings stale.
- The default workflow has no paid external-service dependency.
