# Local Web Studio Design

## Goal

Build a local-first web studio that guides creators from an approved review script to a draft YouTube Short with voice, captions, user-supplied visual assets, copyright checks, and an FFmpeg render. The MVP minimizes recurring cost and preserves explicit human approval before paid TTS and final rendering.

## Product Principles

- Keep all project data local under `projects/<project-id>/`.
- Use Piper for free draft speech generation.
- Make OpenAI speech generation optional, explicit, estimated, and confirmed.
- Never fall back from local TTS to a paid provider automatically.
- Never download or harvest third-party footage automatically.
- Require human approval for scripts, source assets, copyright risk, paid speech, and final renders.
- Reuse domain services between the CLI and web application.

## MVP Scope

The studio provides a production pipeline with these stages:

1. Brief
2. Script approval
3. Voice generation
4. Asset preparation
5. Caption preparation
6. Copyright approval
7. Draft rendering
8. Render preview

The MVP supports the existing `shorts` format and renders vertical `1080x1920` video. Long-form rendering, YouTube upload, automatic footage discovery, collaborative editing, accounts, and cloud persistence remain outside this scope.

## Architecture

The application remains a TypeScript and Node.js project. A lightweight local HTTP server exposes project and job APIs and serves a responsive browser interface. The browser never accesses the filesystem, OpenAI credentials, Piper, or FFmpeg directly.

The backend separates transport from domain logic:

- Project services read and write project files.
- Approval services track stage decisions and source hashes.
- TTS providers implement a shared speech-generation interface.
- Caption services produce timing data and SRT files.
- Render services build and execute FFmpeg commands.
- Job services serialize long-running work and expose progress.

The existing CLI is refactored only where needed so it calls the same project, TTS, caption, and render services as the web routes.

## User Interface

The selected layout is a production pipeline. A project screen contains:

- A persistent stage list showing complete, active, blocked, and stale states.
- One focused workspace for the active stage.
- A status area for requirements, warnings, job progress, and actionable errors.
- A preview area where the current voice or video can be reviewed.

The first page lists projects and their latest pipeline status. Selecting a project opens its current stage. The interface remains usable on desktop and tablet widths; mobile support is limited to status review and simple approvals.

## Project Storage

Existing authored files remain unchanged:

```text
projects/<project-id>/
  brief.json
  script.md
  metadata.json
  scene-plan.json
  copyright-check.json
```

New user-managed assets live under:

```text
projects/<project-id>/assets/
  images/
  clips/
  asset-manifest.json
```

Generated and replaceable output lives under an ignored workspace:

```text
projects/<project-id>/workspace/
  project-state.json
  voice/
  captions/
  renders/
  jobs/
```

`project-state.json` stores stage approvals, input hashes, generated artifact metadata, and stale state. It contains no API keys.

## Approval Model

An approval records:

- Stage name
- Approval timestamp
- Hash of the approved source data
- Optional human note

Changing approved source content does not delete outputs. It invalidates the matching approval and marks dependent artifacts stale. Rendering is enabled only when:

- The current script hash is approved.
- Every selected asset has a manifest entry and human-confirmed usage purpose.
- The current copyright checklist is approved and is not `blocked`.
- Current voice and caption artifacts match the approved script hash.

The UI clearly distinguishes stale output from current output.

## TTS Providers

### Shared Interface

Both providers consume normalized narration text, voice configuration, output format, and destination path. They return provider identity, model or voice identity, content hash, duration, output path, and generation timestamp.

### Piper Draft Provider

Piper is the default provider. It runs as a child process against a locally installed executable and voice model. The application checks both dependencies before enabling generation and provides installation guidance when either is missing.

Piper generation has no per-request provider fee. Failure never triggers an OpenAI request.

### OpenAI Final Provider

OpenAI speech generation is optional and reads `OPENAI_API_KEY` only from the backend environment. Before a request, the UI displays:

- Normalized character and word counts
- Estimated duration
- Current configured model and voice
- Estimated cost with an explicit note that billing is approximate
- A confirmation control specific to that request

The provider defaults to `gpt-4o-mini-tts`. Model pricing is configuration data so it can be updated without changing estimation logic. The request is rejected when the key is missing or confirmation is absent.

### Cache

The cache key includes narration hash, provider, model, voice, speed, instructions, and output format. A matching successful artifact is reused. The UI reports cache reuse and does not request paid confirmation when no API request will occur.

## Narration Extraction

Speech generation does not read Markdown headings, production labels, or scene instructions aloud. A narration extractor converts `script.md` into normalized spoken paragraphs. The extracted narration is shown for review before voice generation.

## Captions

The MVP uses a free deterministic timing strategy:

1. Split normalized narration into sentences and caption-sized phrases.
2. Measure the generated audio duration with FFprobe.
3. Allocate duration in proportion to word count.
4. Enforce minimum display time and prevent overlapping ranges.
5. Write structured caption JSON and an SRT file.

Caption timing is regenerated when narration or audio duration changes. Local or paid transcription is not required for the MVP.

## Assets

The web interface accepts user-selected image and video files and stores them in project asset directories. Supported types are validated by extension and FFprobe where applicable.

Each manifest entry records:

- Relative path
- Media type
- Optional source reference
- Human-written usage purpose
- Rights or permission confirmation
- Optional preferred scene assignment

The app does not search for, download, remove watermarks from, or transform third-party media for copyright avoidance. Missing usage purpose or rights confirmation blocks rendering with that asset.

## Rendering

FFmpeg produces a vertical H.264 MP4 with AAC audio. The renderer combines:

- A generated animated background
- Opening title card
- Voice track
- Burned-in captions
- Optional user-supplied images and short clips assigned through the manifest
- Closing call-to-action card

Assets are fit safely into the vertical frame without destructive cropping by default. Source clips remain short and are tied to declared commentary purposes. Render metadata records all inputs, their hashes, FFmpeg arguments, start time, completion time, and output path.

The renderer refuses to run when required approvals or tools are missing. It never silently omits failed assets or switches providers.

## Jobs and Progress

Voice and render operations are jobs. Only one mutating job can run per project at a time. Job state includes queued, running, succeeded, failed, and cancelled states plus progress messages.

The web client receives progress through server-sent events. Refreshing the page reloads persisted job state. Cancellation terminates the owned child process and preserves logs for diagnosis.

## Error Handling

Errors returned to the browser include a stable code, a concise message, and a suggested action. Expected cases include:

- Missing FFmpeg, FFprobe, Piper, or voice model
- Missing OpenAI key
- Invalid or unsupported project asset
- Invalid project identifier or path traversal attempt
- Corrupt project JSON
- Stale approval or artifact
- Concurrent project job
- Child-process failure
- OpenAI request failure

Secrets, authorization headers, and full environment values are removed from logs and API responses.

## Security Boundaries

- Project identifiers are validated and resolved paths must remain under `projects/`.
- Uploaded filenames are normalized and generated server-side when necessary.
- API requests are accepted only from the local server origin in the MVP.
- The server binds to loopback by default.
- OpenAI credentials stay in the server process.
- Child processes receive explicit argument arrays rather than shell-built command strings.

## Testing

Unit tests cover:

- Narration extraction
- Project path validation
- Approval invalidation and stale propagation
- Caption segmentation and timing
- TTS cache keys
- OpenAI cost estimation and confirmation requirements
- Asset manifest validation
- FFmpeg argument construction

Integration tests use temporary project directories and fake Piper, FFprobe, and FFmpeg executables. They do not call OpenAI or incur cost. API tests cover project loading, script approval, job conflicts, paid-provider confirmation, and render gating.

A smoke test starts the local server, opens a sample project, generates a short fake draft voice, creates captions, and produces a small draft render through a fake or fixture-backed media pipeline.

## Delivery Sequence

Implementation proceeds in independently testable increments:

1. Shared project state and approval services
2. Narration extraction and caption generation
3. Piper provider and cache
4. OpenAI provider with estimation and confirmation
5. Asset manifest and validation
6. FFmpeg render service
7. Job orchestration and progress events
8. Local HTTP API and production-pipeline interface
9. End-to-end sample workflow and documentation

## Success Criteria

The MVP is complete when a user can open the local studio, select the sample project, approve or edit its script, generate a free Piper voice draft, prepare captions, attach and approve optional local assets, approve the copyright checklist, render a vertical draft with FFmpeg, and preview the output. The same user can optionally generate a cached OpenAI final voice only after seeing and confirming an estimated charge.
