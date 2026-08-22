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

- [x] **Step 1: Write the failing test**

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

import { sampleCandidate, withSourcesRoot } from "./helpers.ts";
```

Both helpers are new and shared — Tasks 3, 4, 6, and 7 import them rather than redefining them. Add them to `tests/helpers.ts`, which currently imports `chmod, mkdtemp, writeFile` and needs `rm` added. `SourceCandidate` must be a **type-only** import (`import type { SourceCandidate } from "../src/sources/store.ts"`): a value import would pull the source store into every suite that touches helpers and risks an import cycle.

```ts
export async function withSourcesRoot(run: (root: string) => Promise<void>): Promise<void> {
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

export function sampleCandidate(id: string): SourceCandidate {
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

- [x] **Step 2: Run it and watch it fail**

Run: `node --test tests/sources-store.test.ts`
Expected: FAIL — `src/sources/store.ts` does not exist.

- [x] **Step 3: Add the root**

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

- [x] **Step 4: Write the store**

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

- [x] **Step 5: Verify and commit**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run and watch fail**

Run: `node --test tests/sources-yt-dlp.test.ts` — FAIL, module missing.

- [x] **Step 3: Add the config block**

In `src/config.ts`, mirroring the `render` block: a `sources` section with `ytDlpPath: stringValue(candidate.sources?.ytDlpPath, "")`, `format: stringValue(candidate.sources?.format, "bv*+ba/b")`, and `subtitleLanguages` normalised to a string array defaulting to `["en"]`.

- [x] **Step 4: Write the adapter**

Create `src/sources/yt-dlp.ts`. `fetchSourceMetadata` throws naming `sources.ytDlpPath` when no path is given, runs `[...prefixArgs, "--dump-single-json", "--skip-download", url]` through `runProcess`, parses stdout, and normalises: `extractor_key || "unknown"`, `webpage_url || url`, `title || url`, `uploader || ""`, `description || ""`, `Math.max(0, Math.floor(Number(duration) || 0))`. Wrap a `ProcessError` so its stderr passes through `redact` from `src/redact.ts` — a URL can carry a token, and the message is about to be shown and logged.

- [x] **Step 5: Verify and commit**

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

- [x] **Step 1: Write the failing test**

`tests/sources-candidates.test.ts` covers the duplicate policy — the part most likely to be got wrong:

```ts
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { addCandidate } from "../src/sources/candidates.ts";
import { listCandidates, saveCandidate } from "../src/sources/store.ts";
import { makeFakeExecutable, sampleCandidate, withSourcesRoot } from "./helpers.ts";

const PAYLOAD = {
  extractor_key: "Youtube",
  id: "dQw4w9WgXcQ",
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Episode 1",
  uploader: "Studio",
  duration: 1440,
  description: "First episode.",
};

async function ytDlpOptions(payload: unknown = PAYLOAD) {
  return {
    ytDlpPath: process.execPath,
    prefixArgs: [await makeFakeExecutable(`console.log(${JSON.stringify(JSON.stringify(payload))});`)],
  };
}

test("pasting the same video twice returns the first candidate", async () => {
  await withSourcesRoot(async () => {
    const first = await addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions());
    const second = await addCandidate("https://www.youtube.com/watch?v=dQw4w9WgXcQ", await ytDlpOptions());

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.candidate.id, first.candidate.id);
    assert.equal(second.candidate.addedAt, first.candidate.addedAt);
    assert.equal((await listCandidates()).length, 1);
  });
});

test("a different video colliding on one id is refused, naming both", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate({ ...sampleCandidate("youtube-dqw4w9wgxcq"), platformVideoId: "OTHERVIDEO" });

    await assert.rejects(
      async () => addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions()),
      (error: unknown) => /OTHERVIDEO/.test(String(error)) && /dQw4w9WgXcQ/.test(String(error)),
    );
  });
});

test("a directory with no candidate file cannot be created over", async () => {
  await withSourcesRoot(async (root) => {
    await mkdir(join(root, "youtube-dqw4w9wgxcq"), { recursive: true });

    await assert.rejects(
      async () => addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions()),
      /youtube-dqw4w9wgxcq/,
    );
  });
});

test("a candidate starts with unknown rights and no score", async () => {
  await withSourcesRoot(async () => {
    const { candidate } = await addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions());
    assert.equal(candidate.rights, "unknown");
    assert.equal(candidate.status, "metadata");
    assert.equal(candidate.score, undefined);
  });
});
```

In `tests/server.test.ts`, add:

```ts
test("the sources routes reject a missing url and list an empty store", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const listed = await fetch(`${running.url}/api/sources`);
      assert.deepEqual(await listed.json(), { sources: [] });

      const created = await fetch(`${running.url}/api/sources`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(created.status, 400);
      assert.equal((await created.json()).code, "source-url-required");
    } finally {
      await running.close();
    }
  });
});
```

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement `addCandidate`**

Derive the id from the fetched metadata. Then: no directory → create; `candidate.json` present and `platform` + `platformVideoId` both match → return it with `created: false`; present and not matching → throw naming both identities; directory present without `candidate.json` → throw naming the path.

- [x] **Step 4: Add the routes**

In `src/server.ts`, beside the existing `/api/projects` routes. 409 for the collision and the occupied-directory cases with codes `source-id-collision` and `source-directory-occupied`; 400 `source-url-required` for a missing url.

- [x] **Step 5: Verify and commit**

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

- [x] **Step 1: Write the failing test**

Append to `tests/sources-candidates.test.ts`:

```ts
test("a download is refused while rights are unknown, naming the candidate", async () => {
  await withSourcesRoot(async () => {
    const candidate = sampleCandidate("youtube-abc");
    assert.throws(() => assertDownloadable(candidate), /youtube-abc/);
  });
});

test("declaring rights records the note and permits the download", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    const updated = await setCandidateRights("youtube-abc", "third-party-fair-use", "Review commentary only.");

    assert.equal(updated.rights, "third-party-fair-use");
    assert.equal(updated.rightsNote, "Review commentary only.");
    assert.doesNotThrow(() => assertDownloadable(updated));
    assert.equal((await loadCandidate("youtube-abc"))?.rights, "third-party-fair-use");
  });
});

test("an unrecognised rights value is refused rather than coerced", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await assert.rejects(
      () => setCandidateRights("youtube-abc", "whatever" as never, ""),
      /rights/,
    );
    assert.equal((await loadCandidate("youtube-abc"))?.rights, "unknown");
  });
});
```

In `tests/server.test.ts`:

```ts
test("the rights route refuses a value it does not recognise", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await fetch(`${running.url}/api/sources/youtube-abc`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ rights: "whatever" }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "source-rights-invalid");
    } finally {
      await running.close();
    }
  });
});
```

- [x] **Step 2-4: Run, implement, verify**

`assertDownloadable` throws when `rights === "unknown"`. `setCandidateRights` validates against the four literals, takes the per-candidate lock, and rewrites `candidate.json`.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write the failing test**

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

test("a missing key names the environment variable it should come from", async () => {
  await assert.rejects(
    () => chatJson(
      { ...paidConfig, apiKey: "", apiKeyEnv: "OPENAI_API_KEY", fetch: async () => new Response("{}") },
      [{ role: "user", content: "hi" }],
      { confirmedPaidRequest: true },
    ),
    /OPENAI_API_KEY/,
  );
});

test("an abort is rethrown as an abort, not wrapped", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => chatJson(
      { ...localConfig, fetch: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } },
      [{ role: "user", content: "hi" }],
      { confirmedPaidRequest: false, signal: controller.signal },
    ),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("a non-ok body is redacted and truncated", async () => {
  await assert.rejects(
    () => chatJson(
      {
        ...localConfig,
        fetch: async () => new Response(`{"error":"Authorization: Bearer sk-live-ABC123DEF ${"x".repeat(600)}"}`, { status: 500 }),
      },
      [{ role: "user", content: "hi" }],
      { confirmedPaidRequest: false },
    ),
    (error: unknown) => {
      const message = String(error);
      return /\[redacted\]/.test(message) && !/sk-live-ABC123DEF/.test(message) && message.length < 800;
    },
  );
});

test("the returned string is the message content", async () => {
  let sent: unknown;
  const raw = await chatJson(
    {
      ...localConfig,
      fetch: async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    },
    [{ role: "user", content: "hi" }],
    { confirmedPaidRequest: false },
  );

  assert.equal(raw, '{"ok":true}');
  assert.deepEqual((sent as { messages: unknown }).messages, [{ role: "user", content: "hi" }]);
});
```

`paidConfig` and `localConfig` are the two `OpenAiCompatibleConfig` fixtures already used by `tests/llm-openai-compatible.test.ts`; copy their shape rather than inventing new ones.

**Codex verified the no-edit claim is achievable, with one condition.** `tests/llm-openai-compatible.test.ts` asserts that the request body's `messages` equals `buildScriptPrompt(request.brief)`. So `buildScriptPrompt` and `parseScriptGeneration` must stay in the **provider**, and only the transport moves. Pulling prompt construction into `chatJson` would break that test and prove the extraction went too far.

Write each body in full, mirroring the assertions already in `tests/llm-openai-compatible.test.ts`.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Move the code**

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

- [x] **Step 4: Verify nothing moved underfoot**

Run `npm test`. Every pre-existing LLM and script test must pass **without edits**. If any needed changing, the extraction changed behaviour — revert and redo.

- [x] **Step 5: Commit**

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
- Produces: `scoreCandidate(id, options: { scorer?: SourceScorer }): Promise<SourceCandidate>`, route `POST /api/sources/:id/score`, and:

```ts
export type SourceScorer = {
  readonly name: string;    // stamped into score.provider
  readonly model: string;   // stamped into score.model
  generate(candidate: SourceCandidate, signal?: AbortSignal): Promise<string>;  // raw model JSON
};
```

**This is deliberately not `LlmProvider`.** That interface returns a `ScriptGenerationResult`; a scorer returns raw JSON for `parseSourceScore` to validate. Typing the scorer as `LlmProvider` will not compile — Codex caught this in review. `createConfiguredScorer(config)` builds the OpenAI-compatible scorer over `chatJson`, and `createDryRunScorer()` is the default when no model is configured.

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceScore } from "../src/sources/score-parse.ts";
import { buildScorePrompt } from "../src/sources/score-prompt.ts";
import { scoreCandidate } from "../src/sources/score.ts";
import { loadCandidate, saveCandidate } from "../src/sources/store.ts";
import { sampleCandidate, withSourcesRoot } from "./helpers.ts";

const GOOD = JSON.stringify({
  value: 72,
  angle: "How the training arc breaks the usual pattern",
  hooks: ["The mentor lies in episode one"],
  risks: ["Heavy spoilers past the midpoint"],
  reason: "Clear arc with a contrarian read available.",
});

function scorerReturning(raw: string) {
  return { generate: async () => raw, name: "stub", model: "stub-model" };
}

test("the prompt carries metadata only, since nothing is downloaded yet", () => {
  const prompt = buildScorePrompt(sampleCandidate("youtube-abc"));
  const text = JSON.stringify(prompt);
  assert.match(text, /Episode 1/);
  assert.match(text, /Studio/);
  assert.ok(!/video\.mp4/.test(text));
});

test("a score records the provider and model that produced it", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    const updated = await scoreCandidate("youtube-abc", { scorer: scorerReturning(GOOD) });

    assert.equal(updated.score?.value, 72);
    assert.equal(updated.score?.provider, "stub");
    assert.equal(updated.score?.model, "stub-model");
    assert.ok(updated.score?.scoredAt);
    assert.equal((await loadCandidate("youtube-abc"))?.score?.value, 72);
  });
});

test("a value outside 0-100 is refused, naming the field", () => {
  assert.throws(() => parseSourceScore(JSON.stringify({ ...JSON.parse(GOOD), value: 140 })), /value/);
  assert.throws(() => parseSourceScore(JSON.stringify({ ...JSON.parse(GOOD), value: "high" })), /value/);
});

test("a malformed response leaves the previous score intact", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await scoreCandidate("youtube-abc", { scorer: scorerReturning(GOOD) });

    await assert.rejects(() => scoreCandidate("youtube-abc", { scorer: scorerReturning("not json") }));
    assert.equal((await loadCandidate("youtube-abc"))?.score?.value, 72);
  });
});

test("the dry-run scorer needs no model and says what it is", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    const updated = await scoreCandidate("youtube-abc", {});

    assert.equal(updated.score?.provider, "dry-run");
    assert.match(updated.score?.reason ?? "", /template|dry-run|not a model/i);
  });
});
```

- [x] **Step 2-4: Run, implement, verify**

`buildScorePrompt(candidate)` sends title, uploader, duration, and description only — nothing is downloaded yet — and demands a single JSON object. `parseSourceScore` validates like `src/llm/parse.ts`, naming the bad field. `scoreCandidate` stamps `provider`, `model`, and `scoredAt`, and writes under the per-candidate lock.

- [x] **Step 5: Commit**

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
- Produces: `parseDownloadProgress(line: string): number | null`, `selectSubtitle(files: string[], languages: string[]): { path: string; language: string } | null`, and:

```ts
export type DownloadOptions = {
  ytDlpPath?: string;          // falls back to config.sources.ytDlpPath
  prefixArgs?: string[];       // tests only, as ffmpegPrefixArgs is used elsewhere
  format?: string;             // falls back to config.sources.format
  subtitleLanguages?: string[];
  ffmpegPath?: string;         // absent means subtitles are not converted, not that the download fails
  signal?: AbortSignal;
  update?: (progress: number, message: string) => Promise<void>;
};

export function downloadCandidate(id: string, options: DownloadOptions): Promise<SourceCandidate>;
```

Routes: `POST /api/sources/:id/download`, `POST /api/sources/:id/cancel`, `DELETE /api/sources/:id`, `GET /api/sources/:id/events`.

**The cancel route is new to this plan.** The spec requires `DELETE` to be refused while a job runs, but with no way to cancel a source job that state would be a dead end — and the delete test could not be written. `POST /api/sources/:id/cancel` calls `sourceJobs.cancel`, mirroring what the project side already does internally.

**The download command**, assembled from config:

```
[...prefixArgs, "-f", format, "--write-subs", "--write-auto-subs", "--convert-subs", "srt",
 "--newline", "-o", "<candidateDir>/video.%(ext)s", canonicalUrl]
```

`--newline` is what makes progress parseable line by line. When no ffmpeg path is configured, `--convert-subs srt` is dropped and whatever subtitle format arrives is recorded as-is; a missing converter must not fail a download that otherwise succeeded.

**Abort classification.** `runProcess` passes `options.signal` straight to `spawn`, so Node rejects with an `AbortError` on the child's `error` event — **not** a `ProcessError`. `downloadCandidate` distinguishes them: an `AbortError` returns the candidate to `metadata`, anything else sets `failed` with the message. Codex confirmed this against `src/process.ts`; treating an abort as a failure would leave a cancelled download looking broken.

**Cleanup ownership.** The `finally` block removes partial media and fragments, wrapped in its own try/catch, and the status write happens after it regardless. A full disk that also defeats cleanup must still leave `failed` on record rather than an empty catch and a candidate frozen in `downloading`.

- [x] **Step 1: Write the failing test**

```ts
test("progress comes off the download lines", () => {
  assert.equal(parseDownloadProgress("[download]  42.7% of 1.00GiB at 2MiB/s"), 42.7);
  assert.equal(parseDownloadProgress("[info] writing subtitles"), null);
});

test("author subtitles beat auto-generated ones, then configured language order", () => {
  const files = ["video.vi.srt", "video.en.srt", "video.en.auto.srt"];
  assert.deepEqual(selectSubtitle(files, ["en", "vi"]), { path: "video.en.srt", language: "en" });
  assert.deepEqual(selectSubtitle(["video.vi.srt", "video.en.auto.srt"], ["en", "vi"]), {
    path: "video.vi.srt",
    language: "vi",
  });
});

test("no subtitle at all is not a failure", () => {
  assert.equal(selectSubtitle(["video.mp4"], ["en"]), null);
});

test("a download is refused while rights are unknown", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    const options = await downloadOptions();
    await assert.rejects(() => downloadCandidate("youtube-abc", options), /rights/);
  });
});

test("a failed download leaves status failed, an error, and no partial file", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const options = await downloadOptions({ partial: true, exitCode: 1 });

    await assert.rejects(() => downloadCandidate("youtube-abc", options));

    const candidate = await loadCandidate("youtube-abc");
    assert.equal(candidate?.status, "failed");
    assert.ok(candidate?.error);
    assert.equal(candidate?.media, undefined);
    assert.deepEqual(await readdir(resolveSourcePath("youtube-abc")), ["candidate.json"]);
  });
});

test("an aborted download returns the candidate to metadata and removes partials", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const controller = new AbortController();
    const options = await downloadOptions({ partial: true, hang: true, signal: controller.signal });

    const running = downloadCandidate("youtube-abc", options);
    controller.abort();
    await assert.rejects(() => running);

    const candidate = await loadCandidate("youtube-abc");
    assert.equal(candidate?.status, "metadata");
    assert.deepEqual(await readdir(resolveSourcePath("youtube-abc")), ["candidate.json"]);
  });
});

test("a retry clears the previous error and media before starting", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const failing = await downloadOptions({ exitCode: 1 });
    await assert.rejects(() => downloadCandidate("youtube-abc", failing));

    const candidate = await downloadCandidate("youtube-abc", await downloadOptions());

    assert.equal(candidate.status, "downloaded");
    assert.equal(candidate.error, undefined);
    assert.ok(candidate.media?.videoRelativePath);
  });
});
```

`downloadOptions` builds a fake yt-dlp that optionally writes a partial file, optionally hangs until aborted, and exits with the given code; `saveDeclaredCandidate` saves a candidate with rights already declared. Write both in this file beside the tests.

In `tests/server.test.ts`:

```ts
test("deleting a source is refused while one of its jobs is running", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await seedDeclaredCandidate("youtube-abc");                 // writes candidate.json under sources/
      const hanging = await makeFakeExecutable("setInterval(() => {}, 1000);");
      await writeStudioConfig({ sources: { ytDlpPath: process.execPath, ytDlpArgs: [hanging] } });

      const started = await fetch(`${running.url}/api/sources/youtube-abc/download`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(started.status, 202);

      const deleted = await fetch(`${running.url}/api/sources/youtube-abc`, {
        method: "DELETE",
        headers: { origin: running.url },
      });
      assert.equal(deleted.status, 409);
      assert.equal((await deleted.json()).code, "source-job-running");

      const cancelled = await fetch(`${running.url}/api/sources/youtube-abc/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ jobId: (await started.json()).job.id }),
      });
      assert.equal(cancelled.status, 200);
    } finally {
      await running.close();
    }
  });
});
```

**No route may ever take an executable path or process arguments from the request body.** Doing so would turn a same-origin POST into arbitrary command execution. No existing route in this repo does it — verified — and this plan does not start. Tests reach a fake binary through `studio.config.json`, which the operator owns and no page can write: the `sources` config block therefore carries `ytDlpArgs: string[]` alongside `ytDlpPath`, prepended to every invocation, exactly as `prefixArgs` works in the module-level API. `writeStudioConfig` writes that file into the temp cwd; `seedDeclaredCandidate` writes a candidate with rights declared into the sources root `withTempCwd` establishes.

Add `ytDlpArgs` to the Task 2 config block and its defaults test (`[]`).

- [x] **Step 2-4: Run, implement, verify**

The download runs on `sourceJobs = new ProjectJobManager(sourcesRoot)` with its own `startSourceJob` and `sendSourceEvents` helpers in `src/server.ts` — the project helpers persist to the projects root and must not be reused. `JobKind` gains `"download"` and `"score"`; the UI label map gains both. Document in `src/jobs.ts` that `JobRecord.projectId` carries the owner id, which is a candidate id for this manager.

Cleanup lives in `finally`: remove partial media and fragments, then write status. A cleanup failure must not prevent the status write, and neither abort nor failure may leave `downloaded`.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2-4: Run, implement, verify**

A paste box, and a list sorted by `score.value` descending with unscored candidates last. Each row shows title, uploader, duration, platform, rights, status, and — when scored — `value`, `angle`, and `risks`. `reason` and `risks` are shown beside the number, never the number alone: the score is an ordinal hint, and hiding its reasoning would present it as a verdict.

The download control is disabled while `rights === "unknown"`, with the reason in text rather than only as a disabled state.

- [x] **Step 5: Drive it**

Run `npm run studio`, open the Sources screen, paste a URL. With no `sources.ytDlpPath` configured, expect the error naming that setting — that is the correct result, not a failure of the screen.

- [x] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: add the sources triage screen"
```
