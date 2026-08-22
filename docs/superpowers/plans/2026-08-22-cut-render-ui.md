# Cut Render UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio a way to trigger the subtitle-driven cut, so the render path that already exists behind `POST /api/projects/:id/edit-render` becomes reachable without curl — and stop the cut from overwriting the narrated draft on its way there.

**Architecture:** The cut gets its own artifact kind so a project can hold a draft and a cut at once. The cut gate joins the project snapshot beside the draft gate, and the Render stage grows a second, clearly separated control block. The segment editor stays where it is, in the Translation stage — that is where cue decisions are made; the Render stage is where renders are started.

**Tech Stack:** Node 22 native TypeScript type-stripping, `node:test`, vanilla DOM in `src/web/app.js` (no framework, no build step).

**Spec:** No separate spec document. This plan extends `docs/superpowers/specs/2026-08-22-segment-editor-design.md` with the cut render that landed in `17f776e` and `70b27ff`.

## Global Constraints

- Node >= 22.6.0, native type-stripping. Every local import carries an explicit `.ts` extension.
- No new runtime dependencies. `busboy` remains the only one.
- Tests are `node:test`. Run `npm test` on its own — running it concurrently with another command in the same working directory makes suites collide over the cwd-relative `studio.config.json` and produces phantom failures.
- `tests/web.test.ts` asserts on the **source text** of `src/web/app.js` and `src/web/styles.css`. There is no DOM harness. Write assertions as regexes over the file contents.
- The rights/copyright gate stays. No auto-download, no reup pipeline. (`AGENTS.md`)
- Mutations are already protected by the server same-origin rule. Do not add a second check.
- `src/web/app.js` is plain JavaScript, not TypeScript. No type annotations.

## Review Outcome (Codex, 2026-08-22)

Codex reviewed the first draft and found no execution defects — anchors, helper signatures, gate reason order, and test regexes all verified against the real code. It overturned two decisions, and both are folded in below:

- **Separate artifact kind (was: share the `render` slot).** Accepted. `renderDraftProject` and `renderEditedCutProject` both wrote `artifacts.render`, so the second render silently replaced the first in `project-state.json`. Silent data loss beats the convenience of one slot. This became Task 1.
- **Artifact-oriented gate wording (was: name the stage).** Accepted. The cut gate can fire on a workflow template that has no Media step, so a label reading "in the Media stage" would point at a screen that is not there.

Kept as drafted: the trigger lives in the Render stage, and the cut gate ships inside the project snapshot rather than on its own lazy route.

---

### Task 1: Give the cut its own artifact kind

**Files:**
- Modify: `src/types.ts:74` (`ArtifactKind`)
- Modify: `src/edit-render.ts` (return type and emitted `kind`)
- Modify: `src/workflow.ts` (return type of `renderEditedCutProject`)
- Test: `tests/edit-render.test.ts`, `tests/edit-render-gate.test.ts`

**Interfaces:**
- Produces: `CutArtifact = ArtifactRecord & { kind: "cut" }`, exported from `src/edit-render.ts`; project state key `artifacts.cut`. Task 3 lists it in the UI.

- [ ] **Step 1: Change the failing assertions**

In `tests/edit-render.test.ts`, in "records a render artifact describing the cut", change the kind assertion:

```ts
    assert.equal(artifact.kind, "cut");
```

In `tests/edit-render-gate.test.ts`, in "the cut is written with subtitles realigned to it", the same:

```ts
    assert.equal(artifact.kind, "cut");
```

Add a test to `tests/edit-render-gate.test.ts` proving the two renders no longer collide:

```ts
test("the cut does not displace a narrated draft render", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject();
    await setArtifact(PROJECT_ID, {
      kind: "render",
      sourceHash: "draft-hash",
      relativePath: "workspace/renders/draft-20260822-000000-000.mp4",
      createdAt: "2026-08-22T00:00:00.000Z",
      metadata: {},
    });

    await renderEditedCutProject(PROJECT_ID, {
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [await fakeFfmpeg()],
    });

    const state = await loadProjectState(PROJECT_ID);
    assert.equal(state.artifacts.render?.sourceHash, "draft-hash");
    assert.equal(state.artifacts.cut?.kind, "cut");
  });
});
```

Hoist the fake ffmpeg into a `fakeFfmpeg()` helper in that file, and import `loadProjectState` from `../src/project-state.ts`.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/edit-render.test.ts tests/edit-render-gate.test.ts`
Expected: FAIL — kind is still `render`, and `state.artifacts.cut` is undefined.

- [ ] **Step 3: Add the kind**

`src/types.ts`:

```ts
export type ArtifactKind = "media" | "audio" | "source-subtitles" | "voice" | "captions" | "render" | "cut";
```

- [ ] **Step 4: Emit it**

In `src/edit-render.ts`, replace the `RenderArtifact` import and usage. Keep `renderArtifactRelativePath`, which is kind-agnostic:

```ts
import { renderArtifactRelativePath } from "./render.ts";
import type { ArtifactRecord } from "./types.ts";

/** Its own kind so a cut never displaces the narrated draft in project state. */
export type CutArtifact = ArtifactRecord & { kind: "cut" };
```

Change the signature and the literal:

```ts
export async function renderEditedCut(input: EditRenderInput, signal?: AbortSignal): Promise<CutArtifact> {
```

```ts
  const artifact: CutArtifact = {
    kind: "cut",
```

In `src/workflow.ts`, import the type and change the return type of `renderEditedCutProject`:

```ts
import { buildCutSrt, cutTimeline, renderEditedCut, type CutArtifact } from "./edit-render.ts";
```

```ts
export async function renderEditedCutProject(
  projectId: string,
  options: RenderDraftOptions = {},
): Promise<CutArtifact> {
```

- [ ] **Step 5: Verify**

Run: `node --test tests/edit-render.test.ts tests/edit-render-gate.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/edit-render.ts src/workflow.ts tests/edit-render.test.ts tests/edit-render-gate.test.ts
git commit -m "fix: stop a cut render from displacing the narrated draft"
```

---

### Task 2: Expose the cut gate in the project snapshot

The client cannot explain why the cut is blocked without the gate. `sendProject` already ships `renderGate`; the cut gate goes beside it under its own key, because the two gates disagree on purpose — the draft gate demands a script and a voice track that a cut never produces.

**Files:**
- Modify: `src/server.ts` (the `sendJson` payload inside `sendProject`)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `evaluateEditRenderGate(projectId: string): Promise<RenderGateResult>` from `src/workflow.ts`, already imported into `src/server.ts`.
- Produces: snapshot key `editRenderGate: { allowed: boolean; reasons: string[] }`, consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.ts`:

```ts
test("project snapshot carries the cut gate beside the draft gate", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const snapshot = await (await fetch(`${running.url}/api/projects/sample-project`)).json();

      assert.equal(snapshot.editRenderGate.allowed, false);
      assert.deepEqual(snapshot.editRenderGate.reasons, [
        "copyright-approval-missing",
        "source-media-missing",
        "edit-manifest-missing",
      ]);
    } finally {
      await running.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/server.test.ts`
Expected: FAIL reading `allowed` of undefined.

- [ ] **Step 3: Add the key to the payload**

In `src/server.ts`, inside `sendProject`, add one line after `renderGate`:

```ts
    pipeline: await projectPipelineStatus(projectId),
    renderGate: await evaluateProjectRenderGate(projectId),
    editRenderGate: await evaluateEditRenderGate(projectId),
    workflow: {
```

- [ ] **Step 4: Verify**

Run: `node --test tests/server.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: report the cut gate in the project snapshot"
```

---

### Task 3: Add cut controls to the Render stage

**The trap to avoid:** `renderRender` early-returns when the project has no visual mapping, printing "Generate a visual mapping to open the timeline editor." A cut project has no visual mapping and never will — mapping belongs to the narrated draft. If the cut controls are appended only on the normal path, they are invisible to exactly the projects that need them. The controls must appear on **both** paths.

**Files:**
- Modify: `src/web/app.js` — `renderRender` (around line 1520), plus new `EDIT_RENDER_GATE_LABELS`, `renderCutControls`, `requestCutRender`
- Modify: `src/web/styles.css` — add `.cut-toolbar`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `snapshot.editRenderGate` from Task 2; `artifacts.cut` from Task 1; existing helpers `wrapSection(title, ...children)`, `paragraph(text)`, `actionButton(text, onClick, type = "button", variant = "")`, `artifactList(artifacts, kinds)`, `projectApiUrl(route)`, `reportedAsJob(response, data)`, `setStatus(text)`, `selectProject(projectId)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/web.test.ts`:

```ts
test("render stage exposes the subtitle-driven cut", async () => {
  const script = await readFile("src/web/app.js", "utf8");
  const styles = await readFile("src/web/styles.css", "utf8");

  assert.match(script, /Render Cut/);
  assert.match(script, /projectApiUrl\("edit-render"\)/);
  assert.match(script, /EDIT_RENDER_GATE_LABELS/);
  assert.match(script, /source-media-missing/);
  assert.match(script, /edit-manifest-keeps-no-cues/);
  assert.match(script, /"voice", "captions", "render", "cut"/);
  assert.match(styles, /\.cut-toolbar/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/web.test.ts`
Expected: FAIL on `/Render Cut/`.

- [ ] **Step 3: Add the gate labels**

In `src/web/app.js`, directly below the existing `RENDER_GATE_LABELS` object. The labels name artifacts, not stages, because the cut gate can fire on a workflow template that has no Media step:

```js
const EDIT_RENDER_GATE_LABELS = {
  "copyright-approval-missing": "Approve the copyright check before cutting source footage.",
  "copyright-approval-stale": "The copyright check changed after approval. Approve it again.",
  "source-media-missing": "Import a source video into this project.",
  "edit-manifest-missing": "Create an edit manifest from a subtitle file.",
  "edit-manifest-keeps-no-cues": "Every cue is marked remove. Keep at least one cue to cut.",
};
```

- [ ] **Step 4: Add the control block**

In `src/web/app.js`, directly below `renderGateNotice`:

```js
function renderCutControls(snapshot) {
  const gate = snapshot.editRenderGate;
  const toolbar = document.createElement("div");
  toolbar.className = "cut-toolbar";
  const badge = document.createElement("span");
  badge.className = `mapping-status mapping-status-${gate?.allowed ? "approved" : "missing"}`;
  badge.textContent = gate?.allowed ? "cut ready" : "cut gated";
  toolbar.append(badge, actionButton("Render Cut", () => requestCutRender(), "button", "primary"));

  const children = [
    paragraph("Cuts the imported source video down to the cues kept in the Translation stage, and writes subtitles realigned to the cut."),
    toolbar,
  ];
  if (gate && !gate.allowed) {
    const notice = document.createElement("ul");
    notice.className = "render-gate-notice";
    for (const reason of gate.reasons) {
      const item = document.createElement("li");
      item.textContent = EDIT_RENDER_GATE_LABELS[reason] ?? reason;
      notice.append(item);
    }
    children.push(notice);
  }
  return wrapSection("Subtitle-driven cut", ...children);
}
```

- [ ] **Step 5: Show it on both paths of the Render stage**

In `renderRender`, add `cutControls` after `gateNotice`:

```js
function renderRender(snapshot) {
  const mapping = snapshot.visualMapping;
  const gateNotice = renderGateNotice(snapshot);
  const cutControls = renderCutControls(snapshot);
```

Append it to the early-return branch:

```js
  if (!mapping?.segments?.length) {
    stageContent.replaceChildren(
      toolbar,
      ...(gateNotice ? [gateNotice] : []),
      paragraph("Generate a visual mapping to open the timeline editor."),
      cutControls,
    );
    return;
  }
```

And to the normal branch, where the artifact list also gains the cut:

```js
  stageContent.replaceChildren(
    toolbar,
    ...(gateNotice ? [gateNotice] : []),
    editor,
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions", "render", "cut"]),
    cutControls,
  );
```

- [ ] **Step 6: Add the request function**

Directly below `requestRender`. It mirrors `requestRender` because the route behaves identically: 409 with gate reasons, or 202 with a job record.

```js
async function requestCutRender() {
  const response = await fetch(projectApiUrl("edit-render"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message || (data.details?.reasons ?? []).join(", ")}`);
    return;
  }
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus(`Cut rendered: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}
```

- [ ] **Step 7: Add the style**

In `src/web/styles.css`, beside the existing `.render-toolbar` rule:

```css
.cut-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 0.5rem 0 0;
}
```

- [ ] **Step 8: Verify**

Run: `node --test tests/web.test.ts`
Expected: PASS

Run: `npm test` then `npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 9: Drive it in the browser**

Run `npm run studio`, open `http://127.0.0.1:3000`, pick a project, open the Render stage.
Expected: the "Subtitle-driven cut" block is visible **even on a project with no visual mapping**, and lists the unmet gates in plain language.

- [ ] **Step 10: Commit**

```bash
git add src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: start the subtitle-driven cut from the render stage"
```
