# YT Review Studio

All-in-one local studio for producing YouTube review videos with AI support.

The product is designed for original commentary and analysis content, not for
reuploading copyrighted anime, donghua, or movie footage. Source footage, when
used, must be short, purposeful, and tied to criticism, review, explanation, or
commentary.

## Initial Scope

- Trend and topic research for YouTube review channels.
- AI-assisted brief, script, title, description, and pinned comment generation.
- Copyright-risk checklist before rendering.
- Media ingest and local ASR subtitle generation when no SRT is available.
- SRT import, translation-prompt generation, and subtitle structure validation.
- TTS voice generation hook.
- Visual asset planning for captions, cards, rankings, and generated B-roll.
- FFmpeg-based render pipeline for 9:16 Shorts and 16:9 long-form exports.

## Planned MVP

The first MVP should run locally and guide the creator through:

1. Create a video brief.
2. Generate a review script and metadata.
3. Import and translate subtitles when a source SRT is available.
4. Prepare voice and visual assets.
5. Run a copyright-risk checklist.
6. Render a draft video.

Auto-upload to YouTube is intentionally postponed until the local review workflow
is solid and OAuth/account risk is handled deliberately.

## Quick Start

Requires Node.js 22+.

```powershell
npm run cli -- --help
npm run sample
```

The sample command creates:

```text
projects/tales-herding-gods-qin-mu/
  brief.json
  script.md
  metadata.json
  scene-plan.json
  copyright-check.json
```

Create your own brief:

```powershell
npm run cli -- create-brief --id muc-than-ky-review-001 --topic "Why Qin Mu feels different" --show "Tales of Herding Gods" --format shorts --audience "EU and Australia donghua viewers" --language English
npm run cli -- generate-script --project muc-than-ky-review-001
npm run cli -- copyright-check --project muc-than-ky-review-001 --commentary-percent 70 --footage-percent 15 --longest-clip-seconds 5
```

Run tests:

```powershell
npm test
npm run typecheck
```

## Local Studio

Start the browser UI:

```powershell
npm run studio
```

Open `http://127.0.0.1:3000`.

Or use the CLI server command with a custom port:

```powershell
npm run cli -- studio --port 4317
```

The studio UI is the primary workflow. It can now:

- upload/import source MP4/MOV/MKV/WebM media
- extract ASR audio with FFmpeg
- generate source SRT through configured local ASR
- upload/import source SRT directly
- build a translation prompt from the current source subtitle artifact
- generate voice
- prepare captions
- render a draft
- edit model/tool config

The CLI remains as a debug and automation fallback, not the main operator path.

## Studio Config

Use the `Config` button in the local studio to edit model and tool settings:

- script provider, model, base URL, API key env, paid flag, temperature, and
  max output tokens
- translation provider/model/default market
- local ASR provider/model/language
- default voice provider and voice model
- Piper, Vietnamese local TTS, FFmpeg, and FFprobe paths
- yt-dlp path, download format, and subtitle languages

The UI saves these settings to `studio.config.json`, which is ignored by Git
because it contains machine-specific paths. API keys are not stored there; keep
real secrets in environment variables such as `OPENAI_API_KEY`.

## Script Model

Script, metadata, and scene plan generation runs through a configurable model.
The default is `dry-run`, the built-in template, which produces the same
structure for every project and exists for offline testing rather than for
publishing.

For a free local model, install [Ollama](https://ollama.com), pull a model, and
point the studio at it:

```powershell
ollama pull qwen2.5:14b
```

```jsonc
"script": {
  "provider": "openai-compatible",
  "model": "qwen2.5:14b",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKeyEnv": "",
  "paid": false,
  "temperature": 0.8,
  "maxOutputTokens": 4000
}
```

For a hosted API, change `baseUrl`, name the environment variable holding the
key, and mark it paid so the studio asks before every spend:

```jsonc
"script": {
  "provider": "openai-compatible",
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "paid": true
}
```

The same settings reach any OpenAI-compatible endpoint, including LM Studio,
llama.cpp, vLLM, DeepSeek, Groq, and OpenRouter.

`provider` accepts only `dry-run` and `openai-compatible`. Any other value still
loads — so the Config screen keeps working and can repair it — but script
generation refuses it by name instead of falling back to the template and
reporting success. With `paid: true`, the CLI needs the confirmation flag:

```powershell
npm run cli -- generate-script --project muc-than-ky-review-001 --confirm-paid true
```

A failed model call fails the job and reports why. The studio never falls back
to the template, because template output presented as model output is exactly
the sameness this setting exists to remove. Generating a script also makes any
existing script approval stale, so voice and render stay blocked until you read
and approve the new text.

## Free Draft Workflow

Prerequisites for local rendering:

- `PIPER_PATH`: path to Piper executable.
- `PIPER_MODEL_PATH`: path to a local Piper voice model.
- `FFMPEG_PATH`: path to FFmpeg executable.
- `FFPROBE_PATH`: path to FFprobe executable.

Set them in your shell or `.env` loader. The app does not read real secrets from
`.env.example`.

```powershell
npm run sample
npm run cli -- generate-voice --project tales-herding-gods-qin-mu --provider piper
npm run cli -- prepare-captions --project tales-herding-gods-qin-mu
npm run cli -- render-draft --project tales-herding-gods-qin-mu
```

Optional paid OpenAI voice requires explicit confirmation:

```powershell
npm run cli -- generate-voice --project tales-herding-gods-qin-mu --provider openai --voice alloy --confirm-paid true
```

No Piper failure falls back to OpenAI automatically.

Local Vietnamese voice can use the offline Python TTS tool:

```powershell
$env:VIETNAMESE_TTS_APP_PATH="D:\DOCS\SUPHAM\New folder\Model\Model\app.py"
npm run cli -- generate-voice --project tales-herding-gods-qin-mu --provider vietnamese-local --voice "piper:Minh Quân (Vbee):model"
```

Set `VIETNAMESE_TTS_PYTHON_PATH` if `python` is not the interpreter that has the
tool's dependencies installed.

## Subtitle Translation Workflow

Use this when a Chinese source SRT is available and you need a reviewed
translation before writing narration or rendering.

```powershell
npm run cli -- import-srt --project tales-herding-gods-qin-mu --file .\source.srt
npm run cli -- build-translation-prompt --project tales-herding-gods-qin-mu --source workspace/subtitles/source-...srt --target vi --genre cultivation
npm run cli -- validate-translation --source .\source.srt --translated .\translated.srt
```

Targets: `vi`, `en-au`, `en-gb`, `pt-br`, `de`.
Genres: `cultivation`, `fantasy-system`, `modern-drama`.

## ASR Workflow

Use this when the source MP4 has usable dialogue audio but no SRT. Configure ASR
from the Studio `Config` screen first.

Supported local providers:

- `faster-whisper`: set ASR executable to `faster-whisper` or a full path.
- `whisper-cpp`: set ASR executable and ASR model path to a local ggml model.

Example:

```powershell
npm run cli -- import-media --project tales-herding-gods-qin-mu --file .\source.mp4
npm run cli -- extract-audio --project tales-herding-gods-qin-mu
npm run cli -- generate-asr-srt --project tales-herding-gods-qin-mu
```

This writes `workspace/subtitles/source.asr.srt`, which can then be sent through
the subtitle translation workflow. OCR for hard-sub-only videos is a separate
next module.

## Source Acquisition

Search by keyword or paste a video URL on the **Sources** screen. Keyword search
is a discovery step only: it returns possible videos from a configured platform,
but it does not track or download anything until you choose **Track Source**.
When a URL is tracked, the studio reads its metadata without downloading
anything, so adding a candidate is cheap and commits to nothing. You then
declare what you may do with the material, and only after that can it be
downloaded.

`yt-dlp` is an external tool, not bundled. Point the studio at it the same way
you point it at FFmpeg:

```json
{
  "sources": {
    "ytDlpPath": "D:/tools/yt-dlp/yt-dlp.exe",
    "defaultSearchPlatform": "bilibili",
    "searchLimit": 8,
    "searchPrefixes": {
      "youtube": "ytsearch",
      "bilibili": "bilisearch"
    },
    "format": "bv*+ba/b",
    "subtitleLanguages": ["en", "vi"]
  }
}
```

One binary covers YouTube, Bilibili, Facebook, and X, because yt-dlp does.
Subtitle conversion to SRT uses the FFmpeg you already configured; without it the
download still succeeds and whatever subtitle format arrived is kept as-is.
Search is currently explicit for YouTube and Bilibili, with prefixes configurable
from the Config screen because extractor syntax can change as yt-dlp evolves.

Downloads and scoring run as background jobs against
`GET /api/sources/<id>/events`. Sources live in `./sources`, a sibling of
`./projects`, so one download can serve several projects. Set
`YT_STUDIO_SOURCES_DIR` to move the store.

**What this is for, and what it is not.** Human-directed source discovery and
one selected URL at a time, to serve original review commentary. There is no
channel crawler, no bulk queue, no scheduled polling, no watermark removal, and
no content-matching evasion — the difference between fetching a source to review
and harvesting a library to republish.

**Declaring rights permits the download and nothing else.** A project still needs
its own approved copyright checklist before it renders; the candidate rights
never satisfy a project gate.

### Scoring

If a script model is configured, the studio can rate a candidate for how worth
reviewing it is and propose an angle. The score is stamped with the provider and
model that produced it, and the reasoning and risks are always shown beside the
number.

Scores are ordinal hints, not calibrated measures: they are not comparable across
models, prompt revisions, or runs. With no model configured, a clearly labelled
dry-run scorer answers instead of a template masquerading as judgement.

## Safety Gates

Every approval is recorded against a hash of the content it was given for. Edit
that content afterwards and the approval goes stale, which blocks render until a
human approves the new version. Nothing in the pipeline approves on your behalf.

- Script approval is tied to the extracted narration hash, and is an explicit
  action (`POST /api/projects/<id>/script/approve`). Voice generation refuses to
  run until the current script is approved.
- Asset approval requires rights confirmation and a usage purpose. It is only
  required for projects that actually have assets.
- Copyright approval refuses blocked checks.
- Render re-derives every gate from current content and refuses on any missing
  or stale approval. The Render stage lists exactly what is still blocking.
- The studio's "Run available tasks" button prepares inputs only; approvals stay
  with the operator.
- Generated files stay under ignored `projects/<id>/workspace/`.

## Background Jobs

Voice, render, ASR, script generation, source scoring, and source downloads run
as background jobs. Those routes answer `202` with a
job record and report progress over `GET /api/projects/<id>/events`, which the
studio follows through `EventSource`. One job runs per project at a time; a
second request while one is running is refused with `409 job-already-running`.

## Project Library Location

Projects live in `./projects` relative to the working directory. Set
`YT_STUDIO_PROJECTS_DIR` to keep the library somewhere else, such as a drive with
room for renders:

```powershell
$env:YT_STUDIO_PROJECTS_DIR="D:\studio-projects"
npm run studio
```
