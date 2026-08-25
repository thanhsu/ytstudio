# Render UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-line status bar with a typed toast notification system and job progress bar, and improve the Render stage editor with tabbed Inspector, slider-based effects, and inline error display.

**Architecture:** All changes are pure frontend (vanilla JS + CSS) with no new API routes. `shell.js` gains `toast()`, `startJobBar()`, `updateJobBar()`, `stopJobBar()` exports. `setStatus()` is kept as a shim that calls `toast('info', …)` so callers migrate incrementally; critical paths (errors, job progress) are updated first. The Inspector is refactored from a single flat form to two tabs (Clip | Effects) within the same form element.

**Tech Stack:** Vanilla ES modules, no bundler, served directly by the Node.js server. CSS custom properties already defined in `styles.css`. No new npm packages.

**Spec:** Approved prototype at `prototype-render.html` (screens R1–R5, captured in `render-screenshots/`).

## Global Constraints

- No framework libraries (React, Vue, etc.) — pure DOM manipulation only
- No new npm packages
- Do not change any server-side TypeScript or Java files
- `setStatus()` must continue to exist in `shell.js` (shim) — do not delete it; callers migrate one task at a time
- Test by running `npm test` (Jest) to ensure no regression in story-pipeline tests; frontend is tested manually in browser at `http://localhost:3000`
- All `fetch` calls keep existing error handling patterns (throw on `!response.ok`)
- Commit after every task

---

## File Map

| File | What changes |
|------|-------------|
| `src/web/index.html` | Remove `<div id="status">`, add `<div id="toast-shelf">`, `<div id="job-bar" hidden>` |
| `src/web/lib/shell.js` | Add `toast()`, `dismissToast()`, `startJobBar()`, `updateJobBar()`, `stopJobBar()`; shim `setStatus()` |
| `src/web/styles.css` | Add toast shelf + toast styles; add job bar styles; remove `.status` rule |
| `src/web/lib/state.js` | Replace `setStatus()` calls in `handleJobEvent()` and `reportedAsJob()` with `toast()` / job bar |
| `src/web/main.js` | Replace top-level error `setStatus()` with `toast('err', ...)` |
| `src/web/screens/jobs.js` | Replace `setStatus()` calls with `toast()` |
| `src/web/screens/review-project.js` | Replace `setStatus()` calls with `toast()`; refactor `renderInspector()` to tabbed layout; add `sliderField()` helper; add `inlineRenderError()` function |
| `src/web/lib/dom.js` | Add `sliderField(label, name, value, min, max, step)` helper |

---

## Task 1: Toast infrastructure in shell.js + index.html

**Files:**
- Modify: `src/web/index.html:25` (replace `<div id="status">`)
- Modify: `src/web/lib/shell.js` (add toast/job-bar API)
- Modify: `src/web/styles.css` (add `.toast-shelf`, `.toast-*`, `#job-bar` styles; remove `.status` rule)

**Interfaces:**
- Produces: `toast(level, title, msg?, opts?)` — exported from shell.js; `level` is `'ok'|'err'|'warn'|'info'`
- Produces: `startJobBar(label, progress?)`, `updateJobBar(progress, label?)`, `stopJobBar()` — exported from shell.js
- Produces: `dismissToast(id)` — exported from shell.js
- Keeps: `setStatus(message)` — still exported, now calls `toast('info', message)`

- [ ] **Step 1: Replace `#status` div and add shelf + job bar in index.html**

In `src/web/index.html`, replace line 25:
```html
      <div id="status" class="status" aria-live="polite">Loading studio...</div>
```
with:
```html
    </header>

    <div id="toast-shelf" aria-live="polite" aria-atomic="false"></div>

    <div id="job-bar" hidden>
      <div class="job-bar-inner">
        <span class="jb-label"></span>
        <div class="jb-track"><div class="jb-fill"></div></div>
        <span class="jb-pct">0%</span>
        <button class="jb-cancel" type="button" aria-label="Cancel job">✕</button>
      </div>
    </div>
```
(Also remove the closing `</header>` that was after the old status div — it moves to just before the toast-shelf.)

- [ ] **Step 2: Add toast + job bar exports to shell.js**

Replace the full content of `src/web/lib/shell.js` with:
```javascript
// Shell regions: view host, breadcrumb, paid-spend dialogs.
// Toast and job-bar replace the old #status line.
export let view;
export let breadcrumb;
export let paidVoiceDialog;
export let confirmPaidVoice;
export let paidScriptDialog;
export let confirmPaidScript;

export function bindShell() {
  view = document.querySelector("#view");
  breadcrumb = document.querySelector("#breadcrumb");
  paidVoiceDialog = document.querySelector("#paid-voice-dialog");
  confirmPaidVoice = document.querySelector("#confirm-paid-voice");
  paidScriptDialog = document.querySelector("#paid-script-dialog");
  confirmPaidScript = document.querySelector("#confirm-paid-script");
}

// ── Toast system ─────────────────────────────────────────────────────────────
let _tid = 0;

const TOAST_DUR = { ok: 4000, info: 3500, warn: 5500, err: 0 };
const TOAST_ICONS = { ok: "✓", info: "ℹ", warn: "!", err: "✕" };

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Show a typed toast notification.
 *
 * @param {"ok"|"info"|"warn"|"err"} level
 * @param {string} title  Short headline shown bold
 * @param {string} [msg]  Optional detail line
 * @param {{ persist?: boolean, actions?: Array<{label:string,handler:()=>void}> }} [opts]
 * @returns {number} toast id (use with dismissToast)
 */
export function toast(level, title, msg = "", opts = {}) {
  const shelf = document.getElementById("toast-shelf");
  if (!shelf) {
    // Shelf not yet in DOM (very early boot); degrade gracefully.
    console.warn(`[toast/${level}] ${title} — ${msg}`);
    return 0;
  }
  const id = ++_tid;
  const dur = opts.persist ? 0 : (TOAST_DUR[level] ?? 4000);
  const actions = opts.actions ?? [];

  const el = document.createElement("div");
  el.id = `toast-${id}`;
  el.className = `toast toast-${level}`;
  el.setAttribute("role", level === "err" ? "alert" : "status");

  const icon = document.createElement("div");
  icon.className = "t-icon";
  icon.textContent = TOAST_ICONS[level] ?? "ℹ";

  const body = document.createElement("div");
  body.className = "t-body";

  const titleEl = document.createElement("div");
  titleEl.className = "t-title";
  titleEl.textContent = title;
  body.append(titleEl);

  if (msg) {
    const msgEl = document.createElement("div");
    msgEl.className = "t-msg";
    msgEl.textContent = msg;
    body.append(msgEl);
  }

  if (actions.length) {
    const actRow = document.createElement("div");
    actRow.className = "toast-actions";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.addEventListener("click", action.handler);
      actRow.append(btn);
    }
    body.append(actRow);
  }

  if (dur > 0) {
    const timer = document.createElement("div");
    timer.className = "t-timer";
    timer.style.setProperty("--dur", `${dur}ms`);
    body.append(timer);
  }

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "t-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", () => dismissToast(id));

  el.append(icon, body, dismiss);
  shelf.appendChild(el);

  if (dur > 0) setTimeout(() => dismissToast(id), dur);
  return id;
}

export function dismissToast(id) {
  const el = document.getElementById(`toast-${id}`);
  if (!el) return;
  el.classList.add("toast-out");
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

// Backward-compat shim: callers that haven't been migrated yet still work.
export function setStatus(message) {
  toast("info", message);
}

// ── Job progress bar ─────────────────────────────────────────────────────────
let _jobCancelHandler = null;

/**
 * Show the floating job progress bar.
 * @param {string} label Description of the running job
 * @param {number} [progress=0] 0–100
 * @param {(() => void) | null} [onCancel] Called when user clicks ✕
 */
export function startJobBar(label, progress = 0, onCancel = null) {
  const bar = document.getElementById("job-bar");
  if (!bar) return;
  _jobCancelHandler = onCancel;
  const cancelBtn = bar.querySelector(".jb-cancel");
  cancelBtn.hidden = onCancel === null;
  if (onCancel) {
    cancelBtn.onclick = () => { if (_jobCancelHandler) _jobCancelHandler(); };
  }
  bar.querySelector(".jb-label").textContent = label;
  _setJobBarProgress(bar, progress);
  bar.hidden = false;
}

export function updateJobBar(progress, label) {
  const bar = document.getElementById("job-bar");
  if (!bar || bar.hidden) return;
  if (label !== undefined) bar.querySelector(".jb-label").textContent = label;
  _setJobBarProgress(bar, progress);
}

export function stopJobBar() {
  const bar = document.getElementById("job-bar");
  if (bar) bar.hidden = true;
  _jobCancelHandler = null;
}

function _setJobBarProgress(bar, progress) {
  const pct = Math.max(0, Math.min(100, progress));
  bar.querySelector(".jb-fill").style.width = `${pct}%`;
  bar.querySelector(".jb-pct").textContent = `${Math.round(pct)}%`;
}

// ── Nav / breadcrumb ─────────────────────────────────────────────────────────
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

- [ ] **Step 3: Add toast + job bar CSS to styles.css**

Append the following block to the end of `src/web/styles.css` (keep all existing rules intact — just add these):
```css
/* ── Toast shelf ── */
#toast-shelf {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 5000;
  display: flex;
  flex-direction: column;
  gap: .45rem;
  align-items: flex-end;
  pointer-events: none;
}

.toast {
  pointer-events: all;
  display: grid;
  grid-template-columns: 18px 1fr 18px;
  align-items: start;
  gap: .55rem;
  min-width: 300px;
  max-width: 400px;
  padding: .65rem .85rem;
  border-radius: 10px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,.1));
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 16px rgba(0,0,0,.4);
  animation: toast-in 200ms cubic-bezier(.16,1,.3,1) both;
}

.toast.toast-out {
  animation: toast-out 160ms ease-in both;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateX(14px) scale(.97); }
  to   { opacity: 1; transform: none; }
}
@keyframes toast-out {
  from { opacity: 1; }
  to   { opacity: 0; transform: translateX(14px); }
}

.toast-ok   { background: #0d2210; border-color: rgba(63,185,80,.25); }
.toast-info { background: #0d1a2e; border-color: rgba(108,165,255,.2); }
.toast-warn { background: #221a08; border-color: rgba(210,153,34,.25); }
.toast-err  { background: #2a1111; border-color: rgba(248,81,73,.3); }

.t-icon {
  width: 18px; height: 18px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700;
  flex-shrink: 0; margin-top: 2px;
}
.toast-ok   .t-icon { background: rgba(63,185,80,.2);  color: #3fb950; }
.toast-info .t-icon { background: rgba(31,111,235,.2); color: #6ca5ff; }
.toast-warn .t-icon { background: rgba(210,153,34,.2); color: #d29922; }
.toast-err  .t-icon { background: rgba(248,81,73,.2);  color: #f85149; }

.t-title {
  font-weight: 600;
  font-size: .82rem;
  line-height: 1.3;
}
.toast-ok   .t-title { color: #3fb950; }
.toast-info .t-title { color: #6ca5ff; }
.toast-warn .t-title { color: #d29922; }
.toast-err  .t-title { color: #f85149; }

.t-msg {
  font-size: .75rem;
  color: var(--text-muted, #9aa4b2);
  margin-top: .1rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

.t-dismiss {
  background: transparent;
  border: none;
  color: var(--text-muted, #9aa4b2);
  width: 18px; height: 18px;
  padding: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}
.t-dismiss:hover { background: rgba(255,255,255,.08); color: var(--text, #e6edf3); }

.t-timer {
  height: 2px;
  border-radius: 999px;
  margin-top: .45rem;
  background: currentColor;
  opacity: .2;
  animation: t-shrink var(--dur, 4s) linear both;
}
.toast-ok   .t-timer { color: #3fb950; }
.toast-info .t-timer { color: #6ca5ff; }
.toast-warn .t-timer { color: #d29922; }
.toast-err  .t-timer { color: #f85149; }

@keyframes t-shrink {
  from { width: 100%; }
  to   { width: 0; }
}

.toast-actions {
  display: flex;
  gap: .35rem;
  margin-top: .4rem;
}
.toast-actions button {
  font-size: .72rem;
  padding: .2rem .45rem;
}

/* ── Job progress bar ── */
#job-bar {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4900;
  min-width: 360px;
  max-width: 500px;
  background: var(--surface, #14181f);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,.45);
  padding: .55rem .9rem;
}

.job-bar-inner {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: .6rem;
}

.jb-label {
  font-size: .8rem;
  font-weight: 600;
  color: var(--text, #e6edf3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jb-track {
  width: 120px;
  height: 4px;
  border-radius: 999px;
  background: rgba(255,255,255,.08);
  overflow: hidden;
}

.jb-fill {
  height: 4px;
  border-radius: 999px;
  background: #1f6feb;
  transition: width 300ms ease;
}

.jb-pct {
  font-size: .75rem;
  font-family: "IBM Plex Mono", monospace;
  color: #6ca5ff;
  width: 32px;
  text-align: right;
}

.jb-cancel {
  background: transparent;
  border: none;
  color: var(--text-muted, #9aa4b2);
  cursor: pointer;
  padding: .1rem .25rem;
  border-radius: 3px;
  font-size: .8rem;
}
.jb-cancel:hover { color: #f85149; background: rgba(248,81,73,.1); }

/* Remove old status bar rule if present */
.status { display: none !important; }
```

- [ ] **Step 4: Verify index.html is valid (manual)**

Open `src/web/index.html` in an editor and confirm:
- No `<div id="status">` remains
- `#toast-shelf` div appears outside `<header>`, before `<nav id="breadcrumb">`
- `#job-bar` div appears after `#toast-shelf`

- [ ] **Step 5: Run tests to verify no breakage**

```bash
cd D:\DOCS\SUPHAM\GIT\yt-review-studio
npm test
```
Expected: all 787 tests pass (story-factory tests; no UI tests exist).

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/lib/shell.js src/web/styles.css
git commit -m "feat(ui): replace status bar with typed toast notification system and job progress bar"
```

---

## Task 2: Migrate job-event and error callers to toast + job bar

**Files:**
- Modify: `src/web/lib/state.js:70-101` — `handleJobEvent()` and `reportedAsJob()`
- Modify: `src/web/main.js:33` — top-level error handler
- Modify: `src/web/screens/jobs.js:54,103,134` — jobs screen feedback

**Interfaces:**
- Consumes: `toast(level, title, msg?)`, `startJobBar(label, progress)`, `updateJobBar(progress, label)`, `stopJobBar()` from `shell.js`

- [ ] **Step 1: Update handleJobEvent and reportedAsJob in state.js**

Open `src/web/lib/state.js`. Find the import line for `setStatus` (near top) and add the new imports:
```javascript
import { toast, startJobBar, updateJobBar, stopJobBar } from "./shell.js";
```
(Keep `setStatus` in the import if anything else in the file still uses it; otherwise remove it.)

Replace `handleJobEvent()` (lines 70–88):
```javascript
function handleJobEvent(job) {
  const label = JOB_LABELS[job.kind] ?? job.kind;
  if (job.status === "running") {
    appState.activeJob = job;
    startJobBar(`${label}: ${job.message}`, job.progress);
    return;
  }

  stopJobBar();
  appState.activeJob = null;

  if (job.status === "succeeded") {
    toast("ok", `${label} finished`, job.message ?? "");
  } else if (job.status === "cancelled") {
    toast("warn", `${label} cancelled`, "");
  } else {
    toast("err", `${label} failed`, job.error ?? "Unknown error", { persist: true });
  }
  for (const handler of jobEventHandlers) {
    handler(job);
  }
}
```

Replace `reportedAsJob()` (lines 95–102):
```javascript
export function reportedAsJob(response, data) {
  if (response.status !== 202) return false;
  const label = JOB_LABELS[data.job?.kind] ?? data.job?.kind ?? "Job";
  toast("info", `${label} started`);
  return true;
}
```

- [ ] **Step 2: Update main.js top-level error handler**

In `src/web/main.js`, find the line:
```javascript
setStatus(error.message);
```
Replace with:
```javascript
toast("err", "Navigation error", error.message, { persist: true });
```
Also update the import to include `toast`:
```javascript
import { bindShell, toast } from "./lib/shell.js";
```
(Remove `setStatus` from the import if it's no longer used in main.js.)

- [ ] **Step 3: Update jobs.js**

In `src/web/screens/jobs.js`, update import at top to include `toast` and remove `setStatus`:
```javascript
import { toast } from "../lib/shell.js";
```

Replace line 54: `setStatus("Jobs loaded.");` → delete this line (success is silent; jobs render themselves).

Replace line 103: `() => reviewJob(job).catch((error) => setStatus(error.message))`
→ `() => reviewJob(job).catch((error) => toast("err", "Failed to open result", error.message))`

Replace line 134: `setStatus("The result artifact is no longer registered; open the project instead.");`
→ `toast("warn", "Artifact not found", "The result artifact is no longer registered. Open the project instead.");`

- [ ] **Step 4: Verify in browser (manual)**

Start the app: `npm start`
- Open `http://localhost:3000/#/jobs`
- Trigger any job (e.g., start a voice render)
- Confirm: job bar appears at bottom-center during job, toast appears on success/failure
- No old status bar visible in header

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: all 787 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/state.js src/web/main.js src/web/screens/jobs.js
git commit -m "feat(ui): migrate job events and navigation errors to toast + job progress bar"
```

---

## Task 3: Migrate review-project.js setStatus() calls

**Files:**
- Modify: `src/web/screens/review-project.js` — all `setStatus()` calls

**Interfaces:**
- Consumes: `toast(level, title, msg?, opts?)` from shell.js

- [ ] **Step 1: Update import in review-project.js**

Find the existing import from `../lib/shell.js` in `review-project.js`. Add `toast` to it and remove `setStatus`:
```javascript
import { view, setBreadcrumb, setActiveNav, toast } from "../lib/shell.js";
```

- [ ] **Step 2: Replace every setStatus call in review-project.js**

The following table maps each call to its replacement (search for `setStatus` in the file):

| Old call | Replacement |
|----------|-------------|
| `setStatus(error.message)` (fetch/catch patterns — there are ~10 of these) | `toast("err", "Action failed", error.message, { persist: true })` |
| `setStatus(\`Loaded ${route.id}.\`)` | *(delete — silent load success)* |
| `setStatus(data.message ?? \`Project ${projectId} not found.\`)` | `toast("warn", "Project not found", data.message ?? \`Project ${projectId} not found.\`)` |
| `setStatus(\`Created ${data.brief.id}.\`)` | `toast("ok", "Project created", data.brief.id)` |
| `setStatus("Background loop saved. Approve the mapping again before rendering.")` | `toast("ok", "Background loop saved", "Approve the mapping again before rendering.")` |
| `setStatus("Background loop cleared; the scene timeline is active again. Approve the mapping again before rendering.")` | `toast("ok", "Background loop cleared", "The scene timeline is active again. Approve the mapping again before rendering.")` |
| `setStatus(\`Reset effects for ${sceneId}. This does not approve the mapping — approve it again before rendering.\`)` | `toast("ok", "Effects reset", \`${sceneId} — approve the mapping again before rendering.\`)` |
| Any remaining `setStatus(...)` | `toast("info", message)` |

Make replacements one-by-one rather than a bulk find/replace to avoid hitting the function definition itself.

- [ ] **Step 3: Verify no setStatus references remain (except the shim in shell.js)**

```bash
grep -n "setStatus" src/web/screens/review-project.js
```
Expected: no matches.

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/screens/review-project.js
git commit -m "feat(ui): migrate review-project screen feedback from status bar to toasts"
```

---

## Task 4: sliderField() helper in dom.js

**Files:**
- Modify: `src/web/lib/dom.js` (add `sliderField`)

**Interfaces:**
- Produces: `sliderField(label, name, value, min, max, step)` → returns a `<label>` element containing a `<input type="range">` synced with an `<input type="number">`
- Consumed by: Task 5 (`renderInspector()` in review-project.js)

- [ ] **Step 1: Add sliderField to dom.js**

Append to the end of `src/web/lib/dom.js`:
```javascript
/**
 * A label containing a range slider and a number input kept in sync.
 * Both share the same `name` so formValues() reads the number input value.
 * The range input has `data-mirror` pointing at the number input id.
 */
export function sliderField(label, name, value, min, max, step = "any") {
  const numberId = `sf-${name.replace(/\W/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  const wrapper = document.createElement("label");
  wrapper.className = "field slider-field";

  const caption = document.createElement("span");
  caption.textContent = label;

  const row = document.createElement("div");
  row.className = "slider-row";

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  range.setAttribute("aria-label", label);
  range.dataset.mirror = numberId;

  const num = document.createElement("input");
  num.type = "number";
  num.id = numberId;
  num.name = name;
  num.min = String(min);
  num.max = String(max);
  num.step = String(step);
  num.value = String(value);
  num.className = "slider-num";

  // Two-way sync
  range.addEventListener("input", () => { num.value = range.value; });
  num.addEventListener("input", () => { range.value = num.value; });

  row.append(range, num);
  wrapper.append(caption, row);
  return wrapper;
}
```

- [ ] **Step 2: Add CSS for slider-field in styles.css**

Append to `src/web/styles.css`:
```css
/* ── Slider field ── */
.slider-field .slider-row {
  display: grid;
  grid-template-columns: 1fr 60px;
  gap: .4rem;
  align-items: center;
}

.slider-field input[type="range"] {
  width: 100%;
  accent-color: #1f6feb;
  height: 20px;
  padding: 0;
}

.slider-num {
  font-size: .78rem;
  padding: .28rem .4rem;
  text-align: center;
}
```

- [ ] **Step 3: Export sliderField from dom.js (verify)**

```bash
grep -n "export function sliderField" src/web/lib/dom.js
```
Expected: one match on the newly added line.

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: all tests pass (no test covers dom.js directly; this ensures no syntax error).

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/dom.js src/web/styles.css
git commit -m "feat(ui): add sliderField DOM helper for range+number synced inputs"
```

---

## Task 5: Tabbed Inspector (Clip tab | Effects tab) + sliders in renderInspector()

**Files:**
- Modify: `src/web/screens/review-project.js:1184-1241` — `renderInspector()` function

**Interfaces:**
- Consumes: `sliderField(label, name, value, min, max, step)` from `dom.js`
- The form still has the same `name` attributes so `buildEffectsPatch()` and `saveVisualMappingSegment()` work without changes
- The two tab panels are divs toggled via `hidden`; the form submit is still triggered by the "Save mapping" button in the Clip tab; the "Save effects" button calls `saveVisualMappingEffects()` directly (same as before)

- [ ] **Step 1: Add sliderField to the import line in review-project.js**

Find the dom.js import in `review-project.js`:
```javascript
import { ... } from "../lib/dom.js";
```
Add `sliderField` to the list.

- [ ] **Step 2: Replace renderInspector() with tabbed version**

Replace the entire `renderInspector(segment, assets)` function (lines 1184–1241) with:

```javascript
function renderInspector(segment, assets) {
  const effects = segment.effects ?? NEUTRAL_SEGMENT_EFFECTS;
  const color = effects.color ?? NEUTRAL_SEGMENT_EFFECTS.color;
  const watermarkIneligible =
    !!effects.watermark &&
    !eligibleWatermarkAssets(assets).some((a) => a.id === effects.watermark.assetId);

  const form = document.createElement("form");
  form.className = "render-inspector";

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const tabBar = document.createElement("div");
  tabBar.className = "inspector-tabs";

  const tabClip = document.createElement("button");
  tabClip.type = "button";
  tabClip.className = "inspector-tab active";
  tabClip.textContent = "Clip";

  const tabEffects = document.createElement("button");
  tabEffects.type = "button";
  tabEffects.className = "inspector-tab";
  tabEffects.textContent = "Effects";

  tabBar.append(tabClip, tabEffects);

  // ── Clip tab panel ───────────────────────────────────────────────────────
  const clipPanel = document.createElement("div");
  clipPanel.className = "inspector-panel";

  const narrationExcerpt = document.createElement("p");
  narrationExcerpt.className = "inspector-narration";
  narrationExcerpt.textContent = segment.narration;

  clipPanel.append(
    sectionTitle(`${segment.id} · ${formatTimecode(segment.startSeconds)}–${formatTimecode(segment.endSeconds)}`),
    narrationExcerpt,
    confidenceMeter(segment.confidence),
    paragraph(segment.reason),
    selectField("Asset", "assetId", segment.assetId ?? "", [
      ["", "Generated background"],
      ...assets.map((a) => [a.id, a.filename]),
    ]),
    selectField("Fit", "fitMode", segment.fitMode, [["cover", "Cover"], ["contain", "Contain"]]),
    field("Source start (s)", "sourceStartSeconds", String(segment.sourceStartSeconds), "number", "", "any"),
    field("Source duration (max 5 s for video)", "sourceDurationSeconds", String(segment.sourceDurationSeconds), "number", "", "any"),
    checkboxField("Mute source audio", "muteSourceAudio", segment.muteSourceAudio),
    actionButton("Save mapping", null, "submit", "primary"),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveVisualMappingSegment(segment.id, form)
      .then(() => toast("ok", "Mapping saved", `${segment.id} — approve the mapping again before rendering.`))
      .catch((error) => toast("err", "Save failed", error.message, { persist: true }));
  });

  // ── Effects tab panel ─────────────────────────────────────────────────────
  const effectsPanel = document.createElement("div");
  effectsPanel.className = "inspector-panel";
  effectsPanel.hidden = true;

  const effectsNote = paragraph("Effects render only into an exported draft. Saving or resetting does not approve the mapping — approve again before rendering.");
  effectsNote.className = "inspector-note";

  effectsPanel.append(
    effectsNote,
    sectionTitle("Motion"),
    sliderField("Speed (0.5 – 2.0)", "speed", effects.speed, 0.5, 2, 0.05),
    selectField("Zoom", "zoom", effects.zoom, ZOOM_OPTIONS),
    selectField("Flip", "flip", effects.flip ?? "none", FLIP_OPTIONS),
    sectionTitle("Transitions"),
    selectField("Transition in", "transitionIn", effects.transitionIn, TRANSITION_OPTIONS),
    selectField("Transition out", "transitionOut", effects.transitionOut, TRANSITION_OPTIONS),
    sectionTitle("Color"),
    sliderField("Brightness (−1 – 1)", "color.brightness", color.brightness, -1, 1, 0.05),
    sliderField("Contrast (0 – 2)", "color.contrast", color.contrast, 0, 2, 0.05),
    sliderField("Saturation (0 – 2)", "color.saturation", color.saturation, 0, 2, 0.05),
    sliderField("Grayscale (0 – 1)", "color.grayscale", color.grayscale, 0, 1, 0.05),
    sliderField("Blur (0 – 40)", "blur", effects.blur, 0, 40, 1),
    sectionTitle("Watermark"),
    selectField("Logo asset", "watermark.assetId", effects.watermark?.assetId ?? "", watermarkAssetOptions(assets, effects.watermark)),
    ...(watermarkIneligible ? [assetWarning("Saved watermark asset is not an eligible logo. Pick a valid logo or clear it.")] : []),
    selectField("Position", "watermark.position", effects.watermark?.position ?? "bottom-right", WATERMARK_POSITION_OPTIONS),
    field("Scale (0.05 – 0.5)", "watermark.scale", String(effects.watermark?.scale ?? 0.12), "number", "", "any", "0.05", "0.5"),
    field("Opacity (0 – 1)", "watermark.opacity", String(effects.watermark?.opacity ?? 0.2), "number", "", "any", "0", "1"),
  );

  const effectsActions = document.createElement("div");
  effectsActions.className = "inspector-actions";
  effectsActions.append(
    actionButton("Save effects", () => {
      const patch = buildEffectsPatch(form, effects);
      if (!patch) return;
      saveVisualMappingEffects(segment.id, patch)
        .then(() => toast("ok", "Effects saved", `${segment.id} — approve the mapping again before rendering.`))
        .catch((error) => toast("err", "Save failed", error.message, { persist: true }));
    }, "button", "primary"),
    actionButton("Reset effects", () => {
      resetVisualMappingEffects(segment.id)
        .then(() => toast("ok", "Effects reset", `${segment.id} — approve the mapping again before rendering.`))
        .catch((error) => toast("err", "Reset failed", error.message, { persist: true }));
    }),
  );
  effectsPanel.append(effectsActions);

  // ── Tab switching ────────────────────────────────────────────────────────
  tabClip.addEventListener("click", () => {
    tabClip.classList.add("active");
    tabEffects.classList.remove("active");
    clipPanel.hidden = false;
    effectsPanel.hidden = true;
  });
  tabEffects.addEventListener("click", () => {
    tabEffects.classList.add("active");
    tabClip.classList.remove("active");
    clipPanel.hidden = true;
    effectsPanel.hidden = false;
  });

  form.append(tabBar, clipPanel, effectsPanel);
  return form;
}
```

- [ ] **Step 3: Add Inspector tab CSS to styles.css**

Append to `src/web/styles.css`:
```css
/* ── Inspector tabs ── */
.inspector-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.08));
  margin-bottom: .75rem;
}

.inspector-tab {
  flex: 1;
  padding: .5rem .5rem;
  font-size: .78rem;
  font-weight: 600;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted, #9aa4b2);
  cursor: pointer;
  transition: color 120ms, border-color 120ms;
}
.inspector-tab:hover { color: var(--text, #e6edf3); }
.inspector-tab.active {
  color: #6ca5ff;
  border-bottom-color: #6ca5ff;
}

.inspector-panel {
  padding: 0;
}
.inspector-panel > * + * { margin-top: .5rem; }

.inspector-narration {
  font-size: .78rem;
  font-style: italic;
  color: var(--text-muted, #9aa4b2);
  padding: .35rem .5rem;
  background: rgba(255,255,255,.04);
  border-radius: 4px;
  line-height: 1.45;
}

.inspector-note {
  font-size: .75rem;
  color: var(--text-muted, #9aa4b2);
  padding: .35rem .5rem;
  background: rgba(255,255,255,.04);
  border-radius: 4px;
  line-height: 1.4;
}

.inspector-actions {
  display: flex;
  gap: .4rem;
  margin-top: .65rem;
}
```

- [ ] **Step 4: Verify in browser (manual)**

- Open any project at the Render stage
- Click a clip in the timeline
- Confirm: Inspector shows "Clip" and "Effects" tabs
- Click Effects tab → see sliders for Speed, Brightness, Contrast, Saturation, Grayscale, Blur
- Move a slider → number input updates; type in number → slider moves
- Click "Save effects" → toast "Effects saved" appears
- Click "Reset effects" → toast "Effects reset" appears

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/screens/review-project.js src/web/styles.css
git commit -m "feat(ui): refactor Clip Inspector to tabbed layout with slider-based effects controls"
```

---

## Task 6: Inline render error display

When a render job fails, the error is now shown inline in the stage content area (not just a toast). A persistent toast still fires, but the stage also shows a structured error block with the error message, file path if available, and a retry button.

**Files:**
- Modify: `src/web/lib/dom.js` — add `inlineError()` helper
- Modify: `src/web/screens/review-project.js` — use `inlineError()` in the render job failure handler; add `renderRenderError()` function

**Interfaces:**
- Produces: `inlineError(title, detail, actions)` in dom.js — returns a styled error block element
- Consumed by: `review-project.js` when a render job status comes back as `failed` on the Render stage

- [ ] **Step 1: Add inlineError() to dom.js**

Append to `src/web/lib/dom.js`:
```javascript
/**
 * Builds a styled inline error block for display inside a stage panel.
 *
 * @param {string} title  Short error headline
 * @param {string} detail Full error text (monospace, pre-wrap)
 * @param {Array<{label: string, variant?: string, onClick: () => void}>} [actions]
 */
export function inlineError(title, detail, actions = []) {
  const wrapper = document.createElement("div");
  wrapper.className = "inline-error";
  wrapper.setAttribute("role", "alert");

  const head = document.createElement("div");
  head.className = "inline-error-head";

  const icon = document.createElement("div");
  icon.className = "inline-error-icon";
  icon.textContent = "✕";
  icon.setAttribute("aria-hidden", "true");

  const titleEl = document.createElement("strong");
  titleEl.className = "inline-error-title";
  titleEl.textContent = title;

  head.append(icon, titleEl);

  const pre = document.createElement("pre");
  pre.className = "inline-error-detail";
  pre.textContent = detail;

  wrapper.append(head, pre);

  if (actions.length) {
    const actRow = document.createElement("div");
    actRow.className = "inline-error-actions";
    for (const action of actions) {
      const btn = actionButton(action.label, action.onClick, "button", action.variant ?? "");
      actRow.append(btn);
    }
    wrapper.append(actRow);
  }

  return wrapper;
}
```

- [ ] **Step 2: Add CSS for inline-error in styles.css**

Append to `src/web/styles.css`:
```css
/* ── Inline render error ── */
.inline-error {
  display: grid;
  gap: .5rem;
  padding: .75rem;
  border: 1px solid rgba(248,81,73,.25);
  border-left: 4px solid #f85149;
  border-radius: 8px;
  background: rgba(248,81,73,.05);
  margin: .5rem 0;
}

.inline-error-head {
  display: flex;
  align-items: center;
  gap: .4rem;
}

.inline-error-icon {
  width: 18px; height: 18px;
  border-radius: 50%;
  background: rgba(248,81,73,.15);
  color: #f85149;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700;
  flex-shrink: 0;
}

.inline-error-title {
  font-weight: 700;
  color: #f85149;
  font-size: .85rem;
}

.inline-error-detail {
  font-family: "IBM Plex Mono", monospace;
  font-size: .72rem;
  color: var(--text-muted, #9aa4b2);
  background: rgba(0,0,0,.3);
  border-radius: 3px;
  padding: .35rem .5rem;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}

.inline-error-actions {
  display: flex;
  gap: .4rem;
}
```

- [ ] **Step 3: Add inlineError to the dom.js import in review-project.js**

Find the dom.js import and add `inlineError`:
```javascript
import { ..., inlineError } from "../lib/dom.js";
```

- [ ] **Step 4: Add a job event handler in the Render stage to show inline error**

In `review-project.js`, locate the `renderRender()` function. Inside it, after `editor` is appended (around line 874), add a job event subscription:

```javascript
// Show an inline error block if a render job fails while this stage is open.
addJobEventHandler((job) => {
  if (job.kind !== "final-render" && job.kind !== "render") return;
  if (job.status !== "failed") return;
  const existingErr = stageContent.querySelector(".inline-error");
  if (existingErr) existingErr.remove();
  const errBlock = inlineError(
    `Render failed — ${job.kind}`,
    job.error ?? "Unknown error. Check the server log.",
    [
      {
        label: "↺ Retry render",
        variant: "primary",
        onClick: () => { requestRender().catch((e) => toast("err", "Retry failed", e.message, { persist: true })); },
      },
      {
        label: "📋 Copy error",
        onClick: () => navigator.clipboard?.writeText(job.error ?? "").catch(() => {}),
      },
    ],
  );
  stageContent.prepend(errBlock);
});
```

Note: `addJobEventHandler` is already exported from `state.js`. Confirm its import is present in `review-project.js`; if not, add it.

- [ ] **Step 5: Verify in browser (manual)**

- Trigger a render job that will fail (e.g., remove a referenced asset file from disk to trigger a missing-file error)
- Confirm: persistent error toast appears AND an inline error block appears inside the stage content area
- Confirm: "Retry render" button triggers a new render
- Confirm: "Copy error" copies the error string to clipboard

- [ ] **Step 6: Run tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/lib/dom.js src/web/styles.css src/web/screens/review-project.js
git commit -m "feat(ui): add inline render error display with retry action inside Render stage"
```

---

## Self-Review

**Spec coverage:**
- ✅ R1 Render Editor → Tasks 5 (Inspector tabs) + Task 4 (sliders) + existing code (timeline already color-coded)
- ✅ R1b Effects tab → Task 5 (sliders + section titles for Motion/Transitions/Color/Watermark)
- ✅ R4 Render Failed inline → Task 6
- ✅ R5 Toast notifications → Tasks 1–3
- ⚠️ R2 Cut/Trim editor — waveform view is out of scope: the backend has no waveform data API and `renderCutControls()` already surfaces the "Render Cut" action. A full cut/trim editor with waveform requires a new server route and is a separate feature.
- ⚠️ R3 Export + Copyright screen — `export-package.ts` exists but there is no existing frontend route for it. This is a separate feature addition.

**Placeholder scan:** None — all steps have concrete code.

**Type consistency:** `sliderField` defined in Task 4 → consumed in Task 5 ✓. `inlineError` defined in Task 6 dom.js → consumed in Task 6 review-project.js ✓. `toast/startJobBar/updateJobBar/stopJobBar` defined in Task 1 → consumed in Tasks 2–6 ✓.
