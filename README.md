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
```
