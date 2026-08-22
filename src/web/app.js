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

const RUN_AVAILABLE_TASKS_LABEL = "Run available tasks";

const appState = {
  projects: [],
  series: [],
  reviewProjectsBySeries: {},
  audioStoryWorkspaces: {},
  brandKits: {},
  thumbnailBriefs: {},
  selectedSeries: null,
  selectedReviewProjectId: null,
  selectedProject: null,
  activeStage: "brief",
  projectSnapshot: null,
  translationPresets: null,
  workflowTemplates: null,
  config: null,
  selectedMappingSceneId: null,
  eventStream: null,
  eventStreamProject: null,
  activeJob: null,
};

const JOB_LABELS = { voice: "Voice", render: "Render", asr: "ASR", captions: "Captions", asset: "Asset analysis", script: "Script" };

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
document.querySelector("#open-series").addEventListener("click", () => renderSeriesManager());
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
  renderProjects();
  if (location.hash === "#series") {
    renderSeriesManager();
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
  stageRail.replaceChildren(
    ...stages.map((stage) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.stage = stage;
      button.textContent = STAGE_TITLES[stage] ?? stage;
      item.append(button);
      return item;
    }),
  );
  bindStageRail();
  setActiveStageButton();
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
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
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
      appState.selectedReviewProjectId = null;
      renderSeriesManager();
    });
    if (appState.selectedSeries?.id === series.id) button.classList.add("selected");
    list.append(button);
  }
  return wrapSection("Series", list);
}

function renderSeriesDetail(series) {
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

  return wrapSection(
    `${series.title} - ${series.episodes.length} episodes`,
    summaryGrid({
      Show: series.show,
      Original: series.originalTitle,
      Workflow: series.workflowType,
      Audience: series.audience,
      Language: series.language,
      Schedule: series.scheduleNotes,
    }),
    renderBrandKitPanel(series),
    planForm,
    table,
    series.workflowType === "audio-story" ? renderAudioStoryPanel(series) : renderBatchReviewPanel(series),
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

function renderRender(snapshot) {
  const mapping = snapshot.visualMapping;
  const gateNotice = renderGateNotice(snapshot);
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
    artifactList(snapshot.state?.artifacts ?? {}, ["voice", "captions", "render"]),
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
    field("Source start (seconds)", "sourceStartSeconds", String(segment.sourceStartSeconds), "number"),
    field("Source duration (max 5s for video)", "sourceDurationSeconds", String(segment.sourceDurationSeconds), "number"),
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

function confidenceMeter(value) {
  const wrapper = document.createElement("div");
  wrapper.className = "confidence-meter";
  const bar = document.createElement("span");
  bar.style.width = `${Math.round(value * 100)}%`;
  wrapper.append(bar, document.createTextNode(`${Math.round(value * 100)}% match`));
  return wrapper;
}

function strongText(value) {
  const element = document.createElement("strong");
  element.textContent = value;
  return element;
}

function formatTimecode(value) {
  const total = Math.max(0, Number(value));
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const frames = Math.floor((total % 1) * 30);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
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
    selectField("Script provider", "script.provider", config.script.provider, [
      ["dry-run", "Dry run (offline template)"],
      ["openai-compatible", "OpenAI-compatible"],
    ]),
    field("Script model", "script.model", config.script.model),
    field("Script base URL", "script.baseUrl", config.script.baseUrl),
    field("Script API key env", "script.apiKeyEnv", config.script.apiKeyEnv),
    checkboxField("Script provider is paid", "script.paid", config.script.paid),
    field("Script temperature", "script.temperature", String(config.script.temperature), "number", "", "any"),
    field("Script max output tokens", "script.maxOutputTokens", String(config.script.maxOutputTokens), "number"),
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
  if (step.id === "script" && appState.config?.script?.paid) {
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
    setPathValue(
      nextConfig,
      input.name,
      input.type === "number" ? Number(input.value) : input.type === "checkbox" ? input.checked : input.value,
    );
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
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus(`Voice ready: ${data.artifact.relativePath}`);
  await selectProject(appState.selectedProject);
}

async function requestScript(confirmedPaidRequest) {
  if (!confirmedPaidRequest && appState.config?.script?.paid) {
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

function formatSeconds(value) { return `${Number(value).toFixed(1)}s`; }

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

function formatBytes(sizeBytes) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
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

function wrapSection(title, ...children) {
  const section = document.createElement("section");
  section.className = "subpanel";
  section.append(sectionTitle(title), ...children);
  return section;
}

function inlineInput(name, value) {
  const input = document.createElement("input");
  input.name = name;
  input.value = value ?? "";
  return input;
}

function linkButton(label, relativePath) {
  const link = document.createElement("a");
  link.className = "button-link";
  link.href = projectFileUrl(relativePath);
  link.target = "_blank";
  link.textContent = label;
  return link;
}

function seriesLinkButton(seriesId, label, relativePath) {
  const link = document.createElement("a");
  link.className = "button-link";
  link.href = seriesFileUrl(seriesId, relativePath);
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

function field(label, name, value, type = "text", placeholder = "", step = "1") {
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
    input.step = step;
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

function reviewProjectApiUrl(seriesId, reviewProjectId, route) {
  return `/api/series/${encodeURIComponent(seriesId)}/review-projects/${encodeURIComponent(reviewProjectId)}/${route}`;
}

function projectFileUrl(relativePath) {
  return `/api/projects/${encodeURIComponent(appState.selectedProject)}/files/${encodeURIComponent(relativePath)}`;
}

function seriesFileUrl(seriesId, relativePath) {
  return `/api/projects/${encodeURIComponent(seriesId)}/files/${encodeURIComponent(relativePath)}`;
}

function parseEpisodeNumbers(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function lines(value) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function targetOptions() {
  return (appState.translationPresets?.presets ?? []).map((preset) => [preset.language ?? preset.target, preset.label]);
}

function workflowTypeOptions() {
  return (appState.workflowTemplates?.templates ?? []).map((template) => [template.type, template.title]);
}

function translationTargetLabels() {
  return (appState.translationPresets?.presets ?? []).map((preset) => preset.label);
}

function unique(values) {
  return [...new Set(values)];
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
