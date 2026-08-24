# AI Audio Story Factory — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 2 of the story factory: parallel story jobs, native Anthropic/Gemini adapters, per-section editing, xfade transitions + SFX events, prompt overrides + management UI, YouTube OAuth + upload + analytics snapshots, performance-profile feedback into the idea generator, scheduling/budget calendars, and compilation projects.

**Architecture:** Everything extends the Phase 1 patterns: JSON artifacts with hash anchors under `projects/<channelId>/`, `ProjectJobManager` jobs + SSE, config sections in `studio.config.json` with defensive normalizers, injectable `fetch`/providers for tests, zero new npm dependencies. New YouTube modules live in `src/youtube/`; all other work extends `src/story-factory/`, `src/llm/`, `src/config.ts`, `src/server.ts`, `src/web/app.js`.

**Tech Stack:** Node ≥22.6 native TypeScript, `node --test`, vanilla-JS web UI, ffmpeg via `runProcess`, REST via global `fetch`.

**Spec:** `docs/ai-audio-story-factory-design.md` (Phase 2 bullet in "Phases" section). This plan is the detailed decomposition of that bullet list.

## Global Constraints

- Zero new npm dependencies; all HTTP through injectable `fetch` (test with fake fetch, never live calls).
- Node `>=22.6.0`; run tests with `node --test tests/<file>.test.ts`; typecheck with `npm run typecheck` (`tsc --noEmit`). Both must pass before every commit.
- All new JSON files carry `version: 1` and a defensive normalizer that survives missing/garbage fields.
- Paths only through `resolveProjectPath` / `storyPath` / `channelStoryFactoryPath` — never hand-joined `join("projects", …)`.
- Paid API calls require `confirmedPaidRequest` explicitly; secrets only as `…Env` env-var names in config, never literal keys.
- Mutating story-factory routes stay behind `config.storyFactory.enabled` (the existing gate in `routeStoryFactory`).
- Export/publish are human clicks, never pipeline stages (AGENTS.md approval rule).
- Work on branch `feature/story-factory-phase2`. Commit after every task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Follow existing code style: file-header block comments explaining *why*, sparse inline comments stating constraints only.

## Execution order and dependencies

```
Task 1  composite job owners          (infra; unblocks 8, 12)
Task 2  anthropic + gemini adapters   (independent)
Task 3  per-section editing           (independent)
Task 4  xfade transitions             (independent)
Task 5  SFX events                    (after 4 — same files)
Task 6  prompt overrides backend      (independent)
Task 7  YouTube OAuth                 (independent)
Task 8  upload + publish stage        (needs 1, 7)
Task 9  analytics snapshots           (needs 8)
Task 10 performance profile + idea feedback (needs 9)
Task 11 scheduling + budget calendar  (needs 8 for publishAt prefill; budget part independent)
Task 12 compilations                  (needs 1; render/export reuse)
Task 13 web UI: publish/analytics/section editing
Task 14 web UI: prompts, calendar, compilations, config additions
Task 15 docs update + final QA sweep
```

---

### Task 1: Parallel story jobs per channel (composite owner ids)

**Files:**
- Modify: `src/jobs.ts`
- Modify: `src/story-factory/routes.ts` (pass owner suffix)
- Modify: `src/server.ts` (`startProjectJob` accepts composite owner; SSE unchanged)
- Test: `tests/jobs.test.ts` (add cases), `tests/story-server.test.ts` (add case)

**Interfaces:**
- Produces: composite owner id format `"<channelId>::<suffix>"` (`::` can never appear in a valid project id, so no collision). New export in `src/jobs.ts`:
  ```ts
  export function ownerChannel(ownerId: string): string; // "ch::st" -> "ch", "ch" -> "ch"
  export function compositeOwner(channelId: string, suffix: string): string; // -> "ch::st"
  ```
- `ProjectJobManager` behavior changes:
  - `jobsDir(ownerId)` persists under `join(root, ownerChannel(ownerId), "workspace", "jobs")` so composite ids never create a `ch::st` directory.
  - `emit(ownerId, record)` notifies listeners subscribed to the full `ownerId` **and** (when composite) listeners subscribed to `ownerChannel(ownerId)` — so the existing per-channel SSE stream receives all story jobs unchanged.
  - `recoverInterrupted(channelId)` already reads the channel jobs dir; records with composite `projectId` recover fine (no change needed, but the test proves it).
- `StoryFactoryTools.startChannelJob` gains a third parameter: `startChannelJob(kind, operation, ownerSuffix?: string)`. `src/server.ts` maps it to `startProjectJob(response, ownerSuffix ? compositeOwner(seriesId, ownerSuffix) : seriesId, kind, operation)`.
- `routes.ts`: every story job start (`pipeline/run`, `stages/:stage/run`, chunk retry, image retry) passes `ownerSuffix: storyId`. Two different stories on one channel now run concurrently; the same story still 409s.

- [ ] **Step 1: Write failing tests** in `tests/jobs.test.ts`:
  - `ownerChannel("ch::st") === "ch"`, `ownerChannel("ch") === "ch"`, `compositeOwner("ch","st") === "ch::st"`.
  - Two jobs with owners `ch::a` and `ch::b` run concurrently (both `start` calls succeed); a second `start` on `ch::a` while running throws.
  - A listener subscribed to `"ch"` receives events emitted for owner `"ch::a"`; a listener on `"ch::a"` also receives them.
  - Job records for owner `ch::a` are persisted under `<root>/ch/workspace/jobs/`.
- [ ] **Step 2: Run tests, verify FAIL** (`node --test tests/jobs.test.ts`).
- [ ] **Step 3: Implement** the helpers + `jobsDir`/`emit` changes in `src/jobs.ts`; thread `ownerSuffix` through `StoryFactoryTools` type, `routes.ts` call sites, and `server.ts`.
- [ ] **Step 4: Run tests + typecheck, verify PASS** (`node --test tests/jobs.test.ts tests/story-server.test.ts && npm run typecheck`).
- [ ] **Step 5: Commit** `feat: run story jobs in parallel per channel via composite job owners`

### Task 2: Native Anthropic and Gemini chat adapters

**Files:**
- Create: `src/llm/anthropic.ts`, `src/llm/gemini.ts`
- Modify: `src/config.ts` (`LlmEndpointConfig` gains `provider`), `src/story-factory/stage-llm.ts` (dispatch by provider)
- Test: `tests/llm-anthropic.test.ts`, `tests/llm-gemini.test.ts`, `tests/config.test.ts` (provider normalization), `tests/story-stages.test.ts` (unchanged — proves default path still works)

**Interfaces:**
- `LlmEndpointConfig` gains `provider: "openai-compatible" | "anthropic" | "gemini"` (default `"openai-compatible"`; `enumValue` in the normalizer; default baseUrl stays as-is — operators set `https://api.anthropic.com` / `https://generativelanguage.googleapis.com/v1beta` themselves).
- Both adapters implement the exact `ChatFn` signature from `stage-llm.ts` (`(config: OpenAiCompatibleConfig, messages, options) => Promise<ChatResult>`), reusing the paid-guard and missing-key rules from `chat.ts` (same semantics: paid without confirmation throws; configured-but-empty apiKeyEnv throws).
- `src/llm/anthropic.ts` — `export async function anthropicChat(config, messages, options): Promise<ChatResult>`:
  - Endpoint `${baseUrl.replace(/\/+$/,"")}/v1/messages`, headers `{"x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json"}`.
  - Body: `{ model, max_tokens: maxOutputTokens, temperature, system: <all system messages joined "\n\n">, messages: <non-system, roles user|assistant> }`.
  - Response: `content` array — concatenate all `type === "text"` blocks; `usage: {input_tokens, output_tokens}` → `ChatUsage`. Empty text → same "no usable message content" error style as chat.ts, with `redact` + 400-char truncation.
- `src/llm/gemini.ts` — `export async function geminiChat(config, messages, options): Promise<ChatResult>`:
  - Endpoint `${baseUrl}/models/${model}:generateContent`, header `{"x-goog-api-key": apiKey}`.
  - Body: `{ systemInstruction: {parts:[{text}]}, contents: [{role: "user"|"model", parts:[{text}]}], generationConfig: {temperature, maxOutputTokens, responseMimeType: "application/json"} }` (assistant→model).
  - Response: `candidates[0].content.parts[].text` joined; `usageMetadata {promptTokenCount, candidatesTokenCount, totalTokenCount}` → `ChatUsage` (null when absent).
- `stage-llm.ts`: `const chat = options.chat ?? chatFnFor(options.endpoint.provider)` where `chatFnFor` returns `anthropicChat` / `geminiChat` / `chatJsonWithUsage`. Provenance + ai-log `provider` field becomes `options.endpoint.provider` instead of the literal `"openai-compatible"`.

- [ ] **Step 1: Write failing tests** with fake `fetch` (config.fetch): correct URL/headers/body mapping for each adapter (system extraction, role mapping, responseMimeType), content + usage parsing, usage-absent → null, API error body → thrown message with status, paid-guard throw, abort passthrough.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement** both adapters + config normalizer + dispatch.
- [ ] **Step 4: Run tests + typecheck, verify PASS** (`node --test tests/llm-anthropic.test.ts tests/llm-gemini.test.ts tests/config.test.ts tests/story-stages.test.ts && npm run typecheck`).
- [ ] **Step 5: Commit** `feat: add native Anthropic and Gemini chat adapters for story-factory roles`

### Task 3: Per-section HTTP editing

**Files:**
- Create: `src/story-factory/section-edit.ts`
- Modify: `src/story-factory/routes.ts` (GET `sections`, GET/PUT `sections/:index`)
- Test: `tests/story-section-edit.test.ts`

**Interfaces:**
- Consumes: `sections/section-NNN.json` files (`SectionArtifact`) and `script.json` (`ScriptArtifact`) written by `src/story-factory/stages/sections.ts` — read that stage first and REUSE its script-assembly logic (extract a shared `assembleScriptArtifact(sections: SectionArtifact[]): ScriptArtifact` into `section-edit.ts` or export it from the stage; do not duplicate the hashing).
- Produces in `section-edit.ts`:
  ```ts
  export async function listSections(channelId, storyId): Promise<SectionArtifact[]>;
  export async function readSection(channelId, storyId, index: number): Promise<SectionArtifact | null>;
  export async function editSectionText(channelId, storyId, index: number, text: string): Promise<{ section: SectionArtifact; invalidated: StoryStageId[] }>;
  ```
  `editSectionText` updates `text` + `wordCount` on the section file, reassembles and rewrites `script.json` through `writeStageArtifact(channelId, storyId, "sections", …)` (so the artifact hash moves honestly), then `invalidateDependents(story, "sections")` + `saveStory`. Empty/whitespace text throws.
- Routes (inside `routeStory`):
  - `GET sections` → `{ok, sections: [{index, title, wordCount}]}`
  - `GET sections/:index` → `{ok, section}` (404 `section-not-found`)
  - `PUT sections/:index` body `{text}` → `{ok, section, invalidated}` (400 `section-text-required`)

- [ ] **Step 1: Write failing tests**: seed a temp channel/story (copy the seeding pattern from `tests/story-project.test.ts`) with 2 section files + script.json; `editSectionText` updates the section file, rewrites `script.json` fullText/hashes, marks `continuity-qa`/`naturalize`/`scenes`/… stale; rejects empty text; `readSection` returns null for missing index.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement** module + routes.
- [ ] **Step 4: Run tests + typecheck, verify PASS** (include `tests/story-server.test.ts`).
- [ ] **Step 5: Commit** `feat: edit individual story sections over HTTP with honest invalidation`

### Task 4: xfade transitions

**Files:**
- Modify: `src/story-factory/render-story.ts`, `src/config.ts` (render section), `src/story-factory/pipeline.ts` (thread the setting)
- Test: `tests/story-render.test.ts` (add cases), `tests/config.test.ts`

**Interfaces:**
- Config `render` gains `storyTransition: "fade" | "xfade"` (default `"fade"` — current behavior unchanged) and `storyTransitionSeconds: number` (default 0.5, range 0.1–2).
- `RenderStoryOptions` gains `transition?: { kind: "fade" | "xfade"; seconds: number }`.
- xfade mode:
  - Each segment is encoded WITHOUT per-segment fade in/out (keep fade-in on first segment and fade-out on last only), and every segment except the last is encoded `transitionSeconds` LONGER than its scene duration — the overlap consumed by xfade — so total video duration still equals narration duration.
  - New pure builder:
    ```ts
    export function buildXfadeTimelineArgs(
      segmentNames: string[],            // relative file names, cwd = temp dir
      segmentDurations: number[],        // encoded durations (already includes the +T padding)
      transitionSeconds: number,
      outputName: string,
    ): string[];
    ```
    Filtergraph chains pairwise: `[0:v][1:v]xfade=transition=fade:duration=T:offset=O1[x1];[x1][2:v]xfade=…:offset=O2[x2];…` with `O1 = d0 - T`, `O_i = O_{i-1} + d_i - T`. Map the last label, re-encode `libx264 -preset ultrafast -pix_fmt yuv420p -r 30`. Single-segment input returns a plain copy command.
  - `renderStoryVideo` picks concat-copy (fade) vs the xfade single pass; the mux step is unchanged.
- `runRenderStage` passes `transition` from `ctx.config.render`.

- [ ] **Step 1: Write failing tests** (pure-args tests, no ffmpeg run — same style as existing `story-render.test.ts`): offsets computed per the formula for 3 segments; padding applied to all but last segment in `buildStorySegments`-equivalent path; fade filters present only on first/last; single segment degenerates to copy; config normalizer defaults/ranges.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit** `feat: optional xfade crossfades between story scenes`

### Task 5: SFX events

**Files:**
- Modify: `src/story-factory/types.ts` (`BgmPlan` v1 stays; add `events`), `src/story-factory/bgm.ts`, `src/story-factory/channel.ts` (bgm normalizer), `src/story-factory/render-story.ts` (mux args), `src/story-factory/pipeline.ts` (pass scene starts)
- Test: `tests/story-render.test.ts`, `tests/story-channel.test.ts` (add cases)

**Interfaces:**
- `StoryChannelConfig.bgm` gains:
  ```ts
  sfx: {
    sceneChange: { path: string; volumeDb: number } | null;  // stinger at every scene boundary
    events: Array<{ path: string; atSeconds: number; volumeDb: number }>; // fixed cues (e.g. intro at 0)
  }
  ```
  (normalizer defaults: `{ sceneChange: null, events: [] }`; old channel files load unchanged).
- `BgmPlan` gains `events?: Array<{ path: string; atSeconds: number; volumeDb: number }>`.
- `buildBgmPlan(channel, totalDurationSeconds, sceneStartSeconds?: number[])` adds one event per interior scene start when `sceneChange` is set (skip 0), clamps events beyond duration, plus the fixed `events` list. `runBgmStage` reads `scenes.json` (already scaled? — scenes are unscaled estimates at bgm time; use unscaled starts × the same rescale done in render… **simpler and correct**: compute events in `runRenderStage` where the scale factor already exists, passing `scaledSceneStarts` into `buildBgmPlan` is impossible since bgm runs before render — therefore: `buildBgmPlan` stores `sceneChange` config verbatim in the plan (`plan.sceneChangeSfx`), and `runRenderStage` expands it into concrete `events` using the scaled scene starts before calling `renderStoryVideo`). Lock this: `BgmPlan = { version: 1; tracks: […]; sceneChangeSfx: {path, volumeDb} | null; events: [{path, atSeconds, volumeDb}] }` where `events` from config are copied verbatim and scene-change expansion happens in the render stage.
- `buildStoryMuxArgs`: each event adds an input `-i <path>`; filter per event `[<n>:a]adelay=<ms>:all=1,volume=<db>dB[s<k>]`; final mix `amix=inputs=<2+K>:duration=first:normalize=0` (narration first, `normalize=0` keeps narration level; with no bed, inputs=1+K). No events and no bed → current passthrough mapping.

- [ ] **Step 1: Write failing tests**: mux args with 1 bed + 2 events contain two `adelay` filters with correct ms and `normalize=0`; events without bed; neither → passthrough; channel normalizer round-trips sfx and defaults old files; render stage expands sceneChangeSfx at scaled starts (pure function test: `expandSceneChangeEvents(sceneStarts, scale, sfx) → events`).
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit** `feat: SFX event cues mixed into the story soundtrack`

### Task 6: Prompt overrides (backend)

**Files:**
- Create: `src/story-factory/prompt-overrides.ts`
- Modify: every module in `src/story-factory/prompts/` except `template.ts`/`context.ts` (extract each system prompt into an exported `…_TEMPLATE` with `{{context}}` and stage-specific `{{slots}}`), `src/story-factory/stages/context.ts` (`StageContext.promptOverrides`), `src/story-factory/pipeline.ts` (load overrides in `buildStageContext`), `src/story-factory/routes.ts` (+ prompts routes)
- Test: `tests/story-prompt-overrides.test.ts`

**Interfaces:**
- Storage `story-channel/prompt-overrides.json`:
  ```ts
  export type PromptOverrides = { version: 1; entries: Record<string, { system: string; updatedAt: string }> };
  export async function loadPromptOverrides(channelId): Promise<PromptOverrides>;
  export async function savePromptOverride(channelId, name: string, system: string): Promise<PromptOverrides>; // empty system deletes
  ```
- Each prompt module refactor (mechanical, 10 modules: idea, hook, outline, bible, sections, continuity-qa, naturalize, originality-qa, scenes, metadata):
  - `export const IDEA_SYSTEM_TEMPLATE = "…{{context}}…{{jsonRule}}…"` — the exact current text with `renderStoryContext(context)` replaced by `{{context}}` and `JSON_ONLY_RULE` by `{{jsonRule}}`; stage-specific dynamic blocks stay in the USER message (they already are — verify per module; where a dynamic value sits in system text today, hoist it to a named `{{slot}}` and document it in the catalog).
  - Builder signature gains a final optional param `overrides?: PromptOverrides`; system text = `interpolate(override?.system ?? DEFAULT_TEMPLATE, vars)`.
  - When overridden, the stage's `promptVersion` becomes `` `${VERSION}+custom.${sha256(override.system).slice(0,8)}` `` — provenance stays honest. Implement once: `export function resolvePromptSystem(overrides, name, defaultTemplate, defaultVersion, vars): { system: string; version: string }` in `prompt-overrides.ts`; every builder calls it.
- `PROMPT_CATALOG`: `export const PROMPT_CATALOG: Array<{ name: string; version: string; template: string; variables: string[] }>` — built from the modules' exports, used by the API.
- Routes: `GET /api/series/:channelId/prompts` → `{ok, prompts: [{name, version, template, variables, override: string|null, overrideVersion: string|null}]}`; `PUT /api/series/:channelId/prompts/:name` body `{system}` (unknown name → 404 `unknown-prompt`; system with an unknown `{{var}}` → 400 `unknown-variable`, validated against the catalog's variables list).

- [ ] **Step 1: Write failing tests**: default build unchanged byte-for-byte for idea + sections (regression guard); override replaces system and flips version to `+custom.<hash8>`; unknown variable rejected on save; empty save deletes; catalog lists all 10 prompts with non-empty variables.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement** (do idea first end-to-end, then the mechanical 9; keep `tests/story-stages.test.ts` green throughout).
- [ ] **Step 4: Run full story test suite + typecheck** (`node --test tests/story-*.test.ts && npm run typecheck`).
- [ ] **Step 5: Commit** `feat: channel-level prompt overrides with honest version stamps`

### Task 7: YouTube OAuth

**Files:**
- Create: `src/youtube/oauth.ts`, `src/youtube/token-store.ts`
- Modify: `src/config.ts` (new `youtube` section), `src/server.ts` (3 routes + callback)
- Test: `tests/youtube-oauth.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Config section:
  ```ts
  youtube: {
    clientIdEnv: string;      // default "YOUTUBE_CLIENT_ID"
    clientSecretEnv: string;  // default "YOUTUBE_CLIENT_SECRET"
    scopes: string[];         // default ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]
  }
  ```
- `src/youtube/oauth.ts` (pure + fetch-injected; Google endpoints hardcoded consts `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`):
  ```ts
  export function buildAuthUrl(o: { clientId: string; redirectUri: string; scopes: string[]; state: string }): string; // access_type=offline&prompt=consent
  export async function exchangeCode(o: { clientId; clientSecret; redirectUri; code; fetch? }): Promise<TokenResponse>;
  export async function refreshAccessToken(o: { clientId; clientSecret; refreshToken; fetch? }): Promise<TokenResponse>;
  export type TokenResponse = { accessToken: string; refreshToken?: string; expiresAt: string; scope: string };
  ```
- `src/youtube/token-store.ts`: tokens at `resolveProjectPath(channelId, "workspace", "youtube", "tokens.json")` (workspace is gitignored — VERIFY `.gitignore` covers `projects/*/workspace/` and add if not):
  ```ts
  export type StoredTokens = { version: 1; refreshToken: string; accessToken: string; expiresAt: string; scope: string; connectedAt: string };
  export async function loadTokens(channelId): Promise<StoredTokens | null>;
  export async function saveTokens(channelId, tokens): Promise<void>;
  export async function clearTokens(channelId): Promise<void>;
  export async function getFreshAccessToken(channelId, config, fetchImpl?): Promise<string>; // refreshes when < 60s left, persists
  ```
- Server routes:
  - `GET /api/series/:channelId/youtube/status` → `{ok, connected, scope?, connectedAt?, configured}` (`configured` = both env vars non-empty).
  - `POST /api/series/:channelId/youtube/connect` body `{redirectBaseUrl?}` → `{ok, authUrl}`; `state` = `<channelId>.<randomUUID()>` kept in an in-module `Map<state, channelId>` (single-process local server; entries expire after 10 min).
  - `GET /api/youtube/oauth/callback?code&state` → exchanges, saves tokens, responds tiny HTML "YouTube connected — you can close this tab." Unknown state → 400.
  - `POST /api/series/:channelId/youtube/disconnect` → clears tokens.
  - redirectUri = `${redirectBaseUrl ?? "http://127.0.0.1:3000"}/api/youtube/oauth/callback`.

- [ ] **Step 1: Write failing tests** (fake fetch): auth URL carries client_id/redirect_uri/scope/state/access_type=offline/prompt=consent; exchange/refresh post correct form bodies and parse tokens (expiresAt computed from expires_in); token store round-trip + clear; `getFreshAccessToken` returns stored token when fresh, refreshes + persists when expired; error body from Google → thrown redacted message.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement** modules + routes + config; check/patch `.gitignore`.
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit** `feat: per-channel YouTube OAuth with local callback and token refresh`

### Task 8: YouTube upload + publish stage

**Files:**
- Create: `src/youtube/upload.ts`
- Modify: `src/story-factory/types.ts` (add `"publish"` stage + `PublishArtifact`), `src/story-factory/story-project.ts` (deps, artifact file, PUBLISHED derivation), `src/story-factory/pipeline.ts` (exclude publish like export), `src/story-factory/routes.ts` (publish route), `src/jobs.ts` (`"story-publish"` JobKind)
- Test: `tests/youtube-upload.test.ts`, `tests/story-publish.test.ts`

**Interfaces:**
- `STORY_STAGES` gains `"publish"` after `"export"`. `STAGE_DEPS.publish = ["export"]`. `STAGE_ARTIFACT_FILES.publish = "publish.json"`. `PIPELINE_STAGES` excludes both `export` and `publish`; `runSingleStage` rejects both.
- `deriveStoryStatus`: `if (story.stages.publish?.status === "done") return "PUBLISHED";` placed above the READY_TO_PUBLISH check.
- `PublishArtifact`:
  ```ts
  { version: 1; videoId: string; uploadedAt: string; privacyStatus: "private" | "unlisted" | "public"; publishAt?: string; thumbnailSet: boolean; title: string }
  ```
- `src/youtube/upload.ts` (fetch-injected):
  ```ts
  export async function uploadVideo(o: {
    accessToken: string; filePath: string;
    snippet: { title: string; description: string; tags: string[]; categoryId?: string; defaultLanguage?: string };
    status: { privacyStatus: string; publishAt?: string };
    fetch?: typeof fetch; signal?: AbortSignal;
    update?: (uploadedBytes: number, totalBytes: number) => Promise<void>;
  }): Promise<{ videoId: string }>;
  export async function setThumbnail(o: { accessToken; videoId; filePath; fetch?; signal? }): Promise<void>;
  ```
  Resumable protocol: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with JSON metadata + headers `X-Upload-Content-Length`/`X-Upload-Content-Type: video/mp4` → `location` header; then a single `PUT` of the whole file to that location with body = `createReadStream(filePath)` wrapped in `Readable.toWeb`, `duplex: "half"`, `content-length` set. Progress via a counting Transform stream. `publishAt` set ⇒ force `privacyStatus: "private"` (YouTube requires it for scheduled publish). Thumbnail: `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=…` body = PNG bytes, `content-type: image/png`.
- Route `POST stories/:id/publish` body `{privacyStatus?, publishAt?}`:
  - 409 `approval-required` unless export stage is done; 409 `youtube-not-connected` without tokens.
  - Starts job kind `"story-publish"` with ownerSuffix `storyId`; the job reads `export.json` (video path, title/description/tags files) and `thumbnail.json`, uploads, sets thumbnail, writes `publish.json` via `writeStageArtifact(…, "publish", …)` and marks the stage done through the same saveStageRun flow as other stages (mark running/done/failed with `classifyError`).

- [ ] **Step 1: Write failing tests**: upload init request carries metadata + upload headers and PUT streams to the returned location (fake fetch records both calls; use a small temp file); publishAt forces private; setThumbnail posts bytes; stage list/deps/artifact-file round-trip; PUBLISHED derivation; publish route refuses without export done (reuse `tests/story-server.test.ts` harness patterns); pipeline never runs publish.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS** (full `tests/story-*.test.ts` — the stage-list change touches many normalizers).
- [ ] **Step 5: Commit** `feat: publish stories to YouTube with resumable upload and scheduling`

### Task 9: Analytics snapshots

**Files:**
- Create: `src/youtube/analytics.ts`, `src/story-factory/analytics.ts`
- Modify: `src/story-factory/routes.ts` (2 routes)
- Test: `tests/story-analytics.test.ts`

**Interfaces:**
- `src/youtube/analytics.ts`: `export async function fetchVideoStats(o: { accessToken; videoIds: string[]; fetch? }): Promise<Map<string, { views: number; likes: number; comments: number }>>` via `GET https://www.googleapis.com/youtube/v3/videos?part=statistics&id=…` (missing stats fields → 0).
- Story artifact `analytics.json` (NOT a pipeline stage — a sidecar like cost.json, read/written by `src/story-factory/analytics.ts`):
  ```ts
  export type StoryAnalytics = { version: 1; videoId: string; snapshots: Array<{ bucket: "24h" | "72h" | "7d" | "28d"; capturedAt: string; ageHours: number; views: number; likes: number; comments: number }> };
  export const SNAPSHOT_BUCKETS = [{ id: "24h", hours: 24 }, { id: "72h", hours: 72 }, { id: "7d", hours: 168 }, { id: "28d", hours: 672 }] as const;
  export function dueBuckets(uploadedAt: string, existing: StoryAnalytics | null, now: Date): BucketId[]; // pure
  export async function refreshChannelAnalytics(channelId, o: { fetchStats; now?: Date }): Promise<{ updated: string[] }>; // iterates published stories, one stats call for all due videos
  ```
- Routes: `POST /api/series/:channelId/analytics/refresh` → runs inline (one HTTP call — no job needed), 409 `youtube-not-connected` without tokens; `GET stories/:id/analytics` → `{ok, analytics}` (404 `analytics-missing`).

- [ ] **Step 1: Write failing tests**: `dueBuckets` — nothing due before 24h; 24h+72h both due at 80h when neither captured; captured buckets never repeat; `refreshChannelAnalytics` with 2 published stories captures due snapshots with real ageHours and skips unpublished; stats parser handles missing likeCount.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit** `feat: capture 24h/72h/7d/28d YouTube analytics snapshots per story`

### Task 10: Performance profile + idea-generator feedback (70/30)

**Files:**
- Create: `src/story-factory/performance.ts`
- Modify: `src/story-factory/prompts/idea.ts` (performance block + directive), `src/story-factory/stages/idea.ts` (load profile, pick directive), `src/story-factory/analytics.ts` (rebuild profile after refresh)
- Test: `tests/story-performance.test.ts`

**Interfaces:**
- `story-channel/performance-profile.json`:
  ```ts
  export type PerformanceProfile = {
    version: 1; updatedAt: string; storyCount: number;
    themes: Array<{ theme: string; stories: number; avgViews: number }>;   // from idea.json themes × best snapshot views
    subNiches: Array<{ subNiche: string; stories: number; avgViews: number }>;
    provenThemes: string[];   // top-half themes with ≥1 story and above-median avgViews, max 8
  };
  export async function rebuildPerformanceProfile(channelId): Promise<PerformanceProfile>; // reads stories' idea.json + analytics.json
  export async function loadPerformanceProfile(channelId): Promise<PerformanceProfile | null>;
  export function ideaDirective(storyId: string): "proven" | "explore"; // sha256(storyId) first 4 bytes % 10 < 3 → "explore" — deterministic 70/30
  ```
- `buildIdeaMessages` options gain `performance?: { provenThemes: string[]; directive: "proven" | "explore" }`. Rendered as a user-message block: proven → `"Performance data — these themes hold attention on this channel; lean into ONE of them (without repeating a previous premise):"` + list; explore → `"Exploration slot — deliberately avoid the proven themes listed below and try a fresh angle for this channel:"` + list. No profile (or empty provenThemes) → no block (Phase 1 behavior byte-identical).
- `runIdeaStage`: `const profile = await loadPerformanceProfile(ctx.channelId);` passes `performance` only when `profile?.provenThemes.length`.
- `refreshChannelAnalytics` calls `rebuildPerformanceProfile` at the end.

- [ ] **Step 1: Write failing tests**: profile aggregation from 3 seeded stories (themes averaged over best-snapshot views, provenThemes = above-median); `ideaDirective` deterministic and ~30% explore over the 100 ids `story-000…story-099` (assert count between 15 and 45); prompt block renders per directive; no profile → messages identical to Phase 1 (snapshot equality).
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS** (include `tests/story-stages.test.ts`).
- [ ] **Step 5: Commit** `feat: feed channel performance back into the idea generator (70/30 proven/exploration)`

### Task 11: Scheduling + budget calendars

**Files:**
- Create: `src/story-factory/calendar.ts`
- Modify: `src/story-factory/types.ts` (`ChannelCosts.byMonth`), `src/story-factory/cost.ts` (monthly ledger + monthly cap check), `src/story-factory/channel.ts` (`budget.maxCostPerMonthUsd`), `src/story-factory/routes.ts` (calendar CRUD)
- Test: `tests/story-calendar.test.ts`, `tests/story-cost.test.ts` (add cases)

**Interfaces:**
- `ChannelCosts` gains `byMonth: Record<string, number>` (key `"YYYY-MM"` from the entry's date, UTC; normalizer defaults `{}`). `addStoryCost` bumps it.
- `StoryBudget` (channel level only — `StoryChannelConfig.budget`) gains `maxCostPerMonthUsd: number` (0 = unlimited, default 0). `assertWithinBudget` gains the channel monthly check: signature becomes `assertWithinBudget(channelId, storyId, maxPerStoryUsd, estimateUsd, monthly?: { maxUsd: number; now?: Date })` — call sites in pipeline pass `monthly: { maxUsd: ctx.channel.budget.maxCostPerMonthUsd }`. Over-cap throws `BudgetExceededError` (message names the month and cap).
- `story-channel/calendar.json`:
  ```ts
  export type ChannelCalendar = { version: 1; entries: Array<{ id: string; date: string /* YYYY-MM-DD */; storyId: string | null; plannedPublishAt: string | null; note: string }> };
  export async function loadCalendar(channelId): Promise<ChannelCalendar>;
  export async function upsertCalendarEntry(channelId, entry: { id?: string; date: string; storyId?: string | null; plannedPublishAt?: string | null; note?: string }): Promise<ChannelCalendar>; // id = randomUUID when absent; date must match /^\d{4}-\d{2}-\d{2}$/
  export async function deleteCalendarEntry(channelId, id: string): Promise<ChannelCalendar>;
  ```
- Routes: `GET|POST /api/series/:channelId/calendar`, `DELETE /api/series/:channelId/calendar/:entryId`. The publish route (Task 8) — when body has no `publishAt` but a calendar entry references the story with `plannedPublishAt` in the future, uses it (test this).

- [ ] **Step 1: Write failing tests**: monthly ledger accumulates per-month; monthly cap throws `BudgetExceededError` while per-story cap alone passes; 0 = unlimited; calendar CRUD round-trip + bad date rejected; publish route prefers explicit publishAt over calendar, falls back to calendar entry.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS** (full `tests/story-*.test.ts` — cost signature change touches pipeline call sites).
- [ ] **Step 5: Commit** `feat: publish calendar and monthly channel budget caps`

### Task 12: Compilation projects

**Files:**
- Create: `src/story-factory/compilation.ts`, `src/story-factory/compilation-routes.ts`
- Modify: `src/story-factory/routes.ts` (mount `compilations…` under the same namespace), `src/jobs.ts` (`"compilation-render"` JobKind), `src/story-factory/prompts/metadata.ts` reuse (see below)
- Test: `tests/story-compilation.test.ts`

**Interfaces:**
- Entity `projects/<channelId>/compilations/<compId>/compilation.json` (id rules = `validateStoryId`):
  ```ts
  export type CompilationProject = {
    version: 1; id: string; channelId: string; title: string;
    storyIds: string[];                      // 4–6, each with render stage done — validated at create
    stages: Partial<Record<"metadata" | "render" | "thumbnail" | "export", StageRun>>;
    approvals: Partial<Record<"final", StoryApproval>>;   // anchored to render artifactHash
    createdAt: string; updatedAt: string;
  };
  ```
  Artifacts beside it: `metadata.json` (reuses `StoryMetadataArtifact`), `render.json` (`RenderStageArtifact` + `chapters: Array<{title, startSeconds}>`), `thumbnail.json`, `export.json`. Media under `compilations/<id>/workspace/`.
- `compilation.ts` core:
  ```ts
  export async function createCompilation(channelId, input: { id: string; title: string; storyIds: string[] }): Promise<CompilationProject>;
  export async function listCompilations(channelId): Promise<CompilationProject[]>;
  export async function renderCompilation(channelId, compId, deps: { config; ffmpegPath?; ffmpegPrefixArgs?; probeDuration?; signal?; update? }): Promise<void>;
  export async function runCompilationMetadata(channelId, compId, deps): Promise<void>;  // planner LLM call
  export async function exportCompilation(channelId, compId): Promise<ExportManifest>;   // requires final approval, hash-anchored to render
  ```
  - **Render** reuses member stories' finished `workspace/render/story.mp4` files (they already carry narration + bgm): concat demuxer with `-c copy` (all members share codec settings from the same renderer), chapters = cumulative `probeDuration` offsets with member story titles. This is the "reusing narration/images" path — the member videos ARE that reuse; no re-synthesis, no re-generation, zero paid spend.
  - **Metadata**: one planner call reusing the metadata prompt-module pattern (new prompt `compilation-metadata` name `story.compilation-metadata` version `comp-meta-v1`; inputs: member titles + loglines; outputs same `StoryMetadataArtifact` shape; description MUST embed chapter markers `MM:SS Title` lines — appended deterministically by code from render chapters, not by the model).
  - **Thumbnail**: reuse `generateThumbnail` with the first member story's background image as the base (copy it; no new image spend) + compilation overlay text.
  - **Export**: same package layout as `exportStoryPackage` (read that module and mirror it) into `compilations/<id>/workspace/export/`.
- Routes under the story-factory namespace (`rest.startsWith("compilations")` — extend the mount condition in `server.ts`): `GET|POST compilations`, `GET compilations/:id`, `POST compilations/:id/metadata/run` (planner; paid-confirmation per planner endpoint), `POST compilations/:id/render/run` (job kind `compilation-render`, ownerSuffix `comp::<id>`), `POST compilations/:id/approve/final`, `POST compilations/:id/export`.

- [ ] **Step 1: Write failing tests**: create validates 4–6 members and render-done (seed fake member stories with render.json + fake mp4 files); concat args + chapter offsets from probed durations (inject `probeDuration`); chapter lines appended to description; export refuses without final approval and packages with it; listCompilations skips broken dirs.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit** `feat: compilation projects that stitch 4-6 finished stories with chapters`

### Task 13: Web UI — publish, analytics, section editing

**Files:**
- Modify: `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`
- Test: `npm run typecheck` + `node --test tests/web.test.ts` + manual smoke via `npm run studio`

**Interfaces (consumes):** Task 7 status/connect/disconnect, Task 8 publish, Task 9 analytics routes, Task 3 section routes. Follow the existing story-detail screen pattern in `app.js` (find the Story Factory section by searching `story-factory`; reuse its `fetchJson`/tab helpers).

- [ ] **Step 1:** Story detail gains a **Publish** tab: YouTube connection status + Connect (opens authUrl in new tab) / Disconnect; privacy select (private/unlisted/public), optional publish-at datetime, Publish button (disabled until status READY_TO_PUBLISH); after publish shows videoId link `https://youtu.be/<id>`; **Analytics** panel on the same tab: snapshot table (bucket, age, views, likes, comments) + Refresh button (channel-level refresh, then reload).
- [ ] **Step 2:** Script tab gains per-section editing: section list from `GET sections`, textarea per section, Save → `PUT sections/:index`, then show returned `invalidated` list as a warning banner ("Stages marked stale: …").
- [ ] **Step 3:** Verify: `npm run typecheck && node --test tests/web.test.ts tests/story-server.test.ts`, then `npm run studio` and click through both flows against a seeded project (no paid calls: connect/publish buttons exercised only to their error states without env keys — 409 youtube-not-connected must render as a readable message).
- [ ] **Step 4: Commit** `feat: publish, analytics, and section-editing UI for stories`

### Task 14: Web UI — prompts, calendar, compilations, config

**Files:**
- Modify: `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`

**Interfaces (consumes):** Task 6 prompts routes, Task 11 calendar routes, Task 12 compilation routes, Task 2/4/5/7 config fields.

- [ ] **Step 1:** Channel settings screen gains **Prompts** section: list from `GET prompts` (name, version, overridden badge), expandable editor per prompt showing the default template read-only + override textarea + variable chips, Save/Reset.
- [ ] **Step 2:** Channel settings gains **Calendar** section: month list of entries (date, story picker from channel stories, plannedPublishAt, note), add/edit/delete; and **Budget**: monthly cap input (channel PUT already carries budget).
- [ ] **Step 3:** Story Factory dashboard gains **Compilations** tab: list, create form (title + 4–6 story multi-select filtered to render-done), detail row with Run metadata / Render / Approve final / Export buttons mirroring the story action pattern.
- [ ] **Step 4:** Config screen additions: per-role LLM `provider` select (openai-compatible/anthropic/gemini), render `storyTransition` + `storyTransitionSeconds`, `youtube` section (env var names + scopes), bgm SFX fields on the channel settings screen.
- [ ] **Step 5:** Verify `npm run typecheck && node --test tests/web.test.ts`, manual click-through of each new screen.
- [ ] **Step 6: Commit** `feat: prompt, calendar, compilation, and provider config UI`

### Task 15: Docs + final QA sweep

**Files:**
- Modify: `docs/ai-audio-story-factory-design.md` (move Phase 2 items to "as built", document new endpoints/config/stage), `README.md` (if it lists features/endpoints)

- [ ] **Step 1:** Update the design doc: data-model table (+publish.json, analytics.json, prompt-overrides.json, performance-profile.json, calendar.json, compilations/), API list, config sections, "Risks/limitations" (composite-owner semantics: same story still serialized; YouTube quota costs; analytics snapshots are pull-based via Refresh, not a daemon).
- [ ] **Step 2:** Full verification: `node --test tests/*.test.ts && npm run typecheck` — everything green.
- [ ] **Step 3: Commit** `docs: record story factory Phase 2 as built`

## Self-Review notes (done at plan time)

- Spec coverage against the Phase 2 bullet: OAuth+upload (T7/T8), analytics snapshots (T9), ContentPerformanceProfile + 70/30 feedback (T10), CompilationProject reusing story media (T12), scheduling + budget calendars (T11), native Anthropic/Gemini adapters (T2), xfade (T4), SFX (T5), prompt-management UI (T6+T14), per-section HTTP editing (T3+T13), parallel jobs per channel via composite owner ids (T1). No gaps.
- Type-consistency: `ChatFn` reused for adapters; `StageRun`/`StoryApproval` reused by compilations; `StoryMetadataArtifact` reused for compilation metadata; owner format `::` used by Tasks 1, 8, 12.
- Deliberate scope cuts (documented in T15): captions upload to YouTube deferred; analytics are pull-triggered (button), not a background daemon; compilation render reuses member MP4s rather than re-rendering from images (zero-cost path that satisfies "reusing narration/images").
