# YouTube Publishing & Channel Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a local-first, human-triggered YouTube operations surface for per-series channel connection, remote video management, approval-gated publishing, scheduling, queue tracking, and manually refreshed cached analytics.

**Architecture:** Extract the YouTube provider/domain surface into focused modules under src/youtube/, with a versioned per-series JSON store for remote channel identity, local video links, publish jobs, and analytics snapshots. src/youtube/routes.ts owns the entire /api/series/:channelId/youtube/* namespace; the server dispatches it before Story Factory, while the legacy stories/:id/publish route delegates to the reusable publish service. The existing app shell remains unchanged; src/web/screens/youtube.js contains the YouTube screen's internal sidebar and views.

**Tech Stack:** TypeScript/Node.js, Node built-in test runner, vanilla browser JavaScript, local versioned JSON, ProjectJobManager + SSE, injectable fetch, existing FFmpeg/export artifacts, zero new npm dependencies.

**Spec:** docs/superpowers/specs/2026-08-24-youtube-publishing-channel-management-design.md

## Global Constraints

- Keep the app local-first; generated outputs and YouTube store records live under the owning series workspace, and never persist client secrets or access tokens outside the existing token store.
- Publishing is always human-triggered; export completion never publishes automatically.
- Use resolveProjectPath(channelId, "workspace", ...) for project files after validating relative segments; never hand-join join("projects", ...).
- Every new JSON document has version: 1 and a defensive normalizer that tolerates missing, malformed, and legacy fields.
- Use { ok: true, ... } for successful API bodies and { code, message, action? } for failures; redact provider response bodies before logging or returning them.
- Keep mutating requests behind the existing same-origin guard; retain server-side validation even when the client validates first.
- Use 202 plus ProjectJobManager for video uploads and SSE progress; cancellation waits for the operation to settle before another publish for the same source/channel is accepted.
- Inject fetch into provider and route-test seams; tests must never call live YouTube or OAuth services.
- Do not add npm dependencies, React, Tailwind, or TypeScript web screens; web screens are plain .js modules and must not use innerHTML.
- Preserve the human copyright-risk workflow and the approval gates below. Do not add copyright-detection bypass, watermark removal, mass-reupload, or third-party clip harvesting behavior.
- Each task is TDD: write named failing tests, run the narrow test file, implement the smallest change, run the narrow tests plus npm run typecheck, and commit the task in the implementation branch.

## Boundary contracts and approval matrix

### Route-prefix ownership

src/youtube/routes.ts owns every endpoint beginning with /api/series/:channelId/youtube/, and src/server.ts dispatches this module before any Story Factory dispatch. Story Factory must no longer match rest.startsWith("youtube/") or rest === "analytics/refresh" for this surface.

The endpoint ownership is fixed:

| Endpoint | Owning module |
|---|---|
| GET /api/series/:channelId/youtube/status | src/youtube/routes.ts -> channel connection service |
| POST /api/series/:channelId/youtube/connect | src/youtube/routes.ts -> existing oauth.ts |
| POST /api/series/:channelId/youtube/disconnect | src/youtube/routes.ts -> token store + channel store |
| GET /api/series/:channelId/youtube/channel | src/youtube/routes.ts -> channel.ts |
| GET /api/series/:channelId/youtube/videos | src/youtube/routes.ts -> videos.ts + youtube-store.ts |
| GET /api/series/:channelId/youtube/videos/:videoId | src/youtube/routes.ts -> videos.ts |
| PATCH /api/series/:channelId/youtube/videos/:videoId | src/youtube/routes.ts -> videos.ts |
| DELETE /api/series/:channelId/youtube/videos/:videoId | src/youtube/routes.ts -> videos.ts |
| POST /api/series/:channelId/youtube/publish | src/youtube/routes.ts -> publish.ts |
| GET /api/series/:channelId/youtube/publish | src/youtube/routes.ts -> youtube-store.ts queue listing |
| GET /api/series/:channelId/youtube/publish/:jobId | src/youtube/routes.ts -> youtube-store.ts |
| POST /api/series/:channelId/youtube/publish/:jobId/cancel | src/youtube/routes.ts -> ProjectJobManager + youtube-store.ts |
| GET /api/series/:channelId/youtube/analytics | src/youtube/routes.ts -> cached store snapshots |
| POST /api/series/:channelId/youtube/analytics/refresh | src/youtube/routes.ts -> analytics.ts + store snapshots |
| POST /api/youtube/oauth/callback | src/server.ts callback compatibility route; it consumes OAuth state and writes through token-store.ts |
| POST /api/series/:channelId/stories/:id/publish | src/story-factory/routes.ts compatibility route; it validates/loads Story Factory input and delegates to publish.ts, never calls provider APIs directly |

### Approval-gate matrix

publish.ts must not invent one shared stage list. It calls the existing workflow readiness logic in src/workflow.ts for review projects and compares each approval's recorded hash with the current artifact hash before creating a job.

| sourceKind | Required current approvals | Required completed artifact | Failure behavior |
|---|---|---|---|
| story | Story Factory script, media, and final approvals, each current against its artifact hash | Completed Story Factory export package/render | 409 youtube-approval-required with missing or stale approval names; no job |
| compilation | Compilation script, media, and final approvals, each current against compilation artifact hashes | Completed compilation export package/render | 409 youtube-approval-required; no job |
| review | Review script, assets, and copyright approvals current against current hashes, using src/workflow.ts readiness logic | Completed review render/export artifact | 409 youtube-approval-required for missing/stale approvals, or 409 youtube-export-missing for absent/incomplete render; render-done plus the three current approvals is the accepted gate and no review final approval is introduced |

The matrix is returned by publish validation so the wizard can show exactly which gate is missing. A job record uses one terminal lifecycle success status, completed; visibility is read from YouTubeVideoLink.privacyStatus and publishAt, not encoded as job statuses.

## Delivery phases

The five design phases are implemented in order. Every task below is independently test-gated and produces a committable increment.

---

## Phase 1 — YouTube client/domain extraction and local store

### Task 1: Normalize provider errors and channel identity

**Files:**
- Create: src/youtube/errors.ts, src/youtube/channel.ts
- Modify: src/youtube/upload.ts, src/youtube/analytics.ts, src/youtube/oauth.ts, src/youtube/token-store.ts
- Test: tests/youtube-errors.test.ts, tests/youtube-channel.test.ts, tests/youtube-upload.test.ts

**Interfaces:**
- normalizeYouTubeError(error): { code: string; message: string; retryable: boolean; action?: string } maps provider quotaExceeded and uploadLimitExceeded to youtube-quota-exceeded, marks them non-retryable until quota reset, and redacts response bodies.
- getChannelProfile({ accessToken, fetch }): Promise<ChannelProfile> calls channels.list and defensively normalizes the first item.
- Stored channel identity is the remote UC-prefixed YouTube channel id. Route param :channelId remains the local series/project id and is only used to resolve the owning workspace and token file. On connect, compare the newly fetched remote id with the stored remote id and return 409 youtube-channel-mismatch with a reconnect action instead of silently rebinding.

- [ ] Write failing tests for normal network/provider errors, quotaExceeded, uploadLimitExceeded, redaction, empty channel responses, profile normalization, and reconnecting a series to a different remote UC-prefixed id.
- [ ] Run node --test tests/youtube-errors.test.ts tests/youtube-channel.test.ts tests/youtube-upload.test.ts; verify failure for missing exports/mappings.
- [ ] Implement the error mapper, injected-fetch channel client, and remote-id persistence hooks without changing route ownership yet.
- [ ] Run the three tests and npm run typecheck; verify provider payloads never appear in surfaced errors and quota errors have retryable: false.
- [ ] Commit feat: normalize YouTube provider errors and channel identity.

### Task 2: Add the versioned YouTube store

**Files:**
- Create: src/youtube/youtube-store.ts
- Test: tests/youtube-store.test.ts

**Interfaces:**
- Store path is resolveProjectPath(seriesId, "workspace", "youtube", "store.json"); never use a client-provided path.
- YouTubeStore contains version: 1, remoteChannelId: string | null, links: YouTubeVideoLink[], jobs: YouTubePublishJob[], and analytics: Record<string, { views: number; likes: number; comments: number; fetchedAt: string }>.
- YouTubeVideoLink.channelId and YouTubePublishJob.channelId are remote UC-prefixed ids; the local series id is carried by the file location and function argument.
- Job status is queued | uploading | thumbnail-uploading | completed | failed | cancelled; terminal success is only completed.
- Export loadYouTubeStore(seriesId), saveYouTubeStore(seriesId, store), upsertVideoLink(seriesId, link), upsertPublishJob(seriesId, job), listPublishJobs(seriesId), and getAnalyticsSnapshot(seriesId, videoId).
- Normalizers preserve valid records, discard malformed records, default absent analytics to null/empty, and upgrade old records without rewriting remote tokens.

- [ ] Write failing tests for versioned round trips, malformed JSON/fields, store location, remote-channel-id retention, analytics snapshot round trips, one completed status, and duplicate upsert by job/video id.
- [ ] Run node --test tests/youtube-store.test.ts; verify failure.
- [ ] Implement normalizer and atomic JSON save/load helpers using resolveProjectPath.
- [ ] Run the store test and npm run typecheck; verify no token or client secret is written into store.json.
- [ ] Commit feat: add versioned local YouTube publishing store.

### Task 3: Extract reusable video client primitives

**Files:**
- Create: src/youtube/videos.ts
- Modify: src/youtube/analytics.ts
- Test: tests/youtube-videos.test.ts, tests/youtube-analytics.test.ts

**Interfaces:**
- listRemoteVideos({ accessToken, pageToken, fetch }): Promise<{ videos: RemoteYouTubeVideo[]; nextPageToken: string | null }> lists remote channel uploads using the channel's uploads playlist and returns normalized metadata plus the provider page token.
- getRemoteVideo, updateRemoteVideo, and deleteRemoteVideo validate title, description, tags, and privacy values before provider calls. deleteRemoteVideo requires server-validated confirm === true; this is an intentional exception to the repo's client-side-confirm convention because it irreversibly deletes the remote video while preserving the local export.
- fetchVideoStats remains injectable and returns normalized counts; it does not write storage.

- [ ] Write failing fake-fetch tests for upload-playlist paging, metadata normalization, supported privacy values, invalid metadata, remote not-found, delete request shape, server confirmation requirement, and stats normalization.
- [ ] Run node --test tests/youtube-videos.test.ts tests/youtube-analytics.test.ts; verify failure.
- [ ] Implement provider clients and stable error mapping.
- [ ] Run those tests and npm run typecheck; verify all provider response text is redacted.
- [ ] Commit feat: extract YouTube channel video and statistics clients.

---

## Phase 2 — Channel profile and video library APIs

### Task 4: Move the complete YouTube route namespace

**Files:**
- Create: src/youtube/routes.ts
- Modify: src/server.ts, src/story-factory/routes.ts
- Test: tests/youtube-routes.test.ts, tests/story-server.test.ts, tests/server.test.ts

**Interfaces:**
- routeYouTube({ method, rest, url, seriesId, request, tools }): Promise<boolean> handles the complete youtube/* rest namespace and returns whether it handled the request.
- Move existing status/connect/disconnect logic into this module, including OAuth state creation and the existing /api/youtube/oauth/callback compatibility behavior in server wiring.
- In server.ts, call the YouTube dispatcher immediately after parsing/validating the series id and before Story Factory. Remove startsWith("youtube/") and rest === "analytics/refresh" from Story Factory dispatch.
- Preserve {ok:true, ...}, same-origin checks, injected request-body reading, and existing configuration errors.

- [ ] Write route tests proving every YouTube prefix request is answered by the new dispatcher, Story Factory no longer receives youtube/status or analytics/refresh, mutating cross-origin requests return 403, and OAuth status/connect/disconnect remain compatible.
- [ ] Run node --test tests/youtube-routes.test.ts tests/story-server.test.ts tests/server.test.ts; verify failure.
- [ ] Implement dispatch and route extraction without adding new provider behavior.
- [ ] Run route tests and npm run typecheck; verify no duplicate prefix matcher remains.
- [ ] Commit refactor: make YouTube routes the sole owner of the YouTube API prefix.

### Task 5: Implement channel and video library routes with local joins

**Files:**
- Modify: src/youtube/routes.ts, src/youtube/channel.ts, src/youtube/videos.ts, src/youtube/youtube-store.ts
- Test: tests/youtube-routes.test.ts, tests/youtube-channel.test.ts, tests/youtube-videos.test.ts

**Interfaces:**
- Add GET /channel, GET /videos, GET /videos/:videoId, PATCH /videos/:videoId, and DELETE /videos/:videoId.
- GET /videos lists remote channel uploads and joins each remote video to local link metadata by videoId. Videos without a local link are returned with sourceProject: null, sourceKind: null, and sourceId: null rather than hidden.
- Use provider paging with bounded maxResults and return { ok: true, videos, nextPageToken }; client requests the next page explicitly. Empty state is “No videos found on this YouTube channel yet”; a connected channel with only external videos shows “No source project” badges.
- Remote delete never deletes the local export or link automatically; it marks/removes only remote-link metadata according to the store contract after confirm: true is validated server-side.

- [ ] Write failing route tests for profile, joined remote/local rows, external videos with no source project, empty response, page-token forwarding, metadata patch validation, and DELETE rejection without body { confirm: true }.
- [ ] Run focused route tests; verify failure.
- [ ] Implement route handlers and store joins with bounded provider paging.
- [ ] Run focused tests plus npm run typecheck; verify no innerHTML or live analytics fetch is introduced.
- [ ] Commit feat: add channel profile and joined YouTube video library APIs.

---

## Phase 3 — Publish orchestration, approval gates, and scheduled visibility

### Task 6: Implement source resolution and approval readiness

**Files:**
- Create: src/youtube/publish-readiness.ts
- Modify: src/workflow.ts only to expose/reuse existing readiness helpers if currently private; do not change approval semantics
- Test: tests/youtube-publish-readiness.test.ts

**Interfaces:**
- evaluatePublishReadiness(seriesId, sourceKind, sourceId): Promise<{ ready: boolean; matrix: ApprovalMatrixResult; exportPath: string | null; thumbnailPath: string | null; metadata: { title: string; description: string; tags: string[] } | null }> implements the matrix above.
- For review, call existing src/workflow.ts readiness logic so current hash checks remain authoritative, and separately require completed render/export. For story and compilation, compare current script, media, final artifact hashes and require completed export package.
- Validate paths against the owning project with resolveProjectPath; return stable youtube-export-missing, youtube-approval-required, or source-not-found errors.

- [ ] Write failing tests for every missing and stale approval in all three source kinds, current approvals, missing render, invalid paths, and the explicit accepted review rule (three current review approvals plus completed render, with no review final approval).
- [ ] Run node --test tests/youtube-publish-readiness.test.ts; verify failure.
- [ ] Implement readiness using real Story Factory/review fixtures and existing workflow readiness logic.
- [ ] Run readiness test and npm run typecheck; verify the returned matrix is suitable for the UI checklist.
- [ ] Commit feat: enforce source-specific YouTube publish readiness gates.

### Task 7: Implement durable publish jobs and reusable publish service

**Files:**
- Create: src/youtube/publish.ts
- Modify: src/jobs.ts, src/youtube/upload.ts, src/youtube/youtube-store.ts
- Test: tests/youtube-publish.test.ts, tests/jobs.test.ts, tests/youtube-upload.test.ts

**Interfaces:**
- startYouTubePublish(seriesId, input, deps): Promise<YouTubePublishJob> creates a queued local job, returns it to a 202 route, and runs upload/thumbnail/store transitions through ProjectJobManager with SSE progress.
- Input includes sourceKind, sourceId, export reference, title/description/tags, thumbnail reference, privacyStatus, and optional publishAt.
- Preserve the calendar plannedPublishAt fallback in publish.ts: if publishAt is absent, load the matching calendar entry and use its future plannedPublishAt. The wizard also pre-fills the same value, but the server remains authoritative.
- Before upload, inspect the store for an existing matching source/job. If a video id is already recorded, skip video upload and only reconcile thumbnail/link state; never create a duplicate remote upload.
- State transitions are queued -> uploading -> thumbnail-uploading -> completed or failed/cancelled; visibility is stored on YouTubeVideoLink. Scheduled uploads send private + normalized UTC publishAt to the existing uploader.
- Map quota errors to non-retryable youtube-quota-exceeded; network/upload failures remain retryable; stale approvals, missing exports, metadata failures, permission failures, and quota failures stop with a specific action.

- [ ] Write failing tests for 202-compatible job creation, all readiness refusals, calendar fallback, timezone normalization, successful upload/thumbnail/link persistence, one completed terminal state, scheduled private visibility, duplicate prevention after saved video id, thumbnail failure, retryable failure, quota failure, cancellation settlement, and redacted errors.
- [ ] Run node --test tests/youtube-publish.test.ts tests/jobs.test.ts tests/youtube-upload.test.ts; verify failure.
- [ ] Implement service and job transitions with injected provider/fetch/file dependencies.
- [ ] Run focused tests and npm run typecheck; verify retry never re-uploads a known video id.
- [ ] Commit feat: add durable approval-gated YouTube publish jobs.

### Task 8: Add publish, queue, status, cancel, and Story Factory compatibility routes

**Files:**
- Modify: src/youtube/routes.ts, src/story-factory/routes.ts, src/server.ts
- Test: tests/youtube-publish-routes.test.ts, tests/story-publish.test.ts, tests/story-server.test.ts

**Interfaces:**
- Add POST /publish returning 202 { ok: true, job }, GET /publish returning current and recent jobs from youtube-store.ts, GET /publish/:jobId, and POST /publish/:jobId/cancel.
- Queue listing is explicitly local-store-backed and does not call YouTube. It includes failed/cancelled/completed recent records needed by the queue UI.
- Keep stories/:id/publish in Story Factory as a compatibility adapter that maps story input to startYouTubePublish; preserve old response/error semantics where possible while using the new approval matrix and calendar fallback.
- Route handlers return stable {ok:true} success bodies and {code,message,action?} failures.

- [ ] Write failing route tests for 202 response, queue listing, job lookup, cancel settlement, same-origin rejection, malformed publish input, Story Factory delegation, and no direct provider call from story-factory/routes.ts.
- [ ] Run focused route tests; verify failure.
- [ ] Implement handlers and compatibility delegation.
- [ ] Run focused tests plus npm run typecheck; verify SSE job events remain available through existing project event streams.
- [ ] Commit feat: expose YouTube publish queue and compatibility routes.

---

## Phase 4 — YouTube dashboard, library, and publish wizard UI

### Task 9: Add internal YouTube screen navigation and dashboard

**Files:**
- Create: src/web/screens/youtube.js
- Modify: src/web/main.js, src/web/lib/router.js, and existing app navigation only to add the reachable YouTube entry; modify src/web/styles.css for scoped YouTube layout
- Test: tests/youtube-screen.test.ts

**Interfaces:**
- Export mountYouTube(route) and keep sidebar navigation internal to the YouTube screen: Overview, Videos, Publish Queue, Calendar, Analytics, Settings. Do not restructure the app shell.
- Channel switcher uses existing series data; route param in the UI is the local series id.
- Build all DOM with document.createElement, textContent, and existing DOM helpers; no innerHTML. Use accessible labels, keyboard navigation, 44px targets, disabled loading actions, reduced-motion CSS, and semantic status text.
- Dashboard reads /channel, /status, /videos, and /publish; connection errors provide Reconnect/Review permissions actions.

- [ ] Write failing DOM tests for existing-nav reachability, internal sidebar selection, channel switching, loading/error/empty states, dashboard counts, accessible labels, and no innerHTML usage.
- [ ] Run node --test tests/youtube-screen.test.ts; verify failure.
- [ ] Implement screen and narrow CSS without changing global shell structure.
- [ ] Run UI test, npm run typecheck, and existing screen/server tests.
- [ ] Commit feat: add internal YouTube dashboard navigation and overview.

### Task 10: Add video library UI and publish wizard

**Files:**
- Modify: src/web/screens/youtube.js, src/web/styles.css
- Test: tests/youtube-screen.test.ts

**Interfaces:**
- Video table renders thumbnail, title, privacy, publish date, views/likes/comments, source project, YouTube URL, and cached last-refresh time. External videos show “No source project”. Paging uses nextPageToken; empty state uses the API wording from Task 5.
- Edit panel supports metadata/privacy/thumbnail updates and server-confirmed delete with a visible destructive confirmation field/action. The client cannot bypass the server confirm: true requirement.
- Publish wizard has three steps: source preview, metadata validation, visibility/schedule confirmation. It pre-fills calendar plannedPublishAt, displays local and UTC times, shows the approval matrix checklist, and submits only after explicit human confirmation.
- Queue progress subscribes to existing SSE and remains visible after internal navigation.

- [ ] Write failing DOM tests for joined rows, external-video empty source, paging, edit validation, delete confirmation, wizard required fields, calendar prefill, local/UTC display, approval checklist, 202 queue response, loading disablement, and SSE progress updates.
- [ ] Run node --test tests/youtube-screen.test.ts; verify failure.
- [ ] Implement library and wizard using DOM APIs and injected fetch/SSE test seams.
- [ ] Run UI tests plus npm run typecheck; verify no app-shell rewrite or innerHTML appears.
- [ ] Commit feat: add YouTube video library and approval-aware publish wizard.

---

## Phase 5 — Analytics refresh and Story Factory regression compatibility

### Task 11: Add cached analytics snapshots and manual refresh

**Files:**
- Modify: src/youtube/analytics.ts, src/youtube/youtube-store.ts, src/youtube/routes.ts, src/web/screens/youtube.js
- Test: tests/youtube-analytics.test.ts, tests/youtube-analytics-routes.test.ts, tests/youtube-screen.test.ts

**Interfaces:**
- Store snapshots are { views, likes, comments, fetchedAt } keyed by remote videoId.
- GET /analytics returns cached snapshots only and joins them to the local/remote video list; it never makes a provider request. POST /analytics/refresh fetches current stats for requested or listed video ids, updates snapshots atomically, and returns refreshed timestamps.
- No automatic polling is added. UI labels data as cached and exposes an explicit Refresh action; analytics colors are never the only meaning.

- [ ] Write failing tests proving list/analytics GETs make zero provider calls and return cached snapshots, refresh updates counts and fetchedAt, malformed stats normalize to zero, provider errors are redacted, and UI shows cached/refresh/loading/error states.
- [ ] Run focused analytics and screen tests; verify failure.
- [ ] Implement store-backed snapshots and manual refresh.
- [ ] Run focused tests plus npm run typecheck; verify the video list never silently live-fetches analytics.
- [ ] Commit feat: cache manually refreshed YouTube analytics snapshots.

### Task 12: Preserve Story Factory regression behavior and finalize compatibility

**Files:**
- Modify: src/story-factory/routes.ts, src/story-factory/types.ts, src/types.ts, src/workflow.ts, src/server.ts, src/youtube/publish.ts
- Test: tests/story-publish.test.ts, tests/story-server.test.ts, tests/story-compilation.test.ts, tests/review-jobs.test.ts, tests/youtube-publish.test.ts

**Interfaces:**
- Story Factory publish remains human-triggered and still writes its publish artifact/stage result as a compatibility side effect, but reusable YouTube job/store is the source of truth for remote video id, visibility, duplicate prevention, and terminal job state.
- Story Factory approvals remain script | media | final; review approvals remain script | assets | copyright; no shared approval-stage type is introduced that erases this distinction.
- Existing calendar plannedPublishAt behavior remains covered through both wizard and server-side publish.ts fallback.

- [ ] Write regression tests for old story publish requests, compilation publish readiness, review readiness through src/workflow.ts, calendar fallback, existing OAuth callback, existing job/SSE behavior, and route-prefix non-overlap.
- [ ] Run all named regression tests; verify any failures identify an intentional contract change before implementation proceeds.
- [ ] Implement only compatibility fixes required by reusable module; keep Story Factory free of YouTube provider calls.
- [ ] Run regression tests and npm run typecheck.
- [ ] Commit test: preserve Story Factory publishing and workflow compatibility.

### Task 13: Final documentation and verification sweep

**Files:**
- Modify: docs/superpowers/plans/2026-08-24-youtube-publishing-channel-management.md only if implementation notes require a correction; otherwise no source changes
- Test: all existing tests/*.test.ts plus the new YouTube tests

- [ ] Review implementation against every numbered design-review finding: approval matrix, route ownership, one completed state, queue GET, cached analytics, remote channel id, quota code, calendar prefill/server fallback, internal plain-JS sidebar, remote-upload join/paging/empty state, and server-side delete confirmation exception.
- [ ] Run npm run typecheck.
- [ ] Run node --test tests/*.test.ts and require green output for the complete suite.
- [ ] Inspect git diff --check, confirm generated outputs remain ignored, confirm no new npm dependency, and confirm final branch contains only intended implementation commits.
- [ ] Commit test: verify YouTube publishing and channel management end to end.

## Verification

Run the narrow test file and npm run typecheck at the end of every task as specified above. At the end of Phase 5 and before declaring implementation complete, run both commands across the complete repository:

    npm run typecheck
    node --test tests/*.test.ts

Both commands must finish green. The final review must also confirm that the YouTube namespace has one owner, review findings are all resolved in code, list analytics are cache-only, remote deletion requires server-side confirm: true, and all publishing remains human-approved.
