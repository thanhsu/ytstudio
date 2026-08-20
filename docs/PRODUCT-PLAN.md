# Product Plan

## Product Name

YT Review Studio

## Goal

Help a creator produce YouTube Shorts and long-form review videos using AI while
keeping the value of each video in original commentary, analysis, structure, and
visual packaging.

## Target Use Case

Initial niche: anime/donghua review content for English-speaking markets such as
EU and Australia.

Example series:

- Tales of Herding Gods explained.
- Character power scale.
- Episode review with commentary.
- Donghua comparison and ranking.
- Plot theory and ending explanation.

## Non-Goals

- No reupload automation.
- No Content ID evasion.
- No watermark removal.
- No source-site scraping pipeline for copyrighted episodes.
- No automatic publishing in the MVP.

## Core Workflow

1. Topic input: keyword, show name, episode, source notes, target language.
2. Trend brief: angle ideas, audience promise, title candidates.
3. Script generation: Shorts or long-form structure with hook, points, and CTA.
4. Subtitle translation: import SRT, generate market-specific translation
   prompts, validate unchanged timing, and flag lines that need manual review.
5. Asset plan: voice, captions, visual cards, B-roll, optional short clip notes.
6. Copyright guard: checklist and risk score before render.
7. Render draft: local MP4 export with metadata sidecar.
8. Human review: creator approves or revises before upload.

## MVP Modules

### Brief Studio

Stores the project idea, target audience, topic, format, language, and source
notes in a structured JSON file.

### Script Studio

Generates a script, title options, description, hashtags, pinned comment, and
scene beats.

### Copyright Guard

Asks for declared footage usage and flags obvious risk:

- Long continuous clips.
- Full fight or full scene reuse.
- Low original commentary ratio.
- Thumbnail based mainly on copyrighted frames.
- Visuals that depend on the original footage for most viewer value.

### Asset Planner

Produces a shot list for captions, cards, rankings, diagrams, AI-generated
backgrounds, and optional user-supplied short clips.

### SRT Translation Studio

Imports Chinese SRT files, builds strict translation prompts by target market
and genre, and validates that translated subtitles keep cue count and timestamps
unchanged. This module supports manual subtitle review and does not make the
video safe to reupload by itself.

### Renderer

Uses FFmpeg to compose voice, captions, simple cards, background visuals, and
music into a Shorts-ready or long-form draft.

## Near-Term Roadmap

1. Film Scout and Risk Score for choosing a low-risk niche and title.
2. SRT Translation Studio with glossary and xung-ho review.
3. Subtitle editor for names, pronouns, line length, and leftover Chinese text.
4. Brand kit and thumbnail generator.
5. 8-10 minute review render pipeline.

## Recommended Architecture

- Frontend: Next.js or local web UI.
- Pipeline: Node.js commands for project generation and rendering.
- Rendering: FFmpeg.
- AI providers: adapter interface for script and TTS providers.
- Storage: local filesystem projects.

## Local Project Shape

```text
projects/
  <video-id>/
    brief.json
    script.md
    metadata.json
    copyright-check.json
    assets/
    voice/
    renders/
```

## Risk Position

The app should reduce copyright risk by steering production toward critique,
review, commentary, and original visuals. It cannot guarantee fair use/fair
dealing or prevent claims, strikes, or demonetization.
