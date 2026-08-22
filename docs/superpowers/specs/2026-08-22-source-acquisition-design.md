# Source Acquisition Design

## Goal

Bring source videos into the studio from a pasted URL, let a model triage which ones are worth reviewing, and hand the chosen one to a project ready to cut.

## Scope

- A `sources/` store outside `projects/`, so one download can feed several projects.
- Paste a URL; fetch its metadata without downloading anything.
- Score candidates with the configured model: how worth reviewing, from what angle.
- Declare rights per candidate before any download.
- Download the chosen candidate with subtitles, as a background job.
- Promote a downloaded candidate into a project already holding its media and subtitles.

## Boundary

This subsystem downloads **one URL at a time, pasted by a person, to serve original review commentary**. That is what it is for and that is all it does.

It does not crawl channels, queue bulk downloads, poll for new uploads on a schedule, remove watermarks, or evade content matching. Those are the difference between fetching a source to review and harvesting a library to republish, and they are out of scope regardless of what any configuration file says.

The existing copyright gate is untouched. Nothing here relaxes it.

## Store

`sourcesRoot()` joins `projectsRoot()` in `src/fs.ts`: `resolve(cwd, "sources")` by default, overridable with `YT_STUDIO_SOURCES_DIR`. `sources/` is added to `.gitignore`.

One directory per candidate:

```
sources/<id>/candidate.json
sources/<id>/video.mp4          # after download
sources/<id>/subs.<lang>.srt    # after download, when the platform has any
sources/<id>/workspace/jobs/    # job records
```

Listing is a `readdir`, matching how projects are listed. There is no central index to fall out of step with the directories.

`<id>` derives from the extractor and the platform's own video id — `youtube-dqw4w9wgxcq`, `bilibili-bv1xx411c7xd` — lowercased and stripped to `[a-z0-9-]`, then validated by a `validateSourceId` mirroring `validateProjectId`. Deriving it from the video rather than generating one means pasting the same URL twice finds the existing candidate instead of duplicating it.

## Candidate record

```ts
type SourceRights = "unknown" | "own" | "licensed" | "third-party-fair-use";
type SourceStatus = "metadata" | "scored" | "downloading" | "downloaded" | "failed";

type SourceCandidate = {
  version: 1;
  id: string;
  url: string;
  platform: string;          // yt-dlp extractor key
  title: string;
  uploader: string;
  durationSeconds: number;
  description: string;
  addedAt: string;
  status: SourceStatus;
  rights: SourceRights;
  rightsNote: string;
  score?: SourceScore;
  media?: { videoRelativePath: string; subtitleRelativePath?: string; downloadedAt: string };
  error?: string;
};

type SourceScore = {
  value: number;             // 0-100
  angle: string;             // the review angle the model proposes
  hooks: string[];
  risks: string[];
  reason: string;
  provider: string;
  model: string;             // stamped, never read back from live config
  scoredAt: string;
};
```

`provider` and `model` are recorded for the same reason the script generator is: a score on disk must say what produced it, not what happens to be configured when it is read.

## yt-dlp adapter

`src/sources/yt-dlp.ts` wraps the binary. Its path comes from `studio.config.json` under a new `sources` block — `ytDlpPath`, `format`, `subtitleLanguages` — following exactly the pattern `render.ffmpegPath` already uses. The binary is not bundled and not installed by the studio; a missing path produces an error naming the setting.

One adapter covers YouTube, Bilibili, Facebook, and X, because yt-dlp does.

- **Metadata**: `--dump-single-json --skip-download <url>`. No media is fetched, so adding a candidate is cheap and commits to nothing.
- **Download**: `--write-subs --write-auto-subs --convert-subs srt`, format from config, output template into the candidate directory. Subtitle conversion shells out to ffmpeg, which is already configured; if `render.ffmpegPath` is unset the download still succeeds and the subtitle is recorded as absent rather than failing the job.

Progress is parsed from yt-dlp's `[download] NN.N%` lines and reported through the job's `update`.

Tests drive a fake executable through `ffmpegPrefixArgs`-style injection, as `tests/smoke.test.ts` already does for ffmpeg and piper. No test reaches the network.

## Rights gate

A candidate is created with `rights: "unknown"`. **Download is refused while rights are unknown**, with an error naming the candidate. `PATCH /api/sources/:id` sets `rights` and `rightsNote`.

The declaration is a person stating what they may do with the material, recorded next to the material. It is not a legal check and does not claim to be one; it exists so the decision is made before the file lands and is still readable afterwards.

## Scoring

`src/sources/score.ts` scores one candidate per model call, on its own merit, and the board ranks by the returned value. One call per candidate keeps prompts small, isolates failures to the candidate that caused them, and lets a new candidate be scored without rescoring the rest.

The prompt carries title, uploader, duration, and description — metadata only, since nothing has been downloaded yet. It asks for a JSON object matching `SourceScore` minus the stamped fields, and `src/sources/score-parse.ts` validates it the way `src/llm/parse.ts` validates script output, naming the field that is wrong.

### Transport extraction

`src/llm/openai-compatible.ts` currently welds transport to script generation: `buildScriptPrompt(request.brief)` sits inside the request body and `parseScriptGeneration` consumes the response. Scoring needs the same transport with a different prompt and a different parser.

Extract `chatJson(config, messages, signal): Promise<string>` — endpoint construction, the paid check, the API-key check, the request, error redaction, and content extraction — into `src/llm/chat.ts`. Script generation becomes `parseScriptGeneration(await chatJson(config, buildScriptPrompt(brief)), projectId)`; scoring becomes `parseSourceScore(await chatJson(config, buildScorePrompt(candidate)))`. Behaviour of the existing script path must not change; its tests are the proof.

The dry-run provider gets a scoring counterpart that returns a fixed, obviously-synthetic score, so the feature works with no model configured and never silently passes a template off as judgement.

## Promote

`POST /api/sources/:id/promote` creates a project from a downloaded candidate:

- Brief pre-filled: `topic` from `score.angle` when scored and from the title otherwise, `show` from the title, the rest from the request body.
- `workflowType` defaults to `subtitle-render`, the only template carrying Media, Subtitles, and Translation — the path the cut render needs.
- The video is placed in the project and recorded as the `media` artifact; the subtitle, when present, as `source-subtitles`.

**Placement is a hard link, falling back to a copy across volumes.** An artifact's `relativePath` resolves through `resolveProjectPath`, which refuses to leave the project directory, so the project cannot simply point at `sources/`. A hard link gives the project its own path to the same bytes; a copy of a multi-gigabyte source per project does not scale, and the fallback exists only because links do not cross volumes.

Promoting the same candidate twice into different projects is allowed. That is the reason the store sits outside `projects/`.

## Jobs and events

Downloads and scoring run as background jobs. `ProjectJobManager` already takes a root resolver in its constructor, so `new ProjectJobManager(sourcesRoot)` yields a source-scoped manager writing job records under `sources/<id>/workspace/jobs/` with no change to the class.

`JobKind` gains `"download"` and `"score"`.

Source job events are served by `GET /api/sources/:id/events`, mirroring the per-project stream. When the global stream from the project-management effort lands, it covers both managers; this spec does not depend on that and does not block it.

## Routes

```
GET    /api/sources                 list candidates
POST   /api/sources                 { url } -> fetch metadata, create candidate
GET    /api/sources/:id             one candidate
PATCH  /api/sources/:id             { rights, rightsNote }
POST   /api/sources/:id/score       job
POST   /api/sources/:id/download    job; 409 while rights are unknown
POST   /api/sources/:id/promote     { projectId, ... } -> project
DELETE /api/sources/:id             remove the candidate and its files
GET    /api/sources/:id/events      SSE
```

All mutations sit behind the server's existing same-origin rule; nothing new is added for that.

## UI

A `Sources` screen alongside `Projects`: a paste box, and a list of candidates showing title, channel, duration, platform, rights, score with its proposed angle, and status. Per candidate: declare rights, score, download, promote, delete. Sorting by score puts the model's recommendation at the top without hiding anything below it.

## Error handling

Missing `sources.ytDlpPath`: error naming the setting.
Unsupported or private URL: yt-dlp's failure is surfaced with its message redacted through `redact`, since URLs can carry tokens.
Duplicate URL: returns the existing candidate rather than creating a second.
Download while rights are unknown: 409.
Promote before download: 409.
Promote into an existing project id: 409, as project creation already behaves.
Failed download: `status: "failed"` with `error`, partial files removed.
Malformed model score: the candidate keeps its previous score and the job fails with the parser's message.

## Testing

- Candidate id derivation, including two different platforms producing distinct ids and the same URL twice producing one candidate.
- Metadata fetch parses a recorded yt-dlp JSON payload; no network.
- Download is refused while rights are `unknown`, and permitted once declared.
- Download progress parsing from sample yt-dlp output lines.
- A failed download leaves `status: "failed"` and no partial video file.
- `chatJson` extraction: every existing script-generation test still passes unchanged.
- Score parsing rejects a missing or out-of-range `value`, naming the field.
- A scored candidate records the provider and model that scored it.
- Promote creates the project, records both artifacts, and the project's `editRenderGate` no longer reports `source-media-missing`.
- Promote uses a link when possible and a copy otherwise, verified by inode comparison where the platform exposes it and by content equality everywhere.
- `sources/` is excluded from the projects listing.

## Sequencing

This effort precedes the project-management board specified in `2026-08-22-project-management-design.md`, by the user's decision on 2026-08-22. The two touch different files; the only overlap is the global event stream, which the board introduces and which this spec deliberately does not require.
