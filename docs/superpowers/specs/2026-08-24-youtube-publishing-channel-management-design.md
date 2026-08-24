# YouTube Publishing & Channel Management Design

**Date:** 2026-08-24

**Status:** Implemented on `feature/youtube-publishing` (2026-08-24). Plan:
`docs/superpowers/plans/2026-08-24-youtube-publishing-channel-management.md`;
review: `docs/superpowers/reviews/2026-08-24-youtube-publishing-channel-management-design-review.md`.

## Goal

Add a professional local-first YouTube operations surface that lets each
series connect to one independent YouTube channel, publish approved exports
immediately or on a schedule, manage published video metadata, and inspect
basic channel/video analytics.

## Product constraints

- Each series maps to one independent OAuth connection and one YouTube
  channel. Tokens are never shared between series.
- Publishing is always human-triggered; export completion never publishes
  automatically.
- A publish request must pass the current script, asset/copyright, and final
  render approval gates.
- Source media must remain original commentary/review material and the
  existing copyright-risk workflow remains authoritative.
- Generated files remain under the ignored project workspace.
- MVP supports public, private, unlisted, and scheduled publication.
- MVP does not include comments, playlists, bulk upload, cross-channel
  publishing, automatic analytics polling, or replacing YouTube Studio.

## Existing context

The repository already provides YouTube OAuth, per-series token storage,
resumable video upload, thumbnail upload, video statistics, Story Factory
export packages, publishing calendar entries, background jobs, SSE progress
events, and approval gates. The new work should extract the YouTube HTTP and
domain surface from the growing Story Factory route file while preserving
compatibility with existing Story Factory flows.

## Architecture

Create a reusable YouTube module with focused responsibilities:

- `src/youtube/channel.ts` owns channel profile retrieval and normalization.
- `src/youtube/videos.ts` owns video listing, detail retrieval, metadata
  updates, privacy updates, and deletion.
- `src/youtube/publish.ts` owns publish-input validation, approval checks,
  upload orchestration, thumbnail handling, and publish state transitions.
- `src/youtube/youtube-store.ts` owns local mappings between series, YouTube
  video IDs, publish jobs, source exports, and failure history.
- `src/youtube/analytics.ts` keeps existing statistics fetching and adds the
  list/snapshot operations needed by the dashboard.
- `src/youtube/routes.ts` owns the `/api/series/:channelId/youtube/...` HTTP
  surface.
- `src/web/screens/youtube.js` owns the Channel Dashboard, Video Library, and
  Publish Queue screens.

`story-factory/routes.ts` may retain compatibility endpoints, but new YouTube
logic must call the reusable module instead of adding more provider logic to
that file.

## Data flow

```text
Approved story/review export
        -> validate current approval hashes and files
        -> create local publish job
        -> resumable video upload
        -> thumbnail upload
        -> persist YouTube video ID and confirmed visibility
        -> expose queue result and video library entry
        -> human-triggered analytics refresh
```

Scheduled publishing sends `privacyStatus: private` with `publishAt` to the
YouTube API and displays both the selected local time and the normalized UTC
instant. Upload jobs are background jobs and return HTTP 202. Progress uses
the existing event-stream mechanism. A retry of a failed job must inspect the
local record first and must not create a duplicate upload when a YouTube video
ID is already known.

## Local data model

The store must use versioned JSON files under the owning series workspace and
must never persist client secrets or access tokens outside the existing token
store.

```ts
type YouTubeVideoLink = {
  version: 1;
  videoId: string;
  channelId: string;
  sourceKind: "story" | "review" | "compilation";
  sourceId: string;
  exportPath: string;
  title: string;
  privacyStatus: "public" | "private" | "unlisted";
  publishAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type YouTubePublishJob = {
  version: 1;
  id: string;
  channelId: string;
  sourceKind: "story" | "review" | "compilation";
  sourceId: string;
  status: "queued" | "uploading" | "thumbnail-uploading" | "published" |
    "scheduled" | "private" | "unlisted" | "failed" | "cancelled";
  requestedPrivacy: "public" | "private" | "unlisted";
  requestedPublishAt: string | null;
  videoId: string | null;
  progress: number;
  error: { code: string; message: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
};
```

The implementation may add fields only through a versioned normalizer. Paths
must be validated against the owning project before a job reads an export.

## HTTP API

```text
GET    /api/series/:channelId/youtube/status
POST   /api/series/:channelId/youtube/connect
POST   /api/series/:channelId/youtube/disconnect
GET    /api/series/:channelId/youtube/channel

GET    /api/series/:channelId/youtube/videos
GET    /api/series/:channelId/youtube/videos/:videoId
PATCH  /api/series/:channelId/youtube/videos/:videoId
DELETE /api/series/:channelId/youtube/videos/:videoId

POST   /api/series/:channelId/youtube/publish
GET    /api/series/:channelId/youtube/publish/:jobId
POST   /api/series/:channelId/youtube/publish/:jobId/cancel

GET    /api/series/:channelId/youtube/analytics
POST   /api/series/:channelId/youtube/analytics/refresh
```

`POST /publish` accepts an export reference, metadata, thumbnail reference,
privacy status, and optional schedule time. It returns 202 with the job record.
Metadata update endpoints validate title, description, tags, and supported
privacy values before calling YouTube. Delete requires an explicit confirmation
field and removes the remote video only; it never removes the local export.

## UI design

The UI is a dark-first creator operations console inspired by YouTube Studio,
Linear, and modern shadcn dashboards. It uses the current vanilla
TypeScript/HTML/CSS stack with semantic CSS tokens and focused component
helpers; it does not introduce React or Tailwind for this feature.

### Shell

- Fixed collapsible sidebar with YouTube, Overview, Videos, Publish Queue,
  Calendar, Analytics, and Settings navigation.
- Channel switcher at the top of the sidebar; each option represents one
  series/channel OAuth connection.
- Header contains page title, connection status, search, and one primary CTA.
- Content uses a max-width around 1440px, 8px spacing rhythm, restrained
  borders, and low-elevation surfaces.
- Dark theme is primary; light theme remains supported through semantic tokens.
- Use one consistent SVG icon family such as Lucide; no emoji icons.

### Channel Dashboard

Show channel identity, connection state, subscriber count when available,
published count, queued jobs, failed jobs, recent videos, and a compact
analytics summary. Connection errors must include a recovery action such as
Reconnect or Review permissions.

### Video Library

Use a responsive data table with thumbnail, title, privacy status, publish date,
views, likes, comments, source project, YouTube URL, and last refresh time.
Row actions open an edit panel for title/description/tags, thumbnail, privacy,
or delete. Mobile layouts collapse secondary columns into a detail drawer and
must not introduce horizontal page scrolling.

### Publish Queue

Use a three-step side panel or modal:

1. Select an exported story/review/compilation and preview the video and
   thumbnail.
2. Edit metadata and validate required fields.
3. Choose public/private/unlisted or schedule time, review approval status,
   then confirm.

The confirmation view shows the exact channel, visibility, local time, UTC
time, thumbnail, and approval checklist. Upload progress remains visible after
navigation through the existing event stream.

### Quality rules

- One primary CTA per screen.
- Visible labels for all form fields; errors appear next to the field and
  include a recovery action.
- Focus states, keyboard navigation, semantic buttons, and accessible labels
  are mandatory.
- Interactive targets are at least 44px; loading actions are disabled while
  their request is active.
- Motion is limited to 150–300ms and respects `prefers-reduced-motion`.
- Analytics colors never carry meaning alone; use labels and icons as well.

## Error handling

Normalize provider failures into stable codes such as:

- `youtube-not-configured`
- `youtube-not-connected`
- `youtube-permission-denied`
- `youtube-token-expired`
- `youtube-invalid-metadata`
- `youtube-approval-required`
- `youtube-export-missing`
- `youtube-upload-failed`
- `youtube-video-not-found`
- `youtube-job-already-running`

Provider response bodies must be redacted before logging or returning them.
Retryable network/upload failures keep the local job and expose Retry. Invalid
metadata, stale approvals, missing exports, and permission failures stop the
job with a specific fix. Cancellation must wait for the running operation to
settle before allowing another publish action for the same channel/source.

## Testing strategy

- Unit-test channel and video response normalization, supported privacy values,
  metadata validation, timezone conversion, and versioned store round trips.
- Unit-test publish gate refusal for every missing/stale approval.
- Test resumable upload success, thumbnail failure, retry behavior, duplicate
  prevention after a saved video ID, cancellation, and redacted provider errors.
- Route-test OAuth status/connect/disconnect, channel profile, video list/edit/
  delete, publish 202 response, job status, and analytics refresh.
- UI-test DOM behavior for channel switching, empty/error/loading states,
  publish wizard validation, destructive delete confirmation, and progress
  updates.
- Run `npm test` and `npm run typecheck` before completion.

## Delivery phases

1. YouTube client/domain extraction and local store.
2. Channel profile and video library APIs.
3. Publish job orchestration with approval gates and scheduled visibility.
4. Dashboard UI, video library UI, and publish wizard.
5. Analytics refresh and regression compatibility for Story Factory.

The phase order keeps each increment testable and preserves the existing local
export workflow while the new publishing surface is introduced.

