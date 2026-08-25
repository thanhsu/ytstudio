# Story Canon + Localization — Design

Status: design (2026-08-25). Extends the AI Audio Story Factory
(`docs/ai-audio-story-factory-design.md`, Phase 1 + 2, on master).

## Goal

Separate **story creation** from **language-specific publication**:

```
ONE CANONICAL STORY (English)  →  MANY LOCALIZED PUBLICATION VARIANTS
```

Today the factory writes each story directly in its channel's language, and
`naturalize` is same-language polish, not translation. Spanish horror and French
horror therefore share nothing: separate ideas, separate bibles, separate
continuity, separate cost.

This layer introduces a canon series that owns a long-running fictional
universe — bible, characters with tracked knowledge, world state, arcs, plot
threads, an event ledger, and retrieved story memory. Canon chapters are written
in English by a small/local model against a budgeted, retrieved context,
continuity-checked against structured state, and only then localized into
es-MX / fr-FR / it-IT / de-DE and pushed through the **existing** TTS → images
→ render → thumbnail → metadata → YouTube pipeline.

Payoff: chapter 40 stays continuous with chapter 3 without re-reading it; one
canon feeds four channels at near-zero marginal story cost; and analytics
separate *story quality* from *localization / voice / market quality*.

Non-goals: no second story system; localization never becomes a source of story
truth; published content is never silently regenerated.

## Scope honesty

This modifies the existing factory's core files — `types.ts`,
`story-project.ts`, `pipeline.ts`, `stage-llm.ts`, `config.ts`. It does not fork
them. An earlier revision of this design claimed "no change to the existing
factory" while proposing exactly these edits; that claim is withdrawn.

## Current architecture findings (at design time)

- `StoryProject` (`src/story-factory/types.ts:107`) already provides ordered
  stages, per-stage `StageRun`, resumability, hash-bound approvals, derived
  staleness, a cost ledger, an AI log, one JSON artifact per stage, and a job.
- `compilation.ts:101-118` is the in-tree precedent for reusing `runLlmCall` +
  `stageEndpoint` + `parseMetadata` on a *sibling* entity by passing
  `storyId: compilationId`. Nothing was forked to do it.
- `storyPath()` (`paths.ts:21`) already resolves and containment-guards
  `projects/<id>/stories/<storyId>/`.
- `checkDuplicate` (`fingerprint.ts:76`) is already "score every stored entry
  against a query text, sort, return top-N" — a complete ranked-retrieval
  function — over a `fingerprint-index.ts` JSON store.
- `compositeOwner` (`jobs.ts:65`) already enables concurrent per-entity jobs on
  one owner; the story routes use it via `ownerSuffix` (`routes.ts:447`).
- `runRenderStage` already rescales estimated scene timings onto the measured
  narration duration (`pipeline.ts:547-553`), which absorbs the 20–25% length
  difference between English and German narration for free.
- Absent: any canon/series entity, story memory, retrieval, embeddings,
  localization, or cross-channel linkage.

### Collisions found

- `src/audio-story.ts` is a deprecated prototype of this very feature. It
  exports `StoryBible`, `StoryOutline`, `StoryOutlineChapter`, `StoryChapter`,
  `StoryContinuityReport`, has 6 live routes (`server.ts:582-630`), and ships a
  Bible/Outline/Chapters/Continuity UI (`series.js:270-378`).
  **Decision: leave it running; prefix all canon types `Canon*`.** Its removal
  is a separate, explicitly-approved change — deleting live UI is outside the
  scope of this work.
- `src/story-arc.ts:11` exports `StoryArc` for episode reviews. Ours is
  `CanonArc`. No shared behaviour; they are not unified.

## Decisions

1. **Everything is a `StoryProject`.** A canon chapter, an original story, and
   a localized variant are one entity with a different `kind`:
   `"original" | "canon" | "variant"`, plus `canonRef` on variants. This deletes
   an entire parallel canon pipeline/paths/cost/ai-log layer.
2. **A canon series is a channel project.** `projects/<seriesId>/` gets a normal
   `series.json`, a `story-channel.json` with `language: "en"`, and a
   `story-series.json` sidecar (the brand-kit pattern). It therefore appears in
   the existing series list, opens in the existing channel workspace, and its
   chapters appear as stories — reusing list UI, jobs, SSE, cost, AI log, and
   prompt overrides with no new plumbing.
3. **Staleness is derived, never stored** — the rule `story-project.ts:22-25`
   already states. `canonState(story, chapter)` compares `canonRef.canonTextHash`
   against the chapter's current hash exactly as `approvalState` compares anchors.
4. **Retrieval is keyword+structured first**, built on the existing fingerprint
   helpers. Embeddings are an optional enhancement behind one `retrieve()`
   signature, defaulting to disabled.
5. **Canon alignment inverts the QA polarity**: a deterministic typed check is
   the only thing allowed to hard-FAIL; LLM fact-extraction is advisory (WARN).
6. **Three new model roles**, not an eight-profile matrix. Escalation reuses the
   `endpoint` parameter `runLlmCall` already accepts (`stage-llm.ts:82`).
7. Zero new npm dependencies; all HTTP through injectable `fetch`.

## Data model

```
projects/the-missing-floor/           # canon series - a channel that never publishes
  series.json  story-channel.json     # language: "en"
  story-series.json                   # canonicalLanguage, genre, tone, audience, budget
  canon/
    bible.json  characters.json  world-state.json  arcs.json  threads.json
    events.jsonl                      # append + retract records
    memory/{index.jsonl, vectors.jsonl}
  stories/chapter-001/                # a StoryProject, kind:"canon"
    story.json plan.json context.json chapter.json
    continuity-report.json memory.json scenes.json
    workspace/images/<sceneId>.png    # generated once, copied to every locale
  story-channel/{costs.json, prompt-overrides.json}

projects/horror-es/                   # publication channel, otherwise unchanged
  story-channel.json                  # + canonSeriesId, + localeNotes
  stories/<variantId>/                # a StoryProject, kind:"variant"
```

## Stage model

Eight new ids join `STORY_STAGES`. `STAGE_DEPS` and `STAGE_ARTIFACT_FILES` are
total `Record<StoryStageId, ...>`, so `tsc` forces every map to be filled — a
feature, not a hazard.

```
canon:    chapter-plan → canon-context → canon-write → canon-continuity
          → [CANON APPROVAL GATE] → memory-extract → memory-apply → scenes → images
variant:  localize → naturalize → canon-alignment → originality-qa → tts-normalize
          → tts → bgm → render → metadata → thumbnail → final-qa → export → publish
original: unchanged
```

Three mechanical changes make this safe:

1. `runStoryPipeline` takes its list from `pipelineStagesFor(story)` rather than
   the module-level `PIPELINE_STAGES`. Without it, every existing story run
   would try to execute `localize` and die at `executeStage`'s `default:` throw.
2. `invalidateDependents` filters to the story's own pipeline. Otherwise
   `editSectionText` marks `continuity-qa` stale on a variant forever, pinning
   it at `IN_PROGRESS`.
3. `runSingleStage` rejects stages outside the story's pipeline. Today it
   refuses only `export`/`publish`, so nothing would stop an operator running
   `sections` on a variant and generating a fresh English story over it.

`normalizeStory` rebuilds the story object field by field and runs on every
stage write, so `kind`/`canonRef` must be added there or they are erased on the
first write. `kind` is **derived from `canonRef` presence**; a variant whose
`canonRef` does not resolve parks `failed(content)` rather than silently falling
back to the original pipeline.

## Variant creation: synthesize, don't branch

Four existing stages hard-require artifacts a variant cannot produce:
`metadata` needs idea+hook (`metadata.ts:37`), `originality-qa` needs idea
(`originality-qa.ts:38`), `scenes` needs sections+bible (`scenes.ts:45`),
`final-qa` needs `originality.publishable` (`final-qa.ts:48`).

Rather than branch four stages, `createVariant()` projects the canon chapter
into those artifacts at creation: `idea.json` from the chapter summary and
series themes, `hook.json` from the chapter opening, `bible.json` from the canon
bible, `scenes.json` copied from the canon chapter. All four then run unmodified.

Two genuine stage edits remain:

- `runImagesStage` copies the canon chapter's rendered scene image when present
  and generates only on a miss. Cross-project *paths* are impossible
  (`resolveProjectPath` throws outside the named root), so this is a second
  `resolveProjectPath(seriesId, ...)` read plus a `copyFile`;
  `ImageManifest.relativePath` stays channel-relative or render/export break.
- `runOriginalityStage` excludes same-series stories from the fingerprint
  candidate set for variants. Four locales of one canon with a recurring cast
  would otherwise self-flag, and `gateQaPassed("script")` reads
  `originality-qa.publishable` — so assisted mode would silently stop
  auto-granting across the whole series.

## Story context builder

The headline claim is "chapter 40 stays continuous with chapter 3". A naive
priority scheme does not deliver it: character and world state grow linearly and
would sit in a band the budget is forbidden to shrink, so the context becomes
state-only around chapter 15–20 and then overflows with nothing droppable.

- **Bounded, relevance-selected state.** Characters and locations are selected
  by the chapter plan's cast, not "all characters". Each knowledge fact carries
  `status: active|superseded|retracted` and `supersedes?: factId`; a periodic
  rollup keeps each character at *bounded summary + last K deltas*.
- **Item-level budgeting with a total order.** Blocks carry
  `(priority, dropRank, minItems, required)`. Series rules and chapter plan are
  `required` and raise rather than drop. List blocks shrink item by item before
  any block is dropped whole. `dropRank` breaks priority ties, which would
  otherwise fall out of object key order.
- **A real ceiling.** `LlmEndpointConfig` has `maxOutputTokens` but no context
  window, so a writer pointed at an 8k local model overflows silently — and
  llama.cpp/Ollama truncate the *front* of the prompt, exactly where the stable
  bible and canon rules live. `contextWindowTokens` is added per role; effective
  budget is `min(window - maxOutputTokens - margin, canon.contextTokenBudget)`;
  the chars/4 estimate carries a ×1.15 safety factor; assembly over budget
  throws before the call; and estimated-vs-actual is recorded from
  `result.usage.promptTokens`, which `chatJsonWithUsage` already returns.
- **A defined query.** Query = plan beats + cast names + locations + open-thread
  titles. Pre-filter = entity in {cast, locations, threads-in-plan} OR
  `chapterNumber in [N-3, N-1]`. **topK per entity class**, so one chatty
  character cannot monopolise every slot. Chapters 1–3 take an explicit
  cold-start branch.

`context.json` is a normal stage artifact, so the existing generic viewer
`renderStoryArtifactView` renders the context debugger for one line in the tab
list — no bespoke screen.

## Retrieval and embeddings

Primary path is keyword + structured, over `normalizeText` / `shingles` /
`estimateJaccard` / `checkDuplicate` (`fingerprint.ts:13,21,52,76`).

Embeddings are optional, default disabled, behind the same `retrieve()`
signature: an `EmbeddingProvider` (Ollama / OpenAI-compatible) plus a JSONL
vector store with cosine in TS. Every vector is stamped with `embeddingModel`
and `dim` so a model change is detected rather than cosine-compared across
incompatible spaces, and scoring renormalises weights over the signals actually
present per record — otherwise enabling embeddings at chapter 12 would
systematically rank every earlier record last. Embedding calls go through the
same paid-request guard as chat and carry their own pricing entry; otherwise
they spend money that records as 0 and evades the budget guard.

## Memory integrity

- **Validation beyond referential integrity.** Rejecting unknown characters and
  source-less knowledge is not enough: duplicate and *contradicting* facts both
  pass and accumulate, and the continuity checker then treats mutually
  contradictory state as authoritative. Every knowledge delta carries
  `changeType: add|supersede|retract`, with `supersedes` mandatory for
  `supersede`; deltas dedupe on the normalized token form; an `add` is rejected
  when an active fact with the same subject/object exists.
- **Idempotency.** `eventId = sha256(seriesId|chapterNumber|deltaIndex|payload)`,
  skip-on-existing. `executeGuarded` re-runs any stage not marked `done`, so a
  crash between the ledger append and the `done` write would otherwise duplicate
  every event of that chapter on resume.
- **Retraction from an append-only ledger.** A `{type:"retract", targets:[...]}`
  record plus a materialised-view reader that *every* reader goes through.
  Re-running `memory-apply` first retracts that chapter's prior contributions.

## Localization

`localize` writes byte-identical artifacts to the `sections` stage
(`writeSectionFile` + `assembleScriptArtifact`), so `naturalize`, `section-edit`,
`scenes`, and `metadata` need no change. Its context is deliberately narrow:
canonical chapter, summary, relevant canon facts, character names and
relationships, important objects, locale notes, narration style, pronunciations
— not series history. It may rewrite structure, idiom, and rhythm; it may not
touch events, chronology, clues, identity, knowledge, relationships, world
rules, reveals, foreshadowing, objects, injuries, or deaths.

### Canon alignment — inverted

An LLM fact-diff used as a hard gate fires on precisely the transformations
localization is *instructed* to perform: pronunciation respelling (German
declines `Marcos Schlüssel`), digits to words (`tts-normalize` exists for
this), locale date order (`March 4` → `4 de marzo`). And detecting `03:17` vs
`03:30` requires reliably parsing *"las tres y diecisiete"* /
*"drei Uhr siebzehn"*, which a small local model will not do. Each false
positive re-localizes a section that has nothing wrong with it, fails again,
burns the escalation budget, and parks the variant.

Therefore:

1. A **deterministic typed pre-check is the only thing allowed to hard-FAIL**.
   Numbers, times, and dates are canonicalised on both sides — the canon side
   taken from typed `CanonEvent`/fact records, never re-extracted from canon
   prose — and compared as typed values through a per-locale word-to-value table.
2. **LLM extraction is WARN only.** Advisory, never an automatic re-localize.
3. **`alignmentExemptions`** on the channel's locale config declares intentional
   divergence (name respellings, honorifics, unit conversions) once.
4. **Every issue carries a `canonAnchor`** (event or fact id); an issue that
   cannot name one is dropped.

Alignment runs *after* `naturalize`, so it checks the text TTS will actually
read — one stage instead of two. Remediation re-runs `localize` for the
offending section indices only, which requires `runNaturalizeStage` to persist
per-section output (today it joins straight to one `fullText`). After any
remediation, alignment invalidates `naturalize`'s dependents, and
`gateQaPassed` additionally requires `originality-qa.status === "done"` —
otherwise assisted mode re-grants the script approval against a stale QA report.

## Loops, approval, safety

- **Loops.** `attemptCount` on `StageRun` counts stage *invocations*, not loop
  iterations, and resets on crash. Loop state therefore lives in the stage's own
  artifact — the pattern `tts` and `images` already use per chunk and per image.
  A per-chapter global attempt ceiling bounds all loops together, and a
  **no-progress rule** terminates any loop whose attempt did not strictly shrink
  the issue set.
- **Budget.** `assertWithinBudget` runs once per stage with a zero estimate, so
  a continuity loop escalating to a paid model could make several calls behind
  one passing check. It is re-asserted before each iteration, and escalation to
  a paid profile is **refused in an unattended job**: the operator confirmed a
  paid request for the pipeline, not a silent free-to-paid switch.
- **Canon approval.** `StoryApprovalStage` gains `"canon"`, anchored to a
  composite hash of the plan and chapter artifacts so regenerating the plan
  revokes it. **Assisted mode does not auto-grant canon.** `normalizeMode`
  defaults to `assisted` and `ensureGate` auto-approves when the matching QA
  passed, which would let a small local continuity checker approve its own
  canon — exactly what AGENTS.md's human-approval rule exists to prevent.
- **LOCKED.** A stored `lockedAt`, set automatically when any variant publishes;
  that is what makes "published content is never silently regenerated"
  enforceable. Unlock requires a note and marks published variants stale without
  touching artifacts.
- **Concurrency.** `writeJson` is a plain `writeFile`; two sessions writing
  `characters.json` interleave, and normalize-on-read makes the corruption
  *silent* — a truncated-but-parseable file normalizes to an empty roster.
  Canon entities use write-then-rename plus a per-series in-process mutex. Note
  one-job-per-owner does not cover this: the entity PUT routes bypass jobs.

## Model roles

Three roles join the existing total `storyFactory.models` record — `architect`,
`localizer`, `memory` — wired through `STAGE_ROLES`. The record stays **total**
with `model: ""` as the unset signal, which `stageEndpoint` already tests;
optional keys would break `pipeline.ts:234` and `routes.ts:628` at compile time.
Escalation needs no module: `runLlmCall` already takes `endpoint` as a
parameter, and only the `llmStage` wrapper hardcodes it — one optional argument
there is the whole mechanism.

## API

Chapters ride the existing `/api/series/:seriesId/stories/...` surface unchanged;
the artifact and stage-run route regexes already match the new stage ids. New
endpoints, mounted in the same router:

- `GET|PUT series/:id/canon/{bible|characters|world-state|arcs|threads}`
- `GET series/:id/canon/events`, `GET series/:id/canon/memory?q=`
- `POST series/:id/stories/:chapterId/approve/canon`, `.../lock`, `.../unlock`
- `POST series/:id/stories/:chapterId/publish-variants` — bulk, one job per variant
- `GET series/:id/canon/performance` — `rebuildPerformanceProfile` re-keyed by
  `canonRef.chapterId` and locale

## Frontend

The in-panel tab pattern (`STORY_TABS`), not a phase bar: `WORKSPACE_PHASES` and
the router's `PHASE_IDS` are fixed four-element sets shared with review-project
and series, and a twelve-phase canon nav cannot be expressed without changing
both. The canon series overview gains Bible / Characters / World / Arcs /
Threads / Events / Memory tabs; chapter detail reuses `renderStoryDetail` with a
canon tab list; Context / Continuity / Memory are free via the generic artifact
viewer. The config screen's hardcoded planner/writer/qa fields are refactored
into a loop over role names, so six roles cost what three did.

## Risks and accepted limitations

- Token budgeting is a chars/4 × 1.15 estimate calibrated against measured
  `usage.promptTokens`, not a real tokenizer.
- Retention/CTR need YouTube Analytics scopes the repo does not request; canon
  performance ships with views/likes/comments and cost.
- Prompt-cache ordering is a message-assembly convention only — no transport
  here implements `cache_control`, so it costs nothing and delivers nothing
  until one does.
- `src/audio-story.ts` remains live and duplicative pending a separate decision.
- Localization quality of a small local model is unproven; the alignment gate
  bounds factual drift, not prose quality.

## Out of scope

Model A/B comparison, ROI-driven generation, multi-hop RAG, autonomous mode.
