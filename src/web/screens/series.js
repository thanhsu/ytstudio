import { lines } from "../search-queries.js";
import { reviewProjectApiUrl, seriesFileUrl } from "../lib/api.js";
import {
  summaryGrid, wrapSection, inlineInput,
  uploadField, fileField, paragraph, sectionTitle, readinessPill, gateNotice,
  field, textareaField, selectField, actionButton,
  formValues, boolFormValues, seriesLinkButton,
} from "../lib/dom.js";
import { setStatus } from "../lib/shell.js";
import { seriesPanel, stageTitle, stageContent } from "../lib/refs.js";
import { appState, refreshAppData } from "../lib/state.js";
import {
  selectProject, renderProjects, renderStageRail, workflowTypeOptions, setActiveStageButton,
} from "./review-project.js";

export function renderSeriesManager() {
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
  await refreshAppData();
  renderStageRail();
  renderProjects();
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
  await refreshAppData();
  renderStageRail();
  renderProjects();
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
  await refreshAppData();
  renderStageRail();
  renderProjects();
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
  await refreshAppData();
  renderStageRail();
  renderProjects();
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
