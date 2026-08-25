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
