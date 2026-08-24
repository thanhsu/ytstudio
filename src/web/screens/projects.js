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

/**
 * One row per openable workspace. GET /api/projects answers with ids only, so a
 * review row carries its id; a series row adds its workflow type. There is no
 * status column: reading a status per project would cost one request per row.
 */
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
