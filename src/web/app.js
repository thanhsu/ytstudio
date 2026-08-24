import { buildSourceSearchQueries, lines, unique } from "./search-queries.js";
import {
  postJson, patchJson, putJson, fetchJsonOrNull,
  reviewProjectApiUrl, storyApiUrl, seriesFileUrl,
} from "./lib/api.js";
import {
  summaryGrid, formatBytes, checklist, wrapSection, inlineInput,
  uploadField, fileField, paragraph, sectionTitle, readinessPill, gateNotice,
  field, textareaField, checkboxField, selectField, actionButton,
  formValues, boolFormValues, setPathValue, lower, strongText, confidenceMeter,
  formatTimecode, formatSeconds, preBlock, tableCell, seriesLinkButton,
} from "./lib/dom.js";

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

// Groups the 12 pipeline stages into visible production phases. Every stage
// button above still carries its own data-stage and click handler; this only
// changes how they are clustered on the rail.
const STAGE_PHASES = [
  { label: "Plan", stages: ["brief", "script"] },
  { label: "Source", stages: ["media", "asr", "subtitles", "translation"] },
  { label: "Produce", stages: ["voice", "captions", "assets"] },
  { label: "Compliance", stages: ["copyright"] },
  { label: "Output", stages: ["render", "export"] },
];

const RUN_AVAILABLE_TASKS_LABEL = "Run available tasks";

const appState = {
  projects: [],
  series: [],
  reviewProjectsBySeries: {},
  audioStoryWorkspaces: {},
  brandKits: {},
  thumbnailBriefs: {},
  selectedSeries: null,
  selectedSeriesTab: "overview",
  selectedReviewProjectId: null,
  selectedProject: null,
  activeStage: "brief",
  projectSnapshot: null,
  editManifest: null,
  editExport: null,
  translationPresets: null,
  workflowTemplates: null,
  config: null,
  selectedMappingSceneId: null,
  eventStream: null,
  eventStreamProject: null,
  activeJob: null,
  sourceSearchResults: [],
  sourceSearchFilters: {
    expandBilibiliQuery: true,
  },
};

const JOB_LABELS = {
  voice: "Voice",
  render: "Render",
  asr: "ASR",
  captions: "Captions",
  asset: "Asset analysis",
  script: "Script",
  "story-pipeline": "Story pipeline",
  "story-stage": "Story stage",
  "story-export": "Story export",
};

/**
 * Slow routes answer with a job instead of a finished artifact, so the studio
 * follows the project event stream for progress rather than holding a request
 * open for the whole render.
 */
function ensureProjectEventStream(projectId) {
  if (appState.eventStreamProject === projectId && appState.eventStream) {
    return;
  }
  appState.eventStream?.close();
  const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
  source.addEventListener("job", (event) => handleJobEvent(JSON.parse(event.data)));
  appState.eventStream = source;
  appState.eventStreamProject = projectId;
}

function handleJobEvent(job) {
  const label = JOB_LABELS[job.kind] ?? job.kind;
  if (job.status === "running") {
    appState.activeJob = job;
    setStatus(`${label}: ${job.message} (${job.progress}%)`);
    return;
  }

  appState.activeJob = null;
  if (job.status === "succeeded") {
    setStatus(`${label} finished.`);
  } else if (job.status === "cancelled") {
    setStatus(`${label} cancelled.`);
  } else {
    setStatus(`${label} failed: ${job.error ?? "unknown error"}`);
  }
  // A finished story job refreshes the open story screen; other screens keep
  // their existing project refresh.
  if (job.kind.startsWith("story-") && storyFactoryState.channelId && storyFactoryState.storyId) {
    void renderStoryDetail(storyFactoryState.channelId, storyFactoryState.storyId).catch((error) => setStatus(error.message));
    return;
  }
  if (appState.selectedProject) {
    void selectProject(appState.selectedProject);
  }
}

/**
 * Returns true when the route accepted the work as a background job, so the
 * caller should wait for the event stream instead of reading an artifact.
 */
function reportedAsJob(response, data) {
  if (response.status !== 202) {
    return false;
  }
  const label = JOB_LABELS[data.job?.kind] ?? data.job?.kind ?? "Job";
  setStatus(`${label} started.`);
  return true;
}

const projectList = document.querySelector("#project-list");
const seriesPanel = document.querySelector("#series-panel");
const workflowTitle = document.querySelector("#workflow-title");
const workflowDescription = document.querySelector("#workflow-description");
const workflowSteps = document.querySelector("#workflow-steps");
const stageRail = document.querySelector("#stage-rail");
const stageTitle = document.querySelector("#stage-title");
const stageContent = document.querySelector("#stage-content");
const status = document.querySelector("#status");
const paidVoiceDialog = document.querySelector("#paid-voice-dialog");
const confirmPaidVoice = document.querySelector("#confirm-paid-voice");
const paidScriptDialog = document.querySelector("#paid-script-dialog");
const confirmPaidScript = document.querySelector("#confirm-paid-script");
const audioPreview = document.querySelector("#audio-preview");
const videoPreview = document.querySelector("#video-preview");

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
  const [projectsResponse, seriesResponse, presetsResponse, workflowsResponse, configResponse] = await Promise.all([
    fetch("/api/projects"),
    fetch("/api/series"),
    fetch("/api/translation-presets"),
    fetch("/api/workflow-templates"),
    fetch("/api/config"),
  ]);
  const data = await projectsResponse.json();
  appState.series = (await seriesResponse.json()).series ?? [];
  appState.translationPresets = await presetsResponse.json();
  appState.workflowTemplates = await workflowsResponse.json();
  appState.config = (await configResponse.json()).config;
  appState.projects = data.projects ?? [];
  appState.reviewProjectsBySeries = Object.fromEntries(
    await Promise.all(
      appState.series.map(async (series) => {
        const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/review-projects`);
        return [series.id, (await response.json()).reviewProjects ?? []];
      }),
    ),
  );
  appState.audioStoryWorkspaces = Object.fromEntries(
    await Promise.all(
      appState.series
        .filter((series) => series.workflowType === "audio-story")
        .map(async (series) => {
          const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/audio-story`);
          return [series.id, (await response.json()).workspace ?? {}];
        }),
    ),
  );
  appState.brandKits = Object.fromEntries(
    await Promise.all(
      appState.series.map(async (series) => {
        const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/brand-kit`);
        return [series.id, (await response.json()).brandKit ?? {}];
      }),
    ),
  );
  if (!appState.selectedSeries && appState.series.length > 0) {
    appState.selectedSeries = appState.series[0];
  }
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

function renderProjects() {
  const hiddenEpisodeProjects = seriesEpisodeProjectIds();
  const visibleProjects = appState.projects.filter((id) => !hiddenEpisodeProjects.has(id) || id === appState.selectedProject);
  projectList.replaceChildren(
    ...visibleProjects.map((id) => {
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

function renderWorkflowBoard() {
  const workflow = appState.projectSnapshot?.workflow;
  if (!workflow) {
    workflowTitle.textContent = "Workflow";
    workflowDescription.textContent = "Create or select a project to load its flow.";
    workflowSteps.replaceChildren(...workflowTemplateCards());
    return;
  }

  workflowTitle.textContent = workflow.title;
  workflowDescription.textContent = workflow.description;
  workflowSteps.replaceChildren(
    ...workflow.steps.map((step) => {
      const item = document.createElement("li");
      item.className = `workflow-step ${step.status}`;
      if (step.parallelGroup) item.dataset.parallelGroup = step.parallelGroup;

      const button = document.createElement("button");
      button.type = "button";
      button.className = step.stage === appState.activeStage ? "selected" : "";
      button.addEventListener("click", () => {
        appState.activeStage = step.stage;
        renderStage();
      });

      const badge = document.createElement("span");
      badge.className = "step-status";
      badge.textContent = step.status;

      const title = document.createElement("strong");
      title.textContent = step.title;

      const description = document.createElement("small");
      description.textContent = step.parallelGroup
        ? `${step.description} Parallel group: ${step.parallelGroup}.`
        : step.description;

      button.append(badge, title, description);
      item.append(button);
      return item;
    }),
  );
}

function workflowTemplateCards() {
  return (appState.workflowTemplates?.templates ?? []).map((template) => {
    const item = document.createElement("li");
    item.className = "workflow-step ready";
    const block = document.createElement("div");
    block.className = "workflow-template-card";
    const title = document.createElement("strong");
    title.textContent = template.title;
    const description = document.createElement("small");
    description.textContent = template.description;
    block.append(title, description);
    item.append(block);
    return item;
  });
}

function renderStageRail() {
  const workflow = appState.projectSnapshot?.workflow;
  const stages = workflow ? unique(workflow.steps.map((step) => step.stage)) : STAGES;
  const stageSet = new Set(stages);
  const grouped = new Set();
  const items = [];

  for (const phase of STAGE_PHASES) {
    const phaseStages = phase.stages.filter((stage) => stageSet.has(stage));
    if (phaseStages.length === 0) continue;
    phaseStages.forEach((stage) => grouped.add(stage));
    items.push(stagePhaseItem(phase.label, phaseStages));
  }

  const ungrouped = stages.filter((stage) => !grouped.has(stage));
  if (ungrouped.length > 0) {
    items.push(stagePhaseItem("Other", ungrouped));
  }

  stageRail.replaceChildren(...items);
  bindStageRail();
  setActiveStageButton();
}

function stagePhaseItem(label, stages) {
  const item = document.createElement("li");
  const group = document.createElement("div");
  group.className = "stage-phase";
  const heading = document.createElement("span");
  heading.className = "stage-phase-label";
  heading.textContent = label;
  const buttons = document.createElement("div");
  buttons.className = "stage-phase-buttons";
  buttons.append(
    ...stages.map((stage) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.stage = stage;
      button.textContent = STAGE_TITLES[stage] ?? stage;
      return button;
    }),
  );
  group.append(heading, buttons);
  item.append(group);
  return item;
}

function bindStageRail() {
  for (const button of stageRail.querySelectorAll("[data-stage]")) {
    button.addEventListener("click", () => {
      appState.activeStage = button.dataset.stage;
      renderStage();
    });
  }
}

async function selectProject(projectId) {
  appState.selectedProject = projectId;
  ensureProjectEventStream(projectId);
  const [response] = await Promise.all([
    fetch(`/api/projects/${encodeURIComponent(projectId)}`),
    loadEditManifestState(projectId),
  ]);
  appState.projectSnapshot = await response.json();
  const workflowStages = appState.projectSnapshot.workflow?.steps?.map((step) => step.stage) ?? [];
  if (!workflowStages.includes(appState.activeStage)) {
    appState.activeStage = workflowStages[0] ?? "brief";
  }
  renderProjects();
  renderWorkflowBoard();
  renderStageRail();
  renderStage();
  setStatus(`Loaded ${projectId}.`);
}

function renderStage() {
  setActiveStageButton();
  seriesPanel.replaceChildren();
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
  renderWorkflowBoard();
  renderPreviews(snapshot);
}

function renderSeriesManager() {
  stageTitle.textContent = "Series Manager";
  setActiveStageButton("series");
  seriesPanel.replaceChildren();
  stageContent.replaceChildren(
    paragraph("Manage a show-level project, generate editable episode/video plans, then perform detailed workflow per episode."),
    renderCreateSeriesForm(),
    renderSeriesList(),
    appState.selectedSeries ? renderSeriesDetail(appState.selectedSeries) : paragraph("Select or create a series to manage episodes."),
  );
  setStatus("Series Manager loaded.");
}

function renderCreateSeriesForm() {
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    createSeries(form).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Series id", "id", "", "text", "muc-than-ky"),
    field("Series title", "title", "", "text", "Muc Than Ky Review"),
    field("Show / film", "show", "", "text", "Muc Than Ky"),
    field("Original title", "originalTitle", "", "text", "牧神记"),
    selectField("Workflow type", "workflowType", "review-recap", workflowTypeOptions()),
    field("Audience", "audience", "Vietnamese donghua review viewers"),
    field("Language", "language", "Vietnamese"),
    field("Schedule notes", "scheduleNotes", "Fixed upload day and hour"),
    actionButton("Create Series", null, "submit", "primary"),
  );
  return wrapSection("New series", form);
}

function renderSeriesList() {
  const list = document.createElement("div");
  list.className = "series-list";
  if (appState.series.length === 0) {
    list.append(paragraph("No series projects yet."));
    return wrapSection("Series", list);
  }
  for (const series of appState.series) {
    const button = actionButton(`${series.title} (${series.episodes.length})`, () => {
      appState.selectedSeries = series;
      appState.selectedSeriesTab = defaultSeriesTab(series);
      appState.selectedReviewProjectId = null;
      renderSeriesManager();
    });
    if (appState.selectedSeries?.id === series.id) button.classList.add("selected");
    list.append(button);
  }
  return wrapSection("Series", list);
}

function renderSeriesDetail(series) {
  const selectedTab = appState.selectedSeriesTab || defaultSeriesTab(series);
  const planForm = document.createElement("form");
  planForm.className = "form-grid compact-form";
  planForm.addEventListener("submit", (event) => {
    event.preventDefault();
    generateSeriesEpisodePlan(series.id, formValues(planForm)).catch((error) => setStatus(error.message));
  });
  planForm.replaceChildren(
    field("Count", "count", "20", "number"),
    field("Start episode", "startEpisode", String(series.episodes.length + 1), "number"),
    actionButton("Generate episode plan", null, "submit", "primary"),
  );

  const table = document.createElement("div");
  table.className = "episode-table";
  table.append(episodeHeader());
  for (const episode of series.episodes) {
    table.append(renderEpisodeRow(series.id, episode));
  }

  const panel = {
    overview: () => renderSeriesOverview(series, planForm, table),
    brand: () => renderBrandKitPanel(series),
    audio: () => renderAudioStoryPanel(series),
    batch: () => renderBatchReviewPanel(series),
  }[selectedTab] ?? (() => renderSeriesOverview(series, planForm, table));

  return wrapSection(
    `${series.title} - Production Workspace`,
    renderSeriesWorkspaceHeader(series),
    renderSeriesWorkspaceTabs(series, selectedTab),
    panel(),
  );
}

function defaultSeriesTab(series) {
  return series.workflowType === "audio-story" ? "audio" : "overview";
}

function renderSeriesWorkspaceHeader(series) {
  const header = document.createElement("div");
  header.className = "series-workspace-header card";
  header.append(
    summaryGrid({
      Show: series.show,
      Original: series.originalTitle,
      Workflow: series.workflowType,
      Episodes: String(series.episodes.length),
      Audience: series.audience,
      Language: series.language,
      Schedule: series.scheduleNotes,
    }),
    gateNotice(
      "Workspace scope",
      "This workspace plans channel output and production assets. Any source footage still needs the source rights gate and project copyright check before render.",
      "info",
    ),
  );
  return header;
}

function renderSeriesWorkspaceTabs(series, selectedTab) {
  const tabs = document.createElement("div");
  tabs.className = "workspace-tabs";
  const batchCount = appState.reviewProjectsBySeries[series.id]?.length ?? 0;
  const chapterCount = appState.audioStoryWorkspaces[series.id]?.chapters?.length ?? 0;
  const kit = appState.brandKits[series.id] ?? {};
  const hasBrandAssets = Boolean(kit.logoRoundPath || kit.logoTextPath || kit.watermarkPath);
  const tabDefs = [
    ["overview", "Overview", `${series.episodes.length} episodes`],
    ["brand", "Brand Kit", hasBrandAssets ? "assets ready" : "needs assets"],
    ["audio", "Audio Story", `${chapterCount} chapters`],
    ["batch", "Batch Review", `${batchCount} batches`],
  ];
  for (const [id, label, meta] of tabDefs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workspace-tab${selectedTab === id ? " selected" : ""}`;
    button.dataset.seriesTab = id;
    const labelElement = document.createElement("span");
    labelElement.className = "workspace-tab-label";
    labelElement.textContent = label;
    button.append(labelElement, readinessPill(selectedTab === id ? "progress" : "neutral", meta));
    button.addEventListener("click", () => {
      appState.selectedSeriesTab = id;
      renderSeriesManager();
    });
    tabs.append(button);
  }
  return tabs;
}

function renderSeriesOverview(series, planForm, episodeTable) {
  return wrapSection(
    "Series Plan",
    paragraph("Plan the first content run, keep episode titles editable, and then move into Brand Kit, Audio Story, or Batch Review when a production lane is ready."),
    planForm,
    episodeTable,
  );
}

function renderBrandKitPanel(series) {
  const kit = appState.brandKits[series.id] ?? {};
  const brief = appState.thumbnailBriefs[series.id];
  return wrapSection(
    "Brand Kit",
    paragraph("Manage channel identity, reusable thumbnail rules, logos, watermarks, and thumbnail briefs for this series."),
    renderBrandKitForm(series, kit),
    renderBrandAssetForm(series),
    renderThumbnailBriefForm(series),
    renderBrandKitSummary(series, kit, brief),
  );
}

function renderBrandKitForm(series, kit) {
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveBrandKitUi(series.id, boolFormValues(form)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Channel name", "channelName", kit.channelName ?? series.title),
    field("Handle", "handle", kit.handle ?? ""),
    field("Primary color", "primaryColor", kit.primaryColor ?? "#f4c430", "color"),
    field("Secondary color", "secondaryColor", kit.secondaryColor ?? "#1b1f2a", "color"),
    field("Accent color", "accentColor", kit.accentColor ?? "#e5484d", "color"),
    field("Font style", "fontStyle", kit.fontStyle ?? "bold condensed sans"),
    selectField("Thumbnail preset", "thumbnailPreset", kit.thumbnailPreset ?? "story-arc", [
      ["story-arc", "Story arc"],
      ["character-focus", "Character focus"],
      ["audio-cover", "Audio cover"],
      ["clean-news", "Clean news"],
    ]),
    field("Watermark opacity", "watermarkOpacity", String(kit.watermarkOpacity ?? 0.2), "number", "", "any"),
    textareaField("Title style", "titleStyle", kit.titleStyle ?? "Clear curiosity with consistent channel language."),
    textareaField("Thumbnail style", "thumbnailStyle", kit.thumbnailStyle ?? "Large readable text, high contrast."),
    textareaField("Safe text rules", "safeTextRules", (kit.safeTextRules ?? ["Use three to five words max"]).join("\n")),
    field("CTA", "cta", kit.cta ?? "Subscribe for the next story"),
    actionButton("Save Brand Kit", null, "submit", "primary"),
  );
  return wrapSection("Channel Identity", form);
}

function renderBrandAssetForm(series) {
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    uploadBrandAssetUi(series.id, form).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    selectField("Asset type", "assetType", "watermark", [
      ["logo-round", "Logo round"],
      ["logo-text", "Logo text"],
      ["watermark", "Watermark"],
      ["reference", "Reference"],
      ["background", "Background"],
    ]),
    fileField("Brand asset", `brand-asset-${series.id}`, "image/*"),
    actionButton("Upload Brand Asset", null, "submit", "primary"),
  );
  return wrapSection("Assets", form);
}

function renderThumbnailBriefForm(series) {
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    generateThumbnailBriefUi(series.id, formValues(form)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    selectField("Workflow", "workflowType", series.workflowType, workflowTypeOptions()),
    field("Video title", "videoTitle", series.show || series.title),
    field("Episode / chapter", "episodeLabel", "EP01-05"),
    textareaField("Hook", "hook", "One hidden detail changes the whole arc."),
    actionButton("Generate Thumbnail Brief", null, "submit", "primary"),
  );
  return wrapSection("Thumbnail Studio", form);
}

function renderBrandKitSummary(series, kit, brief) {
  const output = document.createElement("div");
  output.append(
    summaryGrid({
      Channel: kit.channelName ?? series.title,
      Preset: kit.thumbnailPreset ?? "story-arc",
      Logo: kit.logoRoundPath || kit.logoTextPath || "none",
      Watermark: kit.watermarkPath || "none",
    }),
  );
  if (brief) {
    output.append(
      sectionTitle("Last Thumbnail Brief"),
      summaryGrid({
        Title: brief.videoTitle,
        Text: brief.textLines.join(" / "),
        Layout: brief.layout,
      }),
      paragraph(brief.prompt),
    );
  }
  return wrapSection("Preview Metadata", output);
}

function renderAudioStoryPanel(series) {
  const workspace = appState.audioStoryWorkspaces[series.id] ?? {};
  return wrapSection(
    "Audio Story",
    paragraph("Create original story audio from a reusable bible, chapter outline, editable chapter drafts, continuity checks, and export files."),
    renderStoryBibleForm(series, workspace),
    renderStoryOutlinePanel(series, workspace),
    renderStoryChapterPanel(series, workspace),
    renderAudioStoryOutputLinks(series, workspace),
  );
}

function renderStoryBibleForm(series, workspace) {
  const bible = workspace.bible ?? {};
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveStoryBible(series.id, boolFormValues(form)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Story title", "title", bible.title ?? series.show, "text"),
    field("Genre", "genre", bible.genre ?? "original cultivation fantasy", "text"),
    textareaField("Premise", "premise", bible.premise ?? "A low-status courier discovers a hidden rule under a border town."),
    field("Tone", "tone", bible.tone ?? "cinematic, mysterious, serialized", "text"),
    field("Audience", "audience", bible.audience ?? series.audience, "text"),
    field("Language", "language", bible.language ?? series.language, "text"),
    textareaField("Rules", "rules", (bible.rules ?? ["Original story only", "No copied names or franchise terms"]).join("\n")),
    textareaField("Main character", "mainCharacter", bible.characters?.[0]?.name ?? "Lin Vale"),
    textareaField("Locations", "locations", (bible.locations ?? ["Moon Gate Town", "Ash River"]).join("\n")),
    actionButton("Save Story Bible", null, "submit", "primary"),
  );
  return wrapSection("Story Bible", form);
}

function renderStoryOutlinePanel(series, workspace) {
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    generateStoryOutlineUi(series.id, formValues(form)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Chapter count", "chapterCount", String(workspace.outline?.chapters?.length ?? 10), "number"),
    field("Minutes / chapter", "targetMinutesPerChapter", String(workspace.outline?.targetMinutesPerChapter ?? 12), "number"),
    actionButton("Generate Story Outline", null, "submit", "primary"),
  );
  const list = document.createElement("ol");
  list.className = "artifact-list";
  for (const chapter of workspace.outline?.chapters ?? []) {
    const item = document.createElement("li");
    item.textContent = `Chapter ${chapter.chapterNumber}: ${chapter.titleOptions[0]} - ${chapter.status}`;
    list.append(item);
  }
  if (!workspace.outline) list.append(paragraph("No outline yet."));
  return wrapSection("Outline", form, list);
}

function renderStoryChapterPanel(series, workspace) {
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    generateStoryChapterUi(series.id, values.chapterNumber).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Chapter", "chapterNumber", "1", "number"),
    actionButton("Generate Chapter", null, "submit", "primary"),
  );

  const chapters = document.createElement("div");
  chapters.className = "episode-table";
  for (const chapter of workspace.chapters ?? []) {
    const row = document.createElement("div");
    row.className = "episode-row";
    row.append(
      paragraph(String(chapter.chapterNumber).padStart(3, "0")),
      paragraph(chapter.title),
      paragraph(chapter.status),
      actionButton("Continuity Check", () => runStoryContinuityUi(series.id, chapter.chapterNumber), "button"),
      seriesLinkButton(series.id, "Open Chapter", `audio-story/chapters/chapter-${String(chapter.chapterNumber).padStart(3, "0")}.md`),
    );
    chapters.append(row);
  }
  if ((workspace.chapters ?? []).length === 0) chapters.append(paragraph("No generated chapters yet."));

  return wrapSection(
    "Chapters",
    form,
    chapters,
    actionButton("Export Audio Story", () => exportAudioStoryUi(series.id), "button", "primary"),
  );
}

function renderAudioStoryOutputLinks(series, workspace) {
  const outputs = workspace.outputs ?? {};
  const list = document.createElement("ul");
  list.className = "artifact-list";
  for (const [label, path] of Object.entries(outputs)) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = seriesFileUrl(series.id, path);
    link.target = "_blank";
    link.textContent = `${label}: ${path}`;
    item.append(link);
    list.append(item);
  }
  if (Object.keys(outputs).length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No audio story exports yet.";
    list.append(empty);
  }
  return wrapSection("Audio Story Exports", list);
}

function renderBatchReviewPanel(series) {
  const batches = appState.reviewProjectsBySeries[series.id] ?? [];
  const selectedBatch = batches.find((batch) => batch.id === appState.selectedReviewProjectId) ?? batches[0];
  if (!appState.selectedReviewProjectId && selectedBatch) appState.selectedReviewProjectId = selectedBatch.id;

  return wrapSection(
    "Batch Reviews",
    paragraph("Create one review video from multiple episodes, then process each episode independently before merging the story."),
    renderCreateBatchReviewForm(series),
    renderBatchReviewList(series, batches),
    selectedBatch ? renderBatchReviewDetail(series, selectedBatch) : paragraph("No batch review project yet."),
  );
}

function renderCreateBatchReviewForm(series) {
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    createBatchReview(series.id, formValues(form)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    field("Batch id", "id", "ep01-05", "text"),
    field("Source range", "sourceRange", "Episodes 01-05", "text"),
    field("Episode numbers", "episodeNumbers", "1,2,3,4,5", "text"),
    field("Target minutes", "targetDurationMinutes", "20", "number"),
    selectField("Spoiler mode", "spoilerMode", "donghua-only", [
      ["donghua-only", "Donghua only"],
      ["novel-spoilers", "Novel spoilers"],
    ]),
    actionButton("Create Batch Review", null, "submit", "primary"),
  );
  return form;
}

function renderBatchReviewList(series, batches) {
  const list = document.createElement("div");
  list.className = "series-list";
  if (batches.length === 0) {
    list.append(paragraph("No batch reviews yet."));
    return list;
  }
  for (const batch of batches) {
    const button = actionButton(`${batch.sourceRange} - ${batch.status}`, () => {
      appState.selectedReviewProjectId = batch.id;
      renderSeriesManager();
    });
    if (batch.id === appState.selectedReviewProjectId) button.classList.add("selected");
    list.append(button);
  }
  return list;
}

function renderBatchReviewDetail(series, batch) {
  const section = document.createElement("section");
  section.className = "batch-workflow";
  const episodeTable = document.createElement("div");
  episodeTable.className = "batch-episode-table";
  episodeTable.append(batchEpisodeHeader());
  for (const episode of batch.episodes) {
    episodeTable.append(renderBatchEpisodeRow(series.id, batch.id, episode));
  }
  section.append(
    sectionTitle(`${batch.title} ${batch.sourceRange}`),
    summaryGrid({
      Status: batch.status,
      Duration: `${batch.targetDurationMinutes} min`,
      Spoilers: batch.spoilerMode,
      Outputs: Object.keys(batch.outputs ?? {}).join(", ") || "none",
    }),
    renderBatchActionBar(series.id, batch),
    episodeTable,
    renderBatchOutputLinks(series.id, batch),
  );
  return section;
}

function batchEpisodeHeader() {
  const row = document.createElement("div");
  row.className = "batch-episode-row batch-header";
  for (const label of ["Episode", "Status", "Source", "Subtitle", "AI steps"]) {
    const cell = document.createElement("strong");
    cell.textContent = label;
    row.append(cell);
  }
  return row;
}

function renderBatchEpisodeRow(seriesId, reviewProjectId, episode) {
  const row = document.createElement("div");
  row.className = "batch-episode-row";
  const mediaInput = `batch-media-${reviewProjectId}-${episode.episodeNumber}`;
  const subtitleInput = `batch-subtitle-${reviewProjectId}-${episode.episodeNumber}`;
  row.append(
    paragraph(episode.label),
    paragraph(episode.status),
    uploadField("Media", mediaInput, "video/*,.mkv,.mov,.mp4,.webm", () =>
      uploadReviewEpisodeFile(seriesId, reviewProjectId, episode.episodeNumber, "media", mediaInput),
    ),
    uploadField("Subtitle", subtitleInput, ".srt,.vtt,.ass,.ssa", () =>
      uploadReviewEpisodeFile(seriesId, reviewProjectId, episode.episodeNumber, "subtitle", subtitleInput),
    ),
    batchEpisodeActions(seriesId, reviewProjectId, episode),
  );
  return row;
}

function batchEpisodeActions(seriesId, reviewProjectId, episode) {
  const actions = document.createElement("div");
  actions.className = "episode-actions";
  actions.append(
    actionButton("Scene Map", () => postReviewProjectAction(seriesId, reviewProjectId, `episodes/${episode.episodeNumber}/scene-map`, {}, "Scene map built."), "button"),
    actionButton("Analyze", () => postReviewProjectAction(seriesId, reviewProjectId, `episodes/${episode.episodeNumber}/analysis`, {}, "Episode analyzed."), "button", "primary"),
  );
  return actions;
}

function renderBatchActionBar(seriesId, batch) {
  const actions = document.createElement("div");
  actions.className = "batch-actions";
  actions.append(
    actionButton("Generate Story Arc", () => postReviewProjectAction(seriesId, batch.id, "story-arc", {}, "Story arc generated."), "button", "primary"),
    actionButton("Generate Review Script", () => postReviewProjectAction(seriesId, batch.id, "script", {}, "Review script generated."), "button"),
    actionButton("Generate Editing Plan", () => postReviewProjectAction(seriesId, batch.id, "editing-plan", {}, "Editing plan generated."), "button"),
    actionButton("Export Review Package", () => postReviewProjectAction(seriesId, batch.id, "export", {}, "Review package exported."), "button"),
  );
  return actions;
}

function renderBatchOutputLinks(seriesId, batch) {
  const outputs = batch.outputs ?? {};
  const list = document.createElement("ul");
  list.className = "artifact-list";
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No batch outputs yet.";
    list.append(empty);
    return list;
  }
  for (const [label, path] of entries) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = seriesFileUrl(seriesId, path);
    link.target = "_blank";
    link.textContent = `${label}: ${path}`;
    item.append(link);
    list.append(item);
  }
  return list;
}

function episodeHeader() {
  const row = document.createElement("div");
  row.className = "episode-row episode-header";
  for (const label of ["Episode", "Working title", "Angle", "Status", "Actions"]) {
    const cell = document.createElement("strong");
    cell.textContent = label;
    row.append(cell);
  }
  return row;
}

function renderEpisodeRow(seriesId, episode) {
  const row = document.createElement("form");
  row.className = "episode-row";
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    updateEpisode(seriesId, episode.id, boolFormValues(row)).catch((error) => setStatus(error.message));
  });

  const number = document.createElement("span");
  number.textContent = String(episode.episodeNumber).padStart(3, "0");
  row.append(
    number,
    inlineInput("workingTitle", episode.workingTitle),
    inlineInput("angle", episode.angle),
    selectField("", "status", episode.status, [
      ["idea", "Idea"],
      ["script", "Script"],
      ["voice", "Voice"],
      ["caption", "Caption"],
      ["render", "Render"],
      ["ready", "Ready"],
      ["published", "Published"],
    ]),
    episodeActions(episode),
  );
  return row;
}

function episodeActions(episode) {
  const actions = document.createElement("div");
  actions.className = "episode-actions";
  actions.append(
    actionButton("Save", null, "submit", "primary"),
    actionButton("Perform task", () => performEpisodeTask(episode), "button"),
  );
  return actions;
}

async function createSeries(form) {
  const response = await fetch("/api/series", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(formValues(form)),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.selectedSeries = data.series;
  await loadProjects();
  appState.selectedSeries = appState.series.find((series) => series.id === data.series.id) ?? data.series;
  renderSeriesManager();
  setStatus(`Created series ${data.series.title}.`);
}

async function generateSeriesEpisodePlan(seriesId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episode-plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.selectedSeries = data.series;
  await loadProjects();
  appState.selectedSeries = appState.series.find((series) => series.id === data.series.id) ?? data.series;
  renderSeriesManager();
  setStatus(`Generated episode plan for ${data.series.title}.`);
}

async function updateEpisode(seriesId, episodeId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${encodeURIComponent(episodeId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.selectedSeries = data.series;
  await loadProjects();
  appState.selectedSeries = appState.series.find((series) => series.id === data.series.id) ?? data.series;
  renderSeriesManager();
  setStatus(`Saved ${data.episode.id}.`);
}

async function createBatchReview(seriesId, values) {
  const payload = {
    ...values,
    title: appState.selectedSeries?.show ?? appState.selectedSeries?.title ?? seriesId,
    episodeNumbers: parseEpisodeNumbers(values.episodeNumbers),
  };
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/review-projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.selectedReviewProjectId = data.reviewProject.id;
  await loadProjects();
  appState.selectedSeries = appState.series.find((series) => series.id === seriesId) ?? appState.selectedSeries;
  renderSeriesManager();
  setStatus(`Created batch review ${data.reviewProject.sourceRange}.`);
}

async function saveBrandKitUi(seriesId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/brand-kit`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...values,
      safeTextRules: lines(values.safeTextRules),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.brandKits[seriesId] = data.brandKit;
  renderSeriesManager();
  setStatus("Brand Kit saved.");
}

async function uploadBrandAssetUi(seriesId, form) {
  const input = form.querySelector("[type=file]");
  const file = input?.files?.[0];
  if (!file) throw new Error("Choose a brand asset first.");
  const values = formValues(form);
  const body = new FormData();
  body.append("assetType", values.assetType);
  body.append("file", file);
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/brand-kit/assets`, {
    method: "POST",
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.brandKits[seriesId] = data.brandKit;
  renderSeriesManager();
  setStatus(`Upload Brand Asset complete: ${data.asset.relativePath}`);
}

async function generateThumbnailBriefUi(seriesId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/brand-kit/thumbnail-brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.thumbnailBriefs[seriesId] = data.thumbnailBrief;
  renderSeriesManager();
  setStatus("Generate Thumbnail Brief complete.");
}

async function saveStoryBible(seriesId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/audio-story/bible`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: values.title,
      genre: values.genre,
      premise: values.premise,
      tone: values.tone,
      audience: values.audience,
      language: values.language,
      rules: lines(values.rules),
      locations: lines(values.locations),
      characters: [
        {
          name: values.mainCharacter,
          role: "protagonist",
          traits: ["editable"],
          voiceNotes: "Keep narration consistent with this character.",
        },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.audioStoryWorkspaces[seriesId] = data.workspace;
  renderSeriesManager();
  setStatus("Story Bible saved.");
}

async function generateStoryOutlineUi(seriesId, values) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/audio-story/outline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.audioStoryWorkspaces[seriesId] = data.workspace;
  renderSeriesManager();
  setStatus("Generated Story Outline.");
}

async function generateStoryChapterUi(seriesId, chapterNumber) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/audio-story/chapters/${encodeURIComponent(chapterNumber)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.audioStoryWorkspaces[seriesId] = data.workspace;
  renderSeriesManager();
  setStatus(`Generated Chapter ${data.chapter.chapterNumber}.`);
}

async function runStoryContinuityUi(seriesId, chapterNumber) {
  const response = await fetch(
    `/api/series/${encodeURIComponent(seriesId)}/audio-story/chapters/${encodeURIComponent(chapterNumber)}/continuity`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.audioStoryWorkspaces[seriesId] = data.workspace;
  renderSeriesManager();
  setStatus(data.report.blocked ? "Continuity check found a blocker." : "Continuity Check complete.");
}

async function exportAudioStoryUi(seriesId) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/audio-story/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.audioStoryWorkspaces[seriesId] = data.workspace;
  renderSeriesManager();
  setStatus("Export Audio Story complete.");
}

async function uploadReviewEpisodeFile(seriesId, reviewProjectId, episodeNumber, kind, inputId) {
  const input = document.querySelector(`#${inputId}`);
  const file = input?.files?.[0];
  if (!file) {
    setStatus("Choose a file first.");
    return;
  }
  const body = new FormData();
  body.append("file", file);
  if (kind === "subtitle") body.append("language", "zh");
  const response = await fetch(reviewProjectApiUrl(seriesId, reviewProjectId, `episodes/${episodeNumber}/${kind}`), {
    method: "POST",
    body,
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  await refreshSeriesReviewProjects(seriesId);
  renderSeriesManager();
  setStatus(`Imported ${kind} for episode ${episodeNumber}.`);
}

async function postReviewProjectAction(seriesId, reviewProjectId, route, body, successMessage) {
  const response = await fetch(reviewProjectApiUrl(seriesId, reviewProjectId, route), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  await refreshSeriesReviewProjects(seriesId);
  renderSeriesManager();
  setStatus(successMessage);
}

async function refreshSeriesReviewProjects(seriesId) {
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/review-projects`);
  appState.reviewProjectsBySeries[seriesId] = (await response.json()).reviewProjects ?? [];
}

async function performEpisodeTask(episode) {
  await selectProject(episode.episodeProjectId);
  setStatus(`Perform task: opened detailed workflow for ${episode.id}.`);
}

function renderCreateProject() {
  stageTitle.textContent = "Create Project";
  workflowTitle.textContent = "Workflow";
  workflowDescription.textContent = "Pick the type of video before creating the project.";
  workflowSteps.replaceChildren(...workflowTemplateCards());
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
    selectField("Workflow type", "workflowType", "review-recap", workflowTypeOptions()),
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
  const scriptStatus = snapshot.pipeline?.script ?? "missing";
  stageContent.replaceChildren(
    paragraph("Generate or refresh the review script and metadata from the current brief."),
    paragraph(
      scriptStatus === "approved"
        ? "This script is approved. Editing script.md makes the approval stale and blocks voice and render until you approve again."
        : "Read the script before approving. Voice and render stay blocked until the current narration is approved.",
    ),
    actionButton("Generate Script", () => requestScript(false), "button", "primary"),
    actionButton("Approve Script", () => postProjectAction("script/approve", {}, "Script approved.")),
    summaryGrid({
      Topic: snapshot.brief.topic ?? "",
      "Script model": scriptModelSummary(snapshot),
      Approval: scriptStatus,
      Output: "script.md, metadata.json, scene-plan.json",
    }),
  );
}

// Reads what produced the script on disk, never the live configuration: pointing
// Config at a hosted model must not relabel an existing template-generated script.
function scriptModelSummary(snapshot) {
  const generator = snapshot.metadata?.generator;
  if (generator?.provider) {
    return `${generator.provider} · ${generator.model}`;
  }
  if (snapshot.metadata) {
    return "Unknown — this script predates provenance recording";
  }
  return "No script generated yet";
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
    renderSegmentEditor(),
  );
}

function renderSegmentEditor() {
  const manifest = appState.editManifest;
  const createForm = document.createElement("form");
  createForm.className = "form-grid segment-editor-actions";
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const values = formValues(createForm);
      if (manifest && !confirm("Replace the existing edit manifest? This resets all keep/remove decisions.")) {
        return;
      }
      const data = await runProjectRoute("edit-manifest", manifest ? { ...values, replace: true } : values);
      appState.editManifest = data.manifest;
      appState.editExport = null;
      renderTranslation(appState.projectSnapshot);
      setStatus(`Edit manifest created with ${data.manifest.segments.length} cues.`);
    } catch (error) {
      setStatus(error.message);
    }
  });
  createForm.replaceChildren(
    field("Source SRT path", "source", manifest?.sourceRelativePath ?? sourceSubtitlePath()),
    actionButton("Create Edit Manifest", null, "submit", "primary"),
  );

  const children = [
    sectionTitle("Subtitle Segment Editor"),
    paragraph("Human review step: select subtitle cues to remove, then export a clean SRT and an audit CSV."),
    createForm,
  ];
  if (!manifest) {
    children.push(paragraph("Create an edit manifest to load subtitle cue decisions."));
    return wrapSection("Cue review", ...children);
  }

  const removed = manifest.segments.filter((segment) => segment.decision === "remove");
  const decisionStatus = document.createElement("p");
  decisionStatus.className = "segment-editor-status";
  decisionStatus.setAttribute("aria-live", "polite");
  decisionStatus.textContent = `${manifest.segments.length - removed.length} kept · ${removed.length} removed · ${manifest.segments.length} total`;

  const removeForm = document.createElement("form");
  removeForm.className = "form-grid segment-editor-actions";
  removeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await runProjectRoute("edit-manifest/remove-list", formValues(removeForm));
      appState.editManifest = data.manifest;
      appState.editExport = null;
      renderTranslation(appState.projectSnapshot);
      setStatus("Keep/remove decisions saved.");
    } catch (error) {
      setStatus(error.message);
    }
  });
  removeForm.replaceChildren(
    field("Remove cue numbers", "remove", removed.map((segment) => segment.cueIndex).join(","), "text", "1,5,10-12"),
    actionButton("Apply Keep/Remove Decisions", null, "submit", "primary"),
  );

  const exportButton = actionButton("Export Clean SRT + CSV", async () => {
    try {
      const data = await runProjectRoute("edit-manifest/export", {});
      appState.editExport = data.exported;
      renderTranslation(appState.projectSnapshot);
      setStatus(`Exported ${data.exported.keptCueCount} kept cues.`);
    } catch (error) {
      setStatus(error.message);
    }
  });
  children.push(decisionStatus, removeForm, exportButton, renderSegmentDecisionTable(manifest));
  if (appState.editExport) {
    children.push(
      linkButton("Open clean SRT", appState.editExport.cleanSrtRelativePath),
      linkButton("Open decision CSV", appState.editExport.csvRelativePath),
    );
  }
  return wrapSection("Cue review", ...children);
}

function renderSegmentDecisionTable(manifest) {
  const wrapper = document.createElement("div");
  wrapper.className = "segment-editor-table-wrap";
  const table = document.createElement("table");
  table.className = "segment-editor-table";
  const caption = document.createElement("caption");
  caption.textContent = "Subtitle cue decisions";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Cue", "Timing", "Decision", "Text"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const segment of manifest.segments) {
    const row = document.createElement("tr");
    row.className = `decision-${segment.decision}`;
    for (const value of [segment.cueIndex, `${segment.start} → ${segment.end}`, segment.decision, segment.text]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  wrapper.append(table);
  return wrapper;
}

async function loadEditManifestState(projectId) {
  appState.editExport = null;
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/edit-manifest`);
  if (!response.ok) {
    appState.editManifest = null;
    return;
  }
  appState.editManifest = (await response.json()).manifest;
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
  const assets = snapshot.assetManifest?.assets ?? [];
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
    sectionTitle("Uploaded assets"),
    assets.length > 0 ? uploadedAssetList(assets) : paragraph("No assets uploaded yet."),
    actionButton("Approve Assets", () => postProjectAction("assets/approve", {}, "Assets approved.")),
    artifactList(snapshot.state?.artifacts ?? {}, ["media", "render"]),
  );
}

function uploadedAssetList(assets) {
  const list = document.createElement("div");
  list.className = "asset-list";

  for (const asset of assets) {
    const form = document.createElement("form");
    form.className = "subpanel form-grid";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveAssetMetadata(asset.id, form).catch((error) => setStatus(error.message));
    });

    const link = document.createElement("a");
    link.href = projectFileUrl(asset.relativePath);
    link.target = "_blank";
    link.textContent = asset.filename;

    form.append(
      link,
      paragraph(`${asset.mediaType} · ${formatBytes(asset.sizeBytes)}`),
      field("Usage purpose", "usagePurpose", asset.usagePurpose, "text", "Explain how this asset supports commentary"),
      checkboxField("Rights confirmed", "rightsConfirmed", asset.rightsConfirmed),
      actionButton("Save asset details", null, "submit", "primary"),
    );
    list.append(form);
  }

  return list;
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
    // The risk threshold sits at about 5 seconds, so 4.5 is a realistic entry and
    // the default step="1" would have native validation block the submit.
    field("Longest clip seconds", "longestClipSeconds", "5", "number", "", "any"),
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

const RENDER_GATE_LABELS = {
  "script-approval-missing": "Approve the script in the Script stage.",
  "script-approval-stale": "The script changed after approval. Approve it again.",
  "assets-approval-missing": "Approve the asset manifest in the Assets stage.",
  "assets-approval-stale": "Assets changed after approval. Approve them again.",
  "copyright-approval-missing": "Run and approve the copyright check.",
  "copyright-approval-stale": "The copyright check changed after approval. Approve it again.",
  "voice-missing": "Generate narration in the Voice stage.",
  "voice-stale": "Narration is older than the approved script. Generate it again.",
  "captions-missing": "Prepare captions in the Captions stage.",
  "captions-stale": "Captions are older than the approved script. Prepare them again.",
  "visual-mapping-not-approved": "Approve the visual mapping below.",
};

// Named after artifacts rather than stages: the cut gate can fire on a workflow
// template that has no Media step, and a label may not point at a missing screen.
const EDIT_RENDER_GATE_LABELS = {
  "copyright-approval-missing": "Approve the copyright check before cutting source footage.",
  "copyright-approval-stale": "The copyright check changed after approval. Approve it again.",
  "source-media-missing": "Import a source video into this project.",
  "edit-manifest-missing": "Create an edit manifest from a subtitle file.",
  "edit-manifest-keeps-no-cues": "Every cue is marked remove. Keep at least one cue to cut.",
};

function renderGateNotice(snapshot) {
  const gate = snapshot.renderGate;
  if (!gate || gate.allowed) {
    return null;
  }
  const notice = document.createElement("ul");
  notice.className = "render-gate-notice";
  for (const reason of gate.reasons) {
    const item = document.createElement("li");
    item.textContent = RENDER_GATE_LABELS[reason] ?? reason;
    notice.append(item);
  }
  return notice;
}

function renderCutControls(snapshot) {
  const gate = snapshot.editRenderGate;
  const toolbar = document.createElement("div");
  toolbar.className = "cut-toolbar";
  const badge = document.createElement("span");
  badge.className = `mapping-status mapping-status-${gate?.allowed ? "approved" : "missing"}`;
  badge.textContent = gate?.allowed ? "cut ready" : "cut gated";
  toolbar.append(badge, actionButton("Render Cut", () => requestCutRender(), "button", "primary"));

  const children = [
    paragraph("Cuts the imported source video down to the cues kept in the Translation stage, and writes subtitles realigned to the cut."),
    toolbar,
  ];
  if (gate && !gate.allowed) {
    const notice = document.createElement("ul");
    notice.className = "render-gate-notice";
    for (const reason of gate.reasons) {
      const item = document.createElement("li");
      item.textContent = EDIT_RENDER_GATE_LABELS[reason] ?? reason;
      notice.append(item);
    }
    children.push(notice);
  }
  return wrapSection("Subtitle-driven cut", ...children);
}

function renderRender(snapshot) {
  const mapping = snapshot.visualMapping;
  const gateNotice = renderGateNotice(snapshot);
  // Built before the early return below: a cut project never has a visual
  // mapping, so appending it only on the mapped path hides it from every
  // project that actually needs it.
  const cutControls = renderCutControls(snapshot);
  const toolbar = document.createElement("div");
  toolbar.className = "render-toolbar";
  const statusBadge = document.createElement("span");
  statusBadge.className = `mapping-status mapping-status-${mapping?.status ?? "missing"}`;
  statusBadge.textContent = mapping ? `${mapping.status} · ${mapping.segments.length} scenes` : "mapping missing";
  toolbar.append(
    statusBadge,
    actionButton(mapping ? "Regenerate mapping" : "Generate mapping", () => requestVisualMapping()),
    actionButton("Approve mapping", () => approveVisualMapping()),
    actionButton("Render Draft", () => requestRender(), "button", "primary"),
  );

  if (!mapping?.segments?.length) {
    stageContent.replaceChildren(
      toolbar,
      ...(gateNotice ? [gateNotice] : []),
      paragraph("Generate a visual mapping to open the timeline editor."),
      cutControls,
    );
    return;
  }

  const selected = mapping.segments.find((segment) => segment.id === appState.selectedMappingSceneId) ?? mapping.segments[0];
  appState.selectedMappingSceneId = selected.id;
  const assets = snapshot.assetManifest?.assets ?? [];
  const editor = document.createElement("div");
  editor.className = "render-editor";
  editor.append(renderMonitor(selected, assets), renderInspector(selected, assets), renderTimeline(mapping, assets));
  stageContent.replaceChildren(
    toolbar,
    ...(gateNotice ? [gateNotice] : []),
    editor,
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions", "render", "cut"]),
    cutControls,
  );
}

function renderMonitor(segment, assets) {
  const monitor = document.createElement("section");
  monitor.className = "render-monitor";
  const viewport = document.createElement("div");
  viewport.className = "monitor-viewport";
  const asset = assets.find((candidate) => candidate.id === segment.assetId);
  if (asset?.mediaType === "image") {
    const image = document.createElement("img");
    image.src = projectFileUrl(asset.relativePath);
    image.alt = `${asset.filename} preview`;
    viewport.append(image);
  } else if (asset?.mediaType === "video") {
    const video = document.createElement("video");
    video.src = projectFileUrl(asset.relativePath);
    video.muted = true;
    video.controls = true;
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(segment.sourceStartSeconds, video.duration || 0); }, { once: true });
    viewport.append(video);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "monitor-fallback";
    fallback.textContent = "Generated background";
    viewport.append(fallback);
  }
  const overlay = document.createElement("div");
  overlay.className = "monitor-overlay";
  overlay.textContent = segment.narration;
  viewport.append(overlay);
  const meta = document.createElement("div");
  meta.className = "monitor-meta";
  meta.append(strongText(segment.id), document.createTextNode(`${formatTimecode(segment.startSeconds)} → ${formatTimecode(segment.endSeconds)}`));
  monitor.append(viewport, meta);
  return monitor;
}

function renderInspector(segment, assets) {
  const form = document.createElement("form");
  form.className = "render-inspector";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveVisualMappingSegment(segment.id, form).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    sectionTitle("Clip Inspector"),
    paragraph(`${segment.id} · ${formatTimecode(segment.startSeconds)}-${formatTimecode(segment.endSeconds)}`),
    confidenceMeter(segment.confidence),
    paragraph(segment.reason),
    selectField("Asset", "assetId", segment.assetId ?? "", [["", "Generated background"], ...assets.map((asset) => [asset.id, asset.filename])]),
    selectField("Fit", "fitMode", segment.fitMode, [["cover", "Cover"], ["contain", "Contain"]]),
    // Visual mapping produces fractional seconds, so the default step="1" would
    // make native validation reject the value and silently block the submit.
    field("Source start (seconds)", "sourceStartSeconds", String(segment.sourceStartSeconds), "number", "", "any"),
    field("Source duration (max 5s for video)", "sourceDurationSeconds", String(segment.sourceDurationSeconds), "number", "", "any"),
    checkboxField("Mute source audio", "muteSourceAudio", segment.muteSourceAudio),
    actionButton("Save mapping", null, "submit", "primary"),
  );
  return form;
}

function renderTimeline(mapping, assets) {
  const timeline = document.createElement("section");
  timeline.className = "render-timeline";
  const duration = Math.max(...mapping.segments.map((segment) => segment.endSeconds), 1);
  const ruler = document.createElement("div");
  ruler.className = "timeline-ruler";
  const tickStep = duration > 90 ? 15 : duration > 45 ? 10 : 5;
  for (let second = 0; second <= duration; second += tickStep) {
    const tick = document.createElement("span");
    tick.style.left = `${(second / duration) * 100}%`;
    tick.textContent = formatTimecode(second);
    ruler.append(tick);
  }
  const tracks = document.createElement("div");
  tracks.className = "timeline-tracks";
  tracks.append(timelineTrackLabel("V1", "Visual"), timelineClipTrack(mapping, assets, duration), timelineTrackLabel("A1", "Narration"), narrationTrack(mapping, duration));
  const selected = mapping.segments.find((segment) => segment.id === appState.selectedMappingSceneId) ?? mapping.segments[0];
  const playhead = document.createElement("div");
  playhead.className = "timeline-playhead";
  playhead.style.left = `calc(92px + (100% - 92px) * ${selected.startSeconds / duration})`;
  timeline.append(ruler, tracks, playhead);
  return timeline;
}

function timelineClipTrack(mapping, assets, duration) {
  const track = document.createElement("div");
  track.className = "timeline-track timeline-visual-track";
  for (const segment of mapping.segments) {
    const asset = assets.find((candidate) => candidate.id === segment.assetId);
    const clip = document.createElement("button");
    clip.type = "button";
    clip.className = `timeline-clip timeline-${asset?.mediaType ?? "fallback"}${segment.id === appState.selectedMappingSceneId ? " selected" : ""}${segment.confidence < 0.35 ? " low-confidence" : ""}`;
    clip.style.left = `${(segment.startSeconds / duration) * 100}%`;
    clip.style.width = `${Math.max(2.5, ((segment.endSeconds - segment.startSeconds) / duration) * 100)}%`;
    clip.title = `${segment.id}: ${asset?.filename ?? "Generated background"}`;
    if (asset?.mediaType === "image") clip.style.backgroundImage = `linear-gradient(90deg, rgba(10,15,25,.25), rgba(10,15,25,.55)), url("${projectFileUrl(asset.relativePath)}")`;
    const name = document.createElement("strong");
    name.textContent = asset?.filename ?? "Background";
    const time = document.createElement("small");
    time.textContent = `${formatSeconds(segment.endSeconds - segment.startSeconds)} · ${Math.round(segment.confidence * 100)}%`;
    clip.append(name, time);
    clip.addEventListener("click", () => selectMappingScene(segment.id));
    track.append(clip);
  }
  return track;
}

function narrationTrack(mapping, duration) {
  const track = document.createElement("div");
  track.className = "timeline-track timeline-audio-track";
  for (const segment of mapping.segments) {
    const block = document.createElement("button");
    block.type = "button";
    block.className = "timeline-narration";
    block.style.left = `${(segment.startSeconds / duration) * 100}%`;
    block.style.width = `${Math.max(2.5, ((segment.endSeconds - segment.startSeconds) / duration) * 100)}%`;
    block.textContent = segment.narration;
    block.addEventListener("click", () => selectMappingScene(segment.id));
    track.append(block);
  }
  return track;
}

function timelineTrackLabel(code, label) {
  const element = document.createElement("div");
  element.className = "timeline-track-label";
  element.innerHTML = `<strong>${code}</strong><span>${label}</span>`;
  return element;
}

function selectMappingScene(sceneId) {
  appState.selectedMappingSceneId = sceneId;
  renderRender(appState.projectSnapshot);
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

// A hand-edited studio.config.json can hold a provider the studio will refuse to
// use. It is listed as it is rather than dropped, so the screen never shows a
// provider that differs from the one Generate Script will complain about.
function scriptProviderOptions(current) {
  const options = [
    ["dry-run", "Dry run (offline template)"],
    ["openai-compatible", "OpenAI-compatible"],
  ];
  if (typeof current === "string" && current && !options.some(([value]) => value === current)) {
    options.push([current, `${current} (unrecognized — pick a valid provider)`]);
  }
  return options;
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

  const scriptReady = config.script.provider === "dry-run"
    ? ["done", "Ready (offline)"]
    : config.script.provider === "openai-compatible" && config.script.model && config.script.baseUrl
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const translationReady = config.translation.provider === "prompt-only"
    ? ["done", "Ready (manual)"]
    : config.translation.model
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const asrReady = config.asr.provider === "disabled"
    ? ["neutral", "Optional"]
    : config.asr.executablePath
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const ttsProvider = config.tts.defaultProvider;
  const ttsReady = ttsProvider === "piper"
    ? (config.tts.piper.executablePath && config.tts.piper.modelPath ? ["done", "Ready"] : ["warn", "Needs setup"])
    : ttsProvider === "vietnamese-local"
      ? (config.tts.vietnameseLocal.pythonPath && config.tts.vietnameseLocal.appPath ? ["done", "Ready"] : ["warn", "Needs setup"])
      : (config.tts.openai.apiKeyEnv ? ["done", "Ready"] : ["warn", "Needs setup"]);
  const renderReady = config.render.ffmpegPath && config.render.ffprobePath ? ["done", "Ready"] : ["warn", "Needs setup"];
  const sourcesReady = config.sources.ytDlpPath ? ["done", "Ready"] : ["neutral", "Optional"];

  form.replaceChildren(
    configSection("Script", scriptReady[0], scriptReady[1], [
      selectField("Script provider", "script.provider", config.script.provider, scriptProviderOptions(config.script.provider)),
      field("Script model", "script.model", config.script.model),
      field("Script base URL", "script.baseUrl", config.script.baseUrl),
      field("Script API key env", "script.apiKeyEnv", config.script.apiKeyEnv),
      checkboxField("Script provider is paid", "script.paid", config.script.paid),
      field("Script temperature", "script.temperature", String(config.script.temperature), "number", "", "any"),
      field("Script max output tokens", "script.maxOutputTokens", String(config.script.maxOutputTokens), "number"),
    ]),
    configSection("Translation", translationReady[0], translationReady[1], [
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
    ]),
    configSection("ASR", asrReady[0], asrReady[1], [
      selectField("ASR provider", "asr.provider", config.asr.provider, [
        ["disabled", "Disabled"],
        ["faster-whisper", "Faster Whisper"],
        ["whisper-cpp", "whisper.cpp"],
      ]),
      field("ASR executable", "asr.executablePath", config.asr.executablePath),
      field("ASR model", "asr.model", config.asr.model),
      field("ASR model path", "asr.modelPath", config.asr.modelPath),
      field("ASR language", "asr.language", config.asr.language),
    ]),
    configSection("Voice", ttsReady[0], ttsReady[1], [
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
    ]),
    configSection("Render", renderReady[0], renderReady[1], [
      field("FFmpeg path", "render.ffmpegPath", config.render.ffmpegPath),
      field("FFprobe path", "render.ffprobePath", config.render.ffprobePath),
      field("Shorts width", "render.shortsWidth", String(config.render.shortsWidth), "number"),
      field("Shorts height", "render.shortsHeight", String(config.render.shortsHeight), "number"),
    ]),
    configSection("Story Factory", config.storyFactory.enabled ? "done" : "neutral", config.storyFactory.enabled ? "Enabled" : "Disabled", [
      checkboxField("Story factory enabled", "storyFactory.enabled", config.storyFactory.enabled),
      field("Planner model", "storyFactory.models.planner.model", config.storyFactory.models.planner.model),
      field("Planner base URL", "storyFactory.models.planner.baseUrl", config.storyFactory.models.planner.baseUrl),
      field("Planner API key env", "storyFactory.models.planner.apiKeyEnv", config.storyFactory.models.planner.apiKeyEnv),
      checkboxField("Planner is paid", "storyFactory.models.planner.paid", config.storyFactory.models.planner.paid),
      field("Writer model", "storyFactory.models.writer.model", config.storyFactory.models.writer.model),
      field("Writer base URL", "storyFactory.models.writer.baseUrl", config.storyFactory.models.writer.baseUrl),
      field("Writer API key env", "storyFactory.models.writer.apiKeyEnv", config.storyFactory.models.writer.apiKeyEnv),
      checkboxField("Writer is paid", "storyFactory.models.writer.paid", config.storyFactory.models.writer.paid),
      field("QA model", "storyFactory.models.qa.model", config.storyFactory.models.qa.model),
      field("QA base URL", "storyFactory.models.qa.baseUrl", config.storyFactory.models.qa.baseUrl),
      field("QA API key env", "storyFactory.models.qa.apiKeyEnv", config.storyFactory.models.qa.apiKeyEnv),
      checkboxField("QA is paid", "storyFactory.models.qa.paid", config.storyFactory.models.qa.paid),
      field("Duplicate similarity threshold", "storyFactory.duplicateSimilarityThreshold", String(config.storyFactory.duplicateSimilarityThreshold), "number", "", "any"),
      field("Default max cost per story (USD)", "storyFactory.defaultMaxCostPerStoryUsd", String(config.storyFactory.defaultMaxCostPerStoryUsd), "number", "", "any"),
    ]),
    configSection("Google TTS", config.tts.google.apiKeyEnv ? "done" : "warn", "Story narration", [
      field("Google TTS API key env", "tts.google.apiKeyEnv", config.tts.google.apiKeyEnv),
      field("Google TTS base URL", "tts.google.baseUrl", config.tts.google.baseUrl),
      selectField("Audio encoding", "tts.google.audioEncoding", config.tts.google.audioEncoding, [
        ["MP3", "MP3"],
        ["LINEAR16", "WAV (LINEAR16)"],
      ]),
      field("Chunk min chars", "tts.google.chunkMinChars", String(config.tts.google.chunkMinChars), "number"),
      field("Chunk max chars", "tts.google.chunkMaxChars", String(config.tts.google.chunkMaxChars), "number"),
      field("Economy USD / 1M chars", "tts.google.pricing.economy", String(config.tts.google.pricing.economy), "number", "", "any"),
      field("Standard USD / 1M chars", "tts.google.pricing.standard", String(config.tts.google.pricing.standard), "number", "", "any"),
      field("Premium USD / 1M chars", "tts.google.pricing.premium", String(config.tts.google.pricing.premium), "number", "", "any"),
    ]),
    configSection("Images", config.images.provider === "gemini" ? "done" : "neutral", config.images.provider === "gemini" ? "Gemini" : "Disabled", [
      selectField("Image provider", "images.provider", config.images.provider, [
        ["disabled", "Disabled"],
        ["gemini", "Gemini"],
      ]),
      field("Gemini API key env", "images.gemini.apiKeyEnv", config.images.gemini.apiKeyEnv),
      field("Gemini image model", "images.gemini.model", config.images.gemini.model),
      field("USD per image (approx.)", "images.gemini.usdPerImage", String(config.images.gemini.usdPerImage), "number", "", "any"),
    ]),
    configSection("Sources", sourcesReady[0], sourcesReady[1], [
      field("yt-dlp path", "sources.ytDlpPath", config.sources.ytDlpPath),
      textareaField("yt-dlp args", "sources.ytDlpArgs", (config.sources.ytDlpArgs ?? []).join("\n")),
      field("Download format", "sources.format", config.sources.format),
      textareaField("Subtitle languages", "sources.subtitleLanguages", (config.sources.subtitleLanguages ?? []).join("\n")),
      selectField("Default source search", "sources.defaultSearchPlatform", config.sources.defaultSearchPlatform, sourcePlatformOptions()),
      field("Source search limit", "sources.searchLimit", String(config.sources.searchLimit), "number"),
      field("YouTube search prefix", "sources.searchPrefixes.youtube", config.sources.searchPrefixes.youtube),
      field("Bilibili search prefix", "sources.searchPrefixes.bilibili", config.sources.searchPrefixes.bilibili),
      field("TikTok search prefix", "sources.searchPrefixes.tiktok", config.sources.searchPrefixes.tiktok),
      field("Douyin search prefix", "sources.searchPrefixes.douyin", config.sources.searchPrefixes.douyin),
    ]),
    actionButton("Save Config", null, "submit", "primary"),
  );
  stageContent.replaceChildren(form);
  setStatus("Config loaded. Secrets stay in environment variables, not in this file.");
}

async function runAvailableTasks() {
  const workflow = appState.projectSnapshot?.workflow;
  if (!workflow || !appState.selectedProject) {
    setStatus("Select a project first.");
    return;
  }

  const runnable = workflow.steps.filter((step) => step.canRun && taskActionForStep(step));
  if (runnable.length === 0) {
    setStatus("No UI-runnable tasks are ready. Complete the current manual step first.");
    return;
  }

  const groups = runnable.reduce((map, step) => {
    const key = step.parallelGroup ?? step.id;
    map.set(key, [...(map.get(key) ?? []), step]);
    return map;
  }, new Map());
  const groupLabel = [...groups.entries()].map(([group, steps]) => `${group}: ${steps.map((step) => step.title).join(", ")}`);
  setStatus(`Running available tasks. ${groupLabel.join(" | ")}`);

  const results = await Promise.allSettled(runnable.map((step) => runStepTask(step)));
  const failures = results.filter((result) => result.status === "rejected");
  const started = results.filter((result) => result.status === "fulfilled" && result.value?.job).length;
  await selectProject(appState.selectedProject);
  if (failures.length > 0) {
    setStatus(`${runnable.length - failures.length}/${runnable.length} tasks completed. ${failures[0].reason.message}`);
    return;
  }
  const background = started > 0 ? ` ${started} running in the background.` : "";
  setStatus(`${runnable.length - started} available task(s) completed.${background}${pendingApprovalNotice()}`);
}

function pendingApprovalNotice() {
  const waiting = (appState.projectSnapshot?.workflow?.steps ?? [])
    .filter((step) => APPROVAL_STEP_IDS.has(step.id) && step.status !== "done")
    .map((step) => step.title);
  return waiting.length > 0 ? ` Waiting on your approval: ${waiting.join(", ")}.` : "";
}

// Steps whose completion is a human approval. The batch runner may prepare their
// inputs but must never sign them off, so they are always left to the operator.
const APPROVAL_STEP_IDS = new Set(["script", "assets", "copyright", "source-risk"]);

function taskActionForStep(step) {
  return {
    script: "script",
    "extract-audio": "media/audio",
    asr: "asr",
    translation: "subtitles/translation-prompt",
    voice: "voice",
    captions: "captions",
    "source-risk": "copyright-check",
    copyright: "copyright-check",
    render: "render",
  }[step.id];
}

async function runStepTask(step) {
  if (step.id === "voice" && appState.config?.tts?.defaultProvider === "openai") {
    throw new Error("OpenAI voice needs paid confirmation. Run Voice step manually.");
  }
  if (step.id === "script" && paidScriptModelConfigured()) {
    throw new Error("Paid script model needs confirmation. Run Generate Script manually.");
  }
  if (step.id === "copyright" || step.id === "source-risk") {
    await runProjectRoute("copyright-check", {
      commentaryPercent: 70,
      footagePercent: 15,
      longestClipSeconds: 5,
      usesFullScene: false,
      thumbnailFromCopyrightFrame: false,
      clipsHaveCommentaryPurpose: true,
    });
    return {};
  }
  if (step.id === "voice") {
    const provider = appState.config?.tts?.defaultProvider ?? "piper";
    const voice = appState.config?.tts?.[provider === "vietnamese-local" ? "vietnameseLocal" : provider]?.voice;
    return runProjectRoute("voice", { provider, voice, confirmedPaidRequest: false });
  }
  if (step.id === "translation") {
    await runProjectRoute("subtitles/translation-prompt", {
      source: sourceSubtitlePath(),
      target: appState.config?.translation?.defaultTarget ?? "vi",
      genre: appState.config?.translation?.defaultGenre ?? "cultivation",
    });
    return {};
  }
  return runProjectRoute(taskActionForStep(step), {});
}

async function runProjectRoute(route, body) {
  const response = await fetch(projectApiUrl(route), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${data.code}: ${data.message}`);
  }
  return data;
}

async function saveConfig(form) {
  const nextConfig = structuredClone(appState.config);
  for (const input of Array.from(form.elements)) {
    if (!input.name) continue;
    setPathValue(nextConfig, input.name, configInputValue(input));
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

function configInputValue(input) {
  if (input.type === "number") return Number(input.value);
  if (input.type === "checkbox") return input.checked;
  if (input.name === "sources.ytDlpArgs" || input.name === "sources.subtitleLanguages") return lines(input.value);
  return input.value;
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
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus(`Voice ready: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

// Only a hosted model can cost money. A leftover `paid: true` on the offline
// template must not raise a spend dialog for a local string template.
function paidScriptModelConfigured() {
  return appState.config?.script?.provider === "openai-compatible" && appState.config?.script?.paid === true;
}

async function requestScript(confirmedPaidRequest) {
  if (!confirmedPaidRequest && paidScriptModelConfigured()) {
    paidScriptDialog.showModal();
    return;
  }
  const response = await fetch(projectApiUrl("script"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmedPaidRequest }),
  });
  const data = await response.json();
  if (response.status === 409 && data.code === "paid-confirmation-required") {
    paidScriptDialog.showModal();
    return;
  }
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus("Script generated.");
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
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus(`Rendered: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function requestCutRender() {
  const response = await fetch(projectApiUrl("edit-render"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message || (data.details?.reasons ?? []).join(", ")}`);
    return;
  }
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus(`Cut rendered: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function requestVisualMapping() {
  const response = await fetch(projectApiUrl("visual-mapping/generate"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  setStatus(`Generated mapping for ${data.mapping.segments.length} scenes.`);
  await selectProject(appState.selectedProject);
}

async function approveVisualMapping() {
  const response = await fetch(projectApiUrl("visual-mapping/approve"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  setStatus("Visual mapping approved.");
  await selectProject(appState.selectedProject);
}

async function saveVisualMappingSegment(sceneId, form) {
  const values = boolFormValues(form);
  const response = await fetch(projectApiUrl(`visual-mapping/segments/${encodeURIComponent(sceneId)}`), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  setStatus(`Saved ${sceneId}. Mapping approval is now required again.`);
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

async function saveAssetMetadata(assetId, form) {
  const values = boolFormValues(form);
  if (!String(values.usagePurpose ?? "").trim()) {
    throw new Error("Usage purpose is required before saving an asset.");
  }

  const response = await fetch(projectApiUrl(`assets/${encodeURIComponent(assetId)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      usagePurpose: values.usagePurpose,
      rightsConfirmed: values.rightsConfirmed,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  setStatus(`Saved asset details for ${data.asset.filename}. Approve Assets again when ready.`);
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
  if (reportedAsJob(response, data)) {
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

function linkButton(label, relativePath) {
  const link = document.createElement("a");
  link.className = "button-link";
  link.href = projectFileUrl(relativePath);
  link.target = "_blank";
  link.textContent = label;
  return link;
}

function configSection(title, level, label, fields) {
  const section = document.createElement("div");
  section.className = "config-section";
  const header = document.createElement("div");
  header.className = "config-section-header";
  header.append(sectionTitle(title), readinessPill(level, label));
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "config-section-fields";
  fieldWrap.append(...fields);
  section.append(header, fieldWrap);
  return section;
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

function parseEpisodeNumbers(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((number) => Number.isInteger(number) && number > 0);
}


function targetOptions() {
  return (appState.translationPresets?.presets ?? []).map((preset) => [preset.language ?? preset.target, preset.label]);
}

function workflowTypeOptions() {
  return (appState.workflowTemplates?.templates ?? []).map((template) => [template.type, template.title]);
}

function sourcePlatformOptions() {
  return [
    ["youtube", "YouTube"],
    ["bilibili", "Bilibili"],
    ["tiktok", "TikTok (URL-only unless search prefix is configured)"],
    ["douyin", "Douyin (URL-only unless search prefix is configured)"],
  ];
}

function translationTargetLabels() {
  return (appState.translationPresets?.presets ?? []).map((preset) => preset.label);
}


function seriesEpisodeProjectIds() {
  return new Set(appState.series.flatMap((series) => series.episodes.map((episode) => episode.episodeProjectId)));
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

// Pairs, because selectField destructures each entry as [value, label]. An
// object literal here throws "is not iterable" and takes the whole screen with it.
const SOURCE_RIGHTS_OPTIONS = [
  ["unknown", "Not declared"],
  ["own", "I own this footage"],
  ["licensed", "I hold a licence"],
  ["third-party-fair-use", "Third party, review commentary"],
];

async function renderSources() {
  stageTitle.textContent = "Sources";
  setActiveStageButton("sources");
  seriesPanel.replaceChildren();
  setStatus("Loading sources...");

  let sources = [];
  try {
    sources = (await (await fetch("/api/sources")).json()).sources ?? [];
  } catch (error) {
    setStatus(error.message);
  }

  const addForm = document.createElement("form");
  addForm.className = "form-grid";
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { url } = formValues(addForm);
      const data = await postJson("/api/sources", { url });
      setStatus(data.created ? `Added ${data.candidate.title}.` : `Already tracked: ${data.candidate.title}.`);
      await renderSources();
    } catch (error) {
      setStatus(error.message);
    }
  });

  const searchForm = document.createElement("form");
  searchForm.className = "form-grid source-search-form";
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await searchSources(boolFormValues(searchForm));
  });
  const expandedQueries = textareaField(
    "Expanded queries",
    "expandedQueries",
    (appState.sourceSearchFilters.expandedQueries ?? buildSourceSearchQueries(appState.sourceSearchFilters)).join("\n"),
  );
  expandedQueries.classList.add("source-query-preview");
  searchForm.replaceChildren(
    field("Keyword", "query", appState.sourceSearchFilters.query ?? "", "text", "牧神记 episode 1"),
    selectField("Platform", "platform", appState.sourceSearchFilters.platform ?? appState.config?.sources?.defaultSearchPlatform ?? "youtube", sourcePlatformOptions()),
    field("Limit", "limit", String(appState.sourceSearchFilters.limit ?? appState.config?.sources?.searchLimit ?? 8), "number"),
    checkboxField("Expand Bilibili/Douyin query", "expandBilibiliQuery", appState.sourceSearchFilters.expandBilibiliQuery !== false),
    field("Include keywords", "includeKeywords", appState.sourceSearchFilters.includeKeywords ?? "", "text", "episode, recap"),
    field("Exclude keywords", "excludeKeywords", appState.sourceSearchFilters.excludeKeywords ?? "", "text", "official, trailer"),
    field("Max views", "maxViews", String(appState.sourceSearchFilters.maxViews || ""), "number"),
    checkboxField("Hide short clips", "hideShortClips", appState.sourceSearchFilters.hideShortClips === true),
    expandedQueries,
    sourceSearchToolbar(),
  );

  addForm.replaceChildren(
    field("Video URL", "url", "", "text", "https://www.youtube.com/watch?v=..."),
    actionButton("Add Source", null, "submit", "primary"),
  );

  // Rights are permission to download, and only that. A project still needs its
  // own approved copyright checklist before anything renders, and this screen
  // must not let anyone believe otherwise.
  const boundary = paragraph(
    "One pasted URL at a time, for making original review commentary. " +
      "Declaring rights permits the download only — a project still needs its own approved copyright check before it can render.",
  );
  boundary.className = "source-boundary";

  stageContent.replaceChildren(
    gateNotice(
      "Discovery only",
      "Searching and tracking a candidate does not grant reuse permission. Declaring rights permits the download only — a project still needs its own approved copyright check before it can render.",
      "block",
    ),
    wrapSection(
      "Search by keyword",
      paragraph("Find possible review sources first. Search results are not downloaded or tracked until you choose one."),
      searchForm,
      renderSourceSearchResults(filterSourceSearchResults(appState.sourceSearchResults, appState.sourceSearchFilters)),
    ),
    wrapSection(
      "Add a source",
      paragraph("Paste a video URL. Metadata is read first; nothing is downloaded until you declare rights."),
      addForm,
    ),
    wrapSection("Candidates", boundary, renderSourceList(sources)),
  );
  setStatus(`${sources.length} source${sources.length === 1 ? "" : "s"} tracked.`);
}

function renderSourceSearchResults(results) {
  const wrapper = document.createElement("div");
  wrapper.className = "source-search-results";
  if (!results.length) {
    wrapper.append(paragraph("No keyword search results yet."));
    return wrapper;
  }

  for (const result of results) {
    const card = document.createElement("article");
    card.className = "source-result-card";
    const children = [];
    if (result.thumbnailUrl) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "source-thumbnail";
      thumbnail.src = result.thumbnailUrl;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      children.push(thumbnail);
    }
    const title = document.createElement("h4");
    title.textContent = result.title;
    const meta = document.createElement("p");
    meta.className = "source-meta";
    meta.textContent = [
      result.platform,
      result.uploader || "unknown channel",
      formatSourceDuration(result.durationSeconds),
      result.viewCount ? `${result.viewCount.toLocaleString()} views` : "views unknown",
    ].join(" · ");
    const triage = triageSourceSearchResult(result);
    const badge = document.createElement("span");
    badge.className = `source-triage source-triage-${triage.risk}`;
    badge.textContent = triage.label;
    badge.title = triage.reason;
    const matched = document.createElement("p");
    matched.className = "source-matched-query";
    matched.textContent = result.matchedQuery ? `Matched query: ${result.matchedQuery}` : "Matched query: original keyword";
    const link = document.createElement("a");
    link.href = result.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = result.url;
    const actions = document.createElement("div");
    actions.className = "source-actions";
    actions.append(actionButton("Track Source", () => trackSource(result.url), "button", "primary"));
    card.append(...children, title, meta, badge, matched, link, actions);
    wrapper.append(card);
  }
  return wrapper;
}

function sourceSearchToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "source-search-toolbar field-wide";
  toolbar.append(
    actionButton("Refresh expanded queries", () => refreshSourceExpandedQueries(), "button"),
    actionButton("Search Sources", null, "submit", "primary"),
  );
  return toolbar;
}

function refreshSourceExpandedQueries() {
  const form = document.querySelector(".source-search-form");
  if (!form) return;
  const values = boolFormValues(form);
  const preview = form.elements.namedItem("expandedQueries");
  if (preview) preview.value = buildSourceSearchQueries(values, { ignoreEditedQueryList: true }).join("\n");
}

async function searchSources(values) {
  try {
    const queries = buildSourceSearchQueries(values);
    appState.sourceSearchFilters = {
      query: values.query,
      platform: values.platform,
      limit: values.limit,
      includeKeywords: values.includeKeywords,
      excludeKeywords: values.excludeKeywords,
      maxViews: Number(values.maxViews) > 0 ? values.maxViews : "",
      hideShortClips: values.hideShortClips === true,
      expandBilibiliQuery: values.expandBilibiliQuery !== false,
      expandedQueries: queries,
    };
    const searches = await Promise.all(
      queries.map(async (query) => {
        const data = await postJson("/api/sources/search", {
          query,
          platform: values.platform,
          limit: values.limit,
        });
        return (data.results ?? []).map((result) => ({ ...result, matchedQuery: query }));
      }),
    );
    appState.sourceSearchResults = dedupeSourceSearchResults(searches.flat());
    const visible = filterSourceSearchResults(appState.sourceSearchResults, appState.sourceSearchFilters).length;
    setStatus(`${visible}/${appState.sourceSearchResults.length} source search result(s) visible after filters.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function dedupeSourceSearchResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = result.url || `${result.platform}:${result.id ?? result.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function filterSourceSearchResults(results, filters) {
  const include = lines(filters.includeKeywords).map(lower);
  const exclude = lines(filters.excludeKeywords).map(lower);
  const maxViews = Number(filters.maxViews);
  return results.filter((result) => {
    const haystack = lower(`${result.title} ${result.uploader} ${result.url}`);
    if (include.length && !include.some((term) => haystack.includes(term))) return false;
    if (exclude.some((term) => haystack.includes(term))) return false;
    if (Number.isFinite(maxViews) && maxViews > 0 && Number(result.viewCount) > maxViews) return false;
    if (filters.hideShortClips === true && triageSourceSearchResult(result).label === "short clip") return false;
    return true;
  });
}

/**
 * Rates how workable a result is as review material, and nothing else.
 *
 * It deliberately does not rank by how likely a rights holder is to enforce.
 * Popularity does not weaken fair use, and a rights holder posting their own
 * work does not strengthen it — a badge built on those signals would be steering
 * the operator toward whoever is least likely to object, which is target
 * selection, not review judgement.
 */
function triageSourceSearchResult(result) {
  const haystack = lower(`${result.title} ${result.uploader}`);
  const durationSeconds = Number(result.durationSeconds);

  if (/(trailer|teaser|pv|预告|preview)/.test(haystack)) {
    return { label: "promo material", risk: "warn", reason: "Trailers and teasers are promotional cuts with little story to analyse." };
  }
  if (durationSeconds > 0 && durationSeconds < 180) {
    return { label: "short clip", risk: "warn", reason: "Short clips often lack enough story context for a review." };
  }
  if (!durationSeconds || !lower(result.title).trim()) {
    return { label: "thin metadata", risk: "warn", reason: "Missing duration or title makes this hard to judge before downloading." };
  }
  if (/(official|官方|腾讯|youku|iqiyi)/.test(haystack)) {
    return { label: "official channel", risk: "ok", reason: "Posted by the rights holder, which is the best place to verify the source." };
  }
  return { label: "review-friendly", risk: "ok", reason: "Metadata looks usable for human review triage." };
}

async function trackSource(url) {
  try {
    const data = await postJson("/api/sources", { url });
    appState.sourceSearchResults = appState.sourceSearchResults.filter((result) => result.url !== url);
    setStatus(data.created ? `Tracking ${data.candidate.title}.` : `Already tracked: ${data.candidate.title}.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function renderSourceList(sources) {
  if (!sources.length) {
    return paragraph("No sources yet. Paste a URL above to start.");
  }

  const list = document.createElement("ul");
  list.className = "source-list";
  // Unscored candidates sort last rather than being hidden: a score is an
  // ordinal hint, not a filter.
  const ranked = [...sources].sort((left, right) => (right.score?.value ?? -1) - (left.score?.value ?? -1));
  for (const candidate of ranked) {
    list.append(renderSourceRow(candidate));
  }
  return list;
}

function renderSourceRow(candidate) {
  const item = document.createElement("li");
  item.className = `source-row source-status-${candidate.status}`;

  const heading = document.createElement("h4");
  heading.textContent = candidate.title;

  const meta = document.createElement("p");
  meta.className = "source-meta";
  meta.textContent = [
    candidate.platform,
    candidate.uploader || "unknown channel",
    formatSourceDuration(candidate.durationSeconds),
    candidate.status,
  ].join(" · ");

  const children = [heading, meta];

  if (candidate.score) {
    children.push(renderSourceScore(candidate.score));
  }

  if (candidate.error) {
    const failure = document.createElement("p");
    failure.className = "source-error";
    failure.textContent = candidate.error;
    children.push(failure);
  }

  const rightsForm = document.createElement("form");
  rightsForm.className = "form-grid source-rights";
  rightsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await patchJson(`/api/sources/${encodeURIComponent(candidate.id)}`, formValues(rightsForm));
      setStatus(`Rights recorded for ${candidate.title}.`);
      await renderSources();
    } catch (error) {
      setStatus(error.message);
    }
  });
  rightsForm.replaceChildren(
    selectField("Rights", "rights", candidate.rights, SOURCE_RIGHTS_OPTIONS),
    field("Note", "rightsNote", candidate.rightsNote),
    actionButton("Save rights", null, "submit"),
  );

  const actions = document.createElement("div");
  actions.className = "source-actions";
  const download = actionButton("Download", () => startSourceJob(candidate.id, "download"), "button", "primary");
  if (candidate.rights === "unknown") {
    download.disabled = true;
    download.title = "Declare rights before downloading.";
  }
  actions.append(
    actionButton("Score", () => startSourceJob(candidate.id, "score")),
    download,
    actionButton("Delete", () => deleteSource(candidate.id, candidate.title)),
  );

  item.replaceChildren(...children, rightsForm, actions);
  return item;
}

/**
 * The number never stands alone. A score is one model reading metadata it has not
 * verified, so the angle it proposes, the risks it saw, and what produced it are
 * shown beside it.
 */
function renderSourceScore(score) {
  const panel = document.createElement("div");
  panel.className = "source-score";

  const value = document.createElement("strong");
  value.textContent = `${score.value}/100`;

  const angle = document.createElement("p");
  angle.textContent = `Angle: ${score.angle}`;

  const reason = document.createElement("p");
  reason.className = "source-score-reason";
  reason.textContent = score.reason;

  panel.append(value, angle, reason);

  if (score.risks?.length) {
    const risks = document.createElement("ul");
    risks.className = "source-risks";
    for (const risk of score.risks) {
      const entry = document.createElement("li");
      entry.textContent = risk;
      risks.append(entry);
    }
    panel.append(risks);
  }

  const provenance = document.createElement("p");
  provenance.className = "source-score-provenance";
  provenance.textContent = `Scored by ${score.provider} · ${score.model}`;
  panel.append(provenance);

  return panel;
}

async function startSourceJob(id, action) {
  try {
    const response = await fetch(`/api/sources/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(`${data.code}: ${data.message}`);
      return;
    }
    setStatus(`${action} running in the background for ${id}.`);
    followSourceJob(id);
  } catch (error) {
    setStatus(error.message);
  }
}

function followSourceJob(id) {
  const stream = new EventSource(`/api/sources/${encodeURIComponent(id)}/events`);
  stream.addEventListener("job", async (event) => {
    const job = JSON.parse(event.data);
    setStatus(`${job.kind} ${job.status}: ${job.message}`);
    if (job.status !== "running") {
      stream.close();
      await renderSources();
    }
  });
  stream.addEventListener("error", () => stream.close());
}

async function deleteSource(id, title) {
  if (!confirm(`Delete the source "${title}" and every file downloaded for it?`)) return;
  try {
    const response = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      setStatus(`${data.code}: ${data.message}`);
      return;
    }
    setStatus(`Deleted ${title}.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function formatSourceDuration(seconds) {
  if (!seconds) return "duration unknown";
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// =============================== AI Story Factory ===============================
// Full-screen screens (the renderSources pattern): dashboard, story detail,
// channel settings, and the voice lab. All state lives in storyFactoryState so
// job events can refresh the open screen.

const storyFactoryState = { channelId: null, storyId: null, statusFilter: "" };

const STORY_STAGE_LIST = [
  "idea", "hook", "outline", "bible", "sections", "continuity-qa", "naturalize", "originality-qa",
  "tts-normalize", "tts", "scenes", "images", "bgm", "render", "metadata", "thumbnail", "final-qa", "export",
];
const STORY_STATUS_LEVELS = {
  DRAFT: "neutral", IN_PROGRESS: "progress", GENERATING: "progress", AWAITING_APPROVAL: "warn",
  FAILED: "block", BUDGET_PAUSED: "warn", READY_TO_PUBLISH: "done", PUBLISHED: "done",
};
const STORY_RUN_LEVELS = { pending: "neutral", running: "progress", done: "done", failed: "block", stale: "warn", "awaiting-approval": "warn" };
const EDITABLE_STORY_STAGES = new Set(["idea", "hook", "outline", "bible", "naturalize", "metadata"]);
const STORY_TABS = [
  ["overview", "Overview"], ["idea", "Idea"], ["hook", "Hook"], ["outline", "Outline"], ["bible", "Bible"],
  ["script", "Script"], ["audio", "Audio"], ["scenes", "Scenes"], ["images", "Images"], ["video", "Video"],
  ["thumbnail", "Thumbnail"], ["metadata", "Metadata"], ["ai-log", "AI Logs"], ["cost", "Cost"],
];

async function renderStoryFactory() {
  stageTitle.textContent = "Story Factory";
  setActiveStageButton("story-factory");
  seriesPanel.replaceChildren();
  storyFactoryState.storyId = null;
  if (!storyFactoryState.channelId && appState.series.length > 0) {
    storyFactoryState.channelId = appState.series[0].id;
  }
  const channelId = storyFactoryState.channelId;
  if (!channelId) {
    stageContent.replaceChildren(
      gateNotice("No channel yet", "Create a series first - a story channel is a series plus its story settings.", "info"),
    );
    setStatus("Create a series to host the story channel.");
    return;
  }
  setStatus("Loading stories...");
  const [storiesData, channelData] = await Promise.all([
    fetchJsonOrNull(storyApiUrl(channelId, "stories")),
    fetchJsonOrNull(storyApiUrl(channelId, "story-channel")),
  ]);
  const stories = storiesData?.stories ?? [];
  const channel = channelData?.storyChannel ?? {};

  const pickerForm = document.createElement("form");
  pickerForm.className = "form-grid compact-form";
  pickerForm.addEventListener("submit", (event) => event.preventDefault());
  const channelSelect = selectField("Channel", "channelId", channelId, appState.series.map((series) => [series.id, series.title || series.id]));
  channelSelect.querySelector("select").addEventListener("change", (event) => {
    storyFactoryState.channelId = event.target.value;
    renderStoryFactory().catch((error) => setStatus(error.message));
  });
  const statusFilter = selectField("Status filter", "statusFilter", storyFactoryState.statusFilter, [
    ["", "All"],
    ...Object.keys(STORY_STATUS_LEVELS).map((value) => [value, value]),
  ]);
  statusFilter.querySelector("select").addEventListener("change", (event) => {
    storyFactoryState.statusFilter = event.target.value;
    renderStoryFactory().catch((error) => setStatus(error.message));
  });
  pickerForm.replaceChildren(
    channelSelect,
    statusFilter,
    actionButton("Channel Settings", () => renderStoryChannelSettings(channelId).catch((error) => setStatus(error.message))),
    actionButton("Voice Lab", () => renderVoiceLab(channelId).catch((error) => setStatus(error.message))),
  );

  const createForm = document.createElement("form");
  createForm.className = "form-grid";
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(createForm);
    postJson(storyApiUrl(channelId, "stories"), {
      id: values.id,
      title: values.title,
      subNiche: values.subNiche,
      targetDurationMinutes: Number(values.targetDurationMinutes),
      tone: values.tone,
      mode: values.mode,
    })
      .then(() => renderStoryFactory())
      .catch((error) => setStatus(error.message));
  });
  createForm.replaceChildren(
    field("Story id", "id", "", "text", "es-horror-001"),
    field("Working title", "title", ""),
    field("Sub-niche", "subNiche", channel.subNiches?.[0] ?? ""),
    field("Target minutes", "targetDurationMinutes", String(channel.defaultTargetDurationMinutes ?? 25), "number"),
    field("Tone", "tone", "calm, mysterious, slowly building dread"),
    selectField("Mode", "mode", channel.mode ?? "assisted", [
      ["assisted", "Assisted (generate all, review before publish)"],
      ["manual", "Manual (approve each gate)"],
    ]),
    actionButton("Create Story", null, "submit", "primary"),
  );

  const visible = stories.filter((story) => !storyFactoryState.statusFilter || story.status === storyFactoryState.statusFilter);
  const table = document.createElement("table");
  table.className = "story-table";
  const head = document.createElement("tr");
  for (const label of ["Story", "Sub-niche", "Locale", "Mode", "Minutes", "Status", "Cost (USD)", "Updated"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const story of visible) {
    const row = document.createElement("tr");
    const titleCell = document.createElement("td");
    titleCell.append(actionButton(story.title || story.id, () => renderStoryDetail(channelId, story.id).catch((error) => setStatus(error.message))));
    const statusCell = document.createElement("td");
    statusCell.append(readinessPill(STORY_STATUS_LEVELS[story.status] ?? "neutral", story.status));
    row.append(
      titleCell,
      tableCell(story.subNiche || "-"),
      tableCell(story.locale),
      tableCell(story.mode),
      tableCell(String(story.targetDurationMinutes)),
      statusCell,
      tableCell(story.totalCostUsd.toFixed(4)),
      tableCell(new Date(story.updatedAt).toLocaleString()),
    );
    table.append(row);
  }
  const tableWrapper = document.createElement("div");
  tableWrapper.className = "table-scroll";
  tableWrapper.append(table);

  stageContent.replaceChildren(
    wrapSection("Channel", pickerForm, channelBadgeRow(channel)),
    wrapSection("Create Story", createForm),
    wrapSection("Stories", visible.length > 0 ? tableWrapper : paragraph("No stories yet. Create one above.")),
  );
  setStatus(`${stories.length} stor${stories.length === 1 ? "y" : "ies"} on ${channelId}.`);
}

function channelBadgeRow(channel) {
  const enabled = appState.config?.storyFactory?.enabled === true;
  return summaryGrid({
    "Factory flag": enabled ? "enabled" : "disabled (Config -> Story Factory)",
    Language: `${channel.language ?? "?"} (${channel.locale ?? "?"})`,
    Niche: channel.niche ?? "?",
    Voice: channel.ttsProfile?.voiceName || "not chosen - open the Voice Lab",
    "Budget / story": `$${channel.budget?.maxCostPerStoryUsd ?? "?"}`,
    Mode: channel.mode ?? "assisted",
  });
}

async function renderStoryDetail(channelId, storyId, tab = "overview") {
  storyFactoryState.channelId = channelId;
  storyFactoryState.storyId = storyId;
  ensureProjectEventStream(channelId);
  const detail = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}`));
  if (!detail) {
    setStatus(`Story ${storyId} not found.`);
    return renderStoryFactory();
  }
  stageTitle.textContent = `${detail.story.title} - ${detail.status}`;
  setActiveStageButton("story-factory");
  seriesPanel.replaceChildren();

  const tabs = document.createElement("nav");
  tabs.className = "story-tabs";
  for (const [id, label] of STORY_TABS) {
    const button = actionButton(label, () => renderStoryDetail(channelId, storyId, id).catch((error) => setStatus(error.message)));
    if (id === tab) button.classList.add("selected");
    tabs.append(button);
  }
  const back = actionButton("Back to stories", () => renderStoryFactory().catch((error) => setStatus(error.message)));

  const body = await renderStoryTab(channelId, storyId, tab, detail);
  stageContent.replaceChildren(back, tabs, ...body);
  setStatus(`${storyId}: ${detail.status}`);
}

async function renderStoryTab(channelId, storyId, tab, detail) {
  if (tab === "overview") return renderStoryOverview(channelId, storyId, detail);
  if (tab === "script") return renderStoryArtifactView(channelId, storyId, "sections", detail, (artifact) => [preBlock(artifact.fullText)]);
  if (tab === "audio") return renderStoryAudioTab(channelId, storyId);
  if (tab === "images") return renderStoryImagesTab(channelId, storyId);
  if (tab === "video") return renderStoryVideoTab(channelId, storyId);
  if (tab === "thumbnail") return renderStoryThumbnailTab(channelId, storyId);
  if (tab === "ai-log") return renderStoryAiLogTab(channelId, storyId);
  if (tab === "cost") return renderStoryCostTab(channelId, storyId);
  return renderStoryArtifactView(channelId, storyId, tab, detail);
}

function renderStoryOverview(channelId, storyId, detail) {
  const story = detail.story;
  const summary = summaryGrid({
    Status: detail.status,
    Language: `${story.config.language} (${story.config.locale})`,
    "Niche / sub-niche": `${story.config.niche} / ${story.config.subNiche || "-"}`,
    "Target minutes": String(story.config.targetDurationMinutes),
    Mode: story.config.mode,
    Voice: story.config.ttsProfile.voiceName || "(channel default missing)",
    "Budget (USD)": String(story.config.budget.maxCostPerStoryUsd),
    "Total cost (USD)": String(detail.totalCostUsd),
  });

  const runForm = document.createElement("form");
  runForm.className = "form-grid compact-form";
  runForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = boolFormValues(runForm);
    if (values.confirmPaid !== true) {
      setStatus("Tick the paid confirmation first: the pipeline calls paid LLM, TTS, and image APIs.");
      return;
    }
    postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/pipeline/run`), { confirmedPaidRequest: true })
      .then((data) => setStatus(`${JOB_LABELS[data.job?.kind] ?? "Job"} started.`))
      .catch((error) => setStatus(error.message));
  });
  runForm.replaceChildren(
    checkboxField("I confirm paid API spend for this run", "confirmPaid", false),
    actionButton("Generate Full Story", null, "submit", "primary"),
  );

  const stageTable = document.createElement("table");
  stageTable.className = "story-table";
  const head = document.createElement("tr");
  for (const label of ["Stage", "Status", "Attempts", "Cost", "Error", "Actions"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  stageTable.append(head);
  for (const stage of STORY_STAGE_LIST) {
    const run = story.stages[stage];
    const row = document.createElement("tr");
    const statusCell = document.createElement("td");
    statusCell.append(readinessPill(STORY_RUN_LEVELS[run?.status ?? "pending"] ?? "neutral", run?.status ?? "pending"));
    const actions = document.createElement("td");
    if (stage !== "export") {
      actions.append(
        actionButton(run?.status === "failed" ? "Retry" : "Run", () => runStoryStage(channelId, storyId, stage, false)),
        actionButton("Regenerate", () => runStoryStage(channelId, storyId, stage, true)),
      );
    }
    row.append(
      tableCell(stage),
      statusCell,
      tableCell(String(run?.attemptCount ?? 0)),
      tableCell(run?.costUsd ? run.costUsd.toFixed(4) : "-"),
      tableCell(run?.lastError ? `${run.lastError.classification}: ${run.lastError.message.slice(0, 120)}` : "-"),
      actions,
    );
    stageTable.append(row);
  }
  const stageWrapper = document.createElement("div");
  stageWrapper.className = "table-scroll";
  stageWrapper.append(stageTable);

  const approvals = document.createElement("div");
  approvals.className = "form-grid compact-form";
  for (const approval of ["script", "media", "final"]) {
    const record = story.approvals[approval];
    approvals.append(
      readinessPill(record ? "done" : "neutral", `${approval}: ${record ? "approved" : "not approved"}`),
      actionButton(`Approve ${approval}`, () => {
        postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/approve/${approval}`), { note: "approved in studio" })
          .then(() => renderStoryDetail(channelId, storyId))
          .catch((error) => setStatus(error.message));
      }),
    );
  }
  approvals.append(
    actionButton("Export publish package", () => {
      postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/export`), {})
        .then(() => renderStoryDetail(channelId, storyId))
        .catch((error) => setStatus(error.message));
    }, "button", "primary"),
  );

  const sections = [
    wrapSection("Overview", summary),
    wrapSection("Generate", runForm),
    wrapSection("Stages", stageWrapper),
    wrapSection("Approvals & Publish", paragraph("Approvals are hash-bound: editing an approved artifact makes its approval stale."), approvals),
  ];
  const exportArtifact = detail.artifacts?.export;
  if (exportArtifact) {
    sections.push(wrapSection("Export package", seriesLinkButton(channelId, "Open export.json", exportArtifact)));
  }
  return sections;
}

function runStoryStage(channelId, storyId, stage, regenerate) {
  postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/stages/${stage}/run`), {
    confirmedPaidRequest: true,
    regenerate,
  })
    .then((data) => setStatus(`${JOB_LABELS[data.job?.kind] ?? "Stage job"} started (${stage}).`))
    .catch((error) => setStatus(error.message));
}

async function renderStoryArtifactView(channelId, storyId, stage, detail, custom) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/${stage}`));
  if (!data) {
    return [wrapSection(stage, paragraph(`Stage ${stage} has produced no artifact yet. Run it from the Overview tab.`))];
  }
  if (custom) {
    return [wrapSection(stage, ...custom(data.artifact))];
  }
  if (!EDITABLE_STORY_STAGES.has(stage)) {
    return [wrapSection(stage, preBlock(JSON.stringify(data.artifact, null, 2)))];
  }
  const editor = document.createElement("textarea");
  editor.className = "artifact-editor";
  editor.rows = 24;
  editor.value = JSON.stringify(data.artifact, null, 2);
  const save = actionButton("Save (invalidates dependents)", () => {
    let parsed;
    try {
      parsed = JSON.parse(editor.value);
    } catch (error) {
      setStatus(`Not valid JSON: ${error.message}`);
      return;
    }
    putJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/${stage}`), parsed)
      .then((result) => setStatus(`Saved. Marked stale: ${result.invalidated.join(", ") || "nothing"}.`))
      .catch((error) => setStatus(error.message));
  }, "button", "primary");
  return [wrapSection(`${stage} (editable)`, editor, save)];
}

async function renderStoryAudioTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/tts`));
  if (!data) return [wrapSection("Audio", paragraph("No narration yet."))];
  const manifest = data.artifact;
  const player = document.createElement("audio");
  player.controls = true;
  player.src = seriesFileUrl(channelId, manifest.mergedPath);
  const chunkTable = document.createElement("table");
  chunkTable.className = "story-table";
  for (const chunk of manifest.chunks) {
    const row = document.createElement("tr");
    const retry = document.createElement("td");
    if (chunk.status === "failed") {
      retry.append(actionButton("Retry chunk", () => {
        postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/tts/chunks/${chunk.index}/retry`), { confirmedPaidRequest: true })
          .then((result) => setStatus(`${JOB_LABELS[result.job?.kind] ?? "Job"} started (chunk ${chunk.index}).`))
          .catch((error) => setStatus(error.message));
      }));
    }
    row.append(
      tableCell(`#${chunk.index}`),
      tableCell(`${chunk.chars} chars`),
      tableCell(chunk.status),
      tableCell(chunk.durationSeconds ? `${chunk.durationSeconds.toFixed(1)}s` : "-"),
      tableCell(chunk.lastError ?? ""),
      retry,
    );
    chunkTable.append(row);
  }
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.append(chunkTable);
  return [
    wrapSection("Narration", player, summaryGrid({
      Voice: `${manifest.voiceName} (${manifest.languageCode})`,
      Duration: `${Math.round(manifest.totalDurationSeconds)}s`,
      Chunks: String(manifest.chunks.length),
      Loudness: manifest.loudnormApplied ? "normalized" : "raw",
    })),
    wrapSection("Chunks", wrapper),
  ];
}

async function renderStoryImagesTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/images`));
  if (!data) return [wrapSection("Images", paragraph("No images yet."))];
  const grid = document.createElement("div");
  grid.className = "story-image-grid";
  for (const image of data.artifact.images) {
    const card = document.createElement("figure");
    if (image.status === "done") {
      const img = document.createElement("img");
      img.src = seriesFileUrl(channelId, image.relativePath);
      img.alt = image.sceneId;
      img.loading = "lazy";
      card.append(img);
    } else {
      card.append(paragraph(`${image.sceneId}: ${image.status}${image.lastError ? ` - ${image.lastError}` : ""}`));
      card.append(actionButton("Retry image", () => {
        postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/images/${image.sceneId}/retry`), { confirmedPaidRequest: true })
          .then((result) => setStatus(`${JOB_LABELS[result.job?.kind] ?? "Job"} started (${image.sceneId}).`))
          .catch((error) => setStatus(error.message));
      }));
    }
    const caption = document.createElement("figcaption");
    caption.textContent = `${image.sceneId} - ${image.prompt.slice(0, 90)}`;
    card.append(caption);
    grid.append(card);
  }
  return [wrapSection("Scene images", grid)];
}

async function renderStoryVideoTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/render`));
  if (!data) return [wrapSection("Video", paragraph("Not rendered yet."))];
  const video = document.createElement("video");
  video.controls = true;
  video.src = seriesFileUrl(channelId, data.artifact.videoPath);
  return [wrapSection("Rendered video", video, summaryGrid({
    Duration: `${Math.round(data.artifact.durationSeconds)}s`,
    Size: `${data.artifact.width}x${data.artifact.height}`,
  }))];
}

async function renderStoryThumbnailTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/thumbnail`));
  if (!data) return [wrapSection("Thumbnail", paragraph("No thumbnail yet."))];
  const img = document.createElement("img");
  img.src = seriesFileUrl(channelId, data.artifact.finalPath);
  img.alt = "thumbnail";
  img.className = "story-thumbnail-preview";
  return [wrapSection("Thumbnail", img, paragraph(`Overlay: ${data.artifact.overlayText}. To change it, edit thumbnailText in the Metadata tab and regenerate the thumbnail stage - the background image is reused.`))];
}

async function renderStoryAiLogTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/ai-log`));
  const entries = data?.entries ?? [];
  if (entries.length === 0) return [wrapSection("AI Logs", paragraph("No AI calls yet."))];
  const table = document.createElement("table");
  table.className = "story-table";
  const head = document.createElement("tr");
  for (const label of ["At", "Stage", "Prompt", "Model", "Tokens", "Cost", "Time", "OK"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const entry of entries.slice().reverse()) {
    const row = document.createElement("tr");
    row.append(
      tableCell(new Date(entry.at).toLocaleTimeString()),
      tableCell(entry.stage),
      tableCell(`${entry.promptName}@${entry.promptVersion}`),
      tableCell(entry.model),
      tableCell(entry.usage ? `${entry.usage.promptTokens}+${entry.usage.completionTokens}` : "n/a"),
      tableCell(entry.costUsd ? entry.costUsd.toFixed(5) : "0"),
      tableCell(`${entry.durationMs}ms`),
      tableCell(entry.ok ? "ok" : `failed: ${(entry.error ?? "").slice(0, 80)}`),
    );
    table.append(row);
  }
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.append(table);
  return [wrapSection("AI execution log", wrapper)];
}

async function renderStoryCostTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/cost`));
  if (!data) return [wrapSection("Cost", paragraph("No spend recorded."))];
  return [
    wrapSection("This story", summaryGrid({
      LLM: `$${data.cost.llmUsd}`,
      TTS: `$${data.cost.ttsUsd}`,
      Images: `$${data.cost.imageUsd}`,
      Total: `$${data.cost.totalUsd}`,
    })),
    wrapSection("Channel totals", summaryGrid({
      LLM: `$${data.channelTotals.byKind.llm}`,
      TTS: `$${data.channelTotals.byKind.tts}`,
      Images: `$${data.channelTotals.byKind.image}`,
      Total: `$${data.channelTotals.totalUsd}`,
      Stories: String(Object.keys(data.channelTotals.byStory).length),
    })),
  ];
}

async function renderStoryChannelSettings(channelId) {
  stageTitle.textContent = "Story Channel Settings";
  setActiveStageButton("story-factory");
  seriesPanel.replaceChildren();
  const data = await fetchJsonOrNull(storyApiUrl(channelId, "story-channel"));
  const channel = data?.storyChannel ?? {};
  const form = document.createElement("form");
  form.className = "form-grid";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = boolFormValues(form);
    putJson(storyApiUrl(channelId, "story-channel"), {
      enabled: values.enabled,
      language: values.language,
      locale: values.locale,
      niche: values.niche,
      subNiches: lines(values.subNiches),
      promptStyle: values.promptStyle,
      defaultTargetDurationMinutes: Number(values.defaultTargetDurationMinutes),
      mode: values.mode,
      ttsProfile: {
        provider: "google",
        tier: values.tier,
        voiceName: values.voiceName,
        languageCode: values.languageCode,
        speakingRate: Number(values.speakingRate),
        pitch: Number(values.pitch),
      },
      visualStyleProfile: {
        stylePrompt: values.stylePrompt,
        negativePrompt: values.negativePrompt,
        imageIntervalSeconds: Number(values.imageIntervalSeconds),
        aspectRatio: "16:9",
      },
      bgm: { ambienceTrackPath: values.ambienceTrackPath, volumeDb: Number(values.volumeDb) },
      pronunciations: lines(values.pronunciations)
        .map((line) => {
          const [original, pronunciation] = line.split("=");
          return { original: (original ?? "").trim(), pronunciation: (pronunciation ?? "").trim() };
        })
        .filter((rule) => rule.original && rule.pronunciation),
      budget: { maxCostPerStoryUsd: Number(values.maxCostPerStoryUsd) },
    })
      .then(() => {
        setStatus("Channel settings saved.");
        return renderStoryFactory();
      })
      .catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    checkboxField("Channel enabled", "enabled", channel.enabled ?? false),
    field("Language", "language", channel.language ?? "es"),
    field("Locale", "locale", channel.locale ?? "es-MX"),
    field("Niche", "niche", channel.niche ?? "horror"),
    textareaField("Sub-niches (one per line)", "subNiches", (channel.subNiches ?? []).join("\n")),
    textareaField("Prompt style", "promptStyle", channel.promptStyle ?? ""),
    field("Default target minutes", "defaultTargetDurationMinutes", String(channel.defaultTargetDurationMinutes ?? 25), "number"),
    selectField("Mode", "mode", channel.mode ?? "assisted", [["assisted", "Assisted"], ["manual", "Manual"]]),
    selectField("TTS tier", "tier", channel.ttsProfile?.tier ?? "economy", [["economy", "Economy"], ["standard", "Standard"], ["premium", "Premium"]]),
    field("Voice name", "voiceName", channel.ttsProfile?.voiceName ?? "", "text", "es-US-Neural2-B"),
    field("Voice language code", "languageCode", channel.ttsProfile?.languageCode ?? "es-US"),
    field("Speaking rate", "speakingRate", String(channel.ttsProfile?.speakingRate ?? 0.95), "number", "", "any"),
    field("Pitch", "pitch", String(channel.ttsProfile?.pitch ?? 0), "number", "", "any"),
    textareaField("Visual style prompt", "stylePrompt", channel.visualStyleProfile?.stylePrompt ?? ""),
    textareaField("Negative prompt", "negativePrompt", channel.visualStyleProfile?.negativePrompt ?? ""),
    field("Seconds per image", "imageIntervalSeconds", String(channel.visualStyleProfile?.imageIntervalSeconds ?? 75), "number"),
    field("Ambience track path (licensed)", "ambienceTrackPath", channel.bgm?.ambienceTrackPath ?? ""),
    field("Ambience volume dB", "volumeDb", String(channel.bgm?.volumeDb ?? -22), "number", "", "any"),
    textareaField("Pronunciations (original=pronunciation per line)", "pronunciations", (channel.pronunciations ?? []).map((rule) => `${rule.original}=${rule.pronunciation}`).join("\n")),
    field("Max cost per story (USD)", "maxCostPerStoryUsd", String(channel.budget?.maxCostPerStoryUsd ?? 5), "number", "", "any"),
    actionButton("Save Channel Settings", null, "submit", "primary"),
  );
  stageContent.replaceChildren(
    actionButton("Back to stories", () => renderStoryFactory().catch((error) => setStatus(error.message))),
    wrapSection(`Channel: ${channelId}`, form),
  );
  setStatus("Channel settings loaded.");
}

async function renderVoiceLab(channelId) {
  stageTitle.textContent = "TTS Voice Lab";
  setActiveStageButton("story-factory");
  seriesPanel.replaceChildren();
  const channelData = await fetchJsonOrNull(storyApiUrl(channelId, "story-channel"));
  const channel = channelData?.storyChannel ?? {};

  const controls = document.createElement("form");
  controls.className = "form-grid compact-form";
  controls.replaceChildren(
    field("Language code", "languageCode", channel.ttsProfile?.languageCode ?? "es-US"),
    field("Speaking rate", "speakingRate", String(channel.ttsProfile?.speakingRate ?? 0.95), "number", "", "any"),
    field("Pitch", "pitch", String(channel.ttsProfile?.pitch ?? 0), "number", "", "any"),
    textareaField("Sample text (same for every voice, max 500 chars; empty = Spanish horror sample)", "text", ""),
    checkboxField("I confirm paid TTS sample spend", "confirmPaid", false),
    actionButton("List Voices", null, "submit", "primary"),
  );
  const results = document.createElement("div");
  controls.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = boolFormValues(controls);
    fetchJsonOrNull(storyApiUrl(channelId, `voice-lab/voices?languageCode=${encodeURIComponent(values.languageCode)}`))
      .then((data) => {
        results.replaceChildren(voiceLabTable(channelId, values, data?.voices ?? []));
        setStatus(`${data?.voices?.length ?? 0} voices for ${values.languageCode}.`);
      })
      .catch((error) => setStatus(error.message));
  });

  stageContent.replaceChildren(
    actionButton("Back to stories", () => renderStoryFactory().catch((error) => setStatus(error.message))),
    wrapSection(
      "Voice Lab",
      paragraph("Compare Google voices reading the same sample, then set the channel narrator. Samples are cached, so replaying a voice is free."),
      controls,
      results,
    ),
  );
  setStatus("Voice Lab ready. List voices to begin.");
}

function voiceLabTable(channelId, values, voices) {
  const table = document.createElement("table");
  table.className = "story-table";
  const head = document.createElement("tr");
  for (const label of ["Voice", "Tier", "Gender", "Sample", "Default"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const voice of voices) {
    const row = document.createElement("tr");
    const sampleCell = document.createElement("td");
    const audio = document.createElement("audio");
    audio.controls = true;
    sampleCell.append(
      actionButton("Generate sample", () => {
        if (values.confirmPaid !== true) {
          setStatus("Tick the paid confirmation first.");
          return;
        }
        postJson(storyApiUrl(channelId, "voice-lab/sample"), {
          voiceName: voice.name,
          languageCode: values.languageCode,
          speakingRate: Number(values.speakingRate),
          pitch: Number(values.pitch),
          tier: voice.tier,
          text: values.text,
          confirmedPaidRequest: true,
        })
          .then((data) => {
            audio.src = data.sample.url;
            setStatus(`Sample ready (${data.sample.durationSeconds.toFixed(1)}s, ~$${data.sample.estimatedCostUsd}).`);
          })
          .catch((error) => setStatus(error.message));
      }),
      audio,
    );
    const defaultCell = document.createElement("td");
    defaultCell.append(
      actionButton("Set as channel default", () => {
        putJson(storyApiUrl(channelId, "story-channel"), {
          ttsProfile: {
            provider: "google",
            tier: voice.tier === "unknown" ? "economy" : voice.tier,
            voiceName: voice.name,
            languageCode: values.languageCode,
            speakingRate: Number(values.speakingRate),
            pitch: Number(values.pitch),
          },
        })
          .then(() => setStatus(`${voice.name} is now the channel narrator.`))
          .catch((error) => setStatus(error.message));
      }),
    );
    row.append(tableCell(voice.name), tableCell(voice.tier), tableCell(voice.ssmlGender), sampleCell, defaultCell);
    table.append(row);
  }
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.append(table);
  return wrapper;
}

