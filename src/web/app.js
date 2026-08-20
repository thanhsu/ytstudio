const STAGES = [
  "brief",
  "script",
  "media",
  "asr",
  "subtitles",
  "translation",
  "voice",
  "captions",
  "assets",
  "copyright",
  "render",
  "export",
];

const STAGE_TITLES = {
  brief: "Brief",
  script: "Script",
  media: "Media",
  asr: "ASR/OCR",
  subtitles: "Subtitles",
  translation: "Translation",
  voice: "Voice",
  captions: "Captions",
  assets: "Assets",
  copyright: "Copyright Check",
  render: "Render",
  export: "Export",
  config: "Config",
};

const appState = {
  projects: [],
  selectedProject: null,
  activeStage: "brief",
  projectSnapshot: null,
  translationPresets: null,
  config: null,
};

const projectList = document.querySelector("#project-list");
const stageRail = document.querySelector("#stage-rail");
const stageTitle = document.querySelector("#stage-title");
const stageContent = document.querySelector("#stage-content");
const status = document.querySelector("#status");
const paidVoiceDialog = document.querySelector("#paid-voice-dialog");
const confirmPaidVoice = document.querySelector("#confirm-paid-voice");
const audioPreview = document.querySelector("#audio-preview");
const videoPreview = document.querySelector("#video-preview");

document.querySelector("#refresh-projects").addEventListener("click", () => loadProjects());
document.querySelector("#new-project").addEventListener("click", () => renderCreateProject());
document.querySelector("#open-config").addEventListener("click", () => renderConfig());
confirmPaidVoice.addEventListener("click", () => requestVoice(true));

for (const button of stageRail.querySelectorAll("[data-stage]")) {
  button.addEventListener("click", () => {
    appState.activeStage = button.dataset.stage;
    renderStage();
  });
}

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
  if (appState.projects.length && !appState.selectedProject) {
    await selectProject(appState.projects[0]);
    return;
  }
  setStatus(appState.projects.length ? "Select a project." : "Create a project to start.");
}

function renderProjects() {
  projectList.replaceChildren(
    ...appState.projects.map((id) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = id;
      button.className = id === appState.selectedProject ? "selected" : "";
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
  renderProjects();
  renderStage();
  setStatus(`Loaded ${projectId}.`);
}

function renderStage() {
  setActiveStageButton();
  const snapshot = appState.projectSnapshot;
  if (!snapshot) {
    renderCreateProject();
    return;
  }

  const stage = appState.activeStage;
  stageTitle.textContent = STAGE_TITLES[stage] ?? "Brief";
  const renderer = {
    brief: renderBrief,
    script: renderScript,
    media: renderMedia,
    asr: renderAsr,
    subtitles: renderSubtitles,
    translation: renderTranslation,
    voice: renderVoice,
    captions: renderCaptions,
    assets: renderAssets,
    copyright: renderCopyright,
    render: renderRender,
    export: renderExport,
  }[stage];
  renderer(snapshot);
  renderPreviews(snapshot);
}

function renderCreateProject() {
  stageTitle.textContent = "Create Project";
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    createProject(form).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Project id", "id", "", "text", "muc-than-ky-001"),
    field("Topic", "topic", "", "text", "Why this ordinary drama still hooks viewers"),
    field("Show / film", "show", "", "text", "Chinese short drama"),
    selectField("Format", "format", "shorts", [
      ["shorts", "Shorts"],
      ["longform", "Longform"],
    ]),
    field("Audience", "audience", "", "text", "Vietnamese review viewers"),
    field("Language", "language", "Vietnamese"),
    textareaField("Notes", "notes", ""),
    actionButton("Create Project", null, "submit", "primary"),
  );
  stageContent.replaceChildren(
    paragraph("Create the working folder and brief from the UI. No command line needed."),
    form,
  );
  setStatus("Ready to create a new project.");
}

async function createProject(form) {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(formValues(form)),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  await loadProjects();
  await selectProject(data.brief.id);
  setStatus(`Created ${data.brief.id}.`);
}

function renderBrief(snapshot) {
  const brief = snapshot.brief;
  stageContent.replaceChildren(
    summaryGrid({
      Topic: brief.topic ?? "Untitled",
      Show: brief.show ?? "",
      Format: brief.format ?? "",
      Audience: brief.audience ?? "",
      Language: brief.language ?? "",
      Notes: brief.notes ?? "",
    }),
    sectionTitle("Next"),
    paragraph("Move to Media if you have a video source, or Subtitles if you already have SRT."),
  );
}

function renderScript(snapshot) {
  stageContent.replaceChildren(
    paragraph("Generate or refresh the review script and metadata from the current brief."),
    actionButton("Generate Script", () => postProjectAction("script", {}, "Script generated."), "button", "primary"),
    summaryGrid({
      Topic: snapshot.brief.topic ?? "",
      Model: appState.config?.script?.model ?? "local-template",
      Output: "script.md, metadata.json, scene-plan.json",
    }),
  );
}

function renderMedia(snapshot) {
  stageContent.replaceChildren(
    paragraph("Import the source video and extract ASR-ready audio."),
    uploadField("Import Media", "media-file", "video/*,.mkv,.mov,.mp4,.webm", () => uploadProjectFile("media-file", "media")),
    actionButton("Extract Audio", () => postProjectAction("media/audio", {}, "Audio extracted."), "button", "primary"),
    sectionTitle("Status"),
    artifactList(snapshot.state?.artifacts ?? {}, ["media", "audio"]),
  );
}

function renderAsr(snapshot) {
  stageContent.replaceChildren(
    paragraph("Generate source subtitles from extracted audio. OCR for hard-sub-only video is planned next."),
    paragraph(`Provider: ${appState.config?.asr?.provider ?? "disabled"}`),
    paragraph(`Language: ${appState.config?.asr?.language ?? "zh"}`),
    actionButton("Generate ASR SRT", () => postProjectAction("asr", {}, "ASR subtitles generated."), "button", "primary"),
    sectionTitle("OCR"),
    paragraph("OCR is not active yet. Use ASR for clean dialogue audio, or import SRT manually in Subtitles."),
    artifactList(snapshot.state?.artifacts ?? {}, ["audio", "source-subtitles"]),
  );
}

function renderSubtitles(snapshot) {
  stageContent.replaceChildren(
    paragraph("Upload an existing source SRT, or use the ASR output."),
    uploadField("Import Source SRT", "srt-file", ".srt", () => uploadProjectFile("srt-file", "subtitles/source")),
    sectionTitle("Current source subtitle"),
    artifactList(snapshot.state?.artifacts ?? {}, ["source-subtitles"]),
  );
}

function renderTranslation(snapshot) {
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    postProjectAction("subtitles/translation-prompt", formValues(form), "Translation prompt created.").catch((error) =>
      setStatus(error.message),
    );
  });
  form.replaceChildren(
    field("Source SRT path", "source", sourceSubtitlePath()),
    selectField("Target", "target", appState.config?.translation?.defaultTarget ?? "vi", targetOptions()),
    selectField("Genre", "genre", appState.config?.translation?.defaultGenre ?? "cultivation", [
      ["cultivation", "Cultivation"],
      ["fantasy-system", "Fantasy / system"],
      ["modern-drama", "Modern drama"],
    ]),
    actionButton("Build Translation Prompt", null, "submit", "primary"),
  );
  stageContent.replaceChildren(
    paragraph("Build the prompt for ChatGPT/Gemini while preserving cue numbers and timestamps."),
    form,
    paragraph(`Targets: ${translationTargetLabels().join(", ")}`),
  );
}

function renderVoice(snapshot) {
  stageContent.replaceChildren(
    paragraph("Generate narration with the configured voice provider."),
    summaryGrid({
      Provider: appState.config?.tts?.defaultProvider ?? "piper",
      Piper: appState.config?.tts?.piper?.voice ?? "",
      "Vietnamese local": appState.config?.tts?.vietnameseLocal?.voice ?? "",
      OpenAI: appState.config?.tts?.openai?.voice ?? "",
    }),
    actionButton("Generate Voice", () => {
      if (appState.config?.tts?.defaultProvider === "openai") {
        paidVoiceDialog.showModal();
        return;
      }
      requestVoice(false);
    }, "button", "primary"),
    artifactList(snapshot.state?.artifacts ?? {}, ["voice"]),
  );
}

function renderCaptions(snapshot) {
  stageContent.replaceChildren(
    paragraph("Create SRT captions from the narration and current voice duration."),
    actionButton("Prepare Captions", () => postProjectAction("captions", {}, "Captions prepared."), "button", "primary"),
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions"]),
  );
}

function renderAssets(snapshot) {
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    uploadAsset(form).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    selectField("Media type", "mediaType", "image", [
      ["image", "Image"],
      ["video", "Video clip"],
    ]),
    field("Usage purpose", "usagePurpose", "", "text", "Generated background for intro"),
    checkboxField("Rights confirmed", "rightsConfirmed", true),
    fileField("Asset file", "asset-file", "image/*,video/*,.webp,.png,.jpg,.jpeg,.mp4,.mov,.webm"),
    actionButton("Upload Asset", null, "submit", "primary"),
  );
  stageContent.replaceChildren(
    paragraph("Upload only assets you created, licensed, or can clearly use for review context."),
    form,
    actionButton("Approve Assets", () => postProjectAction("assets/approve", {}, "Assets approved.")),
    artifactList(snapshot.state?.artifacts ?? {}, ["media", "render"]),
  );
}

function renderCopyright(snapshot) {
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    postProjectAction("copyright-check", boolFormValues(form), "Copyright Check saved.").catch((error) =>
      setStatus(error.message),
    );
  });
  form.replaceChildren(
    field("Commentary percent", "commentaryPercent", "70", "number"),
    field("Footage percent", "footagePercent", "15", "number"),
    field("Longest clip seconds", "longestClipSeconds", "5", "number"),
    checkboxField("Uses full scene", "usesFullScene", false),
    checkboxField("Thumbnail from source frame", "thumbnailFromCopyrightFrame", false),
    checkboxField("Clips have commentary purpose", "clipsHaveCommentaryPurpose", true),
    actionButton("Run Copyright Check", null, "submit", "primary"),
  );
  stageContent.replaceChildren(
    paragraph("Declare how much source footage is used before render approval."),
    form,
    actionButton("Approve Copyright", () => postProjectAction("copyright/approve", {}, "Copyright approved.")),
  );
}

function renderRender(snapshot) {
  stageContent.replaceChildren(
    paragraph("Render the current draft after script, asset, copyright, voice, and caption gates are ready."),
    actionButton("Render Draft", () => requestRender(), "button", "primary"),
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions", "render"]),
  );
}

function renderExport(snapshot) {
  const render = snapshot.state?.artifacts?.render;
  stageContent.replaceChildren(
    paragraph("Export is the handoff screen for the generated files and upload checklist."),
    render ? linkButton("Open Render File", render.relativePath) : paragraph("No render artifact yet."),
    sectionTitle("Publish Checklist"),
    checklist(["Thumbnail ready", "Title/description reviewed", "Copyright risk accepted", "Upload scheduled at fixed time"]),
  );
}

function renderConfig() {
  const config = appState.config;
  if (!config) return;
  stageTitle.textContent = "Config";
  setActiveStageButton("config");
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
    actionButton("Save Config", null, "submit", "primary"),
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
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.config = data.config;
  renderConfig();
  setStatus("Config saved to studio.config.json.");
}

async function requestVoice(confirmedPaidRequest) {
  const provider = appState.config?.tts?.defaultProvider ?? "piper";
  const voice = appState.config?.tts?.[provider === "vietnamese-local" ? "vietnameseLocal" : provider]?.voice;
  const response = await fetch(projectApiUrl("voice"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, voice, confirmedPaidRequest }),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  setStatus(`Voice ready: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function requestRender() {
  const response = await fetch(projectApiUrl("render"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message || (data.details?.reasons ?? []).join(", ")}`);
    return;
  }
  setStatus(`Rendered: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function uploadProjectFile(inputId, route) {
  const input = document.querySelector(`#${inputId}`);
  const file = input?.files?.[0];
  if (!file) {
    setStatus("Choose a file first.");
    return;
  }
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(projectApiUrl(route), { method: "POST", body });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  setStatus(`Imported: ${(data.artifact ?? data.asset).relativePath}`);
  await selectProject(appState.selectedProject);
}

async function uploadAsset(form) {
  const input = form.querySelector("#asset-file");
  const file = input?.files?.[0];
  if (!file) throw new Error("Choose an asset file first.");
  const values = boolFormValues(form);
  const body = new FormData();
  body.append("file", file);
  body.append("mediaType", values.mediaType);
  body.append("usagePurpose", values.usagePurpose);
  body.append("rightsConfirmed", String(values.rightsConfirmed));
  const response = await fetch(projectApiUrl("assets"), { method: "POST", body });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  setStatus(`Upload Asset complete: ${data.asset.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function postProjectAction(route, body, successMessage) {
  const response = await fetch(projectApiUrl(route), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  const artifact = data.artifact ?? data.asset ?? data.check ?? data.draft;
  setStatus(artifact?.relativePath ? `${successMessage} ${artifact.relativePath}` : successMessage);
  await selectProject(appState.selectedProject);
}

function renderPreviews(snapshot) {
  const artifacts = snapshot.state?.artifacts ?? {};
  audioPreview.src = artifacts.voice ? projectFileUrl(artifacts.voice.relativePath) : "";
  videoPreview.src = artifacts.render ? projectFileUrl(artifacts.render.relativePath) : "";
}

function summaryGrid(items) {
  const dl = document.createElement("dl");
  dl.className = "summary-grid";
  for (const [term, description] of Object.entries(items)) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = String(description);
    dl.append(dt, dd);
  }
  return dl;
}

function artifactList(artifacts, kinds = Object.keys(artifacts)) {
  const list = document.createElement("ul");
  list.className = "artifact-list";
  const entries = kinds.map((kind) => [kind, artifacts[kind]]).filter(([, artifact]) => artifact);
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No artifacts yet.";
    list.append(empty);
    return list;
  }
  for (const [kind, artifact] of entries) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = projectFileUrl(artifact.relativePath);
    link.textContent = `${kind}: ${artifact.relativePath}`;
    link.target = "_blank";
    item.append(link);
    list.append(item);
  }
  return list;
}

function checklist(items) {
  const list = document.createElement("ul");
  list.className = "checklist";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }
  return list;
}

function linkButton(label, relativePath) {
  const link = document.createElement("a");
  link.className = "button-link";
  link.href = projectFileUrl(relativePath);
  link.target = "_blank";
  link.textContent = label;
  return link;
}

function uploadField(label, inputId, accept, onClick) {
  const wrapper = document.createElement("div");
  wrapper.className = "upload-row";
  wrapper.append(fileField(label, inputId, accept), actionButton(label, onClick, "button", "primary"));
  return wrapper;
}

function fileField(label, id, accept) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "file";
  input.accept = accept;
  wrapper.append(caption, input);
  return wrapper;
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

function field(label, name, value, type = "text", placeholder = "") {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value ?? "";
  input.placeholder = placeholder;
  if (type === "number") {
    input.min = "0";
    input.step = "1";
  }
  wrapper.append(caption, input);
  return wrapper;
}

function textareaField(label, name, value) {
  const wrapper = document.createElement("label");
  wrapper.className = "field field-wide";
  const caption = document.createElement("span");
  caption.textContent = label;
  const textarea = document.createElement("textarea");
  textarea.name = name;
  textarea.rows = 4;
  textarea.value = value ?? "";
  wrapper.append(caption, textarea);
  return wrapper;
}

function checkboxField(label, name, checked) {
  const wrapper = document.createElement("label");
  wrapper.className = "checkbox-field";
  const input = document.createElement("input");
  input.name = name;
  input.type = "checkbox";
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
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

function actionButton(text, onClick, type = "button", variant = "") {
  const button = document.createElement("button");
  button.type = type;
  button.textContent = text;
  if (variant) button.classList.add(variant);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function formValues(form) {
  const values = {};
  for (const field of Array.from(form.elements)) {
    if (!field.name || field.type === "file") continue;
    values[field.name] = field.type === "number" ? Number(field.value) : field.value;
  }
  return values;
}

function boolFormValues(form) {
  const values = formValues(form);
  for (const field of Array.from(form.elements)) {
    if (field.name && field.type === "checkbox") values[field.name] = field.checked;
  }
  return values;
}

function setPathValue(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts[parts.length - 1]] = value;
}

function sourceSubtitlePath() {
  return appState.projectSnapshot?.state?.artifacts?.["source-subtitles"]?.relativePath ?? "workspace/subtitles/source.asr.srt";
}

function projectApiUrl(route) {
  return `/api/projects/${encodeURIComponent(appState.selectedProject)}/${route}`;
}

function projectFileUrl(relativePath) {
  return `/api/projects/${encodeURIComponent(appState.selectedProject)}/files/${encodeURIComponent(relativePath)}`;
}

function targetOptions() {
  return (appState.translationPresets?.presets ?? []).map((preset) => [preset.language ?? preset.target, preset.label]);
}

function translationTargetLabels() {
  return (appState.translationPresets?.presets ?? []).map((preset) => preset.label);
}

function setActiveStageButton(stage = appState.activeStage) {
  for (const button of stageRail.querySelectorAll("[data-stage]")) {
    button.classList.toggle("selected", button.dataset.stage === stage);
  }
}

function setStatus(message) {
  status.textContent = message;
}

loadProjects().catch((error) => setStatus(error.message));
