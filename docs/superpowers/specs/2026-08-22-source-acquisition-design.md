# Source Acquisition Design

## Goal

Bring source videos into the studio from a pasted URL, let a model triage which ones are worth reviewing, and hand the chosen one to a project ready to cut.

## Efforts

Codex reviewed the first draft of this spec on 2026-08-22 and recommended splitting it at the seam between acquiring a source and handing it to a project. That seam is adopted:

- **Effort 1 — Acquisition.** The store, metadata ingestion, candidate identity, the rights gate, scoring, download jobs, source routes and events, cleanup and retry. Independently useful: it is a triage and download board on its own, and it touches no project code.
- **Effort 2 — Promotion.** Creating a project from a downloaded candidate, placing its media, writing artifacts, and rolling back a failed promotion. It consumes a candidate API that Effort 1 has already stabilised.

Each effort gets its own implementation plan. Both are specified here because they are one design.

## Boundary

This subsystem downloads **one URL at a time, pasted by a person, to serve original review commentary**. That is what it is for and that is all it does.

It does not crawl channels, queue bulk downloads, poll for new uploads on a schedule, remove watermarks, or evade content matching. Those are the difference between fetching a source to review and harvesting a library to republish, and they are out of scope regardless of what any configuration file says.

## Store

`src/fs.ts` gains `sourcesRoot()` beside the existing `projectsRoot()`. The two are **siblings, not nested**: `sourcesRoot()` resolves to `<cwd>/sources` by default and to `YT_STUDIO_SOURCES_DIR` when set, exactly as `projectsRoot()` resolves to `<cwd>/projects`. Nothing in the sources store lives under the projects root. `sources/` is added to `.gitignore`.

One directory per candidate:

```
sources/<id>/candidate.json
sources/<id>/video.<ext>          # after download
sources/<id>/<subtitle files>     # after download, named by yt-dlp
sources/<id>/workspace/jobs/      # job records
```

Listing is a `readdir`, matching how projects are listed. There is no central index to fall out of step with the directories.

A directory holding no readable `candidate.json` is **skipped by the listing and never adopted**. Creating a candidate whose id would land on such a directory fails with 409 naming the path. The store must not absorb files it did not write.

## Candidate identity

```
id = slug(extractorKey) + "-" + slug(platformVideoId)
```

where `slug` lowercases, replaces every character outside `[a-z0-9]` with `-`, collapses runs, and trims. If the result fails `validateSourceId` — a mirror of `validateProjectId` — the id falls back to `slug(extractorKey)` plus the first ten hex characters of `sha256(extractorKey + ":" + platformVideoId)`. Sanitising can collapse or empty a platform id, and the fallback keeps such a source addressable instead of unreachable.

The record keeps `platform`, `platformVideoId`, and `canonicalUrl` so identity survives the slugging.

**Duplicate policy.** `POST /api/sources` derives the id, then:

- No candidate with that id: create it.
- A candidate exists whose `platform` and `platformVideoId` both match: return it with 200. Pasting the same video twice finds the existing candidate rather than duplicating it.
- A candidate exists whose identity does **not** match: 409 naming both identities. No disambiguating suffix is generated — two different videos colliding on one id is a defect in the derivation, and hiding it behind a suffix would let it spread.

## Candidate record

```ts
type SourceRights = "unknown" | "own" | "licensed" | "third-party-fair-use";
type SourceStatus = "metadata" | "downloading" | "downloaded" | "failed";

type SourceCandidate = {
  version: 1;
  id: string;
  canonicalUrl: string;
  platform: string;          // yt-dlp extractor key
  platformVideoId: string;
  title: string;
  uploader: string;
  durationSeconds: number;
  description: string;
  addedAt: string;
  status: SourceStatus;
  rights: SourceRights;
  rightsNote: string;
  score?: SourceScore;
  media?: {
    videoRelativePath: string;
    subtitleRelativePath?: string;
    subtitleLanguage?: string;
    downloadedAt: string;
  };
  error?: string;
};

type SourceScore = {
  value: number;             // 0-100
  angle: string;
  hooks: string[];
  risks: string[];
  reason: string;
  provider: string;
  model: string;
  scoredAt: string;
};
```

`status` tracks the download lifecycle only. Whether a candidate has been scored is the presence of `score`, so scoring and downloading never overwrite each other's state.

`provider` and `model` are stamped for the same reason the script generator stamps them: a score on disk must say what produced it, not what happens to be configured when it is read.

**Metadata normalisation.** Missing `uploader` and `description` become empty strings; a missing or non-numeric duration becomes `0`; a missing extractor becomes `"unknown"`; a missing title falls back to the URL. A platform that reports little must still yield a usable candidate.

## yt-dlp adapter

`src/sources/yt-dlp.ts` wraps the binary. Its path comes from a new `sources` block in `studio.config.json` — `ytDlpPath`, `format`, `subtitleLanguages` — following exactly the pattern `render.ffmpegPath` already uses. The binary is not bundled and not installed by the studio; a missing path produces an error naming the setting.

One adapter covers YouTube, Bilibili, Facebook, and X, because yt-dlp does.

- **Metadata**: `--dump-single-json --skip-download <url>`. No media is fetched, so adding a candidate is cheap and commits to nothing.
- **Download**: `--write-subs --write-auto-subs --convert-subs srt`, format from config, output template into the candidate directory. Subtitle conversion shells out to ffmpeg, which is already configured; if `render.ffmpegPath` is unset the download still succeeds and the subtitle is recorded as absent rather than failing the job.

Progress comes from yt-dlp's `[download] NN.N%` lines, reported through the job's `update`.

**Subtitle selection.** yt-dlp emits `<base>.<lang>.<ext>`, possibly several, mixing author-provided and auto-generated tracks. The adapter reads the directory after the download rather than assuming a filename, prefers author-provided over auto-generated, then follows the order in `sources.subtitleLanguages`, and records the file it actually chose along with its language. No subtitle is not a failure.

Tests drive a fake executable, as `tests/smoke.test.ts` already does for ffmpeg and piper. No test reaches the network.

## Rights gate

A candidate is created with `rights: "unknown"`. **Download is refused while rights are unknown**, with an error naming the candidate. `PATCH /api/sources/:id` sets `rights` and `rightsNote`.

The declaration is a person stating what they may do with the material, recorded next to the material. It is not a legal check and does not claim to be one; it exists so the decision is made before the file lands and is still readable afterwards.

**Candidate rights do not satisfy any project gate.** `evaluateEditRenderGate` requires the project's own approved copyright checklist, and promotion does not create or approve one. A declared candidate is permission to download, never permission to render. The UI must not imply otherwise.

## Scoring

`src/sources/score.ts` scores one candidate per model call, on its own merit. One call per candidate keeps prompts small, isolates failures to the candidate that caused them, and lets a new candidate be scored without rescoring the rest.

The prompt carries title, uploader, duration, and description — metadata only, since nothing has been downloaded yet. `src/sources/score-parse.ts` validates the response the way `src/llm/parse.ts` validates script output, naming the field that is wrong and rejecting a `value` outside 0-100.

**`value` is an ordinal hint, not a calibrated measure.** Scores from different models, prompt versions, or metadata lengths are not comparable, and the same candidate may score differently across runs. The board sorts by it and always shows `reason` and `risks` beside it, so the ranking is a starting point for a person rather than a verdict.

A failed or malformed response leaves the previous `score` untouched and fails the job with the parser's message.

### Transport extraction

`src/llm/openai-compatible.ts` currently welds transport to script generation: `buildScriptPrompt(request.brief)` sits inside the request body and `parseScriptGeneration` consumes the response. Scoring needs the same transport with a different prompt and parser.

Extract into `src/llm/chat.ts`:

```ts
chatJson(
  config: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  options: { confirmedPaidRequest: boolean; signal?: AbortSignal },
): Promise<string>
```

`confirmedPaidRequest` is a parameter, not an afterthought: the paid guard depends on it, and a signature without it would silently drop the check that stops an unattended spend. The extraction must preserve, unchanged:

- trailing-slash normalisation and the `/chat/completions` suffix
- `Content-Type`, and `Authorization` only when a key is present
- request fields `model`, `messages`, `temperature`, `max_tokens`, `response_format`
- the paid guard and the API-key guard, including its exact environment-variable guidance
- the caller's `AbortSignal`, with abort errors rethrown as aborts rather than wrapped
- non-abort network errors naming the endpoint
- non-OK responses passed through `redact` and truncated to 400 characters
- JSON parse failures naming the endpoint
- validation of `choices[0].message.content`, with redacted diagnostics

Script generation becomes `parseScriptGeneration(await chatJson(...), projectId)`; scoring becomes `parseSourceScore(await chatJson(...))`. The existing script-generation tests must pass unchanged — that is the proof the extraction changed nothing.

The dry-run provider gains a scoring counterpart returning a fixed, obviously synthetic score, so the feature works with no model configured and never passes a template off as judgement.

## Jobs and events

`ProjectJobManager` already takes a root resolver in its constructor, so `new ProjectJobManager(sourcesRoot)` yields a source-scoped manager writing under `sources/<id>/workspace/jobs/` with no change to the class. The two managers hold independent `running` and listener maps.

`JobKind` gains `"download"` and `"score"`. No consumer switches exhaustively on it and the UI falls back to the raw kind, so this is additive; the UI label map is updated alongside.

`JobRecord.projectId` keeps its name and carries the **owner id** — a project id or a candidate id depending on which manager owns the record. Renaming the field would invalidate every job record already on disk for a cosmetic gain. The convention is documented in `src/jobs.ts`.

`src/server.ts` currently holds one module-global `jobs` manager, and `startProjectJob` and `sendProjectEvents` assume it. Effort 1 adds a second manager with its own `startSourceJob` and `sendSourceEvents` helpers. Reusing the project helpers would persist to the wrong root and mix the two event streams.

`GET /api/sources/:id/events` mirrors the per-project stream. When the global stream from the project-management effort lands it can cover both managers; nothing here depends on that.

**Concurrency.** The job manager serialises jobs per candidate, but not metadata writes. `PATCH`, `DELETE`, and promotion take a per-candidate in-process lock so two requests cannot interleave a read-modify-write of `candidate.json`. `DELETE` returns 409 while a job is running for that candidate.

**Failure and cancellation.** The download job cleans up in a `finally` path: partial media and fragment files are removed, and the removal failing does not prevent the status write. A cancelled download returns the candidate to `metadata`; a failed one sets `failed` with `error`. Neither ever leaves `downloaded`. Retrying a download first clears previous media files, `media`, and `error`, so a retry cannot inherit half of an earlier attempt.

## Promotion — Effort 2

`POST /api/sources/:id/promote` creates a project from a downloaded candidate. It returns 409 if the candidate is not `downloaded`, or if the target project id already exists.

- Brief: `topic` from `score.angle` when scored and from the title otherwise; `show` from the title; `format`, `audience`, `language`, and `notes` from the request body, validated exactly as `createBrief` validates them.
- `workflowType` defaults to `subtitle-render`, the only template carrying Media, Subtitles, and Translation together — the path the cut render needs.
- The video is recorded as the `media` artifact and the chosen subtitle, when present, as `source-subtitles`. Both artifact records carry a `sourceHash` derived from the candidate id and the downloaded file, and metadata naming the candidate and its platform.

**Placement is a hard link, falling back to a copy only on `EXDEV`.** An artifact's `relativePath` resolves through `resolveProjectPath`, which refuses to leave the project directory, so the project cannot point at `sources/`. A hard link gives the project its own path to the same bytes; a full copy per project does not scale. The fallback is restricted to the cross-device error alone — copying on a permission or I/O error would turn a real failure into silent duplication. Subtitles are placed the same way.

**Promotion is ordered so the last write makes it real**, and rolls back otherwise: create the project directory and brief, place the media and subtitle, then write the artifacts into project state. A failure at any step removes the newly created project directory, which is safe precisely because promoting into an existing project id is already refused.

Ownership after promotion is deliberate: deleting the project does not touch the candidate, and deleting the candidate does not remove an already-placed link. Promoting one candidate into several projects is allowed — that is why the store sits outside `projects/`.

## Routes

```
GET    /api/sources                 list candidates
POST   /api/sources                 { url } -> metadata, create or return existing
GET    /api/sources/:id             one candidate
PATCH  /api/sources/:id             { rights, rightsNote }
POST   /api/sources/:id/score       job
POST   /api/sources/:id/download    job; 409 while rights are unknown
DELETE /api/sources/:id             409 while a job is running
GET    /api/sources/:id/events      SSE
POST   /api/sources/:id/promote     Effort 2
```

All mutations sit behind the server's existing same-origin rule.

## UI

A `Sources` screen alongside `Projects`: a paste box, and a list of candidates showing title, channel, duration, platform, rights, score with its proposed angle and risks, and status. Per candidate: declare rights, score, download, delete, and — after Effort 2 — promote. Sorting by score puts the model's suggestion on top without hiding what is below it.

## Error handling

Missing `sources.ytDlpPath`: error naming the setting.
Unsupported, private, or failing URL: yt-dlp's message surfaced through `redact`, since URLs carry tokens.
Same video pasted twice: the existing candidate, 200.
Different video colliding on one id: 409 naming both identities.
Candidate directory without `candidate.json`: skipped in listings; 409 on any attempt to create over it.
Download while rights are unknown: 409.
Download aborted: candidate returns to `metadata`, partial files removed.
Download failed, including disk-full: `failed` with `error`, partial files removed, status written even if cleanup fails.
Delete while a job runs: 409.
Promote before download, or into an existing project: 409.
Promotion failure: the new project directory is removed; the candidate is untouched.

## Testing

**Effort 1**
- Id derivation across two platforms; a platform id that sanitises to nothing falls back to the hashed form and stays valid.
- The same URL twice yields one candidate; a different video colliding on one id is refused.
- Metadata parses a recorded yt-dlp payload, including one missing uploader, description, and duration.
- Download refused while rights are `unknown`, permitted once declared.
- Progress parsed from sample yt-dlp output lines.
- An aborted download leaves `metadata` and no partial file; a failed one leaves `failed` and no partial file.
- A retry clears the previous error and media before starting.
- Subtitle selection prefers author-provided over auto-generated and follows the configured language order; no subtitle is not a failure.
- `chatJson` extraction: every existing script-generation test passes unchanged, and a paid config without confirmation is still refused.
- Score parsing rejects a missing or out-of-range `value`, naming the field; a failed score leaves the previous one intact.
- A scored candidate records the provider and model that scored it.
- A directory without `candidate.json` is absent from the listing and cannot be created over.
- `sources/` is excluded from the projects listing, and `sourcesRoot()` is not under `projectsRoot()`.

**Effort 2**
- Promotion creates the project, records both artifacts, and leaves `editRenderGate` reporting only `copyright-approval-missing` — proving the media gate cleared and the copyright gate did not.
- Placement links when possible and copies on `EXDEV`; a permission error propagates instead of copying.
- A failure after placement removes the new project directory and leaves the candidate untouched.
- Promoting one candidate into two projects succeeds, and deleting one project leaves the other and the candidate intact.

## Sequencing

This design precedes the project-management board in `2026-08-22-project-management-design.md`, by the user's decision on 2026-08-22. The two touch different files; the only overlap is the global event stream, which the board introduces and which this design deliberately does not require.
