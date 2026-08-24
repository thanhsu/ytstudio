// Live-binding references to the workspace DOM regions the screen modules
// render into. Rebound whenever a workspace shell is (re)built.
export let projectList;
export let seriesPanel;
export let workflowTitle;
export let workflowDescription;
export let workflowSteps;
export let stageRail;
export let stageTitle;
export let stageContent;
export let audioPreview;
export let videoPreview;

export function bindWorkspaceRefs(root = document) {
  projectList = root.querySelector("#project-list");
  seriesPanel = root.querySelector("#series-panel");
  workflowTitle = root.querySelector("#workflow-title");
  workflowDescription = root.querySelector("#workflow-description");
  workflowSteps = root.querySelector("#workflow-steps");
  stageRail = root.querySelector("#stage-rail");
  stageTitle = root.querySelector("#stage-title");
  stageContent = root.querySelector("#stage-content");
  audioPreview = root.querySelector("#audio-preview");
  videoPreview = root.querySelector("#video-preview");
}
