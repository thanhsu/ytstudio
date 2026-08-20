const appState = {
  projects: [],
  selectedProject: null,
  projectSnapshot: null,
  translationPresets: null,
  config: null,
};

const projectList = document.querySelector("#project-list");
const stageTitle = document.querySelector("#stage-title");
const stageContent = document.querySelector("#stage-content");
const status = document.querySelector("#status");
const paidVoiceDialog = document.querySelector("#paid-voice-dialog");
const confirmPaidVoice = document.querySelector("#confirm-paid-voice");

document.querySelector("#refresh-projects").addEventListener("click", () => loadProjects());
document.querySelector("#open-config").addEventListener("click", () => renderConfig());
confirmPaidVoice.addEventListener("click", () => requestVoice(true));

async function loadProjects() {
  setStatus("Loading projects...");
  const [projectsResponse, presetsResponse, configResponse] = await Promise.all([
    fetch("/api/projects"),
    fetch("/api/translation-presets"),
    fetch("/api/config"),
  ]);
  const data = await projectsResponse.json();
  appState.translationPresets = await presetsResponse.json();
  appState.config = (await configResponse.json()).config;
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
    sectionTitle("Subtitle Translation"),
    paragraph("Import Chinese SRT, build a market-specific translation prompt, then validate the translated SRT before editing."),
    sectionTitle("Media / ASR"),
    paragraph("If no SRT exists, import MP4, extract mono 16k audio, then generate source.asr.srt with the configured local ASR tool."),
    codeBlock(`npm run cli -- import-media --project ${appState.selectedProject} --file <source.mp4>`),
    codeBlock(`npm run cli -- extract-audio --project ${appState.selectedProject}`),
    codeBlock(`npm run cli -- generate-asr-srt --project ${appState.selectedProject}`),
    paragraph(`ASR provider: ${appState.config?.asr?.provider ?? "disabled"}`),
    codeBlock(`npm run cli -- import-srt --project ${appState.selectedProject} --file <source.srt>`),
    codeBlock(
      `npm run cli -- build-translation-prompt --project ${appState.selectedProject} --source <workspace/subtitles/source.srt> --target vi --genre cultivation`,
    ),
    codeBlock("npm run cli -- validate-translation --source <source.srt> --translated <translated.srt>"),
    paragraph(`Targets: ${translationTargetLabels().join(", ")}`),
    paragraph(`Default voice: ${appState.config?.tts?.defaultProvider ?? "piper"}`),
    actionButton("Generate Voice", () => {
      if (appState.config?.tts?.defaultProvider === "openai") {
        paidVoiceDialog.showModal();
        return;
      }
      requestVoice(false);
    }),
    actionButton("Render Draft", () => requestRender()),
  );
}

function renderConfig() {
  const config = appState.config;
  if (!config) return;
  stageTitle.textContent = "Config";
  const form = document.createElement("form");
  form.className = "config-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveConfig(form).catch((error) => setStatus(error.message));
  });

  form.replaceChildren(
    sectionTitle("Script"),
    field("Script model", "script.model", config.script.model),
    sectionTitle("Translation"),
    selectField("Translation provider", "translation.provider", config.translation.provider, [
      ["prompt-only", "Prompt only"],
      ["openai", "OpenAI"],
      ["gemini", "Gemini"],
    ]),
    field("Translation model", "translation.model", config.translation.model),
    selectField("Default target", "translation.defaultTarget", config.translation.defaultTarget, targetOptions()),
    selectField("Default genre", "translation.defaultGenre", config.translation.defaultGenre, [
      ["cultivation", "Cultivation"],
      ["fantasy-system", "Fantasy / system"],
      ["modern-drama", "Modern drama"],
    ]),
    sectionTitle("ASR"),
    selectField("ASR provider", "asr.provider", config.asr.provider, [
      ["disabled", "Disabled"],
      ["faster-whisper", "Faster Whisper"],
      ["whisper-cpp", "whisper.cpp"],
    ]),
    field("ASR executable", "asr.executablePath", config.asr.executablePath),
    field("ASR model", "asr.model", config.asr.model),
    field("ASR model path", "asr.modelPath", config.asr.modelPath),
    field("ASR language", "asr.language", config.asr.language),
    sectionTitle("Voice"),
    selectField("Default voice provider", "tts.defaultProvider", config.tts.defaultProvider, [
      ["piper", "Piper"],
      ["vietnamese-local", "Vietnamese local"],
      ["openai", "OpenAI"],
    ]),
    field("OpenAI speech model", "tts.openai.model", config.tts.openai.model),
    field("OpenAI voice", "tts.openai.voice", config.tts.openai.voice),
    field("OpenAI API key env", "tts.openai.apiKeyEnv", config.tts.openai.apiKeyEnv),
    field("Piper executable", "tts.piper.executablePath", config.tts.piper.executablePath),
    field("Piper model path", "tts.piper.modelPath", config.tts.piper.modelPath),
    field("Piper voice label", "tts.piper.voice", config.tts.piper.voice),
    field("Vietnamese Python path", "tts.vietnameseLocal.pythonPath", config.tts.vietnameseLocal.pythonPath),
    field("Vietnamese app path", "tts.vietnameseLocal.appPath", config.tts.vietnameseLocal.appPath),
    field("Vietnamese voice", "tts.vietnameseLocal.voice", config.tts.vietnameseLocal.voice),
    sectionTitle("Render"),
    field("FFmpeg path", "render.ffmpegPath", config.render.ffmpegPath),
    field("FFprobe path", "render.ffprobePath", config.render.ffprobePath),
    field("Shorts width", "render.shortsWidth", String(config.render.shortsWidth), "number"),
    field("Shorts height", "render.shortsHeight", String(config.render.shortsHeight), "number"),
    actionButton("Save Config", null, "submit"),
  );
  stageContent.replaceChildren(form);
  setStatus("Config loaded. Secrets stay in environment variables, not in this file.");
}

async function saveConfig(form) {
  const nextConfig = structuredClone(appState.config);
  for (const input of Array.from(form.elements)) {
    if (!input.name) continue;
    setPathValue(nextConfig, input.name, input.type === "number" ? Number(input.value) : input.value);
  }

  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nextConfig),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${data.code}: ${data.message}`);
  }
  appState.config = data.config;
  renderConfig();
  setStatus("Config saved to studio.config.json.");
}

async function requestVoice(confirmedPaidRequest) {
  const provider = appState.config?.tts?.defaultProvider ?? "piper";
  const response = await fetch(`/api/projects/${encodeURIComponent(appState.selectedProject)}/voice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, confirmedPaidRequest }),
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

function sectionTitle(text) {
  const element = document.createElement("h3");
  element.textContent = text;
  return element;
}

function field(label, name, value, type = "text") {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value ?? "";
  if (type === "number") {
    input.min = "1";
    input.step = "1";
  }
  wrapper.append(caption, input);
  return wrapper;
}

function selectField(label, name, value, options) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const select = document.createElement("select");
  select.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    option.selected = optionValue === value;
    select.append(option);
  }
  wrapper.append(caption, select);
  return wrapper;
}

function codeBlock(text) {
  const element = document.createElement("pre");
  element.textContent = text;
  return element;
}

function translationTargetLabels() {
  return (appState.translationPresets?.presets ?? []).map((preset) => preset.label);
}

function targetOptions() {
  return (appState.translationPresets?.presets ?? []).map((preset) => [preset.target, preset.label]);
}

function actionButton(text, onClick, type = "button") {
  const button = document.createElement("button");
  button.type = type;
  button.textContent = text;
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function setPathValue(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function setStatus(message) {
  status.textContent = message;
}

loadProjects().catch((error) => setStatus(error.message));
