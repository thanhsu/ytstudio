import { unique } from "../search-queries.js";
import {
  summaryGrid, formatBytes, checklist, wrapSection, uploadField, fileField,
  paragraph, sectionTitle, field, textareaField, checkboxField, selectField,
  actionButton, formValues, boolFormValues, strongText, confidenceMeter,
  formatTimecode, formatSeconds,
} from "../lib/dom.js";
import { setStatus, paidVoiceDialog, paidScriptDialog } from "../lib/shell.js";
import {
  projectList, seriesPanel, workflowTitle, workflowDescription, workflowSteps,
  stageRail, stageTitle, stageContent, audioPreview, videoPreview,
} from "../lib/refs.js";
import {
  appState, onJobEvent, ensureProjectEventStream, reportedAsJob,
  refreshAppData, projectApiUrl, projectFileUrl,
} from "../lib/state.js";
import { STAGES, STAGE_TITLES, APPROVAL_STEP_IDS } from "../lib/phases.js";

// A finished review job (voice, render, ASR, captions, asset analysis, script)
// refreshes the open project. Story jobs are handled by app.js until the story
// factory screen moves out in a later task.
onJobEvent((job) => {
  if (job.kind.startsWith("story-")) return;
  if (appState.selectedProject) {
    void selectProject(appState.selectedProject);
  }
});

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

export function renderProjects() {
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

export function renderStageRail() {
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

export function bindStageRail() {
  for (const button of stageRail.querySelectorAll("[data-stage]")) {
    button.addEventListener("click", () => {
      appState.activeStage = button.dataset.stage;
      renderStage();
    });
  }
}

export async function selectProject(projectId) {
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

export function renderStage() {
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

export function renderCreateProject() {
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
  // Equivalent to the app.js boot orchestrator's loadProjects() for this case:
  // refresh the fetched state and the project rail, then select the new
  // project directly rather than routing off location.hash.
  await refreshAppData();
  renderStageRail();
  renderProjects();
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

export async function loadEditManifestState(projectId) {
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

export async function runAvailableTasks() {
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

export async function requestVoice(confirmedPaidRequest) {
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

export async function requestScript(confirmedPaidRequest) {
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

function sourceSubtitlePath() {
  return appState.projectSnapshot?.state?.artifacts?.["source-subtitles"]?.relativePath ?? "workspace/subtitles/source.asr.srt";
}

export function targetOptions() {
  return (appState.translationPresets?.presets ?? []).map((preset) => [preset.language ?? preset.target, preset.label]);
}

export function workflowTypeOptions() {
  return (appState.workflowTemplates?.templates ?? []).map((template) => [template.type, template.title]);
}

function translationTargetLabels() {
  return (appState.translationPresets?.presets ?? []).map((preset) => preset.label);
}


function seriesEpisodeProjectIds() {
  return new Set(appState.series.flatMap((series) => series.episodes.map((episode) => episode.episodeProjectId)));
}

export function setActiveStageButton(stage = appState.activeStage) {
  for (const button of stageRail.querySelectorAll("[data-stage]")) {
    button.classList.toggle("selected", button.dataset.stage === stage);
  }
}
