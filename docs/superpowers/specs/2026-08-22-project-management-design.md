# Project Management Design

## Goal

Make the studio manage projects instead of merely opening them. A board lists every project with its real state, projects can be created, edited, and deleted, and one step can be run across a selection.

This is Effort A. Effort B — converting the rest of `src/web/styles.css` to the dark token set — follows and is not specified here. Effort A establishes the token layer and builds only the new screen on it.

## Scope

- `Projects` becomes the home screen: a board of every project showing stage, blocking gate, and running job.
- Create, edit, and delete projects from that board.
- Select several projects and run one step across them.
- A single global event stream replaces per-project subscriptions in the client.
- A dark token layer, applied to the new screen only.

Out of scope: the Workspace stage UI keeps its current structure and styling; downloading media from any URL (removed from the roadmap on 2026-08-22).

## Why the current listing cannot serve a board

`sendProjects` returns `{ projects: string[] }` — validated ids and nothing else. `src/web/app.js` treats each entry as a string throughout, and `tests/server.test.ts` and `tests/series.test.ts` assert that shape. Making the board work means changing that response, and every one of those consumers with it.

`ProjectJobManager` exposes only `subscribe(projectId, listener)`; `listeners` is keyed by project id. A board that opened one stream per project would spend the browser's per-host connection budget (about six on HTTP/1.1) on subscriptions and hang the fetches that follow. One global stream is the only shape that scales here.

Concurrent jobs across different projects are already legal — `running` is keyed by project id and `start()` refuses only a second job for the same project. Batch running therefore needs no new server capability.

## Architecture

### Summary listing

`GET /api/projects` returns one entry per project:

```
{ projects: [ {
    id, brief, pipeline, renderGate, editRenderGate,
    job,                 // the running job record, or null
    updatedAt,           // project-state.json mtime, for ordering
    error,               // present only when the project could not be read
} ] }
```

One loader per project reads `project-state.json`, the brief, the asset manifest, the copyright file, the visual mapping, and the edit manifest **once**, and derives pipeline status and both gates from those values. It must not call `projectPipelineStatus`, `evaluateProjectRenderGate`, and `evaluateEditRenderGate` independently — each of those re-reads state, and three passes per project across a library is waste that grows with every project added. It must not call `sendProject`, which additionally runs interrupted-analysis recovery.

Projects whose `brief.json` or state cannot be read appear in the list with `error` set and every derived field null. The current listing drops them silently, which is the wrong default for a screen whose purpose is to show what exists: a project that is broken is exactly the one the operator needs to see.

Ordering is by `updatedAt` descending, falling back to id for entries without state.

`brief` is the full brief. It is small, and the edit dialog needs every field anyway.

### Editing

`PATCH /api/projects/:id` accepts `topic`, `show`, `format`, `workflowType`, `audience`, `language`, `notes`. It preserves `id` and `createdAt`, rejects unknown fields rather than ignoring them, validates the same way `createBrief` does, and writes the whole brief atomically.

**A brief edit clears the script approval.** Every editable field feeds `buildScriptPrompt`, so an approved script may no longer reflect the brief that produced it. Today's hash model cannot see this: `currentSourceHashes().script` hashes the narration text alone, so editing the brief leaves the approval looking valid. Rather than fold the brief into that hash — which would retroactively stale every existing approval in the library the moment the change ships — `PATCH` deletes `approvals.script` when any field actually changes. Voice and captions derive their status from the script approval and go stale with it.

The cost is that correcting a typo in `notes` costs one re-approval. That is the right side to err on: a stale approval that still reads as valid is a signature on work nobody agreed to.

**Changing `workflowType` is allowed and reported.** It is the only way to rescue a project created under the wrong template — a `review-recap` project has no Media step, so it can never acquire the `media` artifact the cut render requires, and today nothing can move it. `deriveWorkflowStepStates` derives step state from the template plus persisted artifacts without checking that an artifact belongs to the new workflow, so artifacts from the old template can read as completed steps in the new one. The response therefore names every retained artifact that the new template does not produce, and the UI shows that list for confirmation before submitting. No artifact is deleted: the operator decides what is stale, and the files remain on disk either way.

`PATCH` returns 409 while a job is running for that project. A brief edited mid-render produces output whose inputs no longer exist.

### Deleting

`DELETE /api/projects/:id` moves the project directory to `projects/.trash/<id>-<timestamp>` within the same projects root, so the move is a rename rather than a copy. It returns the trash path and the timestamp.

Permanent deletion stays a manual filesystem operation. A project holds human approvals and hours of rendering; a single mis-click must not be the end of it.

`validateProjectId` rejects `.trash` because a leading dot fails its pattern, so the trash directory cannot be listed as a project or reached through any project route. That is load-bearing, not incidental, and gets its own test.

`DELETE` returns 409 while a job is running. The job writes into the directory being moved.

A timestamped destination makes collisions improbable but not impossible; a colliding destination is an error, not an overwrite.

### Global event stream

`GET /api/events` streams job events for every project. `ProjectJobManager` gains:

- `subscribeAll(listener)` — receives events from all projects, current and future, and returns an unsubscribe function.
- `runningJobs()` — the current running job records.

The stream opens with a `snapshot` event carrying `runningJobs()`, which closes the race between the client's initial `GET /api/projects` and its subscription: a job started in that window appears in the snapshot rather than being missed.

**The client uses this stream and only this stream.** The Workspace filters by project id rather than opening `/api/projects/:id/events`. Running both would spend the connections the global stream exists to save. The per-project route stays on the server — it is small, tested, and useful to anything that is not this client.

### Batch running

The client runs the selection itself, calling existing per-project routes. No batch API: the job manager already permits concurrency across projects, and a server-side batch would only start paying for itself once cancellation, retry, and durable batch progress are wanted.

Constraints on the client loop: at most three projects in flight at once, because each job may spawn FFmpeg or a model call and "run all" across a library would otherwise start a dozen encoders together. Each project's current state is re-read before its request rather than trusting the board snapshot. One project's failure is reported against that project and does not stop the rest.

### Dark token layer

A `:root` custom-property set — surface, raised surface, border, text, muted text, accent, and the status colors — introduced in `src/web/styles.css` and used by the new screen. Existing rules keep their hardcoded colors until Effort B. This keeps Effort A from turning into a stylesheet rewrite while ensuring the new screen is not painted twice.

## Data flow

Board load: `GET /api/projects` renders rows, then `GET /api/events` opens and its `snapshot` event reconciles any job that started meanwhile. Job events patch the affected row in place; no refetch.

Edit: dialog submits `PATCH`, response returns the new brief plus retained-artifact warnings, the row updates, and the script approval disappearing is reflected in that row's pipeline column on the next load.

Delete: confirmation dialog, `DELETE`, row removed, trash path reported.

Batch: selection maps to a bounded queue of per-project requests; each response either starts a job — which the global stream then reports — or records a per-project error.

## Error handling

Unreadable project: listed with `error`, not hidden.
Job running: 409 on `PATCH` and `DELETE`, naming the job kind.
Unknown field in `PATCH`: 400 naming the field.
Trash collision: 500 naming the destination; nothing is overwritten.
Batch member failure: recorded against that project; the queue continues.

## Testing

- Summary listing shape, ordering, and that a project with an unreadable brief appears with `error`.
- The loader reads each project's state once — asserted by counting reads through an injected reader, not by timing.
- `PATCH` clears `approvals.script`; `PATCH` with an unchanged body does not.
- `PATCH` of `workflowType` reports retained artifacts the new template does not produce, and deletes nothing.
- `PATCH` and `DELETE` both 409 while a job runs.
- `DELETE` moves the directory, returns the trash path, and the trashed project no longer appears in the listing.
- `validateProjectId` rejects `.trash`.
- `subscribeAll` receives events from a project created after subscription; the opening snapshot carries a job started before subscription.
- Unsubscribing stops delivery.
- Web tests assert the board's controls by source text, as `tests/web.test.ts` already does.

## Review

Codex reviewed this design on 2026-08-22 and verified its four factual claims against the code. Its findings are folded in above: the single-pass summary loader, the brief-edit invalidation contract, the running-job guards on edit and delete, the opening snapshot that closes the subscription race, the single-stream client, bounded batch concurrency, and confining the token layer to the new screen rather than converting the whole stylesheet inside Effort A.
