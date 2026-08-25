import { JOB_LABELS } from "../lib/state.js";
import { toast, view, setBreadcrumb, setActiveNav } from "../lib/shell.js";
import { actionButton, paragraph, sectionTitle, gateNotice } from "../lib/dom.js";
import { navigate } from "../lib/router.js";

// Which artifact a finished job's "Review" button opens, per job kind. Kinds
// without an artifact fall back to opening the owning workspace.
const REVIEW_ARTIFACTS = {
  "final-render": "render",
  render: "render",
  "voiceover-render": "voiceover-track",
  voice: "voice",
  captions: "captions",
  asr: "source-subtitles",
  "youtube-metadata": "youtube-metadata",
  "reup-wizard": "render",
};

const STATUS_PILLS = {
  running: "status-pill-progress",
  succeeded: "status-pill-done",
  failed: "status-pill-block",
  cancelled: "status-pill-neutral",
};

let pollTimer = null;
let rowsHost = null;

export async function mountJobs() {
  setActiveNav("jobs");
  setBreadcrumb([{ label: "Jobs" }]);
  const screen = document.createElement("section");
  screen.className = "jobs-screen";
  screen.append(
    sectionTitle("Background jobs"),
    paragraph("Renders, imports and generations running on the studio. The list refreshes every 3 seconds; finished jobs offer their result for review."),
  );
  rowsHost = document.createElement("div");
  rowsHost.className = "jobs-rows";
  screen.append(rowsHost);
  view.replaceChildren(screen);

  await refreshJobs();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // The interval outlives navigation; stop polling once the user has left.
    if (!location.hash.startsWith("#/jobs")) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    refreshJobs().catch(() => {});
  }, 3000);
}

async function refreshJobs() {
  const response = await fetch("/api/jobs");
  const data = await response.json();
  if (!rowsHost) return;
  renderJobRows(data.jobs ?? []);
}

function renderJobRows(jobs) {
  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.append(gateNotice("No jobs yet", "Start a render or an import and it will show up here.", "info"));
    rowsHost.replaceChildren(empty);
    return;
  }
  const rows = jobs.map((job) => {
    const row = document.createElement("div");
    row.className = "job-row";

    const pill = document.createElement("span");
    pill.className = `status-pill ${STATUS_PILLS[job.status] ?? "status-pill-neutral"}`;
    pill.textContent = job.status;

    const title = document.createElement("div");
    title.className = "job-title";
    const label = document.createElement("strong");
    label.textContent = JOB_LABELS[job.kind] ?? job.kind;
    const owner = document.createElement("small");
    owner.textContent = `${job.projectId} · ${new Date(job.updatedAt).toLocaleString()}`;
    title.append(label, owner);

    const progress = document.createElement("div");
    progress.className = "job-progress";
    const bar = document.createElement("div");
    bar.className = "job-progress-track";
    const fill = document.createElement("div");
    fill.className = `job-progress-fill ${job.status}`;
    fill.style.width = `${Math.max(2, job.progress)}%`;
    bar.append(fill);
    const message = document.createElement("small");
    message.textContent = job.status === "failed" ? (job.error ?? job.message) : `${job.message} (${job.progress}%)`;
    progress.append(bar, message);

    const actions = document.createElement("div");
    actions.className = "job-actions";
    actions.append(actionButton("Open", () => openJobOwner(job)));
    actions.append(actionButton("Debug", () => openJobDebug(job)));
    if (job.status === "succeeded" && REVIEW_ARTIFACTS[job.kind]) {
      actions.append(actionButton("Review result", () => reviewJob(job).catch((error) => toast("err", "Failed to open result", error.message)), "button", "primary"));
    }

    row.append(pill, title, progress, actions);
    return row;
  });
  rowsHost.replaceChildren(...rows);
}

function openJobDebug(job) {
  document.querySelector(".job-debug-drawer")?.remove();
  const drawer = document.createElement("aside");
  drawer.className = "job-debug-drawer";
  drawer.setAttribute("aria-label", "Job detail");
  const header = document.createElement("div");
  header.className = "job-debug-header";
  const title = document.createElement("h3");
  title.textContent = JOB_LABELS[job.kind] ?? job.kind;
  const close = actionButton("Close", () => drawer.remove());
  header.append(title, close);

  const meta = document.createElement("dl");
  meta.className = "job-debug-meta";
  for (const [label, value] of [
    ["Status", job.status],
    ["Owner", job.projectId],
    ["Job id", job.id],
    ["Updated", new Date(job.updatedAt).toLocaleString()],
    ["Message", job.message],
    ["Error", job.error ?? "None"],
  ]) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = String(value);
    meta.append(dt, dd);
  }

  const raw = document.createElement("pre");
  raw.className = "job-debug-json";
  raw.textContent = JSON.stringify(job, null, 2);
  const actions = document.createElement("div");
  actions.className = "job-debug-actions";
  actions.append(
    actionButton("Open owner", () => openJobOwner(job), "button", "primary"),
    actionButton("Copy JSON", async () => {
      await navigator.clipboard?.writeText(raw.textContent ?? "");
      toast("ok", "Job JSON copied");
    }),
  );
  drawer.append(header, meta, actions, raw);
  view.append(drawer);
}

// A composite owner "<channel>::<suffix>" belongs to a story channel; plain
// owners open as review projects.
function ownerChannelId(job) {
  return String(job.projectId).split("::")[0];
}

function openJobOwner(job) {
  const channel = ownerChannelId(job);
  if (String(job.kind).startsWith("story-") || job.projectId.includes("::")) {
    navigate(`#/channel/${encodeURIComponent(channel)}/overview`);
    return;
  }
  navigate(`#/project/${encodeURIComponent(channel)}/overview`);
}

async function reviewJob(job) {
  const channel = ownerChannelId(job);
  const response = await fetch(`/api/projects/${encodeURIComponent(channel)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  const artifact = data.state?.artifacts?.[REVIEW_ARTIFACTS[job.kind]];
  if (!artifact) {
    toast("warn", "Artifact not found", "The result artifact is no longer registered. Open the project instead.");
    return;
  }
  window.open(
    `/api/projects/${encodeURIComponent(channel)}/files/${encodeURIComponent(artifact.relativePath)}`,
    "_blank",
  );
}
