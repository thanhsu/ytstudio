# MVP Task Plan

Status: first build slice approved

## Phase 0: Product Skeleton

- [ ] Create a TypeScript app structure.
- [ ] Add basic README and local setup docs.
- [ ] Add `.gitignore` for generated projects, renders, and secrets.
- [ ] Add config placeholders for AI/TTS providers without committing secrets.

## Phase 1: Project Brief CLI

- [ ] Add a command to create a new video project folder.
- [ ] Store `brief.json` with topic, show, format, audience, language, and notes.
- [ ] Add validation for required fields.
- [ ] Add sample brief for a Tales of Herding Gods review.

## Phase 2: Script Generator

- [ ] Define prompt templates for Shorts and long-form review videos.
- [ ] Generate `script.md`, `metadata.json`, and `scene-plan.json`.
- [ ] Keep provider logic behind an adapter so OpenAI/Gemini/local models can be swapped.
- [ ] Add dry-run mode that works without API keys.

## Phase 3: Copyright Guard

- [ ] Add a structured checklist command before render.
- [ ] Calculate a conservative risk level.
- [ ] Block render by default when declared footage usage is extreme.
- [ ] Save `copyright-check.json` in the project.

## Phase 4: Asset Planner

- [ ] Generate captions and scene card specs from `scene-plan.json`.
- [ ] Create simple visual cards with HTML/CSS or SVG rendered to images.
- [ ] Support user-supplied stills/backgrounds.
- [ ] Keep copyrighted clip import manual.

## Phase 5: Render Pipeline

- [x] Detect local FFmpeg.
- [x] Render 9:16 Shorts draft from voice, cards, captions, and background assets.
- [x] Render 16:9 draft for long-form.
- [ ] Export final MP4 and render report.

## Phase 6: Local UI

- [ ] Add a simple local web UI with project list.
- [ ] Add screens for brief, script, copyright check, assets, and render.
- [ ] Add manual approval buttons before rendering.
- [ ] Display generated files and render status.

## Phase 7: Optional YouTube Integration

- [ ] Research YouTube Data API OAuth requirements.
- [ ] Add metadata export first.
- [ ] Add upload only after explicit approval.
- [ ] Keep publishing manual by default.

## First Approved Build Slice

Recommended first implementation slice:

1. TypeScript CLI app. `[done]`
2. Local project folder format. `[done]`
3. Brief creation command. `[done]`
4. Dry-run script generator with templates. `[done]`
5. Copyright checklist command. `[done]`

This gives a useful tool quickly without waiting for TTS, FFmpeg, or YouTube
account integration.
