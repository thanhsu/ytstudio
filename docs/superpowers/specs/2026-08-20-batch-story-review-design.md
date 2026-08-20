# Batch Story Review Design

## Goal

Add a batch-review workflow that turns multiple source episodes, such as
`Tales of Herding Gods EP01-05`, into one long-form English review package. The
MVP produces structured analysis, a story arc, a voice-over script, an editing
plan with source timestamps, and YouTube metadata. It does not automatically cut
or render the final video.

## Existing Architecture

The project is a local-first TypeScript and Node.js app. The backend is a small
loopback HTTP server in `src/server.ts`. The frontend is vanilla HTML, CSS, and
JavaScript in `src/web/`. Project data is stored as local files under
`projects/<id>/`; there is no database or migration layer.

Existing services already cover project path validation, media import, FFmpeg
audio extraction, local ASR, SRT parsing, translation prompt generation, workflow
templates, series planning, script generation, TTS, captions, render draft, and
approval state. Batch review should extend these services rather than create a
parallel system.

## Product Model

Batch review sits below a `SeriesProject` and above the existing one-video
workflow. A series owns the source library and suggested batches. Each batch
becomes one long-form review project with its own source episodes, analysis,
story arc, script, editing plan, and exports.

```text
SeriesProject
  ReviewProject EP01-05
    EpisodeSource EP01
    EpisodeSource EP02
    EpisodeSource EP03
    EpisodeSource EP04
    EpisodeSource EP05
    StoryArc
    ReviewScript
    EditingPlan
```

The existing episode cards remain useful for planning single videos, but batch
review projects are the preferred unit for long-form story-review content.

## Storage Layout

```text
projects/<series-id>/
  series.json
  review-projects/
    <review-project-id>/
      batch.json
      sources/
        ep001/
          source.mp4
          source.srt
          transcript.json
          scenes.json
          analysis.json
        ep002/
          ...
      story-arc.json
      review-script.json
      voice-over-script.md
      editing-plan.json
      editing-sheet.csv
      voice-over.srt
      youtube-metadata.json
      workspace/
        jobs/
```

Generated files remain local and ignored by Git through the existing
`projects/` ignore rule.

## Workflow

1. Create or open a series.
2. Create a batch review project, for example `EP01-05`.
3. Import five source videos and matching subtitles when available.
4. Parse subtitle files into normalized transcript segments.
5. If a subtitle is missing, extract audio with FFmpeg and use configured local
   ASR.
6. Build scene maps per episode. The MVP can group by subtitle timing and gaps;
   keyframe extraction is optional metadata.
7. Analyze each episode independently.
8. Merge episode analyses into a story arc.
9. Generate a long-form English voice-over script by section.
10. Generate an editing plan that references existing scene ids.
11. Export script, JSON, CSV, SRT, YouTube metadata, chapters, and thumbnail
    text.
12. Let the editor regenerate individual sections without rerunning the whole
    batch.

## Parallelism

The following tasks can run per episode in parallel:

- subtitle parsing
- audio extraction
- ASR fallback
- keyframe extraction
- scene mapping
- episode analysis after transcript and scenes exist

Story merge, script generation, editing plan generation, and export are
sequential because they depend on all required episode analyses.

## AI Chain

The app should never send full five-episode raw media or raw transcripts in one
prompt. The prompt chain is:

1. Transcript cleanup per episode chunk.
2. Scene grouping per episode.
3. Episode analysis per episode.
4. Story arc merge across episode analyses.
5. Script outline with runtime budget.
6. Script segment generation per section.
7. Editing plan generation from segment-to-scene references.
8. Metadata generation.

Every AI step returns structured JSON. The backend validates required fields and
rejects references to unknown scene ids.

## Spoiler Control

`spoilerMode` supports:

- `donghua-only`: use only information available through the current batch end.
- `novel-spoilers`: allow glossary or novel knowledge for deeper explanation.

Knowledge entries include `sourceType`, `spoilerLevel`, and
`firstAllowedEpisode`. In `donghua-only`, retrieval must exclude novel entries
and entries beyond the batch end.

## Data Types

### ReviewProject

```ts
type ReviewProject = {
  version: 1;
  id: string;
  seriesId: string;
  title: string;
  sourceRange: string;
  episodeNumbers: number[];
  targetLanguage: "English";
  reviewStyle: "story-review";
  targetDurationMinutes: number;
  spoilerMode: "donghua-only" | "novel-spoilers";
  status: "draft" | "sources" | "analyzed" | "story" | "script" | "editing-plan" | "exported";
  episodes: EpisodeSource[];
  outputs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
```

### EpisodeSource

```ts
type EpisodeSource = {
  episodeNumber: number;
  label: string;
  sourceVideoPath?: string;
  subtitlePath?: string;
  audioPath?: string;
  transcriptPath?: string;
  sceneMapPath?: string;
  analysisPath?: string;
  sourceHash?: string;
  status: "empty" | "source-ready" | "transcript-ready" | "scene-ready" | "analyzed" | "failed";
  error?: string;
};
```

### TranscriptSegment

```ts
type TranscriptSegment = {
  episode: number;
  cueId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  language: string;
  sourceFile: string;
  confidence?: number;
};
```

### Scene

```ts
type Scene = {
  episode: number;
  sceneId: string;
  startMs: number;
  endMs: number;
  dialogue: string;
  characters: string[];
  visualSummary: string;
  importance: number;
  tags: string[];
  sourceCueIds: string[];
  keyframes: string[];
  excludeReason?: string;
};
```

### EpisodeAnalysis

```ts
type EpisodeAnalysis = {
  episode: number;
  summary: string;
  characters: string[];
  keyEvents: Array<{ event: string; sceneIds: string[]; importance: number }>;
  conflict: string;
  turningPoint: string;
  loreTerms: Array<{ term: string; meaning: string; sceneIds: string[] }>;
  explainers: Array<{ topic: string; sceneIds: string[] }>;
  endingHook: string;
  recommendedScenes: string[];
  omittedScenes: Array<{ sceneId: string; reason: string }>;
};
```

### StoryArc

```ts
type StoryArc = {
  hook: StoryArcItem[];
  setup: StoryArcItem[];
  risingAction: StoryArcItem[];
  climax: StoryArcItem[];
  resolution: StoryArcItem[];
  nextBatchHook: StoryArcItem[];
  omittedScenes: Array<{ sceneId: string; reason: string }>;
};

type StoryArcItem = {
  beat: string;
  sceneIds: string[];
  narrativePurpose: string;
};
```

### ReviewScript

```ts
type ReviewScript = {
  projectId: string;
  language: "English";
  durationTargetMinutes: number;
  ratioPlan: { recap: 70; lore: 20; commentary: 10 };
  segments: ScriptSegment[];
  metadata: YouTubeMetadata;
};
```

### ScriptSegment

```ts
type ScriptSegment = {
  segmentId: string;
  section: "hook" | "setup" | "rising_action" | "climax" | "resolution" | "next_batch_hook";
  narration: string;
  estimatedSeconds: number;
  sourceScenes: string[];
  commentaryType: "plot" | "plot_and_lore" | "lore" | "commentary";
  revision: number;
  updatedAt: string;
};
```

### EditingPlan

```ts
type EditingPlan = {
  projectId: string;
  items: EditingPlanItem[];
};

type EditingPlanItem = {
  segmentId: string;
  sceneId: string;
  source: { episode: number; startMs: number; endMs: number };
  instruction: string;
  assetType: "footage" | "keyframe" | "character-card" | "map" | "graphic";
  durationSeconds: number;
};
```

### KnowledgeTerm

```ts
type KnowledgeTerm = {
  term: string;
  aliases: string[];
  definition: string;
  sourceType: "donghua" | "novel" | "manual";
  spoilerLevel: "none" | "future" | "novel";
  firstAllowedEpisode?: number;
  safeSummary: string;
};
```

## Background Jobs

The current `ProjectJobManager` should be generalized so job identity includes
`scopeId`, `episodeNumber`, `taskKind`, and `idempotencyKey`. Only conflicting
jobs for the same scope should block each other. A failed episode task should
not erase successful artifacts from other episodes.

## Risks and Guards

- Context length: chunk by scene and episode; never prompt all raw transcript at
  once.
- Hallucination: validate all `sceneId` references against stored scene maps.
- Timestamp drift: resolve timestamps in backend from scene ids; LLM never owns
  final timestamp values.
- Spoiler leakage: filter knowledge by `spoilerMode` and batch end episode.
- Cost: estimate text and TTS costs before paid calls; cache by input hash.
- Copyright: keep workflow focused on commentary and analysis; editing plans
  describe short, purposeful source usage and do not implement evasion.

## MVP Acceptance

The MVP is accepted when a user can create an `EP01-05` batch review project,
attach five sources/subtitles, generate or import transcripts, produce episode
analysis, merge a story arc, generate and edit a long-form English script,
generate an editing plan with valid timestamps, and export all planned files
without rendering a final cut.
