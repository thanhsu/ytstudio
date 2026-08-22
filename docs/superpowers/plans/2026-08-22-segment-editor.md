# Subtitle Segment Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a human-operated SRT cue editor that persists keep/remove decisions and exports clean SRT and CSV files.

**Architecture:** A focused `edit-manifest.ts` domain module owns parsing, persistence, decision updates, and exports. Thin CLI and HTTP adapters call that module; the existing Translation stage renders the operator controls and decision table.

**Tech Stack:** TypeScript/Node 22, Node test runner, vanilla HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-22-segment-editor-design.md`

## Global Constraints

- Keep all generated outputs under `projects/<id>/workspace/edit/`.
- Preserve source timestamps and text; only reindex kept cues in clean SRT.
- Keep the workflow local-first and require human keep/remove decisions.
- Do not add video downloading, watermark removal, copyright-evasion, or publishing automation.

---

### Task 1: Edit manifest domain

**Files:**
- Create: `src/edit-manifest.ts`
- Create: `tests/edit-manifest.test.ts`

**Interfaces:**
- Consumes: `parseSrt(input: string)`, `stringifySrt(cues: SrtCue[])`, `resolveProjectPath(projectId, ...segments)`.
- Produces: `parseCueSelection`, `createEditManifest` with explicit replacement protection, `loadEditManifest`, `applyRemoveSelection`, and `exportEditManifest`.

- [ ] Write tests for valid/invalid selection ranges, manifest creation from a project-relative SRT, decision updates, clean SRT reindexing, and CSV escaping.
- [ ] Run `node --test tests/edit-manifest.test.ts` and confirm failure because the module is absent.
- [ ] Implement versioned types, strict range parsing, SHA-256 provenance, safe persistence, and deterministic exports.
- [ ] Run `node --test tests/edit-manifest.test.ts` and confirm all domain tests pass.

### Task 2: CLI adapters

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 domain functions.
- Produces: `create-edit-manifest`, `apply-remove-list`, and `export-edit-manifest` commands.

- [ ] Add subprocess tests proving help text and all three command boundaries.
- [ ] Run `node --test tests/cli.test.ts` and confirm the new assertions fail.
- [ ] Wire required flags and concise output messages to the domain module.
- [ ] Run `node --test tests/cli.test.ts` and confirm the CLI tests pass.

### Task 3: Project API

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1 domain functions.
- Produces: GET/POST project routes at `edit-manifest`, `edit-manifest/remove-list`, and `edit-manifest/export`.

- [ ] Add HTTP tests for creating/loading a manifest, applying a remove selection, exporting files, and malformed input.
- [ ] Run targeted server tests and confirm the new routes fail.
- [ ] Add thin same-origin-protected route handlers with 200 responses and existing JSON error handling.
- [ ] Run `node --test tests/server.test.ts` and confirm all server tests pass.

### Task 4: Studio subtitle editor

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `tests/web.test.ts`

**Interfaces:**
- Consumes: Task 3 API routes and the current project snapshot/source-subtitle path.
- Produces: source path field, remove-range field, decision summary/table, and create/apply/export actions in Translation.

- [ ] Add static UI contract tests for editor controls, route names, and accessible table/status content.
- [ ] Run `node --test tests/web.test.ts` and confirm the new assertions fail.
- [ ] Implement loading and rendering manifest state plus the three operator actions; add compact responsive table styles.
- [ ] Run `node --test tests/web.test.ts` and confirm UI contract tests pass.

### Task 5: Full verification

**Files:**
- Modify: `README.md` only if command documentation is not already self-explanatory.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a type-safe, regression-tested feature ready for branch review.

- [ ] Run `npm test` and resolve only regressions caused by this feature.
- [ ] Run `npm run typecheck` and resolve all TypeScript errors.
- [ ] Inspect `git diff --check` and `git status --short` for whitespace errors and unintended files.
