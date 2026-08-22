# Cut Render UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio a way to trigger the subtitle-driven cut, so the render path that already exists behind `POST /api/projects/:id/edit-render` becomes reachable without curl.

**Architecture:** The cut gate joins the project snapshot beside the existing draft gate, and the Render stage grows a second, clearly separated control block for the cut. The segment editor stays where Codex put it, in the Translation stage — that is where cue decisions are made; the Render stage is where renders are started.

**Tech Stack:** Node 22 native TypeScript type-stripping, `node:test`, vanilla DOM in `src/web/app.js` (no framework, no build step).

**Spec:** No separate spec document. This plan extends `docs/superpowers/specs/2026-08-22-segment-editor-design.md` (the segment editor) with the cut render that landed in commits `17f776e` and `70b27ff`.

## Global Constraints

- Node >= 22.6.0, native type-stripping. Every local import carries an explicit `.ts` extension.
- No new runtime dependencies. `busboy` remains the only one.
- Tests are `node:test`. Run `npm test` on its own — running it concurrently with another command in the same working directory makes suites collide over the cwd-relative `studio.config.json` and produces phantom failures.
- `tests/web.test.ts` asserts on the **source text** of `src/web/app.js` and `src/web/styles.css`. There is no DOM harness. Write assertions as regexes over the file contents.
- The rights/copyright gate stays. No auto-download, no reup pipeline. (`AGENTS.md`)
- Mutations are already protected by the server same-origin rule. Do not add a second check.
- `src/web/app.js` is plain JavaScript, not TypeScript. No type annotations.

---

### Task 1: Expose the cut gate in the project snapshot

The client cannot explain why the cut is blocked without the gate. `sendProject` already ships `renderGate`; the cut gate goes beside it under its own key, because the two gates disagree on purpose — the draft gate demands a script and a voice track that a cut never produces.

**Files:**
- Modify: `src/server.ts:1063-1075` (the `sendJson` payload inside `sendProject`)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `evaluateEditRenderGate(projectId: string): Promise<RenderGateResult>` from `src/workflow.ts`, already imported into `src/server.ts`.
- Produces: snapshot key `editRenderGate: { allowed: boolean; reasons: string[] }`, consumed by Task 2.

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
Expected: FAIL reading `allowed` of undefined, because the snapshot has no `editRenderGate`.

- [ ] **Step 3: Add the key to the payload**

In `src/server.ts`, inside `sendProject`, add one line after `renderGate`:

```ts
    pipeline: await projectPipelineStatus(projectId),
    renderGate: await evaluateProjectRenderGate(projectId),
    editRenderGate: await evaluateEditRenderGate(projectId),
    workflow: {
```

- [ ] **Step 4: Run the test and the suite**

Run: `node --test tests/server.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS, no other suite disturbed.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: report the cut gate in the project snapshot"
```

---

### Task 2: Add cut controls to the Render stage

**The trap to avoid:** `renderRender` early-returns when the project has no visual mapping, printing "Generate a visual mapping to open the timeline editor." A cut project has no visual mapping and never will — mapping belongs to the narrated draft. If the cut controls are appended only on the normal path, they are invisible to exactly the projects that need them. The controls must appear on **both** paths.

**Files:**
- Modify: `src/web/app.js` — `renderRender` (around line 1520), plus new `EDIT_RENDER_GATE_LABELS`, `renderCutControls`, `requestCutRender`
- Modify: `src/web/styles.css` — add `.cut-toolbar`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `snapshot.editRenderGate` from Task 1; existing helpers `wrapSection(title, ...children)`, `paragraph(text)`, `actionButton(text, onClick, type = "button", variant = "")`, `projectApiUrl(route)`, `reportedAsJob(response, data)`, `setStatus(text)`, `selectProject(projectId)`.
- Produces: nothing consumed by later tasks.

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
  assert.match(styles, /\.cut-toolbar/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/web.test.ts`
Expected: FAIL on `/Render Cut/`, since no such string exists yet.

- [ ] **Step 3: Add the gate labels**

In `src/web/app.js`, directly below the existing `RENDER_GATE_LABELS` object (around line 1503):

```js
const EDIT_RENDER_GATE_LABELS = {
  "copyright-approval-missing": "Run and approve the copyright check before cutting source footage.",
  "copyright-approval-stale": "The copyright check changed after approval. Approve it again.",
  "source-media-missing": "Import the source video in the Media stage.",
  "edit-manifest-missing": "Create an edit manifest in the Translation stage.",
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

In `src/web/app.js`, `renderRender`. Add the `cutControls` line after `gateNotice`, then append it to **both** `replaceChildren` calls:

```js
function renderRender(snapshot) {
  const mapping = snapshot.visualMapping;
  const gateNotice = renderGateNotice(snapshot);
  const cutControls = renderCutControls(snapshot);
```

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

```js
  stageContent.replaceChildren(
    toolbar,
    ...(gateNotice ? [gateNotice] : []),
    editor,
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions", "render"]),
    cutControls,
  );
```

- [ ] **Step 6: Add the request function**

In `src/web/app.js`, directly below `requestRender` (around line 2006). It mirrors `requestRender` because the route behaves identically: 409 with gate reasons, or 202 with a job record.

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

- [ ] **Step 8: Run the test and the suite**

Run: `node --test tests/web.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: clean. (`src/web/app.js` is not typechecked, but `src/server.ts` from Task 1 is.)

- [ ] **Step 9: Drive it in the browser**

Run: `npm run studio`, open `http://127.0.0.1:3000`, pick a project, open the Render stage.
Expected: the "Subtitle-driven cut" block is visible **even on a project with no visual mapping**, and lists the unmet gates in plain language.

- [ ] **Step 10: Commit**

```bash
git add src/web/app.js src/web/styles.css tests/web.test.ts
git commit -m "feat: start the subtitle-driven cut from the render stage"
```

---

## Review Questions for Codex

These are the four decisions the plan makes that a reviewer could reasonably overturn. Answers should land before Task 1 starts.

**1. Button placement.** The plan puts the cut trigger in the Render stage and leaves the segment editor in the Translation stage, splitting decision from execution across two stages. The alternative is one "Export Clean SRT / Render Cut" row inside the existing segment editor, keeping the whole cut workflow on one screen at the cost of a render button living outside the Render stage. Which reads better to the operator?

**2. The shared `render` artifact slot.** `renderDraftProject` and `renderEditedCutProject` both call `setArtifact(projectId, { kind: "render", ... })`, so a project records either a narrated draft or a cut, never both — the second render silently replaces the first in `project-state.json`. The plan accepts this on the grounds that a project is one workflow or the other. Rejecting it means adding a `cut` member to `ArtifactKind`, which touches `src/types.ts`, `deriveStepStates`, and the artifact list UI. Is the shared slot acceptable?

**3. Snapshot cost.** `evaluateEditRenderGate` internally calls `projectPipelineStatus`, which loads project state, and then loads project state a second time for the media artifact, and reads the edit manifest. Task 1 puts all of that on `GET /api/projects/:id`, which the client calls on every project selection and after every job. Is that acceptable, or should the gate move to its own lazily-fetched route?

**4. Gate wording.** `EDIT_RENDER_GATE_LABELS` names the stage the operator must visit ("Import the source video in the Media stage"). The existing `RENDER_GATE_LABELS` does the same, so this is consistent — but the cut gate can fire on a project whose workflow type has no Media step. Should the labels name artifacts instead of stages?
