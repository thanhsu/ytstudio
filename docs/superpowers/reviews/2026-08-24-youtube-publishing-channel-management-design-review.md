# Review: YouTube Publishing & Channel Management Design (2026-08-24)

Reviewed document:
`docs/superpowers/specs/2026-08-24-youtube-publishing-channel-management-design.md`

Reviewer verdict: **the architecture is sound and matches the codebase — the
existing `src/youtube/` module (oauth, token-store, upload, analytics) already
supports the proposed extraction, and no decision contradicts repo reality.
No blocking findings. Nine gaps must be settled in the implementation plan
before execution; the two most important are the approval-gate matrix per
source kind and ownership of the `youtube/*` route prefix.**

## Verified against the codebase

- `src/youtube/upload.ts` already implements resumable upload with progress
  callback and abort signal, and already forces `privacyStatus: private` when
  `publishAt` is set — exactly the scheduled-publishing semantics the design
  specifies.
- `src/youtube/token-store.ts` stores tokens under the project workspace via
  `resolveProjectPath`, auto-refreshes, and never leaves the token store — the
  design's secret-handling constraint is already the implemented pattern.
- `ProjectJobManager` (`src/jobs.ts`) supports cancel via `AbortController`
  and a `"cancelled"` status, so the 202-job + cancel design fits without new
  job infrastructure.
- Story publish today lives in `src/story-factory/routes.ts` (~762 lines) at
  `stories/:id/publish` and gates only on `stages.export.status === "done"`;
  it does not persist a video ID before upload completes, so the design's
  duplicate-prevention store is a genuine fix, not redundancy.
- Compilations exist (`src/story-factory/compilation.ts`), so
  `sourceKind: "compilation"` is real.
- Calendar entries (`loadCalendar`) currently supply a default
  `plannedPublishAt` when the publish request has none.

## Must settle in the implementation plan

### 1. Approval-gate matrix per source kind (biggest gap)

The design requires "the current script, asset/copyright, and final render
approval gates", but the two source families have different approval models:

- Review projects (`src/types.ts:66`): `ApprovalStage = "script" | "assets" |
  "copyright"` — hash-bound, with **no "final render" approval stage**.
- Story Factory (`src/story-factory/types.ts`): approvals `script | media |
  final`, where `final` is granted by "Approve & package".

`src/youtube/publish.ts` cannot check one uniform gate set. The plan must
define an explicit matrix: for `story`/`compilation`, require the three Story
Factory approvals current against artifact hashes; for `review`, require
script + assets + copyright approvals current (via the existing readiness
logic in `src/workflow.ts`) plus a completed render, and either add a final
approval stage for reviews or state that render-done + current approvals is
the accepted gate. Do not invent a shared abstraction before writing this
matrix down.

### 2. Ownership of the `youtube/*` route prefix

`routeStoryFactory` already handles `youtube/status`, `youtube/connect`, and
`youtube/disconnect` under `/api/series/:channelId/` (routes.ts:174-216), and
the design's new `src/youtube/routes.ts` claims the same paths. Two modules
must never both match the `youtube/` rest prefix. The plan should move the
prefix wholly to `src/youtube/routes.ts`, dispatch it from `server.ts` before
(or instead of) the story-factory dispatch, and have story-factory's
`stories/:id/publish` delegate into the new publish module. The design's "may
retain compatibility endpoints" is too loose — name which endpoints stay and
which module answers each path.

### 3. Publish job status conflates lifecycle with visibility

`YouTubePublishJob.status` includes `"published" | "scheduled" | "private" |
"unlisted"` alongside `"queued" | "uploading" | ... | "cancelled"`. Visibility
already lives in `YouTubeVideoLink.privacyStatus`/`publishAt` and in
`requestedPrivacy` on the job. Collapse the terminal success states to one
`"completed"` and derive display labels from the link record; otherwise every
status consumer needs a four-way success check and the state machine has four
synonymous terminal states.

### 4. No queue-listing endpoint

The Publish Queue screen needs to list jobs, but the API table only has
`GET /publish/:jobId`. Add `GET /api/series/:channelId/youtube/publish`
(returning current + recent jobs from the store) or explicitly state the UI
reads the existing project-jobs API. Pick one in the plan.

### 5. Analytics snapshots have no home in the data model

The Video Library shows views/likes/comments plus "last refresh time", and
the design correctly excludes automatic polling — which means stats must be
cached locally between manual refreshes. Neither `YouTubeVideoLink` nor any
other store record holds a stats snapshot. Add one (e.g. per-video
`{views, likes, comments, fetchedAt}` in the youtube-store) and state that
list endpoints return the cached snapshot, never live-fetch.

### 6. `channelId` is ambiguous in the local data model

Routes use `:channelId` for the local series/project id, but
`YouTubeVideoLink.channelId` and `YouTubePublishJob.channelId` are undefined:
local series id (redundant — the file already lives in that series'
workspace) or remote YouTube channel id (`UC...`, useful for detecting that a
reconnect landed on a different channel)? Recommend storing the **remote**
channel id and renaming the route param understanding accordingly in the
plan; either way, define it.

### 7. Missing quota error code

YouTube Data API uploads cost ~1600 quota units against a 10,000/day default
— roughly six uploads a day. `quotaExceeded`/`uploadLimitExceeded` failures
are guaranteed in normal operation and fit none of the listed codes cleanly.
Add `youtube-quota-exceeded`, non-retryable until quota reset, with a message
saying when to retry.

### 8. Publishing-calendar default is silently dropped

The current publish route falls back to the calendar's `plannedPublishAt`
when the request has no `publishAt` (routes.ts:550-551). The design's new
flow never mentions the calendar despite a Calendar nav item in the shell.
Decide: preserve the fallback in `publish.ts` (and show it pre-filled in the
wizard, which is better UX than a silent server-side default) or drop it
deliberately and say so.

## Clarifications (non-blocking)

### 9. UI shell scope

"Fixed collapsible sidebar with … navigation" reads like an app-wide shell
restructure. The app is screen-per-file (`src/web/screens/*.js` — plain JS,
not TypeScript as the design says). The plan should scope the sidebar as
internal navigation within the YouTube screen(s), reachable from the existing
app nav, not a rebuild of the studio shell.

### 10. Video Library data source

State whether `GET /videos` lists the remote channel's uploads joined with
local link metadata (videos published outside the studio appear with no
source project) or only locally-linked videos. The "source project" column
implies a join; the empty-state and pagination story differ substantially
between the two.

### 11. Delete confirmation transport

"Delete requires an explicit confirmation field" — a DELETE body is unusual
but workable with the existing `readJsonBody`. Note the repo's other deletes
(series, episode, project) confirm client-side only; requiring a server-side
`confirm: true` for remote irreversible deletion is a justified exception —
just make the plan say it is intentional so it doesn't get "fixed" for
consistency later.

## What is good and should not be reopened

- Scope cuts (no comments/playlists/bulk/cross-channel/auto-polling) are the
  right MVP line.
- The duplicate-prevention rule — never re-upload when a video ID is already
  recorded — fixes a real gap in the current story publish flow.
- Versioned store records with normalizers, path validation against the
  owning project, redacted provider bodies, and human-only publish triggers
  all match established repo conventions.
- The five delivery phases are correctly ordered: extraction first, UI after
  the API surface exists, Story Factory regression last.
