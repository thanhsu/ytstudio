import { lines } from "../search-queries.js";
import { postJson, putJson, fetchJsonOrNull, storyApiUrl, seriesFileUrl } from "../lib/api.js";
import {
  summaryGrid, wrapSection, paragraph, readinessPill, gateNotice,
  field, textareaField, checkboxField, selectField, actionButton,
  formValues, boolFormValues, preBlock, tableCell, seriesLinkButton,
} from "../lib/dom.js";
import { setStatus } from "../lib/shell.js";
import { seriesPanel, stageTitle, stageContent } from "../lib/refs.js";
import { appState, JOB_LABELS, ensureProjectEventStream, onJobEvent, refreshAppData } from "../lib/state.js";
import { mountWorkspace } from "../lib/workspace.js";
import { navigate, parseRoute } from "../lib/router.js";
import { PHASE_LABELS } from "../lib/phases.js";

// =============================== AI Story Factory ===============================
// The story channel workspace: the phase bar carries Overview (channel settings,
// prompts, calendar, compilations, voice lab), Content (all stories and story
// detail), Edit (stories still in production), and Publish (finished stories).
// All state lives in storyFactoryState so job events can refresh the open view.

const storyFactoryState = { channelId: null, storyId: null, statusFilter: "", phaseStatuses: null };

// Stories still in production versus stories that reached the publishing lane.
const EDIT_PHASE_STATUSES = ["DRAFT", "IN_PROGRESS", "GENERATING", "AWAITING_APPROVAL", "FAILED", "BUDGET_PAUSED"];
const PUBLISH_PHASE_STATUSES = ["READY_TO_PUBLISH", "PUBLISHED"];

// The route the channel workspace is currently showing, so a mutation can
// repaint the same phase without going through the hash.
let channelRoute = null;

/**
 * Tier-2 entry point for a story channel. The channel is the route id, so the
 * old channel picker is gone; the phase bar selects what the panel shows.
 */
export async function mountChannel(route) {
  channelRoute = route;
  storyFactoryState.channelId = route.id;
  // A deep link lands here without the boot fetch.
  if (!appState.config) {
    await refreshAppData();
  }
  const series = appState.series.find((candidate) => candidate.id === route.id);
  const phase = route.storyId ? "content" : (route.phase ?? "overview");
  mountWorkspace({ screen: "channel", title: series?.title || route.id, route: { ...route, phase } });
  if (route.storyId) {
    await renderStoryDetail(route.id, route.storyId);
    return;
  }
  // Not viewing a story: clear any stale storyId from a previously open story
  // detail, or a finished job repaint (or another channel's stale id) paints
  // the wrong view over this one.
  storyFactoryState.storyId = null;
  if (phase === "overview") {
    await renderChannelOverview(route.id);
    return;
  }
  storyFactoryState.phaseStatuses = phase === "edit" ? EDIT_PHASE_STATUSES : phase === "publish" ? PUBLISH_PHASE_STATUSES : null;
  await renderStoryFactory();
}

// Repaints the open channel workspace after a mutation.
function refreshChannelScreen() {
  if (!channelRoute) return;
  void mountChannel(channelRoute).catch((error) => setStatus(error.message));
}

function channelBackButton() {
  return actionButton("Back to channel", () => refreshChannelScreen());
}

async function renderChannelOverview(channelId) {
  const data = await fetchJsonOrNull(storyApiUrl(channelId, "story-channel"));
  const channel = data?.storyChannel ?? {};
  stageTitle.textContent = PHASE_LABELS.overview;
  seriesPanel.replaceChildren();
  // A canon series is a channel project with a story-series.json sidecar, so
  // the same workspace serves both; the canon panel simply appears when the
  // sidecar is there.
  const canon = await fetchJsonOrNull(storyApiUrl(channelId, "canon/series"));
  stageContent.replaceChildren(
    wrapSection("Channel", channelBadgeRow(channel), channelToolRow(channelId)),
    ...(canon?.series ? [renderCanonPanel(channelId, canon.series)] : []),
    renderStoryChannelSettings(channelId, channel),
  );
  setStatus(`Channel ${channelId} loaded.`);
}

function channelToolRow(channelId) {
  const row = document.createElement("div");
  row.className = "form-grid compact-form";
  row.append(
    actionButton("Prompts", () => renderPromptSettings(channelId).catch((error) => setStatus(error.message))),
    actionButton("Calendar", () => renderStoryCalendar(channelId).catch((error) => setStatus(error.message))),
    actionButton("Compilations", () => renderCompilations(channelId).catch((error) => setStatus(error.message))),
    actionButton("Voice Lab", () => renderVoiceLab(channelId).catch((error) => setStatus(error.message))),
    actionButton("Stories", () => navigate({ screen: "channel", id: channelId, phase: "content" })),
  );
  return row;
}

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

// A canon chapter and a localized variant run different pipelines, so they get
// different tabs. Every tab id below is also a stage id, which is what lets the
// generic artifact viewer render Plan / Context / Continuity / Memory for free.
const CANON_CHAPTER_TABS = [
  ["overview", "Overview"], ["chapter-plan", "Plan"], ["canon-context", "Context"], ["canon-write", "Draft"],
  ["canon-continuity", "Continuity"], ["memory-extract", "Memory Delta"], ["memory-apply", "Memory Applied"],
  ["scenes", "Scenes"], ["images", "Images"], ["ai-log", "AI Logs"], ["cost", "Cost"],
];

const VARIANT_TABS = [
  ["overview", "Overview"], ["localize", "Localization"], ["script", "Script"], ["canon-alignment", "Canon Alignment"],
  ["audio", "Audio"], ["scenes", "Scenes"], ["images", "Images"], ["video", "Video"], ["thumbnail", "Thumbnail"],
  ["metadata", "Metadata"], ["publish", "Publish & Analytics"], ["ai-log", "AI Logs"], ["cost", "Cost"],
];

function tabsForStory(story) {
  if (story?.kind === "canon") return CANON_CHAPTER_TABS;
  if (story?.kind === "variant") return VARIANT_TABS;
  return STORY_TABS;
}

/**
 * The canon banner on a variant. `state` is derived from a hash comparison on
 * every read, never stored, so it cannot go quietly wrong.
 */
function canonBanner(story) {
  if (story?.kind === "variant" && story.canonRef) {
    const ref = story.canonRef;
    return gateNotice(
      `Localization of ${ref.chapterId}`,
      `Canon series ${ref.seriesId}, chapter ${ref.chapterNumber}. Canon is the source of truth: fix the story in the canon chapter, not here.`,
      "info",
    );
  }
  if (story?.kind === "canon") {
    return gateNotice(
      story.lockedAt ? "Canon chapter (LOCKED)" : "Canon chapter",
      story.lockedAt
        ? `Locked since ${story.lockedAt} because a variant of it has published. Unlock explicitly before regenerating.`
        : "This is the authoritative English chapter. Localized variants are generated from it after canon approval.",
      story.lockedAt ? "warn" : "info",
    );
  }
  return null;
}

export async function renderStoryFactory() {
  seriesPanel.replaceChildren();
  storyFactoryState.storyId = null;
  const channelId = storyFactoryState.channelId;
  if (!channelId) {
    stageContent.replaceChildren(
      gateNotice("No channel yet", "Create a series first - a story channel is a series plus its story settings.", "info"),
    );
    setStatus("Create a series to host the story channel.");
    return;
  }
  const phaseStatuses = storyFactoryState.phaseStatuses;
  stageTitle.textContent = phaseStatuses === EDIT_PHASE_STATUSES
    ? PHASE_LABELS.edit
    : phaseStatuses === PUBLISH_PHASE_STATUSES
      ? PHASE_LABELS.publish
      : "Stories";
  setStatus("Loading stories...");
  const [storiesData, channelData] = await Promise.all([
    fetchJsonOrNull(storyApiUrl(channelId, "stories")),
    fetchJsonOrNull(storyApiUrl(channelId, "story-channel")),
  ]);
  const stories = (storiesData?.stories ?? []).filter((story) => !phaseStatuses || phaseStatuses.includes(story.status));
  const channel = channelData?.storyChannel ?? {};

  const pickerForm = document.createElement("form");
  pickerForm.className = "form-grid compact-form";
  pickerForm.addEventListener("submit", (event) => event.preventDefault());
  const statusFilter = selectField("Status filter", "statusFilter", storyFactoryState.statusFilter, [
    ["", "All"],
    ...Object.keys(STORY_STATUS_LEVELS).map((value) => [value, value]),
  ]);
  statusFilter.querySelector("select").addEventListener("change", (event) => {
    storyFactoryState.statusFilter = event.target.value;
    renderStoryFactory().catch((error) => setStatus(error.message));
  });
  pickerForm.replaceChildren(
    statusFilter,
    actionButton("Channel Settings", () => navigate({ screen: "channel", id: channelId, phase: "overview" })),
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
    titleCell.append(actionButton(story.title || story.id, () => navigate({ screen: "channel", id: channelId, storyId: story.id })));
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

export async function renderStoryDetail(channelId, storyId, tab = "overview") {
  storyFactoryState.channelId = channelId;
  storyFactoryState.storyId = storyId;
  ensureProjectEventStream(channelId);
  const detail = await fetchJsonOrNull(storyApiUrl(channelId, `stories/${encodeURIComponent(storyId)}`));
  if (!detail) {
    setStatus(`Story ${storyId} not found.`);
    return renderStoryFactory();
  }
  stageTitle.textContent = `${detail.story.title} - ${detail.status}`;
  seriesPanel.replaceChildren();

  const tabs = document.createElement("nav");
  tabs.className = "story-tabs";
  for (const [id, label] of tabsForStory(detail.story)) {
    const button = actionButton(label, () => renderStoryDetail(channelId, storyId, id).catch((error) => setStatus(error.message)));
    if (id === tab) button.classList.add("selected");
    tabs.append(button);
  }
  const back = actionButton("Back to stories", () => navigate({ screen: "channel", id: channelId, phase: "content" }));

  const body = await renderStoryTab(channelId, storyId, tab, detail);
  const banner = canonBanner(detail.story);
  stageContent.replaceChildren(back, tabs, ...(banner ? [banner] : []), ...body);
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

// Returns the channel settings section for the Overview phase to host.
function renderStoryChannelSettings(channelId, channel) {
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
        refreshChannelScreen();
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
  return wrapSection(`Channel: ${channelId}`, form);
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
  stageContent.replaceChildren(channelBackButton(), ...sections);
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
  stageContent.replaceChildren(channelBackButton(), wrapSection("Add entry", form), wrapSection("Entries", ...list));
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
  stageContent.replaceChildren(channelBackButton(), wrapSection("Create", form), wrapSection("Existing", ...rows));
}

async function renderVoiceLab(channelId) {
  stageTitle.textContent = "TTS Voice Lab";
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
    channelBackButton(),
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

onJobEvent((job) => {
  if (!job.kind.startsWith("story-")) return;
  // Only repaint while a story is actually on screen: a finished background job
  // must not draw into a workspace the browser has already left.
  if (parseRoute(location.hash).screen !== "channel") return;
  if (storyFactoryState.channelId && storyFactoryState.storyId) {
    void renderStoryDetail(storyFactoryState.channelId, storyFactoryState.storyId).catch((error) => setStatus(error.message));
  }
});

// =============================== Story Canon ===============================
// The canon entities for a series. Each opens the raw JSON through the same
// route the pipeline reads, so what the operator inspects is exactly what the
// AI is given - which is the point of having a memory view at all.

const CANON_ENTITIES = [
  ["bible", "Bible"], ["characters", "Characters"], ["world-state", "World State"],
  ["arcs", "Arcs"], ["threads", "Plot Threads"],
];

function renderCanonPanel(seriesId, series) {
  const buttons = document.createElement("div");
  buttons.className = "button-row";
  for (const [entity, label] of CANON_ENTITIES) {
    buttons.append(actionButton(label, () => {
      showCanonEntity(seriesId, entity, label).catch((error) => setStatus(error.message));
    }));
  }
  buttons.append(actionButton("Event Ledger", () => {
    showCanonEvents(seriesId).catch((error) => setStatus(error.message));
  }));
  buttons.append(actionButton("Story Memory", () => {
    showCanonMemory(seriesId).catch((error) => setStatus(error.message));
  }));
  buttons.append(actionButton("Variants", () => {
    showCanonVariants(seriesId).catch((error) => setStatus(error.message));
  }));
  buttons.append(actionButton("Performance", () => {
    showCanonPerformance(seriesId).catch((error) => setStatus(error.message));
  }));

  return wrapSection(
    `Canon: ${series.title}`,
    paragraph(
      `Canonical language ${series.canonicalLanguage} - ${series.status}. ` +
        "The canon is the source of truth; localized variants are renderings of it and never change it.",
    ),
    buttons,
  );
}

async function showCanonEntity(seriesId, entity, label) {
  const data = await fetchJsonOrNull(storyApiUrl(seriesId, `canon/${entity}`));
  const value = data?.[entity];
  if (!value) {
    stageContent.replaceChildren(
      channelBackButton(),
      wrapSection(label, paragraph("Nothing here yet. Design the series first.")),
    );
    return;
  }
  const editor = document.createElement("textarea");
  editor.className = "artifact-editor";
  editor.rows = 28;
  editor.value = JSON.stringify(value, null, 2);
  const save = actionButton("Save canon", () => {
    let parsed;
    try {
      parsed = JSON.parse(editor.value);
    } catch (error) {
      setStatus(`Not valid JSON: ${error.message}`);
      return;
    }
    putJson(storyApiUrl(seriesId, `canon/${entity}`), parsed)
      .then(() => setStatus(`${label} saved.`))
      .catch((error) => setStatus(error.message));
  }, "button", "primary");
  stageContent.replaceChildren(channelBackButton(), wrapSection(`${label} (canon)`, editor, save));
  setStatus(`${label} loaded.`);
}

async function showCanonEvents(seriesId) {
  const data = await fetchJsonOrNull(storyApiUrl(seriesId, "canon/events"));
  const events = data?.events ?? [];
  const rows = events.map((event) =>
    `#${event.chapterNumber} [${event.eventType}] ${event.summary}`
    + (event.storyTime ? ` (${event.storyTime})` : "")
    + (event.characters.length ? ` - ${event.characters.join(", ")}` : ""),
  );
  const sections = [wrapSection("Event Ledger", preBlock(rows.join("\n") || "No events recorded yet."))];
  // A torn line means lost story history, so it is reported rather than hidden.
  if (data?.tornLines) {
    sections.unshift(gateNotice(
      "Damaged ledger lines",
      `${data.tornLines} line(s) could not be parsed and are not counted above.`,
      "warn",
    ));
  }
  if (data?.retracted?.length) {
    sections.push(wrapSection(
      "Retracted",
      paragraph(`${data.retracted.length} event(s) withdrawn by a canon correction. They stay on disk for audit but are invisible to every reader.`),
    ));
  }
  stageContent.replaceChildren(channelBackButton(), ...sections);
  setStatus(`${events.length} canon event(s).`);
}

async function showCanonMemory(seriesId) {
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.name = "q";
  input.placeholder = "e.g. Maria returns to the elevator looking for Diego";
  input.className = "text-input";
  const results = document.createElement("div");
  form.append(input, actionButton("Search memory", null, "submit", "primary"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runCanonMemorySearch(seriesId, input.value, results).catch((error) => setStatus(error.message));
  });
  stageContent.replaceChildren(
    channelBackButton(),
    wrapSection(
      "Story Memory",
      paragraph("Exactly what retrieval would return for this query, with the score breakdown that explains the ranking."),
      form,
      results,
    ),
  );
  setStatus("Story memory ready.");
}

async function runCanonMemorySearch(seriesId, query, target) {
  const data = await fetchJsonOrNull(storyApiUrl(seriesId, `canon/memory?q=${encodeURIComponent(query)}`));
  const lines = (data?.results ?? []).map((entry) =>
    `${entry.rank}. [${entry.entityType} ch.${entry.chapterNumber}] ${entry.text}\n`
    + `    keyword ${entry.keywordScore} | vector ${entry.vectorScore ?? "n/a"} | importance ${entry.importance} | distance ${entry.chapterDistance} | final ${entry.finalScore}`,
  );
  target.replaceChildren(preBlock(lines.join("\n") || "Nothing matched."));
  setStatus(`${data?.results?.length ?? 0} memory hit(s).`);
}

async function showCanonVariants(seriesId) {
  const data = await fetchJsonOrNull(storyApiUrl(seriesId, "canon/variants"));
  const variants = data?.variants ?? [];
  const lines = variants.map((entry) =>
    `${entry.chapterId} -> ${entry.locale} (${entry.channelId}/${entry.storyId}) - ${entry.state}${entry.published ? ", published" : ""}`,
  );
  const stale = variants.filter((entry) => entry.state === "stale");
  const sections = [wrapSection("Publication Variants", preBlock(lines.join("\n") || "No variants yet."))];
  if (stale.length) {
    // Reported, never acted on: regenerating a published video is the
    // operator's decision, not the system's.
    sections.unshift(gateNotice(
      `${stale.length} localization(s) are behind their canon chapter`,
      "The canon chapter changed after these were localized. Nothing has been regenerated - re-run localize on the ones you want updated.",
      "warn",
    ));
  }
  stageContent.replaceChildren(channelBackButton(), ...sections);
  setStatus(`${variants.length} variant(s).`);
}

async function showCanonPerformance(seriesId) {
  const data = await fetchJsonOrNull(storyApiUrl(seriesId, "canon/performance"));
  const performance = data?.performance;
  const lines = (performance?.chapters ?? []).map((chapter) => {
    const locales = chapter.byLocale
      .map((entry) => `      ${entry.locale}: ${entry.views} views, $${entry.productionCostUsd.toFixed(4)}${entry.localizerModel ? `, ${entry.localizerModel}` : ""}`)
      .join("\n");
    return `Chapter ${chapter.chapterNumber} - ${chapter.totalViews} views across ${chapter.localeCount} locale(s)`
      + (chapter.bestLocale ? `, best: ${chapter.bestLocale}` : "")
      + `\n${locales}`;
  });
  stageContent.replaceChildren(
    channelBackButton(),
    wrapSection(
      "Canon Performance",
      paragraph("One chapter across every market it published in - which separates story quality from localization, voice, and market."),
      preBlock(lines.join("\n\n") || "No published variants with analytics yet."),
    ),
  );
  setStatus(performance?.bestLocale ? `Best locale so far: ${performance.bestLocale}.` : "No analytics yet.");
}
