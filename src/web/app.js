import { bindShell, setStatus, confirmPaidVoice, confirmPaidScript } from "./lib/shell.js";
import { bindWorkspaceRefs } from "./lib/refs.js";
import { appState, refreshAppData } from "./lib/state.js";
import { renderSources } from "./screens/sources.js";
import { renderConfig } from "./screens/config.js";
import { renderSeriesManager } from "./screens/series.js";
import { renderStoryFactory } from "./screens/story-factory.js";
import {
  selectProject, renderProjects, renderStageRail, bindStageRail, renderCreateProject,
  runAvailableTasks, requestVoice, requestScript,
} from "./screens/review-project.js";

bindShell();
bindWorkspaceRefs();

document.querySelector("#refresh-projects").addEventListener("click", () => loadProjects());
document.querySelector("#open-sources").addEventListener("click", () => renderSources().catch((error) => setStatus(error.message)));
document.querySelector("#open-series").addEventListener("click", () => renderSeriesManager());
document.querySelector("#open-story-factory").addEventListener("click", () => renderStoryFactory().catch((error) => setStatus(error.message)));
document.querySelector("#new-project").addEventListener("click", () => renderCreateProject());
document.querySelector("#open-config").addEventListener("click", () => renderConfig());
document.querySelector("#run-ready-tasks").addEventListener("click", () => runAvailableTasks());
confirmPaidVoice.addEventListener("click", () => requestVoice(true));
confirmPaidScript.addEventListener("click", () => requestScript(true));

bindStageRail();

async function loadProjects() {
  setStatus("Loading projects...");
  await refreshAppData();
  renderStageRail();
  renderProjects();
  if (location.hash === "#sources") {
    await renderSources();
    return;
  }
  if (location.hash === "#series") {
    renderSeriesManager();
    return;
  }
  if (location.hash === "#config") {
    renderConfig();
    return;
  }
  if (location.hash === "#story-factory") {
    await renderStoryFactory();
    return;
  }
  if (appState.projects.length && !appState.selectedProject) {
    await selectProject(appState.projects[0]);
    return;
  }
  setStatus(appState.projects.length ? "Select a project." : "Create a project to start.");
}

loadProjects().catch((error) => setStatus(error.message));
