# Source Acquisition Implementation Plan (Effort 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a video URL, see what it is, say what you may do with it, let the model say whether it is worth reviewing, and download it — all without touching project code.

**Architecture:** A `sources/` store sibling to `projects/`, one directory per candidate. A yt-dlp adapter behind a configured path, as ffmpeg already is. Scoring reuses the script model through a transport extracted from the OpenAI-compatible provider. Downloads and scoring run as jobs on a second `ProjectJobManager` rooted at the sources store.

**Tech Stack:** Node 22 native TypeScript type-stripping, `node:test`, vanilla DOM in `src/web/app.js`, `yt-dlp` as an external binary.

**Spec:** `docs/superpowers/specs/2026-08-22-source-acquisition-design.md` — Effort 1 only. Promotion (Effort 2) is out of scope here and gets its own plan.

## Global Constraints

- Node >= 22.6.0, native type-stripping. Every local import carries an explicit `.ts` extension.
- No new runtime dependencies. `busboy` remains the only one.
- Run `npm test` on its own — running it concurrently with another command in the same working directory makes suites collide over the cwd-relative `studio.config.json` and produces phantom failures.
- No test may reach the network or invoke a real `yt-dlp`. Drive a fake executable through prefix args, as `tests/smoke.test.ts` does for ffmpeg and piper.
- `tests/web.test.ts` asserts on the source text of `src/web/app.js` and `src/web/styles.css`. There is no DOM harness.
- `src/web/app.js` is plain JavaScript. No type annotations.
- **Boundary, non-negotiable:** one pasted URL at a time. No channel crawling, no bulk queue, no scheduled polling, no watermark removal, no content-matching evasion. This holds regardless of what `AGENTS.md` says at any given moment.
- Candidate rights never satisfy a project gate. Nothing in this effort touches `evaluateEditRenderGate`.

---

### Task 1: The sources store

**Files:**
- Modify: `src/fs.ts` (add `sourcesRoot`)
- Modify: `.gitignore`
- Create: `src/sources/store.ts`
- Test: `tests/sources-store.test.ts`

**Interfaces:**
- Produces: `sourcesRoot(): string`; `validateSourceId(id: string): string`; `deriveSourceId(extractorKey: string, platformVideoId: string): string`; `resolveSourcePath(id: string, ...segments: string[]): string`; `saveCandidate`, `loadCandidate`, `listCandidates`; and the `SourceCandidate`, `SourceScore`, `SourceRights`, `SourceStatus` types. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

Create `tests/sources-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourcesRoot, projectsRoot } from "../src/fs.ts";
import {
  deriveSourceId,
  listCandidates,
  loadCandidate,
  resolveSourcePath,
  saveCandidate,
  validateSourceId,
  type SourceCandidate,
} from "../src/sources/store.ts";

function sampleCandidate(id: string): SourceCandidate {
  return {
    version: 1,
    id,
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    platform: "Youtube",
    platformVideoId: "dQw4w9WgXcQ",
    title: "Episode 1",
    uploader: "Studio",
    durationSeconds: 1440,
    description: "First episode.",
    addedAt: "2026-08-22T00:00:00.000Z",
    status: "metadata",
    rights: "unknown",
    rightsNote: "",
  };
}

async function withSourcesRoot(run: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env.YT_STUDIO_SOURCES_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-sources-"));
  process.env.YT_STUDIO_SOURCES_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_SOURCES_DIR;
    else process.env.YT_STUDIO_SOURCES_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("the sources root is a sibling of the projects root, never inside it", () => {
  assert.notEqual(sourcesRoot(), projectsRoot());
  assert.ok(!sourcesRoot().startsWith(`${projectsRoot()}`));
});

test("ids derive from the platform and its own video id", () => {
  assert.equal(deriveSourceId("Youtube", "dQw4w9WgXcQ"), "youtube-dqw4w9wgxcq");
  assert.equal(deriveSourceId("BiliBili", "BV1xx411c7XD"), "bilibili-bv1xx411c7xd");
});

test("a platform id that sanitises away still produces a usable id", () => {
  const id = deriveSourceId("Youtube", "!!!");
  assert.notEqual(id, "youtube-");
  assert.equal(validateSourceId(id), id);
  assert.equal(id, deriveSourceId("Youtube", "!!!"));
  assert.notEqual(id, deriveSourceId("Youtube", "???"));
});

test("source paths cannot escape the candidate directory", () => {
  assert.throws(() => resolveSourcePath("youtube-abc", "..", "..", "escape.txt"), /outside/);
});

test("candidates round-trip through the store", async () => {
  await withSourcesRoot(async () => {
    assert.equal(await loadCandidate("youtube-abc"), null);
    const candidate = sampleCandidate("youtube-abc");
    await saveCandidate(candidate);
    assert.deepEqual(await loadCandidate("youtube-abc"), candidate);
    assert.deepEqual((await listCandidates()).map((entry) => entry.id), ["youtube-abc"]);
  });
});

test("a directory without a readable candidate file is never listed", async () => {
  await withSourcesRoot(async (root) => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await mkdir(join(root, "youtube-orphan"), { recursive: true });
    await writeFile(join(root, "youtube-orphan", "video.mp4"), "not ours", "utf8");
    assert.deepEqual((await listCandidates()).map((entry) => entry.id), ["youtube-abc"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/sources-store.test.ts`
Expected: FAIL — `src/sources/store.ts` does not exist.

- [ ] **Step 3: Add the root**

In `src/fs.ts`, beside `projectsRoot`:

```ts
const DEFAULT_SOURCES_DIR = "sources";

/**
 * Sibling of the projects root, never nested inside it: one download is meant to
 * serve several projects, so it cannot live inside any one of them.
 */
export function sourcesRoot(): string {
  const configured = process.env.YT_STUDIO_SOURCES_DIR;
  return configured ? resolve(configured) : resolve(process.cwd(), DEFAULT_SOURCES_DIR);
}
```

Add `sources/` to `.gitignore` beside `projects/`.

- [ ] **Step 4: Write the store**

Create `src/sources/store.ts` with the types from the spec plus:

```ts
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function validateSourceId(id: string): string {
  const normalized = id.trim();
  if (!SOURCE_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid source id. Use 3-81 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

/**
 * Derived from the video the platform already names, so pasting one URL twice
 * finds the existing candidate instead of making a second one. Sanitising can
 * empty a platform id, so a hashed form keeps such a source addressable.
 */
export function deriveSourceId(extractorKey: string, platformVideoId: string): string {
  const platform = slug(extractorKey) || "source";
  const video = slug(platformVideoId);
  const candidate = `${platform}-${video}`;
  if (video && SOURCE_ID_PATTERN.test(candidate)) return candidate;
  const digest = createHash("sha256").update(`${extractorKey}:${platformVideoId}`).digest("hex").slice(0, 10);
  return `${platform}-${digest}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolveSourcePath(id: string, ...segments: string[]): string {
  const safeId = validateSourceId(id);
  const root = resolve(sourcesRoot(), safeId);
  const resolved = resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Resolved path is outside the sources directory.");
  }
  return resolved;
}
```

`saveCandidate` writes `candidate.json` through `mkdir` + `writeFile`. `loadCandidate` returns `null` on `ENOENT`. `listCandidates` reads the root, keeps entries passing `validateSourceId`, loads each, and **skips any whose `candidate.json` is missing or unreadable** rather than throwing or inventing one.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/sources-store.test.ts` — PASS. Then `npm test` and `npx tsc --noEmit`.

```bash
git add src/fs.ts src/sources/store.ts tests/sources-store.test.ts .gitignore
git commit -m "feat: add a sources store beside the projects store"
```

---

### Task 2: yt-dlp metadata

**Files:**
- Modify: `src/config.ts` (a `sources` block)
- Create: `src/sources/yt-dlp.ts`
- Test: `tests/sources-yt-dlp.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `SourceCandidate` from Task 1.
- Produces: `fetchSourceMetadata(url, options): Promise<SourceMetadata>` where `SourceMetadata = { platform, platformVideoId, canonicalUrl, title, uploader, durationSeconds, description }`; and `YtDlpOptions = { ytDlpPath?: string; prefixArgs?: string[]; signal?: AbortSignal }`. Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `tests/sources-yt-dlp.test.ts`. The fake executable prints a recorded yt-dlp payload, so nothing reaches the network:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { fetchSourceMetadata } from "../src/sources/yt-dlp.ts";
import { makeFakeExecutable } from "./helpers.ts";

async function fakeYtDlp(payload: unknown): Promise<string> {
  return makeFakeExecutable(`console.log(${JSON.stringify(JSON.stringify(payload))});`);
}

test("metadata comes back normalised from a dump-json payload", async () => {
  const executable = await fakeYtDlp({
    extractor_key: "Youtube",
    id: "dQw4w9WgXcQ",
    webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Episode 1",
    uploader: "Studio",
    duration: 1440.6,
    description: "First episode.",
  });

  const metadata = await fetchSourceMetadata("https://youtu.be/dQw4w9WgXcQ", {
    ytDlpPath: process.execPath,
    prefixArgs: [executable],
  });

  assert.equal(metadata.platform, "Youtube");
  assert.equal(metadata.platformVideoId, "dQw4w9WgXcQ");
  assert.equal(metadata.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(metadata.title, "Episode 1");
  assert.equal(metadata.durationSeconds, 1440);
});

test("a sparse payload still yields a usable candidate", async () => {
  const executable = await fakeYtDlp({ extractor_key: "", id: "abc", duration: null });

  const metadata = await fetchSourceMetadata("https://example.com/watch/abc", {
    ytDlpPath: process.execPath,
    prefixArgs: [executable],
  });

  assert.equal(metadata.platform, "unknown");
  assert.equal(metadata.uploader, "");
  assert.equal(metadata.description, "");
  assert.equal(metadata.durationSeconds, 0);
  assert.equal(metadata.title, "https://example.com/watch/abc");
  assert.equal(metadata.canonicalUrl, "https://example.com/watch/abc");
});

test("the fetch names the setting when no binary is configured", async () => {
  await assert.rejects(() => fetchSourceMetadata("https://example.com/x", {}), /sources\.ytDlpPath/);
});

test("a failing yt-dlp surfaces its message with credentials redacted", async () => {
  const executable = await makeFakeExecutable(
    `console.error("ERROR: token=sk-live-ABC123DEF unsupported URL"); process.exit(1);`,
  );
  await assert.rejects(
    () => fetchSourceMetadata("https://example.com/x", { ytDlpPath: process.execPath, prefixArgs: [executable] }),
    (error) => /\[redacted\]/.test(String(error)) && !/sk-live-ABC123DEF/.test(String(error)),
  );
});
```

Append to `tests/config.test.ts` a case asserting the `sources` block defaults: `ytDlpPath: ""`, `format: "bv*+ba/b"`, `subtitleLanguages: ["en"]`.

- [ ] **Step 2: Run and watch fail**

Run: `node --test tests/sources-yt-dlp.test.ts` — FAIL, module missing.

- [ ] **Step 3: Add the config block**

In `src/config.ts`, mirroring the `render` block: a `sources` section with `ytDlpPath: stringValue(candidate.sources?.ytDlpPath, "")`, `format: stringValue(candidate.sources?.format, "bv*+ba/b")`, and `subtitleLanguages` normalised to a string array defaulting to `["en"]`.

- [ ] **Step 4: Write the adapter**

Create `src/sources/yt-dlp.ts`. `fetchSourceMetadata` throws naming `sources.ytDlpPath` when no path is given, runs `[...prefixArgs, "--dump-single-json", "--skip-download", url]` through `runProcess`, parses stdout, and normalises: `extractor_key || "unknown"`, `webpage_url || url`, `title || url`, `uploader || ""`, `description || ""`, `Math.max(0, Math.floor(Number(duration) || 0))`. Wrap a `ProcessError` so its stderr passes through `redact` from `src/redact.ts` — a URL can carry a token, and the message is about to be shown and logged.

- [ ] **Step 5: Verify and commit**

```bash
git add src/config.ts src/sources/yt-dlp.ts tests/sources-yt-dlp.test.ts tests/config.test.ts
git commit -m "feat: read source metadata without downloading anything"
```

---

### Task 3: Create, list, and read candidates over HTTP

**Files:**
- Create: `src/sources/candidates.ts`
- Modify: `src/server.ts`
- Test: `tests/sources-candidates.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1's store, Task 2's `fetchSourceMetadata`.
- Produces: `addCandidate(url, options): Promise<{ candidate: SourceCandidate; created: boolean }>`, and the routes `GET /api/sources`, `POST /api/sources`, `GET /api/sources/:id`. Tasks 4, 6, and 7 add routes beside these.

- [ ] **Step 1: Write the failing test**

`tests/sources-candidates.test.ts` covers the duplicate policy — the part most likely to be got wrong:

```ts
test("pasting the same video twice returns the first candidate", async () => {
  // addCandidate twice with the same payload -> created true, then false, one directory
});

test("a different video colliding on one id is refused, naming both", async () => {
  // save a candidate, then addCandidate whose derived id matches but whose
  // platformVideoId differs -> rejects with both identities in the message
});

test("a directory with no candidate file cannot be created over", async () => {
  // mkdir sources/<id>, then addCandidate deriving that id -> rejects naming the path
});
```

Write each body out in full against the real modules, following the `withSourcesRoot` helper from Task 1.

In `tests/server.test.ts`, add: `POST /api/sources` with no `url` returns 400 `source-url-required`; `GET /api/sources` on an empty store returns `{ sources: [] }`.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement `addCandidate`**

Derive the id from the fetched metadata. Then: no directory → create; `candidate.json` present and `platform` + `platformVideoId` both match → return it with `created: false`; present and not matching → throw naming both identities; directory present without `candidate.json` → throw naming the path.

- [ ] **Step 4: Add the routes**

In `src/server.ts`, beside the existing `/api/projects` routes. 409 for the collision and the occupied-directory cases with codes `source-id-collision` and `source-directory-occupied`; 400 `source-url-required` for a missing url.

- [ ] **Step 5: Verify and commit**

```bash
git add src/sources/candidates.ts src/server.ts tests/sources-candidates.test.ts tests/server.test.ts
git commit -m "feat: add source candidates from a pasted url"
```

---

### Task 4: The rights gate

**Files:**
- Modify: `src/sources/candidates.ts`, `src/server.ts`
- Test: `tests/sources-candidates.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Produces: `setCandidateRights(id, rights, rightsNote): Promise<SourceCandidate>` and `assertDownloadable(candidate): void`, both consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
test("rights start unknown and downloads are refused until declared", () => {
  // assertDownloadable on a fresh candidate throws naming the candidate id
});

test("declaring rights records the note and permits the download", () => {
  // setCandidateRights(..., "third-party-fair-use", "review commentary")
  // assertDownloadable no longer throws
});

test("an unrecognised rights value is refused rather than coerced", () => {
  // setCandidateRights(..., "whatever") rejects naming the field
});
```

In `tests/server.test.ts`: `PATCH /api/sources/:id` with a bad rights value returns 400 `source-rights-invalid`.

- [ ] **Step 2-4: Run, implement, verify**

`assertDownloadable` throws when `rights === "unknown"`. `setCandidateRights` validates against the four literals, takes the per-candidate lock, and rewrites `candidate.json`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: gate source downloads behind a rights declaration"
```

---

### Task 5: Extract the chat transport

Pure refactor. The existing script-generation tests are the proof it changed nothing — **do not modify them**.

**Files:**
- Create: `src/llm/chat.ts`
- Modify: `src/llm/openai-compatible.ts`
- Test: `tests/llm-chat.test.ts`; `tests/llm-openai-compatible.test.ts` and `tests/script-generation.test.ts` must pass untouched.

**Interfaces:**
- Produces: `chatJson(config: OpenAiCompatibleConfig, messages: ChatMessage[], options: { confirmedPaidRequest: boolean; signal?: AbortSignal }): Promise<string>`. Task 6 consumes it.

- [ ] **Step 1: Write the failing test**

`tests/llm-chat.test.ts`, with an injected `fetch`:

```ts
test("a paid model without confirmation is refused before any request", async () => {
  let called = false;
  await assert.rejects(
    () => chatJson({ ...paidConfig, fetch: async () => { called = true; return new Response("{}"); } },
      [{ role: "user", content: "hi" }], { confirmedPaidRequest: false }),
    /paid/,
  );
  assert.equal(called, false);
});

test("a missing key names the environment variable it should come from", async () => { /* ... */ });
test("an abort is rethrown as an abort, not wrapped", async () => { /* ... */ });
test("a non-ok body is redacted and truncated", async () => { /* ... */ });
test("the returned string is the message content", async () => { /* ... */ });
```

Write each body in full, mirroring the assertions already in `tests/llm-openai-compatible.test.ts`.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Move the code**

Move everything from endpoint construction through content extraction into `chatJson`, unchanged. `createOpenAiCompatibleProvider.generate` becomes:

```ts
    async generate(request, signal) {
      const raw = await chatJson(config, buildScriptPrompt(request.brief), {
        confirmedPaidRequest: request.confirmedPaidRequest,
        signal,
      });
      return parseScriptGeneration(raw, request.projectId);
    },
```

- [ ] **Step 4: Verify nothing moved underfoot**

Run `npm test`. Every pre-existing LLM and script test must pass **without edits**. If any needed changing, the extraction changed behaviour — revert and redo.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: extract the chat transport from script generation"
```

---

### Task 6: Scoring

**Files:**
- Create: `src/sources/score-prompt.ts`, `src/sources/score-parse.ts`, `src/sources/score.ts`
- Modify: `src/server.ts`
- Test: `tests/sources-score.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: `chatJson` from Task 5, the store from Task 1.
- Produces: `scoreCandidate(id, options): Promise<SourceCandidate>`, route `POST /api/sources/:id/score`.

- [ ] **Step 1: Write the failing test**

```ts
test("a score records the provider and model that produced it", () => { /* ... */ });
test("a value outside 0-100 is refused, naming the field", () => { /* ... */ });
test("a malformed response leaves the previous score intact", () => { /* ... */ });
test("the dry-run scorer is obviously synthetic and needs no model", () => { /* ... */ });
```

- [ ] **Step 2-4: Run, implement, verify**

`buildScorePrompt(candidate)` sends title, uploader, duration, and description only — nothing is downloaded yet — and demands a single JSON object. `parseSourceScore` validates like `src/llm/parse.ts`, naming the bad field. `scoreCandidate` stamps `provider`, `model`, and `scoredAt`, and writes under the per-candidate lock.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: score source candidates with the configured model"
```

---

### Task 7: Download

The riskiest task: a long-running external process writing files that must not survive its own failure.

**Files:**
- Modify: `src/sources/yt-dlp.ts`, `src/sources/candidates.ts`, `src/server.ts`
- Test: `tests/sources-download.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Produces: `downloadCandidate(id, options): Promise<SourceCandidate>`, `parseDownloadProgress(line): number | null`, `selectSubtitle(files, languages): { path: string; language: string } | null`; routes `POST /api/sources/:id/download`, `DELETE /api/sources/:id`, `GET /api/sources/:id/events`.

- [ ] **Step 1: Write the failing test**

```ts
test("progress comes off the download lines", () => {
  assert.equal(parseDownloadProgress("[download]  42.7% of 1.00GiB at 2MiB/s"), 42.7);
  assert.equal(parseDownloadProgress("[info] writing subtitles"), null);
});

test("author subtitles beat auto-generated ones, then configured language order", () => { /* ... */ });
test("no subtitle at all is not a failure", () => { /* ... */ });
test("a download is refused while rights are unknown", () => { /* ... */ });
test("a failed download leaves status failed, an error, and no partial file", () => { /* ... */ });
test("an aborted download returns the candidate to metadata and removes partials", () => { /* ... */ });
test("a retry clears the previous error and media before starting", () => { /* ... */ });
test("delete is refused while a job runs", () => { /* ... */ });
```

- [ ] **Step 2-4: Run, implement, verify**

The download runs on `sourceJobs = new ProjectJobManager(sourcesRoot)` with its own `startSourceJob` and `sendSourceEvents` helpers in `src/server.ts` — the project helpers persist to the projects root and must not be reused. `JobKind` gains `"download"` and `"score"`; the UI label map gains both. Document in `src/jobs.ts` that `JobRecord.projectId` carries the owner id, which is a candidate id for this manager.

Cleanup lives in `finally`: remove partial media and fragments, then write status. A cleanup failure must not prevent the status write, and neither abort nor failure may leave `downloaded`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: download a declared source as a background job"
```

---

### Task 8: The Sources screen

**Files:**
- Modify: `src/web/index.html`, `src/web/app.js`, `src/web/styles.css`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: every route above.

- [ ] **Step 1: Write the failing test**

```ts
test("the sources screen exposes paste, rights, score, and download", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const html = await readFile("src/web/index.html", "utf8");

  assert.match(html, /id="open-sources"/);
  assert.match(script, /"\/api\/sources"/);
  assert.match(script, /third-party-fair-use/);
  assert.match(script, /Declare rights/);
  assert.match(script, /Score candidate/);
  assert.match(script, /Download source/);
  assert.match(script, /rights are unknown/i);
});
```

- [ ] **Step 2-4: Run, implement, verify**

A paste box, and a list sorted by `score.value` descending with unscored candidates last. Each row shows title, uploader, duration, platform, rights, status, and — when scored — `value`, `angle`, and `risks`. `reason` and `risks` are shown beside the number, never the number alone: the score is an ordinal hint, and hiding its reasoning would present it as a verdict.

The download control is disabled while `rights === "unknown"`, with the reason in text rather than only as a disabled state.

- [ ] **Step 5: Drive it**

Run `npm run studio`, open the Sources screen, paste a URL. With no `sources.ytDlpPath` configured, expect the error naming that setting — that is the correct result, not a failure of the screen.

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: add the sources triage screen"
```
