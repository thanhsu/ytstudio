const appState = {
  projects: [],
  selectedProject: null,
  projectSnapshot: null,
};

const projectList = document.querySelector("#project-list");
const stageTitle = document.querySelector("#stage-title");
const stageContent = document.querySelector("#stage-content");
const status = document.querySelector("#status");
const paidVoiceDialog = document.querySelector("#paid-voice-dialog");
const confirmPaidVoice = document.querySelector("#confirm-paid-voice");

document.querySelector("#refresh-projects").addEventListener("click", () => loadProjects());
confirmPaidVoice.addEventListener("click", () => requestVoice(true));

async function loadProjects() {
  setStatus("Loading projects...");
  const response = await fetch("/api/projects");
  const data = await response.json();
  appState.projects = data.projects ?? [];
  renderProjects();
  setStatus(appState.projects.length ? "Select a project." : "No projects found. Create one from the CLI.");
}

function renderProjects() {
  projectList.replaceChildren(
    ...appState.projects.map((id) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = id;
      button.addEventListener("click", () => selectProject(id));
      item.append(button);
      return item;
    }),
  );
}

async function selectProject(projectId) {
  appState.selectedProject = projectId;
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
  appState.projectSnapshot = await response.json();
  renderStage();
  setStatus(`Loaded ${projectId}.`);
}

function renderStage() {
  const snapshot = appState.projectSnapshot;
  if (!snapshot) return;
  const brief = snapshot.brief;
  stageTitle.textContent = "Brief";
  stageContent.replaceChildren(
    paragraph(`Topic: ${brief.topic ?? "Untitled"}`),
    paragraph(`Show: ${brief.show ?? ""}`),
    paragraph(`Format: ${brief.format ?? ""}`),
    paragraph(`Audience: ${brief.audience ?? ""}`),
    actionButton("Generate Voice", () => paidVoiceDialog.showModal()),
    actionButton("Render Draft", () => requestRender()),
  );
}

async function requestVoice(confirmedPaidRequest) {
  const response = await fetch(`/api/projects/${encodeURIComponent(appState.selectedProject)}/voice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai", confirmedPaidRequest }),
  });
  const data = await response.json();
  setStatus(response.ok ? "Voice job queued." : `${data.code}: ${data.message}`);
}

async function requestRender() {
  const response = await fetch(`/api/projects/${encodeURIComponent(appState.selectedProject)}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  setStatus(response.ok ? "Render job queued." : `${data.code}: ${(data.details?.reasons ?? []).join(", ")}`);
}

function paragraph(text) {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function actionButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function setStatus(message) {
  status.textContent = message;
}

loadProjects().catch((error) => setStatus(error.message));
