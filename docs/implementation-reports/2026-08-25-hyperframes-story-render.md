# Hyperframes Story Render Implementation Report

Date: 2026-08-25
Branch: feature/hyperframes-story-render

## Summary

- Added pinned `hyperframes@0.8.13` as an optional story-render engine.
- Added render config for `render.storyEngine`, `render.hyperframesCommand`, `render.hyperframesArgs`, and `render.hyperframesTimeoutMinutes`.
- Added deterministic `visual-prompts` stage that derives scene cues from the approved naturalized narration, scene timing, and TTS chunk timing.
- Added Hyperframes composition generation under `workspace/render/hyperframes/` with escaped HTML/CSS and a manifest.
- Added a direct CLI renderer adapter that invokes `node ./node_modules/hyperframes/bin/hyperframes.mjs render --output ... .`, with timeout/abort handling and no `npx` wrapper.
- Wired the story pipeline so `render` depends on `visual-prompts` and can render with either FFmpeg or Hyperframes.
- Render artifacts now record `engine`, optional `outputSha256`, and optional `compositionPath`; final approval staleness remains anchored to the render artifact hash.
- Exposed the new render engine settings in Config and render provenance in the Story Factory video tab.

## Verification

- `npm run typecheck` passed.
- `node --test tests\\story-pipeline.test.ts tests\\hyperframes-renderer.test.ts tests\\hyperframes-composition.test.ts tests\\story-visual-prompts.test.ts tests\\web-phases.test.ts` passed.
- `node --test tests\\web.test.ts tests\\web-phases.test.ts` passed.
- `node --test --test-concurrency=1 tests\\*.test.ts` passed: 662/662.
- `npm ls hyperframes` reports `hyperframes@0.8.13`.
- `node -v` reports `v22.23.2`.

## Notes

- The default engine stays `ffmpeg`; Hyperframes is opt-in via Config.
- A default parallel `npm test` run can hit Windows/Node child-process resource limits in this repo; the same full suite passed with `--test-concurrency=1`.
- Real paid/provider generation was not exercised; tests use deterministic fakes for TTS, image generation, FFmpeg, and the Hyperframes CLI.
