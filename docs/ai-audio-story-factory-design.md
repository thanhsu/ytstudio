# AI Audio Story Factory — Design

Status: Phase 1 implemented (2026-08-23). This document records the architecture as built.

## Goal

Operate AI-generated audio-story YouTube channels with minimal human intervention. First channel: neutral Latin American Spanish (es-MX), horror/mystery/paranormal, 100% original fiction, 20–40 minute videos. The architecture hardcodes neither the language nor the niche — future channels (fr/it/de/en, other niches) are configuration, not code.

The pipeline: Idea → Hook → Outline → Story Bible → section-by-section writing → Continuity QA → Language Naturalizer → Originality/Safety QA → TTS normalization → chunked Google TTS → Scene extraction → Image generation → BGM plan → Video render → Metadata → Thumbnail → Final QA → READY_TO_PUBLISH → manual publish.

## Current architecture findings (at design time)

- Local-first Node ≥22.6 + TypeScript run natively; no DB (JSON files under `projects/`), no framework server (`src/server.ts`), vanilla-JS web UI, `node --test`.
- Reusable as-is: `llm/chat.ts` (OpenAI-compatible transport with paid-guard/redaction), `tts/*` (provider interface + content-hash cache), `jobs.ts` (1 job per owner + SSE), `project-state.ts` (hash-bound approvals), `project-paths.ts` (traversal guard), `process.ts`/`media.ts`/`render.ts` (ffmpeg), `srt.ts`/`captions.ts`, `config.ts` (section pattern, apiKeyEnv secrets), `review-project.ts` (nested-entity pattern).
- Absent: Google TTS, image generation, YouTube API/OAuth/analytics, cost persistence, token-usage capture, TTS chunking, zoompan.
- The legacy `src/audio-story.ts` module (series tab) is template-only — no LLM, no TTS. It is left untouched as a deprecated path; the factory uses disjoint routes and directories.

## Decisions

1. **Channel = existing SeriesProject + `story-channel.json` sidecar** (brand-kit pattern). No change to series.json.
2. **StoryProject** is a nested entity: `projects/<channelId>/stories/<storyId>/story.json` + one JSON artifact per stage + `workspace/` for media (gitignored).
3. **Status is derived, never stored**: `story.json` holds per-stage `StageRun` records; `deriveStoryStatus()` computes `DRAFT | IN_PROGRESS | GENERATING | AWAITING_APPROVAL | FAILED | BUDGET_PAUSED | READY_TO_PUBLISH | PUBLISHED`.
4. **Jobs reuse `ProjectJobManager` with ownerId = channelId**, so the existing SSE endpoint and UI stream work unchanged. Limitation: one running story job per channel (documented below).
5. **LLM = OpenAI-compatible transport only** (covers OpenAI/OpenRouter/Groq/DeepSeek/local; OpenRouter proxies Claude/Gemini). Three configurable roles: planner (idea/hook/outline/bible/scenes/metadata), writer (sections), qa (continuity/naturalize/originality).
6. **Images = Gemini image API** (`gemini-2.5-flash-image`) behind an `ImageProvider` interface; `images.provider: "disabled"` is a throwing default, never a placeholder frame.
7. **Publishing is manual in Phase 1**: export writes an upload-ready folder (mp4, thumbnail, captions, title/description/tags). YouTube OAuth/upload is Phase 2.
8. Zero new npm dependencies; all HTTP via injectable `fetch`.

## Data model

`projects/<channelId>/story-channel.json` — `StoryChannelConfig`: language, locale, niche, subNiches, promptStyle, defaultTargetDurationMinutes, mode (manual|assisted), ttsProfile {provider google, tier economy|standard|premium, voiceName, languageCode, speakingRate, pitch}, visualStyleProfile {stylePrompt, negativePrompt, imageIntervalSeconds, aspectRatio 16:9}, bgm {ambienceTrackPath, volumeDb}, pronunciations [{original, pronunciation}], budget {maxCostPerStoryUsd}.

`projects/<channelId>/story-channel/` — `costs.json` (channel ledger), `fingerprints.json` (minhash index for duplicate detection).

`projects/<channelId>/stories/<storyId>/`:

| File | Content |
|---|---|
| `story.json` | id, config snapshot, `stages: Record<stage, StageRun>`, hash-bound `approvals` (script/media/final) |
| `idea.json` | logline, premise, themes, whyItWorks, duplicateCheck |
| `hook.json` | hookText (first ~30s), altHooks, estimatedSeconds |
| `outline.json` | sections [{index, title, goal, beats, targetWords}] |
| `bible.json` | setting, characters, timeline, locations, supernaturalRules, knownFacts, openQuestions, endingConstraints — patched after every section |
| `sections/section-NNN.json` | per-section text + bibleUpdates + provenance |
| `script.json` | assembled fullText, per-section hashes, sourceHash |
| `continuity-report.json` / `originality-report.json` / `final-qa.json` | QA verdicts |
| `naturalized.json` | locale-natural fullText (the text TTS reads); the script approval anchors to this artifact's hash |
| `tts-normalized.json` | pronunciations + TTS punctuation applied (stored script never altered) |
| `tts-chunks.json` | chunk manifest: per-chunk text, cacheKey, duration, status, attempts |
| `scenes.json` / `images.json` / `bgm.json` / `render.json` / `thumbnail.json` / `metadata.json` / `export.json` | media stage artifacts |
| `cost.json` / `ai-log.jsonl` | per-story spend ledger; append-only AI execution log |
| `workspace/{voice,images,thumbnail,render,export}/` | generated media (gitignored) |

`StageRun`: status (pending|running|done|failed|stale|awaiting-approval), attemptCount, lastError {message, classification: retryable|provider|quota|content|budget}, costUsd, provider/model/promptVersion, artifactHash.

Chunk audio lives in the CHANNEL's `workspace/voice/` cache keyed by content hash, so identical chunks are shared across stories and re-renders/retries are free.

## Workflow / state machine

Stage order: idea → hook → outline → bible → sections → continuity-qa → naturalize → originality-qa → tts-normalize → tts → scenes → images → bgm → render → metadata → thumbnail → final-qa → (export, human-only).

Dependency graph (invalidation): editing an artifact marks all transitive dependents `stale` (metadata → only thumbnail/final-qa/export; never media). Stale stages re-run cheaply: unchanged TTS chunk text hits the cache, unchanged image prompts keep their files.

Gates (AGENTS.md human-approval rule):
- `script` approval before tts-normalize — anchored to the naturalized artifact hash.
- `media` approval before render — anchored to the images manifest hash.
- `final` approval before export — anchored to the render hash.
- ASSISTED mode auto-grants script/media only when their QA actually passed (originality publishable; all images done). Export is ALWAYS a human click.
- MANUAL mode parks the gated stage `awaiting-approval` and the job ends cleanly.

Failure classification: BudgetExceededError → budget (derived status BUDGET_PAUSED); StoryContentError (duplicate idea, failed QA, safety block) → content; 429/quota → quota; network/5xx → retryable; parse/validation → provider. Re-running the pipeline resumes from the failed stage; chunk 17 retries alone; image #7 retries alone; section 5 regenerates alone.

## AI stages

Each stage: pure prompt builder (versioned module under `prompts/`) → `runLlmCall` (endpoint by role, paid-guard, abort-safe) → pure parser (validates before anything is written) → artifact + hash. Every call appends to `ai-log.jsonl` (promptName, promptVersion, model, measured tokens, cost, duration, ok/error) and adds measured cost to the ledger.

Prompt language pattern: JSON structure and field names in English; all creative output demanded in the channel language/locale. The naturalizer is a locale parameter, not Spanish-specific code (its prompt targets `{{language}} ({{locale}})`); locale-keyed text normalizations (e.g. `%` → "por ciento") live in `tts-normalize.ts` steps.

Duplicate detection: minhash signatures (128-perm, 5-token shingles) of idea and final script, compared against the channel index; a flagged idea regenerates once with the collision named, then fails as content. Originality QA merges the local fingerprint verdict with an LLM review for franchise resemblance and content safety.

## TTS architecture

Google Cloud TTS over REST (`text:synthesize`, key in `X-Goog-Api-Key` header; `/voices` for the catalog). Quality tiers map to voice-name families in config (`tierVoicePrefixes`), prices per tier are config-editable and marked approximate. Chunking: sentence-boundary greedy packing between `chunkMinChars`/`chunkMaxChars` (≤4800, under Google's 5000-byte limit); each chunk cached by hash(text+voice+locale+rate+pitch+format); merge via ffmpeg concat demuxer + `loudnorm=I=-16:TP=-1.5:LRA=11` → m4a; captions built per-chunk from measured durations and offset into one SRT. Fallback stays within the configured tier — never a silent upgrade to premium.

Voice Lab: list voices per locale with tier badges, generate capped 500-char samples (cached), set the winner as the channel default.

## Rendering

One slow zoom/pan (Ken Burns) segment per scene image — pre-upscaled `scale=7680:-2` against zoompan jitter, alternating in/out, 0.5s fades — encoded separately and stitched with the concat demuxer (two-pass, no 30-minute filtergraph), then muxed with the narration and an optional looped licensed ambience bed at low volume (`amix duration=first`, narration dominant). 1920×1080 from `render.longformWidth/Height`. Scene timings estimated from word count are rescaled onto the measured narration duration. Crossfades (xfade) deferred to Phase 2.

Thumbnail: generated background (prompt appends "no text, no letters…") + deterministic ffmpeg drawtext overlay (2–5 words from metadata). Metadata edits reuse the paid background layer.

## API

Mounted under `/api/series/:channelId/` (mutations 404 `story-factory-disabled` until `storyFactory.enabled`):

- `GET|PUT story-channel`
- `GET|POST stories`; `GET|PATCH stories/:id`
- `GET|PUT stories/:id/artifacts/:stage` (PUT: editable stages idea/hook/outline/bible/naturalize/metadata; returns `invalidated[]`)
- `POST stories/:id/pipeline/run` `{toStage?, confirmedPaidRequest}` → 202 `story-pipeline` job (progress on the existing `/api/projects/:channelId/events` SSE stream)
- `POST stories/:id/stages/:stage/run` `{regenerate?, sectionIndex?, confirmedPaidRequest}` → 202
- `POST stories/:id/tts/chunks/:index/retry`, `POST stories/:id/images/:sceneId/retry` → 202
- `POST stories/:id/approve/:approval` (script|media|final; 409 `approval-anchor-missing`)
- `POST stories/:id/export` (409 `approval-required` with the missing list)
- `GET stories/:id/ai-log`, `GET stories/:id/cost`
- `GET voice-lab/voices?languageCode=`, `POST voice-lab/sample`

Story files serve through the existing `GET /api/projects/:channelId/files/<rel>` route.

## Frontend

Full-screen screens (the Sources pattern) behind the "Story Factory" nav button / `#story-factory` hash: dashboard (channel picker, status filter, create form, cost column), story detail (tabs: Overview / Idea / Hook / Outline / Bible / Script / Audio / Scenes / Images / Video / Thumbnail / Metadata / AI Logs / Cost; per-stage Run/Retry/Regenerate; hash-bound approvals; export), channel settings, and the Voice Lab. Config screen gains Story Factory, Google TTS, and Images sections.

## Impacted files

New: `src/story-factory/**` (types, paths, channel, story-project, pipeline, stage-llm, stages/*, prompts/*, fingerprint(+index), ai-log, cost, tts-normalize, tts-chunking, bgm, render-story, thumbnail, export, voice-lab, routes, errors), `src/tts/google.ts`, `src/images/{types,gemini}.ts`, 15 test files.
Modified: `src/llm/chat.ts` (usage capture), `src/llm/parse.ts` (exported validators), `src/tts/{types,cache}.ts` (locale/pitch/model in requests+keys, old keys stable), `src/jobs.ts` (3 job kinds), `src/config.ts` (3 sections), `src/server.ts` (dispatch), `src/render.ts` (exported escape helpers), `src/web/*`.
No DB migrations — file-based; all new files are versioned (`version: 1`) with defensive normalizers.

## Phases

- **Phase 1 (done)**: everything above.
- **Phase 2**: YouTube OAuth + Data API upload; analytics snapshots (24h/72h/7d/28d); ContentPerformanceProfile + feedback into the idea generator (70/30 proven/exploration); CompilationProject (4–6 stories, reusing narration/images); scheduling + budget calendars; native Anthropic/Gemini chat adapters; xfade transitions; SFX events; prompt-management UI; per-section HTTP editing; parallel jobs per channel (composite owner ids).
- **Phase 3**: autonomous mode, multi-language localization projects, title/thumbnail experiments, ROI-based generation.

## Risks and accepted limitations

- One running story job per channel (ownerId = channelId): a long render blocks that channel's other stories. Different channels run in parallel.
- Gemini image / Google TTS response field names verified against fake-driven tests; a live API drift throws with a redacted excerpt and is fixed in one provider file.
- Pricing is seeded approximate and config-editable; usage may be null on local LLM servers (cost recorded 0, calls still logged).
- LLM budget pre-check uses spent-so-far (estimate 0); TTS/images check concrete estimates before spending. A single very expensive LLM call can overshoot the budget by one call.
- Scene timings are word-count estimates rescaled to real audio — per-scene forced alignment is Phase 2+.
- Legacy `src/audio-story.ts` remains (deprecated); its known path bug (`join("projects",…)`) is not repeated in the factory, which guards every path through `resolveProjectPath` plus a story-dir traversal check.

## Pending decisions

- Whether ASSISTED should also auto-grant `final` after a passing final-qa (currently never — export always needs a human).
- Compilation chapter markers / intro voice for Phase 2.
- Whether to promote a canonical locale type across the older modules (translation/ASR/brief) — out of scope here.
