# Hyperframes Story Render Design

Status: approved direction, design for implementation plan.

## Goal

Add a Hyperframes-based render path for AI Audio Story Factory videos while keeping the existing FFmpeg renderer as the stable fallback. The target output remains a local, upload-ready MP4 for original audio-story channels.

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
3. The Hyperframes engine consumes only approved local story artifacts: `scenes.json`, `images.json`, narration audio, captions, BGM, SFX events, brand/channel settings, and render dimensions.
4. Hyperframes compositions are generated into the story workspace, not committed source, because they are derived render artifacts.
5. The pipeline writes the same `render.json` shape used by export, final QA, and YouTube publishing. Downstream stages do not need to know which engine produced the MP4.
6. Hyperframes failures are classified as render failures and must include redacted, operator-readable diagnostics. The pipeline must not silently fall back inside the same run, because that hides quality and environment problems. The operator can switch the config back to `ffmpeg` and retry.

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
}
```

Defaults:

- `storyEngine: "ffmpeg"`
- `hyperframesCommand: "npx"`
- `hyperframesArgs: ["hyperframes"]`

The command is operator-owned config, matching the current FFmpeg and yt-dlp pattern. HTTP requests must never accept executable paths or arbitrary command args.

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

`manifest.json` records source artifact hashes, engine version if detectable, dimensions, duration, scene timing, and output path. `frame.md` captures the channel visual rules for the generated composition and can later support reusable style profiles.

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

## Backend Components

Add a focused Hyperframes adapter under `src/story-factory/`:

- `hyperframes-composition.ts`
  - Pure functions for deriving composition data from story artifacts.
  - Pure HTML/frame/manifest generation.
  - Unit-tested without spawning Hyperframes.
- `hyperframes-renderer.ts`
  - Writes the composition workspace.
  - Runs Hyperframes CLI through the existing `runProcess` wrapper.
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
- Link to the generated composition `index.html` when the render engine is Hyperframes.
- Keep the existing MP4 preview path and final approval behavior.

No marketing page or separate authoring app is added in this phase.

## Pipeline and Approval Behavior

The existing approval gates remain authoritative:

- Script approval before TTS.
- Media approval before render.
- Final approval before export.

Hyperframes must not run before media approval. Editing scenes/images/captions invalidates render and final approval exactly like the FFmpeg path. Export still requires final approval anchored to the render hash.

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
- Composition generation produces root timing attributes, scene clips, audio tracks, and relative media references.
- Hyperframes command construction uses config-owned command/args and does not accept request-owned executable input.
- Pipeline dispatch calls the Hyperframes renderer only when configured.
- Render artifact remains compatible with export/final QA expectations.
- UI exposes engine config and Video tab engine status.

Add one smoke validation step in the implementation report:

- Use a fake Hyperframes executable in tests for deterministic CI.
- If local Hyperframes is available, render a tiny 2-scene composition and record command/output path.

## Implementation Phases

1. Config and type support for `storyEngine`, `hyperframesCommand`, and `hyperframesArgs`.
2. Pure composition generation and manifest writing.
3. Hyperframes CLI adapter with fake-process tests.
4. Story Factory render-stage dispatch and unchanged downstream `render.json`.
5. Config UI and Video tab status.
6. Focused tests, typecheck, and implementation report.

## Risks

- Hyperframes CLI may change because the framework is active and evolving. The adapter isolates this to one file and uses config-owned command/args.
- Headless Chrome setup may fail on some machines. FFmpeg remains the default fallback engine.
- Long 20-40 minute stories may be slower or heavier than the current two-pass FFmpeg path. The first implementation should preserve FFmpeg for production reliability until smoke renders prove acceptable.
- HTML compositions can become hard to debug if too much logic is in inline JavaScript. The first implementation should keep composition generation data-driven and simple.

## Open Decisions

- Whether to install Hyperframes as a dev dependency or rely on `npx hyperframes` from config. Recommendation: start with config/`npx` to avoid expanding dependencies until smoke validation is good.
- Whether captions should be burned into the Hyperframes composition in phase one or kept as external SRT for upload. Recommendation: burn simple readable captions only when the channel config enables them; otherwise keep SRT external.
- Whether to add reusable style templates later. Recommendation: defer until one channel's render style has proven stable.
