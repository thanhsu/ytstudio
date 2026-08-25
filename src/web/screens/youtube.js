import { appState, refreshAppData } from "../lib/state.js";
import { actionButton, field, gateNotice, readinessPill, selectField, textareaField } from "../lib/dom.js";
import { setActiveNav, setBreadcrumb, setStatus, toast, view } from "../lib/shell.js";

const INTERNAL_NAV = [
  ["overview", "Overview"],
  ["videos", "Videos"],
  ["queue", "Publish Queue"],
  ["calendar", "Calendar"],
  ["analytics", "Analytics"],
  ["settings", "Settings"],
];
const PRIVACY_OPTIONS = [["public", "Public"], ["private", "Private"], ["unlisted", "Unlisted"]];
const SOURCE_KIND_OPTIONS = [["story", "Story"], ["review", "Review project"], ["compilation", "Compilation"]];
const MATRIX_LEVELS = { current: "done", stale: "warn", missing: "block", "not-required": "neutral" };
const screenState = { activeYouTubeJob: null, videos: [], nextPageToken: null, loading: false, analyticsLoading: false, analyticsError: null, analytics: [], calendar: null };

const api = (seriesId, route) => `/api/series/${encodeURIComponent(seriesId)}/youtube/${route}`;

export async function mountYouTube(route) {
  if (!appState.config) await refreshAppData();
  const series = appState.series.find((candidate) => candidate.id === route.id) ?? appState.series[0];
  if (!series) throw new Error("Create a series before opening YouTube.");
  const activeView = INTERNAL_NAV.some(([id]) => id === route.view) ? route.view : "overview";
  setActiveNav("youtube");
  setBreadcrumb([{ label: "YouTube" }, { label: series.title || series.id }]);
  screenState.loading = true;
  view.replaceChildren(renderShell(series, activeView));
  try {
    const data = await loadDashboard(series.id);
    screenState.loading = false;
    view.replaceChildren(renderShell(series, activeView, data));
    subscribeToPublishProgress(series.id);
    toast("info", `${series.title || series.id}: YouTube ${activeView}`);
  } catch (error) {
    screenState.loading = false;
    view.replaceChildren(renderShell(series, activeView, { error: error instanceof Error ? error.message : "Unable to load YouTube." }));
    toast("err", "Unable to load YouTube", error instanceof Error ? error.message : "");
  }
}

async function loadDashboard(seriesId) {
  const responses = await Promise.all([
    fetch(api(seriesId, "status")),
    fetch(api(seriesId, "channel")),
    fetch(api(seriesId, "videos")),
    fetch(api(seriesId, "publish")),
    fetch(api(seriesId, "analytics")),
    fetch(`/api/series/${encodeURIComponent(seriesId)}/calendar`).catch(() => null),
  ]);
  const values = await Promise.all(responses.map(async (response) => {
    if (!response) return {};
    const data = await response.json();
    if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
    return data;
  }));
  screenState.videos = values[2].videos ?? [];
  screenState.nextPageToken = values[2].nextPageToken ?? null;
  screenState.analytics = values[4].analytics ?? [];
  const calendarData = values[5] ?? {};
  screenState.calendar = (calendarData.calendar?.entries ?? []).find((entry) => entry.plannedPublishAt) ?? null;
  return { status: values[0], channel: values[1].channel, videos: screenState.videos, jobs: values[3].jobs ?? [], analytics: screenState.analytics, calendar: screenState.calendar };
}

function renderShell(series, activeView, data = {}) {
  const root = document.createElement("div");
  root.className = "youtube-screen";
  const heading = document.createElement("div");
  heading.className = "youtube-header";
  const title = document.createElement("div");
  const h2 = document.createElement("h2"); h2.textContent = data.channel?.title || "YouTube operations";
  const status = document.createElement("p"); status.className = "youtube-status";
  status.textContent = data.status?.connected ? "Connected" : "Not connected";
  title.append(h2, status);
  const switcher = document.createElement("label"); switcher.className = "field youtube-channel-switcher";
  const switchLabel = document.createElement("span"); switchLabel.textContent = "Channel";
  const select = document.createElement("select"); select.setAttribute("aria-label", "YouTube channel");
  for (const candidate of appState.series) { const option = document.createElement("option"); option.value = candidate.id; option.textContent = candidate.title || candidate.id; option.selected = candidate.id === series.id; select.append(option); }
  select.addEventListener("change", () => { window.location.hash = `#/youtube/${encodeURIComponent(select.value)}/overview`; });
  switcher.append(switchLabel, select);
  const publishButton = actionButton("Publish video", () => openPublish(series, data), "button", "primary");
  publishButton.disabled = screenState.loading;
  publishButton.setAttribute("aria-disabled", String(screenState.loading));
  heading.append(title, switcher, publishButton);
  const layout = document.createElement("div"); layout.className = "youtube-layout";
  layout.append(renderInternalNav(series.id, activeView), renderView(series, activeView, data));
  root.append(heading, layout);
  if (screenState.activeYouTubeJob) root.append(renderJobProgress(screenState.activeYouTubeJob));
  return root;
}

function renderInternalNav(seriesId, activeView) {
  const nav = document.createElement("nav"); nav.className = "youtube-sidebar"; nav.setAttribute("aria-label", "YouTube");
  for (const [id, label] of INTERNAL_NAV) {
    const button = actionButton(label, () => { window.location.hash = `#/youtube/${encodeURIComponent(seriesId)}/${id}`; }, "button");
    button.classList.toggle("selected", id === activeView); button.setAttribute("aria-current", id === activeView ? "page" : "false"); nav.append(button);
  }
  return nav;
}

function renderView(series, activeView, data) {
  if (data.error) return connectionError(data.error, series.id);
  if (activeView === "videos") return renderVideos(series, data.videos ?? []);
  if (activeView === "queue") return renderQueue(data.jobs ?? []);
  if (activeView === "calendar") return renderCalendar(series.id);
  if (activeView === "analytics") return renderAnalytics(series.id, data.analytics ?? []);
  if (activeView === "settings") return emptyPanel("Settings", "Manage this series’ YouTube connection and permissions.");
  return renderOverview(series, data);
}

function renderAnalytics(seriesId, analytics) {
  const panel = document.createElement("section"); panel.className = "youtube-panel";
  const heading = document.createElement("h3"); heading.textContent = "Analytics"; panel.append(heading);
  const note = document.createElement("p"); note.textContent = "Cached analytics — refresh manually when you want current counts."; panel.append(note);
  const refresh = actionButton(screenState.analyticsLoading ? "Loading analytics" : "Refresh analytics", () => refreshAnalytics(seriesId, refresh), "button", "primary"); refresh.disabled = screenState.analyticsLoading; panel.append(refresh);
  if (screenState.analyticsError) { const error = document.createElement("p"); error.setAttribute("role", "alert"); error.textContent = `Analytics refresh failed: ${screenState.analyticsError}`; panel.append(error); }
  const list = document.createElement("ul");
  for (const item of analytics) { const row = document.createElement("li"); const snapshot = item.snapshot; row.textContent = `${item.videoId}: ${snapshot ? `${snapshot.views} views, ${snapshot.likes} likes, ${snapshot.comments} comments (cached ${snapshot.fetchedAt})` : "No cached snapshot"}`; list.append(row); }
  panel.append(list); return panel;
}

async function refreshAnalytics(seriesId, button) {
  screenState.analyticsLoading = true; screenState.analyticsError = null; button.disabled = true; button.textContent = "Loading analytics";
  try {
    const response = await fetch(api(seriesId, "analytics/refresh"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const data = await response.json(); if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
    const cached = await fetch(api(seriesId, "analytics")); const cachedData = await cached.json(); if (!cached.ok) throw new Error(`${cachedData.code}: ${cachedData.message}`);
    screenState.analytics = cachedData.analytics ?? []; setStatus("YouTube analytics refreshed.");
  } catch (error) { screenState.analyticsError = error instanceof Error ? error.message : "Unable to refresh analytics."; setStatus(screenState.analyticsError); }
  finally { screenState.analyticsLoading = false; button.disabled = false; button.textContent = "Refresh analytics"; }
}

function renderOverview(series, data) {
  const panel = document.createElement("section"); panel.className = "youtube-panel";
  const heading = document.createElement("h3"); heading.textContent = "Channel overview";
  const counts = document.createElement("div"); counts.className = "youtube-counts";
  for (const [label, value] of [["Published videos", data.videos?.length ?? 0], ["Queued jobs", (data.jobs ?? []).filter((job) => ["queued", "uploading", "thumbnail-uploading"].includes(job.status)).length], ["Failed jobs", (data.jobs ?? []).filter((job) => job.status === "failed").length]]) {
    const card = document.createElement("div");
    card.className = "youtube-count";
    const term = document.createElement("span"); term.textContent = label;
    const number = document.createElement("strong"); number.textContent = String(value);
    card.append(term, number);
    counts.append(card);
  }
  const note = document.createElement("p"); note.textContent = data.status?.connected ? `Connected channel: ${data.channel?.id ?? "Unknown"}` : "Connect a YouTube channel to manage videos and publish approved exports.";
  panel.append(heading, counts, note);
  return panel;
}

function connectionError(message, seriesId) {
  const panel = emptyPanel("YouTube connection", message);
  panel.append(actionButton("Reconnect", () => connect(seriesId), "button", "primary"), actionButton("Review permissions", () => setStatus("Review the YouTube OAuth permissions before reconnecting.")));
  return panel;
}

function renderVideos(series, videos) {
  const panel = document.createElement("section"); panel.className = "youtube-panel";
  const heading = document.createElement("h3"); heading.textContent = "Video library"; panel.append(heading);
  if (videos.length === 0) { const empty = document.createElement("p"); empty.textContent = "No videos found on this YouTube channel yet"; panel.append(empty); return panel; }
  const tableWrap = document.createElement("div"); tableWrap.className = "youtube-video-table-wrap";
  const table = document.createElement("table"); table.className = "youtube-video-table";
  const headers = ["Thumbnail", "Title", "Privacy", "Publish date", "Views", "Likes", "Comments", "Source project", "YouTube URL", "Last refresh", "Actions"];
  const thead = document.createElement("thead"); const headRow = document.createElement("tr"); for (const label of headers) { const th = document.createElement("th"); th.scope = "col"; th.textContent = label; headRow.append(th); } thead.append(headRow);
  const body = document.createElement("tbody");
  for (const video of videos) body.append(renderVideoRow(series.id, video));
  table.append(thead, body); tableWrap.append(table); panel.append(tableWrap);
  const pager = document.createElement("div"); pager.className = "youtube-pager";
  if (screenState.nextPageToken) pager.append(actionButton("Next page", () => loadNextVideos(series.id), "button"));
  panel.append(pager); return panel;
}

function renderVideoRow(seriesId, video) {
  const row = document.createElement("tr");
  const imageCell = document.createElement("td"); const image = document.createElement("img"); image.src = video.thumbnailUrl || ""; image.alt = `Thumbnail for ${video.title || "video"}`; image.loading = "lazy"; image.className = "youtube-thumbnail"; imageCell.append(image);
  const values = [video.title || "Untitled", video.privacyStatus || "private", video.publishedAt || "Not published", video.views ?? 0, video.likes ?? 0, video.comments ?? 0, video.sourceProject || "No source project", video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : "", video.fetchedAt || "Not refreshed"];
  row.append(imageCell); for (const value of values) { const cell = document.createElement("td"); if (String(value).startsWith("https://")) { const link = document.createElement("a"); link.href = value; link.textContent = value; link.target = "_blank"; cell.append(link); } else cell.textContent = String(value); row.append(cell); }
  const actions = document.createElement("td"); actions.append(actionButton("Edit", () => openEdit(seriesId, video)), actionButton("Delete", () => openDelete(seriesId, video), "button", "danger")); row.append(actions); return row;
}

async function loadNextVideos(seriesId) { const response = await fetch(`${api(seriesId, "videos")}?pageToken=${encodeURIComponent(screenState.nextPageToken)}`); const data = await response.json(); screenState.videos = data.videos ?? []; screenState.nextPageToken = data.nextPageToken ?? null; setStatus("Loaded next YouTube video page."); }

function renderQueue(jobs) {
  const panel = emptyPanel("Publish Queue", jobs.length ? "Recent and active publish jobs" : "No publish jobs yet.");
  for (const job of jobs) {
    const item = document.createElement("article");
    item.className = "youtube-job";
    const title = document.createElement("strong");
    title.textContent = `${job.sourceKind}:${job.sourceId}`;
    const status = readinessPill(job.status === "completed" ? "done" : job.status === "failed" ? "block" : "progress", job.status);
    const progress = document.createElement("div");
    progress.className = "youtube-publish-progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, Math.min(100, Number(job.progress) || 0))}%`;
    progress.append(fill);
    const detail = document.createElement("small");
    detail.textContent = job.error?.message ?? `${job.progress}%`;
    item.append(title, status, progress, detail);
    panel.append(item);
  }
  return panel;
}
function renderCalendar(seriesId) { const panel = emptyPanel("Calendar", "Planned publish times are used to pre-fill the publish wizard."); panel.append(actionButton("Open publish wizard", () => openPublish({ id: seriesId }, {}), "button", "primary")); return panel; }
function emptyPanel(title, message) { const panel = document.createElement("section"); panel.className = "youtube-panel"; const heading = document.createElement("h3"); heading.textContent = title; const body = document.createElement("p"); body.textContent = message; panel.append(heading, body); return panel; }

function openEdit(seriesId, video) { const panel = document.createElement("section"); panel.className = "youtube-detail-drawer"; panel.setAttribute("aria-label", "Edit YouTube video"); panel.append(document.createElement("h3")); panel.lastChild.textContent = "Edit video"; const form = document.createElement("form"); form.append(field("Title", "title", video.title), textareaField("Description", "description", video.description), field("Tags", "tags", (video.tags ?? []).join(", ")), selectField("Privacy", "privacyStatus", video.privacyStatus, PRIVACY_OPTIONS), field("Thumbnail path", "thumbnailPath", ""), actionButton("Save video", async () => { await patchVideo(seriesId, video.videoId, form); }, "button", "primary")); panel.append(form); view.append(panel); }
async function patchVideo(seriesId, videoId, form) { const values = Object.fromEntries(Array.from(form.elements).filter((element) => element.name).map((element) => [element.name, element.value])); values.tags = String(values.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean); const response = await fetch(api(seriesId, `videos/${encodeURIComponent(videoId)}`), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) throw new Error("Unable to update YouTube video metadata."); setStatus("YouTube video updated."); }
function openDelete(seriesId, video) { const panel = document.createElement("section"); panel.className = "youtube-detail-drawer"; const heading = document.createElement("h3"); heading.textContent = "Delete remote video"; const confirmation = field("Type DELETE to confirm", "confirmation", ""); const button = actionButton("Delete remote video", async () => { if (confirmation.querySelector("input").value !== "DELETE") { setStatus("Type DELETE before deleting the remote video."); return; } const response = await fetch(api(seriesId, `videos/${encodeURIComponent(video.videoId)}`), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }); if (!response.ok) setStatus("The server rejected the delete request."); else setStatus("Remote video deleted; local export retained."); }, "button", "danger"); panel.append(heading, confirmation, button); view.append(panel); }

function openPublish(series, data) {
  const panel = document.createElement("section");
  panel.className = "youtube-publish-wizard";
  panel.setAttribute("aria-label", "Publish approved export");
  const heading = document.createElement("h3");
  heading.textContent = "Publish approved export";
  const steps = document.createElement("ol");
  steps.className = "youtube-publish-steps";
  for (const label of ["1. Pick source", "2. Check readiness", "3. Publish or schedule"]) {
    const li = document.createElement("li"); li.textContent = label; steps.append(li);
  }
  const form = document.createElement("form");
  form.className = "youtube-publish-form form-grid";
  const readinessHost = document.createElement("div");
  readinessHost.className = "youtube-readiness-host field-wide";
  readinessHost.append(gateNotice("Readiness not checked", "Choose a source, then run Check readiness to load approvals, export paths, thumbnail, and metadata before upload.", "warn"));
  const submit = actionButton("Confirm publish", () => submitPublish(series.id, form, submit), "button", "primary");
  const check = actionButton("Check readiness", () => checkPublishReadiness(series.id, form, readinessHost), "button");
  form.append(
    selectField("Source kind", "sourceKind", "story", SOURCE_KIND_OPTIONS),
    field("Source id", "sourceId", ""),
    readinessHost,
    field("Export path", "exportPath", ""),
    field("Thumbnail path", "thumbnailPath", ""),
    field("Title", "title", data.metadata?.title || ""),
    textareaField("Description", "description", data.metadata?.description || ""),
    field("Tags", "tags", (data.metadata?.tags || []).join(", ")),
    selectField("Visibility", "privacyStatus", "private", PRIVACY_OPTIONS),
    field("Planned publish time", "publishAt", screenState.calendar?.plannedPublishAt || "", "datetime-local"),
  );
  const schedule = document.createElement("p");
  schedule.className = "youtube-schedule-summary";
  schedule.textContent = `Channel: ${data.channel?.title || data.channel?.id || "selected channel"}. ${scheduleSummary(screenState.calendar?.plannedPublishAt)}`;
  const actions = document.createElement("div");
  actions.className = "youtube-publish-actions field-wide";
  actions.append(check, submit);
  form.append(schedule, actions);
  panel.append(heading, steps, form);
  view.append(panel);
}

async function checkPublishReadiness(seriesId, form, host) {
  const values = Object.fromEntries(Array.from(form.elements).filter((element) => element.name).map((element) => [element.name, element.value]));
  if (!values.sourceId) {
    host.replaceChildren(gateNotice("Source required", "Enter the story, review project, or compilation id before checking readiness.", "block"));
    return;
  }
  host.replaceChildren(gateNotice("Checking readiness", "Reading approvals, export package, thumbnail, and metadata.", "info"));
  try {
    const response = await fetch(`${api(seriesId, "publish/readiness")}?sourceKind=${encodeURIComponent(values.sourceKind)}&sourceId=${encodeURIComponent(values.sourceId)}`);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(`${data.code}: ${data.message}`), { details: data.details });
    applyReadinessToForm(form, data.readiness);
    host.replaceChildren(renderReadinessPanel(data.readiness));
    toast("ok", "Publish readiness passed", "Export, metadata, thumbnail, and approvals are loaded.");
  } catch (error) {
    const matrix = error.details?.matrix;
    host.replaceChildren(renderReadinessPanel({ ready: false, matrix: matrix ?? {}, exportPath: null, thumbnailPath: null, metadata: null }, error.message));
    toast("err", "Publish readiness failed", error.message);
  }
}

function applyReadinessToForm(form, readiness) {
  const set = (name, value) => { const input = form.elements.namedItem(name); if (input && value) input.value = value; };
  set("exportPath", readiness.exportPath);
  set("thumbnailPath", readiness.thumbnailPath);
  set("title", readiness.metadata?.title);
  set("description", readiness.metadata?.description);
  set("tags", readiness.metadata?.tags?.join(", "));
}

function renderReadinessPanel(readiness, error = "") {
  const panel = document.createElement("div");
  panel.className = `youtube-readiness-panel ${readiness.ready ? "ready" : "blocked"}`;
  const title = document.createElement("strong");
  title.textContent = readiness.ready ? "Ready to publish" : "Publish blocked";
  panel.append(title);
  if (error) panel.append(gateNotice("Fix before publishing", error, "block"));
  const matrix = document.createElement("div");
  matrix.className = "youtube-readiness-matrix";
  for (const [key, value] of Object.entries(readiness.matrix ?? {})) {
    const item = document.createElement("span");
    item.className = "youtube-readiness-item";
    item.append(readinessPill(MATRIX_LEVELS[value] ?? "neutral", value), document.createTextNode(key));
    matrix.append(item);
  }
  if (!matrix.childNodes.length) matrix.append(gateNotice("No matrix returned", "The source could not be read yet.", "warn"));
  const artifacts = document.createElement("dl");
  artifacts.className = "youtube-artifact-summary";
  for (const [label, value] of [["Export", readiness.exportPath ?? "missing"], ["Thumbnail", readiness.thumbnailPath ?? "missing"], ["Title", readiness.metadata?.title ?? "missing"]]) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    artifacts.append(dt, dd);
  }
  panel.append(matrix, artifacts);
  return panel;
}
function scheduleSummary(value) { if (!value) return "No schedule selected."; const date = new Date(value); if (!Number.isFinite(date.getTime())) return "Schedule time needs review."; return `Local: ${date.toLocaleString()} — UTC: ${date.toISOString()}`; }
const explicitConfirmation = "Explicit confirmation is required before publishing.";
async function submitPublish(seriesId, form, button) { const values = Object.fromEntries(Array.from(form.elements).filter((element) => element.name).map((element) => [element.name, element.value])); if (!values.sourceId || !values.title || !values.exportPath) { setStatus("Source, title, and export are required before publishing."); return; } button.disabled = true; try { const response = await fetch(api(seriesId, "publish"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, tags: String(values.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean), publishAt: values.publishAt || undefined }) }); if (response.status !== 202) throw new Error("YouTube publish was not queued."); const data = await response.json(); screenState.activeYouTubeJob = data.job; setStatus("YouTube publish queued."); } catch (error) { setStatus(error instanceof Error ? error.message : "YouTube publish failed."); } finally { button.disabled = false; } }

async function connect(seriesId) { const response = await fetch(api(seriesId, "connect"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); const data = await response.json(); if (data.authUrl) window.location.href = data.authUrl; }
function subscribeToPublishProgress(seriesId) { if (typeof EventSource === "undefined") return; const source = new EventSource(`/api/projects/${encodeURIComponent(seriesId)}/events`); source.addEventListener("job", (event) => { const job = JSON.parse(event.data); if (job.kind === "youtube-publish") { screenState.activeYouTubeJob = job; setStatus(`YouTube publish: ${job.message || job.status} (${job.progress ?? 0}%).`); } }); }
function renderJobProgress(job) { const progress = document.createElement("p"); progress.className = "youtube-job-progress"; progress.setAttribute("aria-live", "polite"); progress.textContent = `Publish progress: ${job.status} (${job.progress ?? 0}%)`; return progress; }

export { renderVideoRow, renderVideos, submitPublish };
