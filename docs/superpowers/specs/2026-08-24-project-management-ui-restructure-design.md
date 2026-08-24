# Project Management & UI/UX Restructure — Design

Date: 2026-08-24
Status: Implemented 2026-08-24 (branch feature/project-management-ui-restructure)
Branch: feature/project-management-ui-restructure

## Goal

Separate project management from content work and reorganize the studio UI
around the operator's real flow:

**Quản lý project → Quản lý nội dung → Biên tập nội dung → Xuất bản**
(Project management → Content management → Content editing → Publishing)

Project management becomes an independent screen that covers all three entity
types (review projects, series, story channels). Each project opens into its
own workspace with a fixed four-step phase bar. Backend APIs and on-disk data
stay unchanged; this is a frontend information-architecture restructure plus a
module split of the 3,900-line `src/web/app.js` monolith.

## Problems being fixed

1. Everything lives on one screen: topbar buttons (Sources, Series, Story
   Factory, New Project, Config, Refresh) swap the middle panel while the
   review-project sidebar stays visible even in unrelated contexts.
2. Project management (create/list/select) is entangled with editing (the
   12-stage rail, workflow board) and with the two other entity types.
3. `src/web/app.js` is a single ~3,900-line file with no routing beyond a
   hardcoded `#story-factory` hash check.

## Decisions (agreed with the user)

1. **Scope of unified project management: all three entity types** — review
   projects, series, story channels — created, listed, and opened from one
   screen.
2. **Change scope: UI/UX + frontend module split.** Backend APIs unchanged;
   one small server tweak to serve the new static module files.
3. **Review-project phase mapping:**
   - Nội dung (content): brief, script, media, ASR, subtitles, translation
   - Biên tập (editing): voice, captions, assets, render
   - Xuất bản (publish): copyright, export

## Rejected approaches

- **Reorganize panels within the single screen** — does not deliver an
  independent project-management module.
- **Introduce a frontend framework** — violates the repo's zero-dependency,
  no-build-step convention for `src/web`.

## Architecture

### Navigation: two tiers, hash-routed

Vanilla JS ES modules with a small hash router in `main.js`. Routes:

| Route | Screen |
|---|---|
| `#/projects` (default) | Unified project management |
| `#/project/<id>` and `#/project/<id>/<phase>` | Review-project workspace |
| `#/series/<id>` and `#/series/<id>/<phase>` | Series workspace |
| `#/channel/<id>` and `#/channel/<id>/<phase>` | Story-channel workspace |
| `#/channel/<id>/story/<storyId>` | Story detail inside the channel workspace |
| `#/sources` | Global sources screen |
| `#/config` | Global config screen |

`<phase>` is one of `overview | content | edit | publish` (default
`overview`). Unknown routes redirect to `#/projects`. The legacy
`#story-factory` hash redirects to `#/projects` filtered to story channels.

### Tier 1 — Project management screen (`#/projects`)

- One unified list combining:
  - review projects from `GET /api/projects`,
  - series from `GET /api/series`,
  - story channels = series whose `GET /api/series/<id>/story-channel`
    sidecar exists (the list endpoint data already loaded is reused; the
    sidecar check reuses the existing fetch pattern).
- Each row: type badge (Review / Series / Story Channel), title, id,
  status/progress summary, and an Open action that navigates to the matching
  workspace route.
- Type filter tabs + a client-side name search box.
- Create actions: New Review Project, New Series, New Story Channel (a story
  channel remains "series + story settings", matching the backend model — the
  create flow makes the series then opens its channel workspace).
- No editing UI on this screen. No preview pane. No stage rail.
- Top nav (global, all screens): Projects | Sources | Config.

A series that also has a story channel appears as two rows (one per role),
each opening its respective workspace; the badge disambiguates them.

### Tier 2 — Project workspaces

Shared workspace shell used by all three types:

- Breadcrumb: `Projects / <project title> / <phase>`.
- Phase bar, fixed order: **Overview → Content → Edit → Publish** (the
  existing UI language is English, so on-screen labels stay English; they
  correspond to Tổng quan → Nội dung → Biên tập → Xuất bản and match the
  route segments).
- Each phase chip shows a derived state: not started / in progress / needs
  approval / done, computed from existing snapshot data (workflow steps,
  hash-bound approvals, story stage runs).
- The preview pane (audio/video) exists only inside workspaces.

Per-type phase content (existing render functions are moved, not rewritten):

| Type | Nội dung | Biên tập | Xuất bản |
|---|---|---|---|
| Review project | brief, script, media, ASR, subtitles, translation | voice, captions, assets, render | copyright, export |
| Series | episode plan, episode list, story bible | batch review, brand kit, thumbnail brief | batch/episode outputs |
| Story channel | story list; per-story idea → hook → outline → bible → sections | TTS, images, video render | metadata, thumbnail, final QA, export package |

For review projects, the Overview tab hosts the existing workflow board
("Run available tasks" stays there). Inside Nội dung/Biên tập/Xuất bản, the
stage rail shows only that phase's stages instead of all 12 at once. The
existing `STAGE_PHASES` grouping in app.js (Plan/Source/Produce/Compliance/
Output) is replaced by the three-phase mapping above.

### Frontend module split

```
src/web/
  index.html            — app shell: top nav + breadcrumb + view container + dialogs
  main.js               — bootstrap + hash router + screen dispatch
  lib/api.js            — fetch helpers and API call functions
  lib/dom.js            — shared DOM builders (field, selectField, actionButton,
                          gateNotice, dialogs, status line)
  lib/state.js          — appState + SSE job stream management
  lib/phases.js         — stage→phase mapping + phase-state derivation (pure, tested)
  screens/projects.js   — unified project management screen
  screens/review-project.js
  screens/series.js
  screens/story-factory.js
  screens/sources.js
  screens/config.js
  styles.css            — updated for top nav, breadcrumb, phase bar, project list
  search-queries.js     — unchanged
```

Business logic inside each screen is moved verbatim where possible; the
change is the navigation frame, not the feature code. `app.js` is deleted at
the end of the migration.

### Server change (the only backend edit)

`src/server.ts` currently routes only four exact static paths (`/`,
`/styles.css`, `/app.js`, `/search-queries.js`) to `sendStatic`. Widen the
condition to: any `GET` whose path does not start with `/api/` falls through
to `sendStatic`, which already maps into `src/web/` behind the existing
path-traversal guard and 404s on misses. `contentTypeFor` already covers
`.html/.css/.js`. No API route changes.

### Error handling

- Router: unknown route or missing entity id → redirect to `#/projects` with
  a status message (reusing `setStatus`).
- Screen loaders keep the current pattern: async render functions catch and
  surface errors via the status line; failed fetches never blank the shell.
- SSE job streams remain per-project, opened when a workspace mounts.

### Testing

- `lib/phases.js` (stage→phase mapping, phase-state derivation) is pure and
  gets `node --test` unit tests.
- Router route-parsing is a pure function with unit tests.
- Existing backend tests untouched and must stay green.
- Manual smoke pass per screen: projects list (all three types), each
  workspace phase, sources, config, one end-to-end review-project stage run,
  one story-factory action.

## Out of scope

- No backend API or domain changes; `projects/` on-disk layout unchanged.
- No automatic publishing (YouTube API remains Phase 2 of the story-factory
  roadmap).
- No new npm dependencies, no frontend framework, no build step for the web
  UI.
- No visual redesign beyond what the new navigation requires (colors and
  typography of `styles.css` stay recognizable).
