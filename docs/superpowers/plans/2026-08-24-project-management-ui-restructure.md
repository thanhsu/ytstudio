# Project Management & UI/UX Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 3,900-line `src/web/app.js` monolith into hash-routed screens with an independent project-management screen and a fixed Overview → Content → Edit → Publish workspace flow for all three project types.

**Architecture:** Vanilla-JS ES modules served statically by the existing Node server. A small hash router in `main.js` dispatches to screen modules; shared code lives in `lib/` (api, dom builders, state + SSE, phase model, shell regions). Existing screen code is *moved verbatim* into screen modules — the only rewrites are the navigation frame and the SSE handler registry. Backend APIs unchanged; one server edit widens static file serving.

**Tech Stack:** Node ≥22.6 (native TS via `node src/server.ts`), vanilla JS ES modules (no framework, no build step, zero new npm dependencies), `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-24-project-management-ui-restructure-design.md`

## Global Constraints

- Zero new npm dependencies; no frontend framework; no build step for `src/web`.
- All UI labels in English. Phase labels exactly: `Overview`, `Content`, `Edit`, `Publish`.
- Backend API routes unchanged. The only `src/server.ts` edit is the static-serving condition (Task 1).
- Every non-`/api/` GET serves from `src/web/` behind the existing `resolveStaticFilePath` traversal guard.
- Moved code is moved **verbatim** except for: adding `import`/`export` statements, and the specific rewrites shown in each task. Do not reformat, rename, or "improve" moved functions.
- After every task: `npm test` and `npm run typecheck` must pass; then commit.
- Screen modules must not touch `document` at module top level (only inside functions), so `node --test` can import any module. DOM element binding happens inside exported `bind*` functions.
- Tests import web modules directly (pattern already used by `tests/sources-search-queries.test.ts`).
- Work on branch `feature/project-management-ui-restructure` (already created; spec committed).
- **Anchor note (amended 2026-08-24 after Phase 2 rebase):** every `L<число>`/line anchor in the task inventories comes from the pre-Phase-2 snapshot of app.js. Master has since added ~118 lines (story-factory Phase 2 UI, Facebook source platform). Function NAMES are authoritative — locate by name (grep), never trust a line number.
- **Phase 2 preservation:** app.js now also contains `renderStorySectionsTab`, `renderStoryPublishTab`, `renderPromptSettings`, `renderStoryCalendar`, `renderCompilations`, a `publish` entry in `STORY_STAGE_LIST` and `STORY_TABS`, Phase 2 config fields (planner/writer/QA provider selectors, YouTube settings, render transitions, Facebook search prefix), and a `facebook` option in `sourcePlatformOptions`. All of it must survive the extraction — the tasks below say where each piece lands.

---

### Task 1: Serve every static file under src/web

The server currently whitelists four exact paths. The module split needs `lib/*.js` and `screens/*.js` served too. All real API routes live under `/api/`, so any other GET can safely fall through to the static handler (which 404s on misses and blocks traversal).

**Files:**
- Modify: `src/server.ts:238-247` (the static whitelist inside `routeRequest`)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: existing `resolveStaticFilePath`, `sendStatic` (unchanged).
- Produces: GET `/lib/<file>.js`, `/screens/<file>.js`, `/main.js` → 200 with `text/javascript`. All later tasks rely on this.

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.ts` (reuse the file's existing imports of `startStudioServer`; follow the file's existing temp-dir server test pattern — look at how other tests in this file build a `staticRoot` with `mkdtemp` and start/stop the server):

```ts
test("static serving covers nested module files under src/web", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-static-"));
  await mkdir(join(root, "src", "web", "lib"), { recursive: true });
  await writeFile(join(root, "src", "web", "lib", "sample.js"), "export const ok = true;\n");

  const server = await startStudioServer({ port: 0, staticRoot: root });
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const hit = await fetch(`${base}/lib/sample.js`);
    assert.equal(hit.status, 200);
    assert.match(hit.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(await hit.text(), "export const ok = true;\n");

    const miss = await fetch(`${base}/lib/missing.js`);
    assert.equal(miss.status, 404);

    const api = await fetch(`${base}/api/unknown-route`);
    assert.equal(api.status, 404);
  } finally {
    server.close();
  }
});
```

If `startStudioServer`'s actual signature differs (check its definition in `src/server.ts` and how `tests/server.test.ts` already calls it), match the existing call style — several tests in that file already start a real server; copy their setup/teardown exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/server.test.ts`
Expected: the new test FAILS — `/lib/sample.js` returns 404 because only the four whitelisted paths reach `sendStatic`.

- [ ] **Step 3: Widen the static condition**

In `src/server.ts`, replace:

```ts
  if (
    method === "GET" &&
    (url.pathname === "/" ||
      url.pathname === "/styles.css" ||
      url.pathname === "/app.js" ||
      url.pathname === "/search-queries.js")
  ) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }
```

with:

```ts
  // Every API route lives under /api/, so any other GET is a static asset
  // request served from src/web behind the traversal guard.
  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/server.test.ts && npm run typecheck`
Expected: PASS, including the pre-existing traversal test (`resolveStaticFilePath` unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: serve any src/web static file for the module split"
```

---

### Task 2: Phase model module (lib/phases.js)

Pure module owning stage metadata and the Content/Edit/Publish phase model. No DOM access.

**Files:**
- Create: `src/web/lib/phases.js`
- Test: `tests/web-phases.test.ts`

**Interfaces:**
- Produces (later tasks import these exact names):
  - `STAGES: string[]`, `STAGE_TITLES: Record<string,string>` (moved from `app.js:3-31`)
  - `REVIEW_PHASES: {id, label, stages}[]`, `PHASE_LABELS: Record<string,string>`
  - `phaseForStage(stage) -> "content"|"edit"|"publish"`
  - `derivePhaseState(phaseStages, workflowSteps) -> "empty"|"pending"|"in-progress"|"needs-approval"|"done"`
  - `APPROVAL_STEP_IDS: Set<string>` (moved from `app.js:2118`)

- [ ] **Step 1: Write the failing test**

Create `tests/web-phases.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGES,
  STAGE_TITLES,
  REVIEW_PHASES,
  phaseForStage,
  derivePhaseState,
} from "../src/web/lib/phases.js";

test("every pipeline stage belongs to exactly one phase", () => {
  const phaseStages = REVIEW_PHASES.flatMap((phase) => phase.stages);
  assert.deepEqual([...phaseStages].sort(), [...STAGES].sort());
  assert.equal(new Set(phaseStages).size, phaseStages.length);
});

test("phase mapping follows the approved split", () => {
  assert.deepEqual(REVIEW_PHASES.map((phase) => phase.id), ["content", "edit", "publish"]);
  assert.deepEqual(REVIEW_PHASES[0].stages, ["brief", "script", "media", "asr", "subtitles", "translation"]);
  assert.deepEqual(REVIEW_PHASES[1].stages, ["voice", "captions", "assets", "render"]);
  assert.deepEqual(REVIEW_PHASES[2].stages, ["copyright", "export"]);
  assert.equal(phaseForStage("brief"), "content");
  assert.equal(phaseForStage("render"), "edit");
  assert.equal(phaseForStage("export"), "publish");
  assert.equal(STAGE_TITLES.copyright, "Copyright Check");
});

test("derivePhaseState reflects workflow step statuses", () => {
  const stages = ["brief", "script"];
  assert.equal(derivePhaseState(stages, []), "empty");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "blocked" },
    { id: "script", stage: "script", status: "blocked" },
  ]), "pending");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "ready" },
    { id: "script", stage: "script", status: "blocked" },
  ]), "in-progress");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "done" },
    { id: "script", stage: "script", status: "ready" },
  ]), "needs-approval");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "done" },
    { id: "script", stage: "script", status: "done" },
  ]), "done");
  assert.equal(derivePhaseState(stages, [
    { id: "media", stage: "media", status: "ready" },
  ]), "empty");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/web-phases.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement lib/phases.js**

Create `src/web/lib/phases.js`. `STAGES` and `STAGE_TITLES` are copied **verbatim** from `app.js:3-31` (do not retype — copy, including the `config: "Config"` entry). Then:

```js
export const STAGES = [ /* verbatim from app.js:3-16 */ ];

export const STAGE_TITLES = { /* verbatim from app.js:18-31 */ };

// The studio's production flow. Every workspace shows these four steps;
// "overview" carries no stages of its own.
export const REVIEW_PHASES = [
  { id: "content", label: "Content", stages: ["brief", "script", "media", "asr", "subtitles", "translation"] },
  { id: "edit", label: "Edit", stages: ["voice", "captions", "assets", "render"] },
  { id: "publish", label: "Publish", stages: ["copyright", "export"] },
];

export const PHASE_LABELS = {
  overview: "Overview",
  content: "Content",
  edit: "Edit",
  publish: "Publish",
};

// Steps whose "ready" state means a human approval is what unblocks the flow.
export const APPROVAL_STEP_IDS = new Set(["script", "assets", "copyright", "source-risk"]);

export function phaseForStage(stage) {
  return REVIEW_PHASES.find((phase) => phase.stages.includes(stage))?.id ?? "content";
}

// Workflow step statuses are "done" | "ready" | "blocked" (src/workflow-templates.ts).
export function derivePhaseState(phaseStages, workflowSteps) {
  const steps = (workflowSteps ?? []).filter((step) => phaseStages.includes(step.stage));
  if (steps.length === 0) return "empty";
  if (steps.every((step) => step.status === "done")) return "done";
  if (steps.some((step) => step.status === "ready" && APPROVAL_STEP_IDS.has(step.id))) return "needs-approval";
  if (steps.some((step) => step.status === "ready" || step.status === "done")) return "in-progress";
  return "pending";
}
```

Do **not** delete anything from `app.js` yet — `app.js` keeps its own copies until Task 9/10 removes them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/web-phases.test.ts && npm test`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/phases.js tests/web-phases.test.ts
git commit -m "feat: add the content/edit/publish phase model"
```

---

### Task 3: Hash router (lib/router.js)

Pure route parsing plus thin navigation helpers. Only `parseRoute`/`routeHash` are unit-tested; `navigate`/`startRouter` touch `location` and are exercised by the app.

**Files:**
- Create: `src/web/lib/router.js`
- Test: `tests/web-router.test.ts`

**Interfaces:**
- Produces:
  - `parseRoute(hash: string) -> Route` where `Route` is one of:
    `{screen:"projects", typeFilter?: "review"|"series"|"channel"}`,
    `{screen:"sources"}`, `{screen:"config"}`,
    `{screen:"review-project", id, phase}`,
    `{screen:"series", id, phase}`,
    `{screen:"channel", id, phase}`,
    `{screen:"channel", id, storyId}` — `phase` ∈ `overview|content|edit|publish`.
  - `routeHash(route) -> string` (inverse for the object forms above)
  - `navigate(routeOrHash)` — sets `location.hash`
  - `startRouter(onChange)` — subscribes to `hashchange` and fires once immediately

- [ ] **Step 1: Write the failing test**

Create `tests/web-router.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeHash } from "../src/web/lib/router.js";

test("parseRoute maps hashes to screens", () => {
  assert.deepEqual(parseRoute(""), { screen: "projects" });
  assert.deepEqual(parseRoute("#/projects"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/sources"), { screen: "sources" });
  assert.deepEqual(parseRoute("#/config"), { screen: "config" });
  assert.deepEqual(parseRoute("#/project/demo-1"), { screen: "review-project", id: "demo-1", phase: "overview" });
  assert.deepEqual(parseRoute("#/project/demo-1/edit"), { screen: "review-project", id: "demo-1", phase: "edit" });
  assert.deepEqual(parseRoute("#/series/muc-than-ky/content"), { screen: "series", id: "muc-than-ky", phase: "content" });
  assert.deepEqual(parseRoute("#/channel/es-horror/publish"), { screen: "channel", id: "es-horror", phase: "publish" });
  assert.deepEqual(parseRoute("#/channel/es-horror/story/story-001"), { screen: "channel", id: "es-horror", storyId: "story-001" });
});

test("parseRoute tolerates junk and legacy hashes", () => {
  assert.deepEqual(parseRoute("#/nope/what"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/project"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/project/demo-1/bogus"), { screen: "review-project", id: "demo-1", phase: "overview" });
  assert.deepEqual(parseRoute("#story-factory"), { screen: "projects", typeFilter: "channel" });
  assert.deepEqual(parseRoute("#series"), { screen: "projects", typeFilter: "series" });
  assert.deepEqual(parseRoute("#sources"), { screen: "sources" });
  assert.deepEqual(parseRoute("#config"), { screen: "config" });
  assert.deepEqual(parseRoute("#/project/demo%2F1"), { screen: "review-project", id: "demo/1", phase: "overview" });
});

test("routeHash is the inverse of parseRoute", () => {
  for (const route of [
    { screen: "projects" },
    { screen: "sources" },
    { screen: "config" },
    { screen: "review-project", id: "demo-1", phase: "content" },
    { screen: "series", id: "muc-than-ky", phase: "overview" },
    { screen: "channel", id: "es-horror", phase: "edit" },
    { screen: "channel", id: "es-horror", storyId: "story-001" },
  ]) {
    assert.deepEqual(parseRoute(routeHash(route)), route);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/web-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement lib/router.js**

```js
const PHASE_IDS = new Set(["overview", "content", "edit", "publish"]);

export function parseRoute(hash) {
  const path = String(hash ?? "").replace(/^#/, "");

  // Legacy single-word hashes from the pre-router shell.
  if (path === "sources") return { screen: "sources" };
  if (path === "config") return { screen: "config" };
  if (path === "series") return { screen: "projects", typeFilter: "series" };
  if (path === "story-factory") return { screen: "projects", typeFilter: "channel" };

  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0] === "projects") return { screen: "projects" };
  if (parts[0] === "sources") return { screen: "sources" };
  if (parts[0] === "config") return { screen: "config" };
  if (parts[0] === "project" && parts[1]) {
    return { screen: "review-project", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  if (parts[0] === "series" && parts[1]) {
    return { screen: "series", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  if (parts[0] === "channel" && parts[1]) {
    if (parts[2] === "story" && parts[3]) {
      return { screen: "channel", id: decodeURIComponent(parts[1]), storyId: decodeURIComponent(parts[3]) };
    }
    return { screen: "channel", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  return { screen: "projects" };
}

function normalizePhase(part) {
  return PHASE_IDS.has(part) ? part : "overview";
}

export function routeHash(route) {
  if (route.screen === "sources") return "#/sources";
  if (route.screen === "config") return "#/config";
  if (route.screen === "review-project") return `#/project/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  if (route.screen === "series") return `#/series/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  if (route.screen === "channel" && route.storyId) {
    return `#/channel/${encodeURIComponent(route.id)}/story/${encodeURIComponent(route.storyId)}`;
  }
  if (route.screen === "channel") return `#/channel/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  return "#/projects";
}

export function navigate(routeOrHash) {
  location.hash = typeof routeOrHash === "string" ? routeOrHash : routeHash(routeOrHash);
}

export function startRouter(onChange) {
  window.addEventListener("hashchange", () => onChange(parseRoute(location.hash)));
  onChange(parseRoute(location.hash));
}
```

Note `routeHash` intentionally omits `typeFilter` (it is a legacy-redirect nicety, not part of canonical URLs) and always writes an explicit phase — that keeps the inverse test exact for phased routes. The `{screen:"projects"}` inverse holds because `parseRoute("#/projects")` has no `typeFilter` key.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/web-router.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/router.js tests/web-router.test.ts
git commit -m "feat: add the hash router with legacy hash redirects"
```

---

### Task 4: Extract lib/api.js and lib/dom.js; make marker tests bundle-aware

First real cut into `app.js`. Two shared modules leave; `app.js` imports them. `tests/web.test.ts` greps `src/web/app.js` for feature markers in many tests — before moving code, switch those tests to read a concatenated bundle of every JS file under `src/web/`, so markers survive the whole migration regardless of which module they land in.

**Files:**
- Create: `src/web/lib/api.js`, `src/web/lib/dom.js`
- Modify: `src/web/app.js`, `tests/web.test.ts`

**Interfaces:**
- Produces `lib/api.js` (exact names, moved verbatim from `app.js`):
  `postJson(url, body)` (L3150), `patchJson(url, body)` (L3161), `putJson(url, body)` (L3204), `fetchJsonOrNull(url)` (L3215), `reviewProjectApiUrl(seriesId, reviewProjectId, route)` (L2654), `storyApiUrl(channelId, route)` (L3200), `seriesFileUrl(seriesId, relativePath)` (L2662).
  `projectApiUrl(route)` and `projectFileUrl(relativePath)` read `appState.selectedProject`, so they move in Task 5 with state — **leave them in app.js for now**.
- Produces `lib/dom.js` (moved verbatim): `summaryGrid` (L2405), `formatBytes` (L2418), `artifactList(artifacts, kinds)` (L2424), `checklist` (L2446), `wrapSection` (L2457), `inlineInput` (L2464), `uploadField` (L2489), `fileField` (L2496), `paragraph` (L2509), `sectionTitle` (L2515), `readinessPill` (L2521), `gateNotice` (L2541), `field` (L2553), `textareaField` (L2571), `checkboxField` (L2584), `selectField` (L2595), `actionButton` (L2613), `formValues` (L2622), `boolFormValues` (L2631), `setPathValue` (L2639), `lower` (L2674), `strongText` (L2888), `confidenceMeter` (L2879), `formatTimecode` (L2894), `formatSeconds` (L2322), `preBlock` (L3866), `tableCell` (L3351).
  (`linkButton`/`seriesLinkButton` call `projectFileUrl`/`seriesFileUrl` + appState — `seriesLinkButton` moves to dom.js only if it doesn't touch appState; check: it takes `seriesId` explicitly, so it moves; `linkButton` uses `projectFileUrl` → stays in app.js until Task 5, then moves into `screens/review-project.js` in Task 7.)
  `configSection` (L2528) is config-only — it moves with the config screen in Task 6, not here.

- [ ] **Step 1: Make tests/web.test.ts read a bundle**

At the top of `tests/web.test.ts` add:

```ts
import { readdir } from "node:fs/promises";

async function readWebScripts(): Promise<string> {
  const parts: string[] = [];
  for (const dir of ["src/web", "src/web/lib", "src/web/screens"]) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // screens/ appears later in the migration
    }
    for (const entry of entries.sort()) {
      if (entry.endsWith(".js")) parts.push(await readFile(join(dir, entry), "utf8"));
    }
  }
  return parts.join("\n");
}
```

Then replace every `const script = await readFile("src/web/app.js", "utf8");` in the file with `const script = await readWebScripts();`. Leave the `index.html` and `styles.css` reads alone. One exception: the assertion `assert.match(script, /from "\.\/search-queries\.js"/)` (~L351) checks a relative import path that will legitimately change module location later; change that assertion now to `/from "\.\/(lib\/)?search-queries\.js"|from "\.\.\/search-queries\.js"/` — or simpler and better: `assert.match(script, /search-queries\.js/)` plus keep the existing "no hardcoded show name" assertions unchanged.

- [ ] **Step 2: Run the web tests to confirm they still pass before moving anything**

Run: `node --test tests/web.test.ts`
Expected: PASS (bundle currently ≈ app.js + search-queries.js).

- [ ] **Step 3: Create lib/api.js and lib/dom.js, update app.js**

Move the functions listed in **Interfaces** verbatim into the two new files, adding `export` to each. `lib/api.js` and `lib/dom.js` import nothing (all listed functions are self-contained — verify with a quick read; if a listed dom.js function references `appState` or another global, leave it in app.js and note it for the task that moves its screen).

In `app.js`: delete the moved function bodies and add at the top:

```js
import {
  postJson, patchJson, putJson, fetchJsonOrNull,
  reviewProjectApiUrl, storyApiUrl, seriesFileUrl,
} from "./lib/api.js";
import {
  summaryGrid, formatBytes, artifactList, checklist, wrapSection, inlineInput,
  uploadField, fileField, paragraph, sectionTitle, readinessPill, gateNotice,
  field, textareaField, checkboxField, selectField, actionButton,
  formValues, boolFormValues, setPathValue, lower, strongText, confidenceMeter,
  formatTimecode, formatSeconds, preBlock, tableCell, seriesLinkButton,
} from "./lib/dom.js";
```

`seriesLinkButton` needs `seriesFileUrl`, so `lib/dom.js` starts with `import { seriesFileUrl } from "./api.js";`.

- [ ] **Step 4: Verify in the browser and with tests**

Run: `node --check src/web/app.js && node --check src/web/lib/api.js && node --check src/web/lib/dom.js`
Run: `npm test && npm run typecheck`
Then start `npm run studio`, open `http://127.0.0.1:<port>`, confirm the studio loads, a project opens, and the Sources screen renders (these exercise both new modules). Stop the server.
Expected: no console errors; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/api.js src/web/lib/dom.js src/web/app.js tests/web.test.ts
git commit -m "refactor: extract shared api and dom helpers from the web monolith"
```

---

### Task 5: Extract lib/shell.js, lib/state.js, lib/refs.js

State, status line, and the SSE job stream leave `app.js`. The screen-specific reactions inside `handleJobEvent` become a handler registry so screens can subscribe without `state.js` knowing about them.

**Files:**
- Create: `src/web/lib/shell.js`, `src/web/lib/state.js`, `src/web/lib/refs.js`
- Modify: `src/web/app.js`

**Interfaces:**
- `lib/shell.js` produces: `bindShell()`, `setStatus(message)`, and exported live bindings `statusLine`, `paidVoiceDialog`, `confirmPaidVoice`, `paidScriptDialog`, `confirmPaidScript`. (Task 10 extends it with `view`, `breadcrumb`, `setBreadcrumb`, `setActiveNav`.)
- `lib/state.js` produces: `appState` (verbatim from L47-73), `JOB_LABELS` (verbatim from L75-90), `ensureProjectEventStream(projectId)`, `onJobEvent(handler)`, `reportedAsJob(response, data)`, `refreshAppData()` (the fetch-only part of `loadProjects`), `projectApiUrl(route)`, `projectFileUrl(relativePath)` (moved from app.js, unchanged — they read `appState.selectedProject` which now lives beside them).
- `lib/refs.js` produces: `bindWorkspaceRefs(root)` and exported live bindings `projectList`, `seriesPanel`, `workflowTitle`, `workflowDescription`, `workflowSteps`, `stageRail`, `stageTitle`, `stageContent`, `audioPreview`, `videoPreview`.

- [ ] **Step 1: Create lib/shell.js**

```js
// Global shell regions shared by every screen: the status line and the two
// paid-spend confirmation dialogs. bindShell() runs once at boot.
export let statusLine;
export let paidVoiceDialog;
export let confirmPaidVoice;
export let paidScriptDialog;
export let confirmPaidScript;

export function bindShell() {
  statusLine = document.querySelector("#status");
  paidVoiceDialog = document.querySelector("#paid-voice-dialog");
  confirmPaidVoice = document.querySelector("#confirm-paid-voice");
  paidScriptDialog = document.querySelector("#paid-script-dialog");
  confirmPaidScript = document.querySelector("#confirm-paid-script");
}

export function setStatus(message) {
  statusLine.textContent = message;
}
```

- [ ] **Step 2: Create lib/refs.js**

```js
// Live-binding references to the workspace DOM regions the screen modules
// render into. Rebound whenever a workspace shell is (re)built.
export let projectList;
export let seriesPanel;
export let workflowTitle;
export let workflowDescription;
export let workflowSteps;
export let stageRail;
export let stageTitle;
export let stageContent;
export let audioPreview;
export let videoPreview;

export function bindWorkspaceRefs(root = document) {
  projectList = root.querySelector("#project-list");
  seriesPanel = root.querySelector("#series-panel");
  workflowTitle = root.querySelector("#workflow-title");
  workflowDescription = root.querySelector("#workflow-description");
  workflowSteps = root.querySelector("#workflow-steps");
  stageRail = root.querySelector("#stage-rail");
  stageTitle = root.querySelector("#stage-title");
  stageContent = root.querySelector("#stage-content");
  audioPreview = root.querySelector("#audio-preview");
  videoPreview = root.querySelector("#video-preview");
}
```

- [ ] **Step 3: Create lib/state.js**

Move `appState` and `JOB_LABELS` verbatim. Move `ensureProjectEventStream` verbatim. Move `reportedAsJob` verbatim. Rewrite `handleJobEvent`: keep the status-line half verbatim, replace the two screen-specific refresh branches (the `story-` branch and the `selectProject` call, L120-126) with a handler loop:

```js
import { setStatus } from "./shell.js";

export const appState = { /* verbatim from app.js:47-73 */ };

export const JOB_LABELS = { /* verbatim from app.js:75-90 */ };

const jobEventHandlers = new Set();

// Screens subscribe to react to finished jobs (e.g. reload the open story or
// project). state.js stays ignorant of which screens exist.
export function onJobEvent(handler) {
  jobEventHandlers.add(handler);
}

/* ensureProjectEventStream: verbatim from app.js:92-101 */

function handleJobEvent(job) {
  const label = JOB_LABELS[job.kind] ?? job.kind;
  if (job.status === "running") {
    appState.activeJob = job;
    setStatus(`${label}: ${job.message} (${job.progress}%)`);
    return;
  }
  appState.activeJob = null;
  if (job.status === "succeeded") {
    setStatus(`${label} finished.`);
  } else if (job.status === "cancelled") {
    setStatus(`${label} cancelled.`);
  } else {
    setStatus(`${label} failed: ${job.error ?? "unknown error"}`);
  }
  for (const handler of jobEventHandlers) {
    handler(job);
  }
}

/* reportedAsJob: verbatim from app.js:134-142 */

/* projectApiUrl, projectFileUrl: verbatim from app.js:2650-2660 */

// The fetch half of the old loadProjects(): fills appState, renders nothing.
export async function refreshAppData() {
  /* verbatim from app.js:171-214 — from the five parallel fetches through the
     appState.selectedSeries default. Delete the setStatus("Loading projects...")
     first line (callers own status text) and everything from renderStageRail()
     (L215) down (callers own rendering and hash dispatch). */
}
```

- [ ] **Step 4: Rewire app.js**

In `app.js`:
- Delete the moved code (`appState`, `JOB_LABELS`, `ensureProjectEventStream`, `handleJobEvent`, `reportedAsJob`, `setStatus`, `projectApiUrl`, `projectFileUrl`, the fetch half of `loadProjects`, and the `const status/paidVoiceDialog/...` DOM lookups now owned by shell/refs — L143-157).
- Add imports:

```js
import { bindShell, setStatus, paidVoiceDialog, confirmPaidVoice, paidScriptDialog, confirmPaidScript } from "./lib/shell.js";
import { bindWorkspaceRefs, projectList, seriesPanel, workflowTitle, workflowDescription, workflowSteps, stageRail, stageTitle, stageContent, audioPreview, videoPreview } from "./lib/refs.js";
import { appState, JOB_LABELS, ensureProjectEventStream, onJobEvent, reportedAsJob, refreshAppData, projectApiUrl, projectFileUrl } from "./lib/state.js";
```

- Before anything else runs: `bindShell(); bindWorkspaceRefs();`
- `loadProjects()` shrinks to the render half:

```js
async function loadProjects() {
  setStatus("Loading projects...");
  await refreshAppData();
  renderStageRail();
  renderProjects();
  /* verbatim hash-dispatch + default-select block from old L217-238 */
}
```

- Register the two reactions that left `handleJobEvent` (top level in app.js):

```js
onJobEvent((job) => {
  if (job.kind.startsWith("story-") && storyFactoryState.channelId && storyFactoryState.storyId) {
    void renderStoryDetail(storyFactoryState.channelId, storyFactoryState.storyId).catch((error) => setStatus(error.message));
    return;
  }
  if (appState.selectedProject) {
    void selectProject(appState.selectedProject);
  }
});
```

(When story-factory and review-project screens move out in Tasks 7-8, this splits into one `onJobEvent` registration per screen module: the story branch — including its early-return semantics, i.e. the review refresh must skip story jobs: `if (job.kind.startsWith("story-")) return;` guard in the review handler — goes to `screens/story-factory.js`, the selectProject branch to `screens/review-project.js`.)

- [ ] **Step 5: Verify**

Run: `node --check` on all five web JS files, then `npm test && npm run typecheck`.
Browser smoke: load studio, select a project, run a cheap action that returns a job (e.g. ASR on the sample project or just confirm the SSE stream connects — network tab shows `/events`), confirm status line updates.
Expected: PASS, no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/shell.js src/web/lib/state.js src/web/lib/refs.js src/web/app.js
git commit -m "refactor: extract shell, app state, and the SSE job stream"
```

---

### Task 6: Extract screens/sources.js and screens/config.js

The two self-contained screens leave first.

**Files:**
- Create: `src/web/screens/sources.js`, `src/web/screens/config.js`
- Modify: `src/web/app.js`

**Interfaces:**
- `screens/sources.js` produces: `renderSources()` (already async) and `sourcePlatformOptions()` (**amended**: it is a pure options list used by BOTH the sources search toolbar and renderConfig — move it here and EXPORT it; screens/config.js imports it; it includes the `facebook` entry which must survive). Moves verbatim from app.js: `SOURCE_RIGHTS_OPTIONS` (L2718), `renderSources` (L2725), `renderSourceSearchResults` (L2813), `sourceSearchToolbar` (L2866), `refreshSourceExpandedQueries` (L2876), `searchSources` (L2884), `dedupeSourceSearchResults` (L2917), `filterSourceSearchResults` (L2929), `triageSourceSearchResult` (L2952), `trackSource` (L2971), `renderSourceList` (L2982), `renderSourceRow` (L2998), `renderSourceScore` (L3067), `startSourceJob` (L3102), `followSourceJob` (L3121), `deleteSource` (L3134), `formatSourceDuration` (L3172). Keep the existing `import { expandSearchQueries } from ...` line if present in the moved code's dependencies (check the top of app.js for the search-queries import and move it if only sources code uses it).
- `screens/config.js` produces: `renderConfig()`. Moves verbatim: `renderConfig` (L1926 — now larger: Phase 2 added planner/writer/QA provider selectors, YouTube settings, render-transition fields, and the Facebook search-prefix field; they all move with it unchanged), `saveConfig` (L2181), `configInputValue` (L2200), `configSection` (L2528), `scriptProviderOptions` (L1915) **only if** a grep shows it is used solely by `renderConfig` — if `renderScript` also uses it, export it from `screens/config.js` and import it in app.js (and later in `screens/review-project.js`).

Each screen module imports what it needs from `../lib/api.js`, `../lib/dom.js`, `../lib/state.js`, `../lib/shell.js`, `../lib/refs.js`. Follow the errors from `node --check` + browser console to complete the import lists — every name is already exported by Tasks 4-5.

- [ ] **Step 1: Grep for shared usage before moving**

Run: `grep -n "scriptProviderOptions\|configSection\|formatSourceDuration" src/web/app.js`
Decide placement per the Interfaces note above.

- [ ] **Step 2: Move the code**

Create both screen files with the moved functions (add `export` only to `renderSources` and `renderConfig`, plus any name another module still needs). Delete the moved code from app.js and add:

```js
import { renderSources } from "./screens/sources.js";
import { renderConfig } from "./screens/config.js";
```

- [ ] **Step 3: Verify**

Run: `node --check src/web/screens/sources.js && node --check src/web/screens/config.js && node --check src/web/app.js && npm test`
Browser smoke: open Sources (search box renders, tracked source list loads), open Config (sections render, save works).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/screens/sources.js src/web/screens/config.js src/web/app.js
git commit -m "refactor: move the sources and config screens into modules"
```

---

### Task 7: Extract screens/review-project.js

The largest move: the review-project workspace (stage rail, workflow board, all 12 stage renderers, segment editor, timeline, actions, uploads, paid-spend dialogs usage).

**Files:**
- Create: `src/web/screens/review-project.js`
- Modify: `src/web/app.js`

**Interfaces:**
- Produces (exported because app.js and later screens/series.js call them):
  `selectProject(projectId)`, `renderProjects()`, `renderStageRail()`, `renderStage()`, `renderWorkflowBoard()`, `renderCreateProject()`, `runAvailableTasks()`, `loadEditManifestState(projectId)`, `setActiveStageButton(stage?)`.
- Moves verbatim (everything between the listed anchors that belongs to the review flow):
  `renderProjects` (L240), `renderWorkflowBoard` (L257), `workflowTemplateCards` (L301), `renderStageRail` (L317), `stagePhaseItem` (L341), `bindStageRail` (L364), `selectProject` (L373), `renderStage` (L392), `renderCreateProject` (L1248), `createProject` (L1280), `renderBrief` (L1293) through `renderExport` (L1902) inclusive — i.e. every `render<Stage>` function, `scriptModelSummary`, `renderSegmentEditor`, `renderSegmentDecisionTable`, `loadEditManifestState`, `uploadedAssetList`, `RENDER_GATE_LABELS`, `EDIT_RENDER_GATE_LABELS`, `renderGateNotice`, `renderCutControls`, `renderMonitor`, `renderInspector`, `renderTimeline`, `timelineClipTrack`, `narrationTrack`, `timelineTrackLabel`, `selectMappingScene`, `renderPreviews` (L2399), `runAvailableTasks` (L2076), `pendingApprovalNotice` (L2109), `taskActionForStep` (L2120), `runStepTask` (L2134), `runProjectRoute` (L2168), `requestVoice` (L2207), `paidScriptModelConfigured` (L2229), `requestScript` (L2233), `requestRender` (L2259), `requestCutRender` (L2277), `requestVisualMapping` (L2295), `approveVisualMapping` (L2303), `saveVisualMappingSegment` (L2311), `uploadProjectFile` (L2324), `uploadAsset` (L2343), `saveAssetMetadata` (L2360), `postProjectAction` (L2380), `linkButton` (L2471), `sourceSubtitlePath` (L2646), `parseEpisodeNumbers` (L2666) **if only used here — grep first; it looks series-related, leave for Task 8 if so**, `targetOptions` (L2678), `workflowTypeOptions` (L2682) (grep — series create form may use it; if so it goes to Task 8's series.js and app.js imports it meanwhile), `translationTargetLabels` (L2695), `seriesEpisodeProjectIds` (L2700), and `artifactList` (**amended**: Task 4 left it in app.js because it depends on `projectFileUrl`; its only callers are this screen's stage renderers, so it moves here, importing `projectFileUrl` from `../lib/state.js`). `sourcePlatformOptions` does NOT move here (**amended**: it belongs to screens/sources.js — see Task 6).
  Constants: import `STAGES`, `STAGE_TITLES` from `../lib/phases.js` and delete app.js's copies; keep `STAGE_PHASES` (L37) and `RUN_AVAILABLE_TASKS_LABEL` (L45) moved verbatim into this module (STAGE_PHASES is replaced in Task 11).
- Registers its own job handler at module top level:

```js
onJobEvent((job) => {
  if (job.kind.startsWith("story-")) return;
  if (appState.selectedProject) {
    void selectProject(appState.selectedProject);
  }
});
```

- [ ] **Step 1: Grep the ambiguous helpers**

Run: `grep -n "parseEpisodeNumbers\|workflowTypeOptions\|targetOptions\|seriesEpisodeProjectIds\|renderPreviews" src/web/app.js`
Place each where its callers live (callers split across screens → export from the screen that owns the concept and import elsewhere; genuinely generic → `lib/dom.js`).

- [ ] **Step 2: Move the code**

Create `src/web/screens/review-project.js` with the moved functions and the imports it needs (`../lib/api.js`, `../lib/dom.js`, `../lib/state.js`, `../lib/shell.js` — the paid dialogs and setStatus, `../lib/refs.js`, `../lib/phases.js`). Add the `onJobEvent` registration above. Remove the equivalent branch from app.js's temporary `onJobEvent` registration (leave the story branch in app.js until Task 8).

In app.js, import what the remaining code (series, story factory, boot) still calls:

```js
import { selectProject, renderProjects, renderStageRail, renderStage, renderCreateProject, runAvailableTasks, loadEditManifestState, setActiveStageButton } from "./screens/review-project.js";
```

- [ ] **Step 3: Verify**

Run: `node --check src/web/screens/review-project.js && node --check src/web/app.js && npm test && npm run typecheck`
Browser smoke: select a project; click through several stages (Brief, Script, Translation, Render); workflow board renders; "Run available tasks" button responds; previews populate for a project with artifacts.
Expected: PASS, no console errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/screens/review-project.js src/web/app.js
git commit -m "refactor: move the review project workspace into a module"
```

---

### Task 8: Extract screens/series.js and screens/story-factory.js

**Files:**
- Create: `src/web/screens/series.js`, `src/web/screens/story-factory.js`
- Modify: `src/web/app.js`

**Interfaces:**
- `screens/series.js` produces: `renderSeriesManager()`. Moves verbatim: everything from `renderSeriesManager` (L422) through `performEpisodeTask` (L1243) inclusive (series CRUD, episodes, batch review, brand kit, audio-story tabs, and their `*Ui` action functions), plus `createSeries` etc. Imports `selectProject` from `./review-project.js` (episode rows open review projects). Also owns `parseEpisodeNumbers`/`workflowTypeOptions` if Task 7's grep put them here.
- `screens/story-factory.js` produces: `renderStoryFactory()`, `renderStoryDetail(channelId, storyId, tab?)`. Moves verbatim: `storyFactoryState` (L3182) and every constant/function from there to end of file (`STORY_STAGE_LIST`, `STORY_STATUS_LEVELS`, `STORY_RUN_LEVELS`, `EDITABLE_STORY_STAGES`, `STORY_TABS`, `renderStoryFactory`, `channelBadgeRow`, `renderStoryDetail`, `renderStoryTab`, `renderStoryOverview`, `runStoryStage`, `renderStoryArtifactView`, `renderStoryAudioTab`, `renderStoryImagesTab`, `renderStoryVideoTab`, `renderStoryThumbnailTab`, `renderStoryAiLogTab`, `renderStoryCostTab`, `renderStoryChannelSettings`, `renderVoiceLab`, `voiceLabTable`) — except `putJson`/`fetchJsonOrNull`/`storyApiUrl`/`preBlock`/`tableCell` which already moved in Task 4. **Amended (Phase 2):** the inventory also includes `renderStorySectionsTab`, `renderStoryPublishTab` (YouTube publish/analytics controls), `renderPromptSettings`, `renderStoryCalendar`, and `renderCompilations` — move them verbatim with their API calls and navigation back to the channel/stories view. `STORY_STAGE_LIST` and `STORY_TABS` now contain a `publish` entry: preserve it exactly, routed through `renderStoryPublishTab`.
  Registers at module top level:

```js
onJobEvent((job) => {
  if (!job.kind.startsWith("story-")) return;
  if (storyFactoryState.channelId && storyFactoryState.storyId) {
    void renderStoryDetail(storyFactoryState.channelId, storyFactoryState.storyId).catch((error) => setStatus(error.message));
  }
});
```

- [ ] **Step 1: Move series code**, **Step 2: Move story-factory code** — as per Interfaces; delete the story branch from app.js's temporary `onJobEvent` registration (app.js should no longer register any job handler).

- [ ] **Step 3: Slim app.js to a bootstrapper**

After this task `app.js` should contain only: imports, `bindShell()`, `bindWorkspaceRefs()`, the topbar button bindings (L159-165, now calling imported functions), `loadProjects()` (render-half from Task 5), and the boot call. Roughly 60 lines.

- [ ] **Step 4: Verify**

Run: `node --check` on both new files and app.js; `npm test && npm run typecheck`.
Browser smoke: Series screen (list, detail tabs, brand kit), Story Factory (stories table, open a story, channel settings, voice lab), and confirm a story job refresh still works if cheap to trigger (otherwise rely on the moved code being verbatim).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/screens/series.js src/web/screens/story-factory.js src/web/app.js
git commit -m "refactor: move the series and story factory screens into modules"
```

---

### Task 9: New shell — index.html, main.js, unified projects screen; delete app.js

The visible restructure. New two-tier navigation: top nav (Projects | Sources | Config) + router; `#/projects` is the unified management screen; workspaces build their own skeletons and rebind `refs`.

**Files:**
- Create: `src/web/main.js`, `src/web/screens/projects.js`, `src/web/lib/workspace.js`
- Modify: `src/web/index.html` (rewrite), `src/web/lib/shell.js` (add view/breadcrumb/nav), `src/web/screens/review-project.js`, `src/web/screens/series.js`, `src/web/screens/story-factory.js`, `src/web/screens/sources.js`, `src/web/screens/config.js` (add `mount*` entry points), `tests/web.test.ts` (shell assertions)
- Delete: `src/web/app.js`

**Interfaces:**
- `lib/shell.js` adds: `view`, `breadcrumb` live bindings (bound in `bindShell`), `setBreadcrumb(items: {label, hash?}[])`, `setActiveNav(screen)`.
- `lib/workspace.js` produces `buildWorkspaceSkeleton(options) -> HTMLElement`: builds the tier-2 chrome — phase bar + panel (`#stage-title`, `#series-panel`, `#stage-content`) + preview aside (`#audio-preview`, `#video-preview`) + optional workflow board (`#workflow-title`, `#workflow-description`, `#workflow-steps`, run-tasks button) + `#stage-rail` — with the same element ids `refs.js` expects, appends nothing itself (caller appends to `view` then calls `bindWorkspaceRefs(view)`).
- Each screen module adds a `mount<Name>(route)` entry: replaces `view` children, sets breadcrumb + active nav, then calls its existing render functions.
- `screens/projects.js` produces `mountProjects(route)`.
- `main.js`: boots everything; no exports.

- [ ] **Step 1: Rewrite index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>YT Review Studio</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="topnav">
      <div class="topnav-brand">
        <h1>YT Review Studio</h1>
        <p>Local production pipeline for original videos.</p>
      </div>
      <nav class="topnav-links" aria-label="Main">
        <a href="#/projects" data-nav="projects">Projects</a>
        <a href="#/sources" data-nav="sources">Sources</a>
        <a href="#/config" data-nav="config">Config</a>
      </nav>
      <div id="status" class="status" aria-live="polite">Loading studio...</div>
    </header>

    <nav id="breadcrumb" class="breadcrumb" aria-label="Breadcrumb"></nav>

    <main id="view" class="view"></main>

    <dialog id="paid-voice-dialog">
      <!-- verbatim from the old index.html -->
    </dialog>
    <dialog id="paid-script-dialog">
      <!-- verbatim from the old index.html -->
    </dialog>

    <script src="/main.js" type="module"></script>
  </body>
</html>
```

- [ ] **Step 2: Extend lib/shell.js**

Add to `bindShell()`: `view = document.querySelector("#view"); breadcrumb = document.querySelector("#breadcrumb");` with matching `export let view; export let breadcrumb;`. Add:

```js
export function setBreadcrumb(items) {
  breadcrumb.replaceChildren(
    ...items.flatMap((item, index) => {
      const parts = [];
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = "/";
        parts.push(sep);
      }
      const node = document.createElement(item.hash ? "a" : "span");
      if (item.hash) node.href = item.hash;
      node.textContent = item.label;
      parts.push(node);
      return parts;
    }),
  );
}

export function setActiveNav(screen) {
  const navScreen = { "review-project": "projects", series: "projects", channel: "projects" }[screen] ?? screen;
  for (const link of document.querySelectorAll(".topnav-links [data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === navScreen);
  }
}
```

- [ ] **Step 3: Create lib/workspace.js**

```js
import { bindWorkspaceRefs } from "./refs.js";
import { view, setBreadcrumb, setActiveNav } from "./shell.js";
import { PHASE_LABELS } from "./phases.js";
import { navigate } from "./router.js";

const WORKSPACE_PHASES = ["overview", "content", "edit", "publish"];

/**
 * Builds the tier-2 workspace chrome every project type shares: breadcrumb,
 * phase bar, stage panel, and preview pane. Screens fill #stage-content (and
 * the workflow board on overview) after this returns.
 *
 * options: {
 *   screen: "review-project"|"series"|"channel",
 *   title: string,               // project title for the breadcrumb
 *   route: Route,                // current route (id + phase)
 *   phaseStates?: Record<string,string>, // phase id -> derivePhaseState value
 *   withWorkflowBoard?: boolean, // overview board (review projects)
 *   onRunTasks?: () => void,
 * }
 */
export function mountWorkspace(options) {
  const { screen, title, route } = options;
  setActiveNav(screen);
  setBreadcrumb([
    { label: "Projects", hash: "#/projects" },
    { label: title },
    { label: PHASE_LABELS[route.phase ?? "overview"] },
  ]);

  const workspace = document.createElement("section");
  workspace.className = "workspace";

  const phaseBar = document.createElement("ol");
  phaseBar.className = "phase-bar";
  for (const phaseId of WORKSPACE_PHASES) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.phase = phaseId;
    button.textContent = PHASE_LABELS[phaseId];
    button.classList.toggle("selected", (route.phase ?? "overview") === phaseId);
    const state = options.phaseStates?.[phaseId];
    if (state) button.dataset.state = state;
    button.addEventListener("click", () => navigate({ ...route, storyId: undefined, phase: phaseId }));
    item.append(button);
    phaseBar.append(item);
  }

  const board = document.createElement("section");
  board.id = "workflow-board";
  board.className = "workflow-board";
  board.hidden = !options.withWorkflowBoard;
  board.innerHTML = `
    <div class="workflow-header">
      <div>
        <h2 id="workflow-title">Workflow</h2>
        <p id="workflow-description"></p>
      </div>
      <button id="run-ready-tasks" type="button">Run available tasks</button>
    </div>
    <ol id="workflow-steps" class="workflow-steps"></ol>`;
  if (options.onRunTasks) {
    board.querySelector("#run-ready-tasks").addEventListener("click", options.onRunTasks);
  }

  const rail = document.createElement("ol");
  rail.id = "stage-rail";
  rail.className = "stage-rail";

  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = `
    <h2 id="stage-title"></h2>
    <div id="series-panel"></div>
    <div id="stage-content"></div>`;

  const preview = document.createElement("aside");
  preview.className = "preview";
  preview.innerHTML = `
    <h2>Preview</h2>
    <audio id="audio-preview" controls></audio>
    <video id="video-preview" controls></video>`;

  workspace.append(phaseBar, board, rail, panel);
  const layout = document.createElement("div");
  layout.className = "workspace-layout";
  layout.append(workspace, preview);

  view.replaceChildren(layout);
  bindWorkspaceRefs(view);
  return layout;
}
```

(Note: `#project-list` no longer exists anywhere; `refs.js` drops the `projectList` binding — set it to `null` or remove it and delete its references from `screens/review-project.js`'s `renderProjects`, which this task retires, see Step 5.)

- [ ] **Step 4: Create screens/projects.js (the unified management screen)**

```js
import { appState, refreshAppData } from "../lib/state.js";
import { fetchJsonOrNull, storyApiUrl } from "../lib/api.js";
import { setStatus, view, setBreadcrumb, setActiveNav } from "../lib/shell.js";
import { actionButton, field, selectField, gateNotice } from "../lib/dom.js";
import { navigate } from "../lib/router.js";
import { renderCreateProjectForm } from "./review-project.js";
import { renderCreateSeriesForm } from "./series.js";

const TYPE_FILTERS = [
  ["", "All"],
  ["review", "Review projects"],
  ["series", "Series"],
  ["channel", "Story channels"],
];

const screenState = { typeFilter: "", search: "", storyChannelIds: new Set(), creating: null };

export async function mountProjects(route) {
  setActiveNav("projects");
  setBreadcrumb([{ label: "Projects" }]);
  if (route.typeFilter) screenState.typeFilter = route.typeFilter;
  setStatus("Loading projects...");
  await refreshAppData();
  await detectStoryChannels();
  renderProjectsScreen();
  setStatus(`${rows().length} projects.`);
}

// A series is also a story channel when its story-channel sidecar exists.
async function detectStoryChannels() {
  const checks = await Promise.all(
    appState.series.map(async (series) => {
      const data = await fetchJsonOrNull(storyApiUrl(series.id, "story-channel"));
      return [series.id, Boolean(data?.storyChannel && Object.keys(data.storyChannel).length > 0)];
    }),
  );
  screenState.storyChannelIds = new Set(checks.filter(([, isChannel]) => isChannel).map(([id]) => id));
}

function rows() {
  const items = [];
  for (const projectId of appState.projects) {
    items.push({ type: "review", id: projectId, title: projectId, hash: `#/project/${encodeURIComponent(projectId)}/overview` });
  }
  for (const series of appState.series) {
    items.push({ type: "series", id: series.id, title: series.title || series.id, subtitle: series.workflowType, hash: `#/series/${encodeURIComponent(series.id)}/overview` });
    if (screenState.storyChannelIds.has(series.id)) {
      items.push({ type: "channel", id: series.id, title: series.title || series.id, hash: `#/channel/${encodeURIComponent(series.id)}/overview` });
    }
  }
  const query = screenState.search.trim().toLowerCase();
  return items.filter((item) =>
    (!screenState.typeFilter || item.type === screenState.typeFilter) &&
    (!query || item.title.toLowerCase().includes(query) || item.id.toLowerCase().includes(query)));
}

const TYPE_BADGES = { review: "Review", series: "Series", channel: "Story Channel" };

function renderProjectsScreen() {
  const screen = document.createElement("section");
  screen.className = "projects-screen";

  const toolbar = document.createElement("div");
  toolbar.className = "projects-toolbar";
  const filterField = selectField("Type", "typeFilter", screenState.typeFilter, TYPE_FILTERS);
  filterField.querySelector("select").addEventListener("change", (event) => {
    screenState.typeFilter = event.target.value;
    renderProjectsScreen();
  });
  const searchField = field("Search", "search", screenState.search, "search", "Filter by name or id");
  searchField.querySelector("input").addEventListener("input", (event) => {
    screenState.search = event.target.value;
    renderProjectsScreen();
  });
  toolbar.append(
    filterField,
    searchField,
    actionButton("New Review Project", () => toggleCreate("review")),
    actionButton("New Series", () => toggleCreate("series")),
    actionButton("New Story Channel", () => toggleCreate("channel")),
  );

  const list = document.createElement("ul");
  list.className = "projects-rows";
  const visible = rows();
  if (visible.length === 0) {
    list.append(gateNotice("Nothing here yet", "Create a project to start.", "info"));
  }
  for (const row of visible) {
    const item = document.createElement("li");
    item.className = `projects-row type-${row.type}`;
    const badge = document.createElement("span");
    badge.className = `type-badge type-${row.type}`;
    badge.textContent = TYPE_BADGES[row.type];
    const title = document.createElement("strong");
    title.textContent = row.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = row.subtitle ? `${row.id} · ${row.subtitle}` : row.id;
    const open = actionButton("Open", () => navigate(row.hash));
    item.append(badge, title, subtitle, open);
    list.append(item);
  }

  const createHost = document.createElement("div");
  createHost.className = "projects-create";
  if (screenState.creating === "review") createHost.append(renderCreateProjectForm(() => mountProjects({ screen: "projects" })));
  if (screenState.creating === "series") createHost.append(renderCreateSeriesForm(() => mountProjects({ screen: "projects" })));
  if (screenState.creating === "channel") {
    createHost.append(
      gateNotice("Story channel", "A story channel is a series plus its story settings. Create the series here, then configure the channel in its workspace.", "info"),
      renderCreateSeriesForm((seriesId) => navigate(`#/channel/${encodeURIComponent(seriesId)}/overview`)),
    );
  }

  screen.append(toolbar, createHost, list);
  view.replaceChildren(screen);
}

function toggleCreate(kind) {
  screenState.creating = screenState.creating === kind ? null : kind;
  renderProjectsScreen();
}
```

**Accepted deviation from the spec:** the spec's project rows mention a
"status/progress summary". `GET /api/projects` returns only ids, and fetching
each project's snapshot would add N requests per page load while the backend
is frozen for this change. Review rows therefore show type + id; series rows
show `workflowType`. A status column becomes possible when a list endpoint
returns statuses (out of scope here — no backend changes).

This requires two small adaptations in existing screens (do them in this task):
- `screens/review-project.js`: split `renderCreateProject` so the form-building part is exported as `renderCreateProjectForm(onCreated)` returning the form element, with `createProject` calling `onCreated()` after success (default behavior when called with no argument preserves the old flow). Keep the old `renderCreateProject` working until Step 5 deletes its callers.
- `screens/series.js`: same for `renderCreateSeriesForm(onCreated)` — it already builds a form (L435); change it to accept and invoke `onCreated(createdSeriesId)` after `createSeries` succeeds and to return the element instead of writing to a fixed container if it currently does. Check the current body and keep the change minimal.

- [ ] **Step 5: Create main.js, add mount entries, delete app.js**

Each workspace screen gets a `mount*` function (in its own module) that wraps its existing renders with `mountWorkspace`:

```js
// screens/review-project.js
import { mountWorkspace } from "../lib/workspace.js";
import { derivePhaseState, REVIEW_PHASES, phaseForStage } from "../lib/phases.js";

export async function mountReviewProject(route) {
  await selectProjectData(route.id); // see below
  const steps = appState.projectSnapshot?.workflow?.steps ?? [];
  const phaseStates = Object.fromEntries(
    REVIEW_PHASES.map((phase) => [phase.id, derivePhaseState(phase.stages, steps)]),
  );
  mountWorkspace({
    screen: "review-project",
    title: route.id,
    route,
    phaseStates,
    withWorkflowBoard: (route.phase ?? "overview") === "overview",
    onRunTasks: () => runAvailableTasks(),
  });
  if ((route.phase ?? "overview") === "overview") {
    renderWorkflowBoard();
    stageTitle.textContent = "Overview";
    stageContent.replaceChildren();
  } else {
    renderStageRail();       // Task 10 makes this phase-scoped
    if (phaseForStage(appState.activeStage) !== route.phase) {
      appState.activeStage = REVIEW_PHASES.find((phase) => phase.id === route.phase).stages[0];
    }
    renderStage();
  }
  renderPreviews(appState.projectSnapshot);
}
```

`selectProjectData(projectId)` is the old `selectProject` minus its render calls (fetch snapshot + manifest + `ensureProjectEventStream`); refactor `selectProject` into `selectProjectData` + renders, and change `selectProject`'s remaining callers (job handler, series episode rows) to `navigate({screen: "review-project", id: projectId, phase: "overview"})` — the job handler instead calls `selectProjectData` then re-mounts the current route via the router's current parse (simplest correct version: the job handler calls `mountReviewProject(parseRoute(location.hash))` when the current route is this project's workspace, else does nothing).

`screens/series.js` gets `mountSeries(route)`: `mountWorkspace({screen: "series", title, route})` then renders per phase — `overview`: the existing series detail overview tab; `content`: episode plan + episode table + story bible panel; `edit`: batch review + brand kit + thumbnail brief; `publish`: batch output links (`renderBatchOutputLinks`) and episode outputs. Reuse the existing tab-content builder functions directly; the old series-tabs strip inside the detail view is replaced by the phase bar (delete `renderSeriesWorkspaceTabs` usage on this path; keep functions it calls). The old `renderSeriesManager` list screen is retired — the projects screen replaces it; delete `renderSeriesManager`/`renderSeriesList` and their styles later in Task 11.

`screens/story-factory.js` gets `mountChannel(route)`: `overview` = channel badge row + channel settings (`renderStoryChannelSettings`) + a voice lab link; `content` = the stories table (the `renderStoryFactory` body minus the channel picker — the channel is now the route id) or, when `route.storyId` is set, `renderStoryDetail(route.id, route.storyId)`; `edit` = the stories table filtered to statuses before `READY_TO_PUBLISH`; `publish` = the table filtered to `READY_TO_PUBLISH`/`PUBLISHED`. Story detail tabs stay as they are inside `renderStoryDetail`. Set `storyFactoryState.channelId = route.id` on mount.

Create `src/web/main.js`:

```js
import { bindShell, setStatus } from "./lib/shell.js";
import { startRouter, navigate } from "./lib/router.js";
import { mountProjects } from "./screens/projects.js";
import { mountReviewProject } from "./screens/review-project.js";
import { mountSeries } from "./screens/series.js";
import { mountChannel } from "./screens/story-factory.js";
import { mountSources } from "./screens/sources.js";
import { mountConfig } from "./screens/config.js";

const SCREENS = {
  projects: mountProjects,
  "review-project": mountReviewProject,
  series: mountSeries,
  channel: mountChannel,
  sources: mountSources,
  config: mountConfig,
};

bindShell();
startRouter((route) => {
  const mount = SCREENS[route.screen] ?? mountProjects;
  Promise.resolve(mount(route)).catch((error) => {
    setStatus(error.message);
    if (route.screen !== "projects") navigate("#/projects");
  });
});
```

`mountSources`/`mountConfig` are thin wrappers in their modules: set nav + breadcrumb (`[{label:"Sources"}]`), `view.replaceChildren(container)` where `container` is a plain `<section>` they pass to their existing render functions (adapt `renderSources`/`renderConfig` to render into a passed container instead of `stageContent` — a one-line change each: accept a `container = stageContent` parameter and write there... since `stageContent` no longer exists globally on these screens, pass the container explicitly).

Delete `src/web/app.js`. Update `index.html`'s script tag already points at `/main.js` (Step 1).

- [ ] **Step 6: Update tests/web.test.ts shell assertions**

The first test ("web shell exposes the complete approval pipeline") asserted old ids. Replace its body:

```ts
test("web shell exposes the routed studio chrome", async () => {
  const html = await readFile("src/web/index.html", "utf8");
  assert.match(html, /id="view"/);
  assert.match(html, /id="breadcrumb"/);
  assert.match(html, /data-nav="projects"/);
  assert.match(html, /data-nav="sources"/);
  assert.match(html, /data-nav="config"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /src="\/main\.js"/);

  const script = await readWebScripts();
  for (const marker of ["workflow-board", "series-panel", "stage-content", "mountProjects", "mountWorkspace", "phase-bar"]) {
    assert.match(script, new RegExp(marker));
  }
});
```

The story-factory test asserts `id="open-story-factory"` in index.html — change that line to assert the marker in the script bundle instead (`assert.match(script, /mountChannel/)`) and drop the html assertion. **Amended (Phase 2):** tests/web.test.ts also gained Facebook assertions (`Facebook search prefix`, `sources.searchPrefixes.facebook`, the `facebook` platform marker) — these read the script bundle and must keep passing unchanged; do not delete or weaken them. Also fix the `#story-factory` marker expectation — it now lives in `lib/router.js` as the legacy redirect, still in the bundle, so it keeps matching. Run the suite and fix any remaining assertion that referenced removed shell ids (`open-series`, `open-config`, `project-list`) by pointing it at the new equivalents (`data-nav` links, `projects-row`).

- [ ] **Step 7: Verify**

Run: `node --check` on every `src/web/**/*.js` file; `npm test && npm run typecheck`.
Browser smoke (the big one):
1. Load `/` → redirected content shows the Projects screen with all three type badges; filter and search work.
2. Open a review project → Overview shows the workflow board; Content/Edit/Publish show their stages; browser Back returns to Projects.
3. Open a series → phases render; an episode row's open action navigates to its review project.
4. Open a story channel → stories table; open a story; story tabs work.
5. Sources and Config from the top nav.
6. Legacy `#story-factory` URL redirects to Projects filtered to channels.
Expected: all pass, no console errors.

- [ ] **Step 8: Commit**

```bash
git add -A src/web tests/web.test.ts
git commit -m "feat: route the studio through an independent project management screen"
```

---

### Task 10: Phase-scoped stage rail for review projects

Inside a review-project phase, the stage rail shows only that phase's stages (the old five-group `STAGE_PHASES` rail dies).

**Files:**
- Modify: `src/web/screens/review-project.js`

**Interfaces:**
- Consumes: `REVIEW_PHASES`, `STAGE_TITLES` from `lib/phases.js`; current route phase (pass it into `renderStageRail(phaseId)`).

- [ ] **Step 1: Rewrite renderStageRail**

Replace the `STAGE_PHASES` loop with:

```js
function renderStageRail(phaseId) {
  const workflow = appState.projectSnapshot?.workflow;
  const workflowStages = workflow ? unique(workflow.steps.map((step) => step.stage)) : STAGES;
  const phase = REVIEW_PHASES.find((entry) => entry.id === phaseId);
  const stages = (phase ? phase.stages : STAGES).filter((stage) => workflowStages.includes(stage));
  stageRail.replaceChildren(stagePhaseItem(phase?.label ?? "Stages", stages));
  bindStageRail();
  setActiveStageButton();
}
```

(`unique` already exists in the module — verify; if it lived elsewhere, import or inline `[...new Set(...)]`.) Update `mountReviewProject` to call `renderStageRail(route.phase)`. Delete the `STAGE_PHASES` constant and the grouped-rail code paths that are now unreachable. Workflow-board step clicks (`renderWorkflowBoard`) currently set `appState.activeStage` + `renderStage()` — change the click handler to `navigate({screen: "review-project", id: appState.selectedProject, phase: phaseForStage(step.stage)})` after setting `appState.activeStage = step.stage`, so clicking a step from Overview lands in the right phase with that stage active.

- [ ] **Step 2: Verify**

`npm test`; browser: in a review project, Content shows exactly brief/script/media/asr/subtitles/translation buttons (subject to the project's workflow template), Edit shows voice/captions/assets/render, Publish shows copyright/export; clicking a workflow step from Overview jumps to the right phase and stage.

- [ ] **Step 3: Commit**

```bash
git add src/web/screens/review-project.js
git commit -m "feat: scope the stage rail to the active production phase"
```

---

### Task 11: Styles for the new chrome; remove dead styles

**Files:**
- Modify: `src/web/styles.css`

**Interfaces:** none (visual only). Class names consumed (already emitted by Tasks 9-10): `.topnav`, `.topnav-brand`, `.topnav-links`, `.topnav-links a.active`, `.breadcrumb`, `.breadcrumb-sep`, `.view`, `.workspace-layout`, `.phase-bar` (+ `button.selected`, `button[data-state="done"|"in-progress"|"needs-approval"|"pending"]`), `.projects-screen`, `.projects-toolbar`, `.projects-rows`, `.projects-row`, `.type-badge.type-review|type-series|type-channel`, `.projects-create`.

- [ ] **Step 1: Add the new rules**

Follow the existing stylesheet's variables/patterns (read the current `.topbar`, `.stage-rail`, `.workflow-step` rules first and reuse their colors and spacing). Required behaviors:
- `.topnav`: flex row, brand left, links center, status right (status keeps `aria-live` styling from old `.status`).
- `.breadcrumb`: single row under the topnav; links styled as links, current item bold.
- `.phase-bar`: horizontal 4-button strip; `selected` = filled accent; `data-state` renders a small left border or dot per state — done: existing "done" green, in-progress: existing progress blue, needs-approval: existing warn amber, pending: muted. Reuse the exact color values already used by `.workflow-step.done/.ready/.blocked` and the `readiness-pill` levels.
- `.projects-rows`: table-like rows (grid: badge / title+id / open button); `.type-badge` colors: review = the accent used by `.stage-rail button.selected`, series = the series-tab accent, channel = the `.story-table` header accent (read the file; pick the closest existing tokens rather than inventing new colors).
- `.workspace-layout`: two-column grid (workspace 1fr, preview fixed ~320px), collapsing to one column under 1100px (match the old `.layout` breakpoint if one exists).

- [ ] **Step 2: Delete dead rules**

Remove rules whose selectors no longer appear in any HTML/JS: `.topbar`, `.topbar-actions`, `.layout`, `.sidebar`, `.project-list` (grep each selector across `src/web` before deleting). Keep `.workflow-*`, `.stage-rail`, `.panel`, `.preview`, `.series-*`, `.story-*` — still used.

- [ ] **Step 3: Verify**

`npm test` (the styles test asserts `.story-table`/`.story-tabs` still present). Browser: check all six smoke screens from Task 9 Step 7 look coherent; nothing unstyled.

- [ ] **Step 4: Commit**

```bash
git add src/web/styles.css
git commit -m "feat: style the routed shell, phase bar, and project list"
```

---

### Task 12: Final sweep — docs, full verification

**Files:**
- Modify: `README.md` (UI description section if it describes the old topbar/sidebar — read it first), `docs/superpowers/specs/2026-08-24-project-management-ui-restructure-design.md` (Status line → "Implemented YYYY-MM-DD")

- [ ] **Step 1: Full verification**

```bash
npm test && npm run typecheck
for f in src/web/*.js src/web/lib/*.js src/web/screens/*.js; do node --check "$f" || exit 1; done
```

Expected: everything green, `src/web/app.js` gone, no file in `src/web` exceeds ~1,200 lines (review-project.js will be the largest).

- [ ] **Step 2: Manual smoke checklist (run the app, tick each)**

- [ ] Projects screen lists review projects, series, story channels with correct badges; search + type filter work.
- [ ] New Review Project / New Series / New Story Channel forms create and navigate correctly.
- [ ] Review project: Overview board runs tasks; each phase shows only its stages; a stage action (e.g. brief save) round-trips; previews play for a project with artifacts.
- [ ] Series: episodes table, batch review actions, brand kit save.
- [ ] Story channel: stories table, story detail tabs, channel settings save, voice lab renders.
- [ ] SSE: start a job, watch status line progress, confirm the screen refreshes on completion.
- [ ] Browser Back/Forward navigate between screens; deep links (`#/project/<id>/edit`) load directly; legacy `#story-factory` redirects.

- [ ] **Step 3: Update docs and commit**

```bash
git add README.md docs/
git commit -m "docs: describe the routed project management studio"
```

---

## Execution notes

- Tasks 1-3 are independent of each other; 4→9 are strictly sequential; 10-12 sequential after 9.
- If a "verbatim move" hits an unlisted shared helper, the rule is: generic DOM/format helper → `lib/dom.js`; touches `appState` → `lib/state.js` or the owning screen; used by exactly one screen → that screen. Never duplicate a function.
- Another agent (Codex) sometimes works this repo: before each task, `git status` must be clean and on `feature/project-management-ui-restructure`.
