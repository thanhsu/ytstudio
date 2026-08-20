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
- TTS voice generation hook.
- Visual asset planning for captions, cards, rankings, and generated B-roll.
- FFmpeg-based render pipeline for Shorts and long-form exports.

## Planned MVP

The first MVP should run locally and guide the creator through:

1. Create a video brief.
2. Generate a review script and metadata.
3. Prepare voice and visual assets.
4. Run a copyright-risk checklist.
5. Render a draft video.

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

## Safety Gates

- Script approval is tied to the extracted narration hash.
- Asset approval requires rights confirmation and a usage purpose.
- Copyright approval refuses blocked checks.
- Render requires current approvals, voice, and captions.
- Generated files stay under ignored `projects/<id>/workspace/`.
