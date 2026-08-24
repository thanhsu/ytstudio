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
