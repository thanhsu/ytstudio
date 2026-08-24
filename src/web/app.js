import { lines } from "./search-queries.js";
import {
  postJson, putJson, fetchJsonOrNull,
  reviewProjectApiUrl, storyApiUrl, seriesFileUrl,
} from "./lib/api.js";
import {
  summaryGrid, wrapSection, inlineInput,
  uploadField, fileField, paragraph, sectionTitle, readinessPill, gateNotice,
  field, textareaField, checkboxField, selectField, actionButton,
  formValues, boolFormValues, preBlock, tableCell, seriesLinkButton,
} from "./lib/dom.js";
import { bindShell, setStatus, confirmPaidVoice, confirmPaidScript } from "./lib/shell.js";
import { bindWorkspaceRefs, seriesPanel, stageTitle, stageContent } from "./lib/refs.js";
import { appState, JOB_LABELS, ensureProjectEventStream, onJobEvent, refreshAppData } from "./lib/state.js";
import { renderSources } from "./screens/sources.js";
import { renderConfig } from "./screens/config.js";
import {
  selectProject, renderProjects, renderStageRail, bindStageRail, renderCreateProject,
  runAvailableTasks, requestVoice, requestScript, workflowTypeOptions, setActiveStageButton,
} from "./screens/review-project.js";

bindShell();
bindWorkspaceRefs();

// A finished story job refreshes the open story screen; review-project.js
// handles its own project refresh via its own onJobEvent registration.
onJobEvent((job) => {
  if (job.kind.startsWith("story-") && storyFactoryState.channelId && storyFactoryState.storyId) {
    void renderStoryDetail(storyFactoryState.channelId, storyFactoryState.storyId).catch((error) => setStatus(error.message));
    return;
  }
});

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

function parseEpisodeNumbers(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((number) => Number.isInteger(number) && number > 0);
}

loadProjects().catch((error) => setStatus(error.message));

// =============================== AI Story Factory ===============================
// Full-screen screens (the renderSources pattern): dashboard, story detail,
// channel settings, and the voice lab. All state lives in storyFactoryState so
// job events can refresh the open screen.

const storyFactoryState = { channelId: null, storyId: null, statusFilter: "" };

const STORY_STAGE_LIST = [
  "idea", "hook", "outline", "bible", "sections", "continuity-qa", "naturalize", "originality-qa",
  "tts-normalize", "tts", "scenes", "images", "bgm", "render", "metadata", "thumbnail", "final-qa", "export", "publish",
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
  ["thumbnail", "Thumbnail"], ["metadata", "Metadata"], ["publish", "Publish & Analytics"], ["ai-log", "AI Logs"], ["cost", "Cost"],
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
    actionButton("Prompts", () => renderPromptSettings(channelId).catch((error) => setStatus(error.message))),
    actionButton("Calendar", () => renderStoryCalendar(channelId).catch((error) => setStatus(error.message))),
    actionButton("Compilations", () => renderCompilations(channelId).catch((error) => setStatus(error.message))),
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
  if (tab === "script") return renderStorySectionsTab(channelId, storyId);
  if (tab === "audio") return renderStoryAudioTab(channelId, storyId);
  if (tab === "images") return renderStoryImagesTab(channelId, storyId);
  if (tab === "video") return renderStoryVideoTab(channelId, storyId);
  if (tab === "thumbnail") return renderStoryThumbnailTab(channelId, storyId);
  if (tab === "publish") return renderStoryPublishTab(channelId, storyId);
  if (tab === "ai-log") return renderStoryAiLogTab(channelId, storyId);
  if (tab === "cost") return renderStoryCostTab(channelId, storyId);
  return renderStoryArtifactView(channelId, storyId, tab, detail);
}

async function renderStorySectionsTab(channelId, storyId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/sections`));
  if (!data || !data.sections?.length) return [wrapSection("Script", paragraph("No sections yet. Run the sections stage first."))];
  const sections = [];
  for (const summary of data.sections) {
    const detail = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/sections/${summary.index}`));
    if (!detail?.section) continue;
    const editor = document.createElement("textarea");
    editor.className = "artifact-editor";
    editor.rows = 10;
    editor.value = detail.section.text;
    const save = actionButton("Save section", () => {
      putJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/sections/${summary.index}`), { text: editor.value })
        .then((result) => setStatus(`Section ${summary.index} saved. Stale stages: ${result.invalidated.join(", ") || "none"}.`))
        .catch((error) => setStatus(error.message));
    }, "button", "primary");
    sections.push(wrapSection(`Section ${summary.index}: ${summary.title}`, paragraph(`${summary.wordCount} words`), editor, save));
  }
  return sections;
}

async function renderStoryPublishTab(channelId, storyId) {
  const publish = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/artifacts/publish`));
  const analytics = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/analytics`));
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    postJson(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}/publish`), { privacyStatus: values.privacyStatus, publishAt: values.publishAt || undefined })
      .then(() => setStatus("YouTube publish job started."))
      .catch((error) => setStatus(error.message));
  });
  form.replaceChildren(
    selectField("Privacy", "privacyStatus", "private", [["private", "Private"], ["unlisted", "Unlisted"], ["public", "Public"]]),
    field("Schedule (optional)", "publishAt", "", "datetime-local"),
    actionButton("Publish to YouTube", null, "submit", "primary"),
  );
  const snapshot = analytics?.analytics?.snapshots ?? [];
  const table = document.createElement("table");
  table.className = "story-table";
  table.innerHTML = "<tr><th>Bucket</th><th>Age</th><th>Views</th><th>Likes</th><th>Comments</th></tr>";
  for (const row of snapshot) table.insertAdjacentHTML("beforeend", `<tr><td>${row.bucket}</td><td>${row.ageHours}h</td><td>${row.views}</td><td>${row.likes}</td><td>${row.comments}</td></tr>`);
  const refresh = actionButton("Refresh channel analytics", () => postJson(storyApiUrl(channelId, "analytics/refresh"), {}).then(() => renderStoryDetail(channelId, storyId, "publish")).catch((error) => setStatus(error.message)));
  return [wrapSection("YouTube", publish?.artifact ? preBlock(JSON.stringify(publish.artifact, null, 2)) : paragraph("No publish record yet."), form), wrapSection("Analytics snapshots", table, refresh)];
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
      bgm: {
        ambienceTrackPath: values.ambienceTrackPath,
        volumeDb: Number(values.volumeDb),
        sfx: { sceneChange: values.sceneChangeSfxPath ? { path: values.sceneChangeSfxPath, volumeDb: Number(values.sceneChangeSfxVolumeDb) } : null },
      },
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
    field("Scene-change SFX path (licensed)", "sceneChangeSfxPath", channel.bgm?.sfx?.sceneChange?.path ?? ""),
    field("Scene-change SFX volume dB", "sceneChangeSfxVolumeDb", String(channel.bgm?.sfx?.sceneChange?.volumeDb ?? -12), "number", "", "any"),
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

async function renderPromptSettings(channelId) {
  stageTitle.textContent = "Story Prompt Management";
  seriesPanel.replaceChildren();
  const data = await fetchJsonOrNull(storyApiUrl(channelId, "prompts"));
  const sections = (data?.prompts ?? []).map((prompt) => {
    const editor = document.createElement("textarea");
    editor.className = "artifact-editor";
    editor.rows = 8;
    editor.value = prompt.override ?? "";
    const save = actionButton("Save override", () => putJson(storyApiUrl(channelId, `prompts/${encodeURIComponent(prompt.name)}`), { system: editor.value }).then(() => setStatus(`${prompt.name} saved.`)).catch((error) => setStatus(error.message)), "button", "primary");
    return wrapSection(`${prompt.name} (${prompt.version})`, paragraph(`Default template variables: ${(prompt.variables ?? []).join(", ")}`), editor, save);
  });
  stageContent.replaceChildren(actionButton("Back to Story Factory", () => renderStoryFactory().catch((error) => setStatus(error.message))), ...sections);
}

async function renderStoryCalendar(channelId) {
  stageTitle.textContent = "Story Calendar";
  seriesPanel.replaceChildren();
  const data = await fetchJsonOrNull(storyApiUrl(channelId, "calendar"));
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    postJson(storyApiUrl(channelId, "calendar"), { date: values.date, storyId: values.storyId || null, plannedPublishAt: values.plannedPublishAt || null, note: values.note || "" }).then(() => renderStoryCalendar(channelId)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(field("Date", "date", "", "date"), field("Story id", "storyId", ""), field("Planned publish", "plannedPublishAt", "", "datetime-local"), field("Note", "note", ""), actionButton("Add calendar entry", null, "submit", "primary"));
  const list = (data?.calendar?.entries ?? []).map((entry) => paragraph(`${entry.date} — ${entry.storyId || "unassigned"} — ${entry.plannedPublishAt || "no publish time"} — ${entry.note || ""}`));
  stageContent.replaceChildren(actionButton("Back to Story Factory", () => renderStoryFactory().catch((error) => setStatus(error.message))), wrapSection("Add entry", form), wrapSection("Entries", ...list));
}

async function renderCompilations(channelId) {
  stageTitle.textContent = "Compilations";
  seriesPanel.replaceChildren();
  const data = await fetchJsonOrNull(storyApiUrl(channelId, "compilations"));
  const form = document.createElement("form");
  form.className = "form-grid compact-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    postJson(storyApiUrl(channelId, "compilations"), { id: values.id, title: values.title, storyIds: lines(values.storyIds) }).then(() => renderCompilations(channelId)).catch((error) => setStatus(error.message));
  });
  form.replaceChildren(field("Compilation id", "id", "comp-001"), field("Title", "title", ""), textareaField("Rendered story ids (one per line)", "storyIds", "story-001\nstory-002\nstory-003\nstory-004"), actionButton("Create compilation", null, "submit", "primary"));
  const rows = (data?.compilations ?? []).map((entry) => paragraph(`${entry.id}: ${entry.title} (${entry.storyIds.length} stories)`));
  stageContent.replaceChildren(actionButton("Back to Story Factory", () => renderStoryFactory().catch((error) => setStatus(error.message))), wrapSection("Create", form), wrapSection("Existing", ...rows));
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
