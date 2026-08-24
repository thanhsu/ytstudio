# Production Contract Design

## Status

Approved direction: define the shared artifact boundary before completing the
Audio Story Factory Phase 2 UI. This slice defines and validates the contract;
it does not migrate every existing renderer in one change.

## Goal

Allow review, audio-story, subtitle, and licensed-source workflows to produce a
common versioned production artifact consumed by Edit, Render, Export, and
Publish stages.

## Design

Each workflow owns its content-generation stages and produces a normalized
`ProductionProject` artifact. Shared production stages consume only that
artifact and must not branch on the originating workflow type.

```text
review / audio-story / subtitle / licensed-source
                         |
                         v
                 ProductionProject v1
                         |
                 Edit -> Render -> Export -> Publish
```

The contract is persisted as JSON under the project's ignored workspace so it
can be inspected, resumed, hashed, cached, and invalidated like the existing
artifacts. The first implementation adds the contract and adapters without
removing the current workflow-specific artifacts or render paths.

## Contract boundaries

### ProductionProject

```ts
type ProductionProject = {
  version: 1;
  projectId: string;
  workflowType: "review-recap" | "audio-story" | "subtitle-render" | "licensed-source";
  format: "shorts" | "longform";
  content: ContentArtifact;
  narration?: NarrationTrack;
  captions?: CaptionTrack;
  assets: ProductionAsset[];
  timeline: EditTimeline;
  publish: PublishMetadata;
};
```

### ContentArtifact

Content is the human-facing source that explains what the video is about. It
does not contain provider-specific model settings.

```ts
type ContentArtifact = {
  title: string;
  summary: string;
  sourceHash: string;
  scriptPath?: string;
  sourcePaths: string[];
};
```

### NarrationTrack and CaptionTrack

Both tracks point to local generated files and carry a source hash. The
renderer may read the files, but it does not regenerate or reinterpret them.

```ts
type NarrationTrack = {
  relativePath: string;
  format: "wav" | "mp3";
  durationSeconds: number;
  sourceHash: string;
};

type CaptionTrack = {
  relativePath: string;
  format: "srt";
  cueCount: number;
  sourceHash: string;
};
```

### ProductionAsset

Assets are typed by production role, not by originating workflow.

```ts
type ProductionAsset = {
  id: string;
  relativePath: string;
  mediaType: "image" | "video" | "audio";
  role:
    | "source-clip"
    | "generated-background"
    | "story-image"
    | "cover"
    | "diagram"
    | "caption-card"
    | "music"
    | "logo";
  durationSeconds?: number;
  sourceStartSeconds?: number;
  sourceHash: string;
  rightsStatus: "owned" | "licensed" | "user-confirmed" | "generated" | "unknown";
  usagePurpose: string;
};
```

`rightsStatus` records provenance; it does not automatically approve a render.
The existing project copyright and asset approvals remain authoritative gates.

### EditTimeline

The timeline is the shared editor input. A segment may use an asset or an
intentional generated fallback, but it must always have an explicit time range.

```ts
type EditTimeline = {
  version: 1;
  durationSeconds: number;
  segments: EditSegment[];
};

type EditSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  narrationText?: string;
  assetId?: string;
  fitMode: "cover" | "contain";
  sourceStartSeconds?: number;
  muteSourceAudio: boolean;
};
```

Timeline validation rejects negative times, zero-length segments, segments
outside the duration, overlapping segments, missing asset references, and video
asset excerpts longer than five seconds. Gaps are allowed so an editor can
intentionally leave a section as a generated background or a dark frame.

### PublishMetadata

Publish metadata is a prepared package, not an instruction to upload.

```ts
type PublishMetadata = {
  title: string;
  description: string;
  tags: string[];
  language: string;
  thumbnailAssetId?: string;
};
```

Actual publishing remains a separate explicit operation after export and final
human approval.

## Persistence

The normalized artifact is stored at:

```text
projects/<project-id>/workspace/production/production-project.json
```

The file is versioned independently from `project-state.json`. A future schema
version must be rejected with a readable error rather than silently normalized
into version 1.

## Adapters

The first adapters are pure functions where possible:

```ts
normalizeReviewProject(input): ProductionProject
normalizeAudioStoryProject(input): ProductionProject
```

Adapters may read existing project/story artifacts, but shared stages must only
consume the normalized contract. The Audio Story adapter maps chapter narration
and scene images into narration, captions, assets, and timeline segments. The
Review adapter maps the current script, voice, captions, and visual mapping.

Subtitle and licensed-source adapters are intentionally specified at the type
boundary but deferred until the review and audio-story adapters prove the
contract.

## Compatibility and migration

- Existing `script.md`, `visual-mapping.json`, story artifacts, and current
  render functions remain unchanged in the contract slice.
- No existing approval is copied into the new artifact automatically.
- A normalized artifact records hashes of its inputs; changing an input makes
  the artifact stale and requires regeneration.
- Render migration will be a later plan and must preserve the current safety
  gates.

## Testing

Contract tests must cover:

1. valid Review and Audio Story inputs normalize to version 1;
2. normalized paths remain project-relative;
3. timeline validation rejects invalid ranges and overlong source video;
4. asset references resolve only within the asset list;
5. changing an input changes the normalized source hash;
6. unsupported contract versions fail clearly;
7. publish metadata contains no implicit upload action.

The contract module must have no FFmpeg, network, model-provider, or DOM
dependency so it can be tested with the existing Node test runner.

## Non-goals

- Replacing the current UI in this slice.
- Migrating all renderers immediately.
- Adding YouTube OAuth or automatic publishing.
- Merging Story Factory stage artifacts into the generic project state.
- Guaranteeing copyright clearance based on `rightsStatus`.
