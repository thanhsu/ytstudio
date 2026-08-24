# Hyperframes Story Render Design

Status: approved direction, design for implementation plan. This is an approved exception to the project rule "Use FFmpeg for rendering" because Hyperframes still renders through FFmpeg internally while adding an HTML composition layer.

## Goal

Add a Hyperframes-based render path for AI Audio Story Factory videos while keeping the existing FFmpeg renderer as the stable fallback. The target output remains a local, upload-ready MP4 for original audio-story channels. Hyperframes compositions should be driven by visual prompts generated from the approved audio/script content so the video rhythm and on-screen emphasis match what the audience hears.

## Context

`yt-review-studio` is a local-first Node >=22.6 TypeScript app with JSON project storage, vanilla JS UI, `node --test`, and FFmpeg-based rendering. Story Factory currently renders a long-form audio video from generated scenes, images, narration, captions, BGM, and optional SFX through `src/story-factory/render-story.ts`.

Hyperframes is an Apache 2.0 framework from HeyGen for deterministic MP4 rendering from HTML, CSS, media, and seekable animations. Its documented manual CLI flow is `npx hyperframes init`, `npx hyperframes preview`, and `npx hyperframes render`; its requirements are Node.js 22+ and FFmpeg. It uses headless Chrome plus FFmpeg under the hood, which fits the current local-first stack without requiring a database, React migration, or hosted render service.

Sources checked:

- https://github.com/heygen-com/hyperframes
- https://raw.githubusercontent.com/heygen-com/hyperframes/main/README.md

## Non-Goals

- Do not replace the current FFmpeg story renderer in this phase.
- Do not use Hyperframes cloud rendering, AWS Lambda rendering, or any hosted render path.
- Do not add automation for bypassing copyright detection, reuploading third-party footage, removing watermarks, or evading Content ID.
- Do not change TTS, image generation, metadata, thumbnail, YouTube upload, analytics, or publishing flows except where the render artifact path must remain compatible.
- Do not require React or a frontend framework migration.

## Decisions

1. Hyperframes is introduced as an optional Story Factory render engine.
2. The default render engine remains `ffmpeg` so existing projects and tests keep working without Hyperframes installed.
3. The Hyperframes engine consumes only approved local story artifacts: `scenes.json`, `images.json`, narration audio, captions, BGM, SFX events, brand/channel settings, render dimensions, and optional audio-derived `visual-prompts.json`.
4. Hyperframes compositions are generated into the story workspace, not committed source, because they are derived render artifacts.
5. The pipeline writes an additive extension of the existing `render.json` shape used by export, final QA, and YouTube publishing. Downstream stages keep reading the existing fields, while `engine`, `outputSha256`, and `compositionPath` make render-engine switches and visually different MP4s invalidate final approval correctly.
6. Hyperframes failures are classified as render failures and must include redacted, operator-readable diagnostics. The pipeline must not silently fall back inside the same run, because that hides quality and environment problems. The operator can switch the config back to `ffmpeg` and retry.
7. Hyperframes is pinned as a dev dependency instead of fetched through unpinned `npx`. The first supported version is `hyperframes@0.8.13`, whose CLI bin is `bin/hyperframes.mjs`.

## Configuration

Extend `StudioConfig.render`:

```ts
type StoryRenderEngine = "ffmpeg" | "hyperframes";

render: {
  ffmpegPath: string;
  ffprobePath: string;
  shortsWidth: number;
  shortsHeight: number;
  longformWidth: number;
  longformHeight: number;
  storyTransition: "fade" | "xfade";
  storyTransitionSeconds: number;
  storyEngine: StoryRenderEngine;
  hyperframesCommand: string;
  hyperframesArgs: string[];
  hyperframesTimeoutMinutes: number;
}
```

Defaults:

- `storyEngine: "ffmpeg"`
- `hyperframesCommand: "node"`
- `hyperframesArgs: ["./node_modules/hyperframes/bin/hyperframes.mjs"]`
- `hyperframesTimeoutMinutes: 90`

The command is operator-owned config, matching the current FFmpeg and yt-dlp pattern. HTTP requests must never accept executable paths or arbitrary command args. On Windows, the implementation must not rely on `spawn("npx", ...)`; it should invoke the pinned local CLI through `process.execPath`/`node` or another explicitly tested non-shell path. A string-array validator is required for `hyperframesArgs`, and malformed arrays must be rejected or repaired on config load/save.

## Composition Artifact Layout

For a story at `projects/<channelId>/stories/<storyId>/`, Hyperframes writes:

```text
workspace/render/hyperframes/
  index.html
  frame.md
  manifest.json
  assets/
    image-000.png
    image-001.png
    narration.m4a
    bgm.<ext>
    sfx-000.<ext>
  output.mp4
```

`manifest.json` records source artifact hashes, the pinned Hyperframes package version, dimensions, duration, scene timing, and output path. `frame.md` captures the channel visual rules for the generated composition and can later support reusable style profiles.

Asset files may be copied or symlinked only if Windows support is reliable; the first implementation should copy or reference resolved local paths conservatively. The composition must use relative paths where practical so diagnostics and previews remain portable within the story workspace.

## Composition Design

The generated `index.html` contains one root composition:

```html
<div id="stage" data-composition-id="story" data-start="0" data-width="1920" data-height="1080">
  ...
</div>
```

Each scene becomes a timed visual layer:

- Scene image as a `.clip` with `data-start`, `data-duration`, and track index.
- CSS or seek-safe keyframe animation for slow zoom/pan, replacing the current FFmpeg `zoompan` look.
- Optional caption layer derived from existing SRT or chunk timing.
- Optional brand watermark/lower-third layer from the channel brand kit.
- Audio layers for narration, BGM, and SFX with explicit start, duration, volume, and track indexes.

The first implementation should use plain HTML, CSS, and minimal inline JavaScript. It should not depend on GSAP or catalog blocks until the basic render path is proven by tests and a local smoke render.

All story-derived text inserted into HTML, including captions, scene labels, title fragments, metadata snippets, and LLM-generated text, must be HTML-escaped before writing `index.html`. The composition is served only for inspection unless a Hyperframes preview runtime is explicitly added later; a raw `index.html` link must not be presented as proof of timed playback.

## Audio-Derived Visual Prompts

Before Hyperframes composition generation, the pipeline should derive a `visual-prompts.json` artifact from the approved naturalized script, TTS chunk timings, captions, and scenes. This stage is deterministic by default and can later accept an LLM enhancement behind the existing paid-request confirmation pattern. Its `sourceHash` is the SHA-256 hash of a canonical JSON payload containing the naturalized text hash, scene timing payload, TTS chunk timing payload, and caption payload used to build the cues.

Initial artifact shape:

```ts
type VisualPromptArtifact = {
  version: 1;
  sourceHash: string;
  cues: Array<{
    sceneId: string;
    startSeconds: number;
    endSeconds: number;
    narrationExcerpt: string;
    visualPrompt: string;
    mood: "calm" | "tense" | "mysterious" | "reveal" | "action";
    captionEmphasis: string[];
    motion: "slow-push" | "slow-pull" | "drift-left" | "drift-right" | "hold";
    overlayText: string;
  }>;
};
```

The deterministic generator should:

- Split the approved narration/caption content onto existing scene timing windows.
- Keep `narrationExcerpt` short and local-only; no full script duplication in the render manifest.
- Choose mood and motion from simple keyword/timing rules, with conservative defaults.
- Generate concise `visualPrompt` text for image/style guidance and composition comments.
- Generate `overlayText` only from words already present in the approved audio/script content.

The Hyperframes composition uses these cues for timed overlays, caption emphasis, motion class selection, and future image prompt handoff. This must not bypass the existing `scenes` and `images` stages; it enriches the render composition after media approval.

## Backend Components

Add a focused Hyperframes adapter under `src/story-factory/`:

- `hyperframes-composition.ts`
  - Pure functions for deriving composition data from story artifacts.
  - Pure HTML/frame/manifest generation.
  - Unit-tested without spawning Hyperframes.
- `visual-prompts.ts`
  - Pure deterministic generator from scenes, captions/TTS timings, and approved script text.
  - Writes `visual-prompts.json` as a render-adjacent artifact before Hyperframes composition.
  - Leaves a provider interface for later LLM enhancement, gated by paid confirmation.
- `hyperframes-renderer.ts`
  - Writes the composition workspace.
  - Runs Hyperframes CLI through the existing `runProcess` wrapper.
  - Applies `hyperframesTimeoutMinutes` through an `AbortController`-backed timeout.
  - Verifies the expected MP4 exists after render.
  - Returns output path and manifest details.
- `render-story.ts`
  - Keeps existing FFmpeg functions.
  - Adds an engine dispatch function or a new exported wrapper used by the pipeline.
- `pipeline.ts`
  - Chooses `ffmpeg` or `hyperframes` from config at the render stage.
  - Writes a render artifact whose downstream contract is unchanged.

The existing FFmpeg renderer remains available and test-covered. Shared helpers should stay pure where possible so command construction and HTML generation are easy to review.

## UI

Config screen:

- Add a Story render engine select: `FFmpeg` / `Hyperframes`.
- Add Hyperframes command and args fields next to FFmpeg settings.
- Show readiness warnings when Hyperframes is selected and no command is configured.

Story Factory Video tab:

- Display the engine used by the latest render.
- Link to the generated composition `index.html` for inspection when the render engine is Hyperframes.
- Keep the existing MP4 preview path and final approval behavior.

No marketing page or separate authoring app is added in this phase.

## Pipeline and Approval Behavior

The existing approval gates remain authoritative:

- Script approval before TTS.
- Media approval before render.
- Final approval before export.

Hyperframes must not run before media approval. Editing scenes/images/captions/audio-derived visual prompts invalidates render and final approval exactly like the FFmpeg path. Export still requires final approval anchored to the render hash.

`render.json` must add:

```ts
type RenderStageArtifact = {
  version: 1;
  videoPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  engine?: "ffmpeg" | "hyperframes";
  outputSha256?: string;
  compositionPath?: string;
};
```

The `engine` and `outputSha256` fields are part of the artifact hash used by final approval. That means a previously approved FFmpeg render cannot remain approved after a Hyperframes re-render, even if the relative `videoPath`, duration, width, and height are unchanged. Existing readers that only need `videoPath` remain compatible because the new fields are additive.

## Error Handling

The Hyperframes adapter should classify:

- Missing command or failed spawn: operator setup error.
- Non-zero CLI exit: render error with redacted stdout/stderr excerpt.
- Missing output MP4 after success: render error.
- Timed-out or aborted process: retryable/cancelled render error.

Diagnostics must redact environment variable values and avoid dumping full paths to secrets. No generated prompt or source story text should be sent to an external service by this render path.

## Tests

Add unit tests for:

- Default config keeps `storyEngine = "ffmpeg"`.
- Config save/load accepts `hyperframes` and rejects unknown engine values.
- Config save/load validates `hyperframesArgs` as a string array and `hyperframesTimeoutMinutes` as a bounded positive number.
- Composition generation produces root timing attributes, scene clips, audio tracks, and relative media references.
- Composition generation HTML-escapes every story-derived text field.
- Visual prompt generation derives scene cues from approved narration/caption content, clamps cue timing to narration duration, and never invents overlay text absent from source content.
- Hyperframes command construction uses config-owned command/args and does not accept request-owned executable input.
- Hyperframes command construction works on Windows without spawning `npx` directly.
- Hyperframes timeout aborts a hung render process and leaves no direct child process behind.
- Pipeline dispatch calls the Hyperframes renderer only when configured.
- Render artifact remains compatible with export/final QA expectations and changes its artifact hash when `engine` or `outputSha256` changes.
- UI exposes engine config and Video tab engine status.

Add one smoke validation step in the implementation report:

- Use a fake Hyperframes executable in tests for deterministic CI.
- If local Hyperframes is available, render a tiny 2-scene composition and record command/output path.

## Implementation Phases

1. Config and type support for `storyEngine`, `hyperframesCommand`, `hyperframesArgs`, and `hyperframesTimeoutMinutes`, plus pinned `hyperframes@0.8.13`.
2. Audio-derived visual prompt artifact generation.
3. Pure composition generation and manifest writing, including pinned Hyperframes package-version capture.
4. Hyperframes CLI adapter with fake-process tests.
5. Story Factory render-stage dispatch and unchanged downstream `render.json`.
6. Config UI and Video tab status.
7. Focused tests, typecheck, and implementation report.

## Risks

- Hyperframes CLI may change because the framework is active and evolving. The adapter isolates this to one file, pins `hyperframes@0.8.13`, records the package version in `manifest.json`, and uses config-owned command/args.
- Headless Chrome setup may fail on some machines. FFmpeg remains the default fallback engine.
- Long 20-40 minute stories may be slower or heavier than the current two-pass FFmpeg path. The first implementation should preserve FFmpeg for production reliability until smoke renders prove acceptable.
- HTML compositions can become hard to debug if too much logic is in inline JavaScript. The first implementation should keep composition generation data-driven and simple.

## Open Decisions

- Whether captions should be burned into the Hyperframes composition in phase one or kept as external SRT for upload. Recommendation: burn simple readable captions only when the channel config enables them; otherwise keep SRT external.
- Whether to add reusable style templates later. Recommendation: defer until one channel's render style has proven stable.
