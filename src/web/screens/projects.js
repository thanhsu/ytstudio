import { appState, refreshAppData } from "../lib/state.js";
import { fetchJsonOrNull, storyApiUrl } from "../lib/api.js";
import { setStatus, view, setBreadcrumb, setActiveNav } from "../lib/shell.js";
import { actionButton, field, selectField, textareaField, formValues, gateNotice } from "../lib/dom.js";
import { navigate } from "../lib/router.js";
import { renderCreateProjectForm } from "./review-project.js";
import { renderCreateSeriesForm } from "./series.js";

const TYPE_FILTERS = [
  ["", "All"],
  ["review", "Review projects"],
  ["series", "Series"],
  ["channel", "Story channels"],
];

const screenState = { typeFilter: "", search: "", storyChannelIds: new Set(), creating: null, editing: null };

// The live `.projects-rows` element. Filtering repaints only this list, so the
// focused search box is never torn out of the DOM between keystrokes.
let rowsList = null;

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

// A series' episodes each carry their own auto-created review project. Those
// stay reachable via the series workspace, not as a top-level Review row.
function seriesEpisodeProjectIds() {
  return new Set(appState.series.flatMap((series) => series.episodes.map((episode) => episode.episodeProjectId)));
}

/**
 * One row per openable workspace. GET /api/projects answers with ids only, so a
 * review row carries its id; a series row adds its workflow type. There is no
 * status column: reading a status per project would cost one request per row.
 */
function rows() {
  const items = [];
  const hiddenEpisodeProjects = seriesEpisodeProjectIds();
  const briefs = Object.fromEntries((appState.projectBriefs ?? []).map((brief) => [brief.id, brief]));
  for (const projectId of appState.projects) {
    if (hiddenEpisodeProjects.has(projectId)) continue;
    const brief = briefs[projectId];
    items.push({
      type: "review",
      id: projectId,
      title: brief?.topic?.trim() || projectId,
      subtitle: brief?.show?.trim() ? `${projectId} · ${brief.show}` : undefined,
      brief,
      hash: `#/project/${encodeURIComponent(projectId)}/overview`,
    });
  }
  for (const series of appState.series) {
    items.push({ type: "series", id: series.id, title: series.title || series.id, subtitle: `${series.id} · ${series.workflowType}`, series, hash: `#/series/${encodeURIComponent(series.id)}/overview` });
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
    renderProjectRows();
  });
  const searchField = field("Search", "search", screenState.search, "search", "Filter by name or id");
  searchField.querySelector("input").addEventListener("input", (event) => {
    screenState.search = event.target.value;
    renderProjectRows();
  });
  toolbar.append(
    filterField,
    searchField,
    actionButton("New Review Project", () => toggleCreate("review")),
    actionButton("New Series", () => toggleCreate("series")),
    actionButton("New Story Channel", () => toggleCreate("channel")),
  );

  rowsList = document.createElement("ul");
  rowsList.className = "projects-rows";
  renderProjectRows();

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

  screen.append(toolbar, createHost, rowsList);
  view.replaceChildren(screen);
}

// Repaints the row list in place. The toolbar (and with it the focused search
// input and the type select) is left alone, so filtering never interrupts typing.
function renderProjectRows() {
  if (!rowsList) return;
  const visible = rows();
  const items = visible.map((row) => {
    const item = document.createElement("li");
    item.className = `projects-row type-${row.type}`;
    const badge = document.createElement("span");
    badge.className = `type-badge type-${row.type}`;
    badge.textContent = TYPE_BADGES[row.type];
    const title = document.createElement("strong");
    title.textContent = row.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = row.subtitle ?? row.id;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(actionButton("Open", () => navigate(row.hash)));
    // A channel row shares its id with its series row, which owns edit/delete.
    if (row.type !== "channel") {
      actions.append(
        actionButton("Edit", () => toggleEdit(row)),
        actionButton("Delete", () => deleteRow(row).catch((error) => setStatus(error.message))),
      );
    }
    item.append(badge, title, subtitle, actions);
    if (screenState.editing && screenState.editing.type === row.type && screenState.editing.id === row.id) {
      item.append(renderEditForm(row));
    }
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.append(gateNotice("Nothing here yet", "Create a project to start.", "info"));
    items.push(empty);
  }
  rowsList.replaceChildren(...items);
}

function toggleCreate(kind) {
  screenState.creating = screenState.creating === kind ? null : kind;
  renderProjectsScreen();
}

function toggleEdit(row) {
  const isOpen = screenState.editing && screenState.editing.type === row.type && screenState.editing.id === row.id;
  screenState.editing = isOpen ? null : { type: row.type, id: row.id };
  renderProjectRows();
}

function renderEditForm(row) {
  const form = document.createElement("form");
  form.className = "row-edit form-grid";
  if (row.type === "review") {
    const brief = row.brief ?? {};
    form.append(
      field("Topic", "topic", brief.topic ?? "", "text"),
      field("Show", "show", brief.show ?? "", "text"),
      field("Audience", "audience", brief.audience ?? "", "text"),
      field("Language", "language", brief.language ?? "", "text"),
      textareaField("Notes", "notes", brief.notes ?? ""),
    );
  } else {
    const series = row.series ?? {};
    form.append(
      field("Title", "title", series.title ?? "", "text"),
      field("Show", "show", series.show ?? "", "text"),
      field("Audience", "audience", series.audience ?? "", "text"),
      field("Language", "language", series.language ?? "", "text"),
      textareaField("Brand notes", "brandNotes", series.brandNotes ?? ""),
    );
  }
  form.append(
    actionButton("Save", null, "submit", "primary"),
    actionButton("Cancel", () => toggleEdit(row)),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveRowEdits(row, formValues(form)).catch((error) => setStatus(error.message));
  });
  return form;
}

async function saveRowEdits(row, values) {
  const url = row.type === "review"
    ? `/api/projects/${encodeURIComponent(row.id)}`
    : `/api/series/${encodeURIComponent(row.id)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  screenState.editing = null;
  setStatus(`Saved ${row.id}.`);
  await mountProjects({ screen: "projects" });
}

async function deleteRow(row) {
  const message = row.type === "series"
    ? `Delete series "${row.title}" and its ${row.series?.episodes?.length ?? 0} episode projects? This cannot be undone.`
    : `Delete project "${row.title}" (${row.id})? This cannot be undone.`;
  if (!window.confirm(message)) return;
  const url = row.type === "series"
    ? `/api/series/${encodeURIComponent(row.id)}`
    : `/api/projects/${encodeURIComponent(row.id)}`;
  const response = await fetch(url, { method: "DELETE" });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  setStatus(`Deleted ${row.id}.`);
  await mountProjects({ screen: "projects" });
}
