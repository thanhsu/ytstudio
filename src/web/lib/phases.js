export const STAGES = [
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

export const STAGE_TITLES = {
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

// The studio's production flow. Every workspace shows these four steps;
// "overview" carries no stages of its own.
export const REVIEW_PHASES = [
  { id: "content", label: "Content", stages: ["brief", "script", "media", "asr", "subtitles", "translation"] },
  { id: "edit", label: "Edit", stages: ["voice", "captions", "assets", "render"] },
  { id: "publish", label: "Publish", stages: ["copyright", "export"] },
];

export const PHASE_LABELS = {
  overview: "Overview",
  content: "Content",
  edit: "Edit",
  publish: "Publish",
};

// Steps whose "ready" state means a human approval is what unblocks the flow.
export const APPROVAL_STEP_IDS = new Set(["script", "assets", "copyright", "source-risk"]);

export function phaseForStage(stage) {
  return REVIEW_PHASES.find((phase) => phase.stages.includes(stage))?.id ?? "content";
}

// Workflow step statuses are "done" | "ready" | "blocked" (src/workflow-templates.ts).
export function derivePhaseState(phaseStages, workflowSteps) {
  const steps = (workflowSteps ?? []).filter((step) => phaseStages.includes(step.stage));
  if (steps.length === 0) return "empty";
  if (steps.every((step) => step.status === "done")) return "done";
  if (steps.some((step) => step.status === "ready" && APPROVAL_STEP_IDS.has(step.id))) return "needs-approval";
  if (steps.some((step) => step.status === "ready" || step.status === "done")) return "in-progress";
  return "pending";
}
