import type { ArtifactKind, ProjectState, WorkflowType } from "./types.ts";

export type WorkflowStepStatus = "done" | "ready" | "blocked";

export type WorkflowStepId =
  | "input"
  | "story-text"
  | "script"
  | "media"
  | "extract-audio"
  | "asr"
  | "ocr"
  | "subtitles"
  | "translation"
  | "voice"
  | "captions"
  | "assets"
  | "source-risk"
  | "copyright"
  | "render"
  | "export";

export type WorkflowStep = {
  id: WorkflowStepId;
  title: string;
  description: string;
  stage: string;
  dependsOn: WorkflowStepId[];
  output?: ArtifactKind | "script-approval" | "asset-approval" | "copyright-approval";
  parallelGroup?: string;
};

export type WorkflowTemplate = {
  type: WorkflowType;
  title: string;
  description: string;
  steps: WorkflowStep[];
};

export type WorkflowStepState = WorkflowStep & {
  status: WorkflowStepStatus;
  canRun: boolean;
};

const inputStep: WorkflowStep = {
  id: "input",
  title: "Input",
  description: "Create the project brief and choose the production flow.",
  stage: "brief",
  dependsOn: [],
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    type: "review-recap",
    title: "Review / Recap",
    description: "Original commentary-led review, recap, or analysis video.",
    steps: [
      inputStep,
      {
        id: "script",
        title: "Script",
        description: "Generate and approve original commentary.",
        stage: "script",
        dependsOn: ["input"],
        output: "script-approval",
      },
      {
        id: "voice",
        title: "Voice",
        description: "Generate narration from the approved script.",
        stage: "voice",
        dependsOn: ["script"],
        output: "voice",
        parallelGroup: "production",
      },
      {
        id: "captions",
        title: "Captions",
        description: "Create timed captions from the narration.",
        stage: "captions",
        dependsOn: ["voice"],
        output: "captions",
      },
      {
        id: "assets",
        title: "Assets",
        description: "Upload or approve visuals with rights confirmed.",
        stage: "assets",
        dependsOn: ["input"],
        output: "asset-approval",
        parallelGroup: "production",
      },
      {
        id: "copyright",
        title: "Copyright",
        description: "Run and approve the copyright risk checklist.",
        stage: "copyright",
        dependsOn: ["input"],
        output: "copyright-approval",
        parallelGroup: "production",
      },
      {
        id: "render",
        title: "Render",
        description: "Export the draft after all approval gates are ready.",
        stage: "render",
        dependsOn: ["script", "voice", "captions", "assets", "copyright"],
        output: "render",
      },
      {
        id: "export",
        title: "Export",
        description: "Review the final file and publish checklist.",
        stage: "export",
        dependsOn: ["render"],
      },
    ],
  },
  {
    type: "audio-story",
    title: "Audio Story",
    description: "Clean up story text, generate chapter audio, and export MP3/MP4.",
    steps: [
      inputStep,
      {
        id: "story-text",
        title: "Story Text",
        description: "Import chapter text and clean wording before narration.",
        stage: "script",
        dependsOn: ["input"],
        output: "script-approval",
      },
      {
        id: "voice",
        title: "Voice Batch",
        description: "Generate audio with the configured Vietnamese voice.",
        stage: "voice",
        dependsOn: ["story-text"],
        output: "voice",
      },
      {
        id: "captions",
        title: "Captions",
        description: "Create captions if exporting story video.",
        stage: "captions",
        dependsOn: ["voice"],
        output: "captions",
      },
      {
        id: "assets",
        title: "Cover Visual",
        description: "Upload or approve a cover/background visual.",
        stage: "assets",
        dependsOn: ["input"],
        output: "asset-approval",
        parallelGroup: "production",
      },
      {
        id: "render",
        title: "Export Audio/Video",
        description: "Export chapter MP3 or a static-background video.",
        stage: "render",
        dependsOn: ["story-text", "voice", "assets"],
        output: "render",
      },
      {
        id: "export",
        title: "Publish",
        description: "Package title, cover, and output files.",
        stage: "export",
        dependsOn: ["render"],
      },
    ],
  },
  {
    type: "subtitle-render",
    title: "Sub Translate / Render",
    description: "Import a source video, produce subtitles, translate, review, and render.",
    steps: [
      inputStep,
      {
        id: "media",
        title: "Media",
        description: "Import the MP4/MOV/MKV source.",
        stage: "media",
        dependsOn: ["input"],
        output: "media",
      },
      {
        id: "extract-audio",
        title: "Extract Audio",
        description: "Create ASR-ready audio from the imported video.",
        stage: "media",
        dependsOn: ["media"],
        output: "audio",
        parallelGroup: "source-analysis",
      },
      {
        id: "source-risk",
        title: "Source Risk",
        description: "Record rights and reuse risk before rendering.",
        stage: "copyright",
        dependsOn: ["media"],
        output: "copyright-approval",
        parallelGroup: "source-analysis",
      },
      {
        id: "asr",
        title: "ASR",
        description: "Generate source subtitles from extracted audio.",
        stage: "asr",
        dependsOn: ["extract-audio"],
        output: "source-subtitles",
      },
      {
        id: "subtitles",
        title: "Sub Editor",
        description: "Import or review source subtitles.",
        stage: "subtitles",
        dependsOn: ["asr"],
        output: "source-subtitles",
      },
      {
        id: "translation",
        title: "Translation",
        description: "Build a translation prompt or draft while preserving timing.",
        stage: "translation",
        dependsOn: ["subtitles"],
      },
      {
        id: "render",
        title: "Render",
        description: "Render the approved subtitle/video output.",
        stage: "render",
        dependsOn: ["translation", "source-risk"],
        output: "render",
      },
      {
        id: "export",
        title: "Export",
        description: "Review the output and checklist.",
        stage: "export",
        dependsOn: ["render"],
      },
    ],
  },
  {
    type: "licensed-source",
    title: "Source / Licensed",
    description: "Work with source material you own, licensed, or can use for review context.",
    steps: [
      inputStep,
      {
        id: "media",
        title: "Source",
        description: "Import source footage.",
        stage: "media",
        dependsOn: ["input"],
        output: "media",
      },
      {
        id: "extract-audio",
        title: "Extract Audio",
        description: "Extract source audio for ASR or reuse review.",
        stage: "media",
        dependsOn: ["media"],
        output: "audio",
        parallelGroup: "source-analysis",
      },
      {
        id: "asr",
        title: "ASR / OCR",
        description: "Generate source subtitles when needed.",
        stage: "asr",
        dependsOn: ["extract-audio"],
        output: "source-subtitles",
      },
      {
        id: "translation",
        title: "Translate / Adapt",
        description: "Translate, adapt, or transform the source text.",
        stage: "translation",
        dependsOn: ["asr"],
      },
      {
        id: "assets",
        title: "Assets",
        description: "Approve brand visuals, overlays, or watermarks.",
        stage: "assets",
        dependsOn: ["input"],
        output: "asset-approval",
        parallelGroup: "source-analysis",
      },
      {
        id: "copyright",
        title: "Rights Check",
        description: "Approve rights/risk before rendering.",
        stage: "copyright",
        dependsOn: ["media"],
        output: "copyright-approval",
      },
      {
        id: "render",
        title: "Render",
        description: "Render the transformed output.",
        stage: "render",
        dependsOn: ["translation", "assets", "copyright"],
        output: "render",
      },
      {
        id: "export",
        title: "Export",
        description: "Package files for manual publishing.",
        stage: "export",
        dependsOn: ["render"],
      },
    ],
  },
];

export function normalizeWorkflowType(value: unknown): WorkflowType {
  return isWorkflowType(value) ? value : "review-recap";
}

export function isWorkflowType(value: unknown): value is WorkflowType {
  return (
    value === "review-recap" ||
    value === "audio-story" ||
    value === "subtitle-render" ||
    value === "licensed-source"
  );
}

export function getWorkflowTemplate(value: unknown): WorkflowTemplate {
  const type = normalizeWorkflowType(value);
  return WORKFLOW_TEMPLATES.find((template) => template.type === type) ?? WORKFLOW_TEMPLATES[0];
}

export function deriveWorkflowStepStates(type: unknown, state: ProjectState): WorkflowStepState[] {
  const steps = getWorkflowTemplate(type).steps;
  const statuses = new Map<WorkflowStepId, WorkflowStepStatus>();

  for (const step of steps) {
    const status = stepDone(step, state)
      ? "done"
      : step.dependsOn.every((dependency) => statuses.get(dependency) === "done")
        ? "ready"
        : "blocked";
    statuses.set(step.id, status);
  }

  return steps.map((step) => ({
    ...step,
    status: statuses.get(step.id) ?? "blocked",
    canRun: statuses.get(step.id) === "ready",
  }));
}

function stepDone(step: WorkflowStep, state: ProjectState): boolean {
  if (step.id === "input") return true;
  if (!step.output) return false;
  if (step.output === "script-approval") return Boolean(state.approvals.script);
  if (step.output === "asset-approval") return Boolean(state.approvals.assets);
  if (step.output === "copyright-approval") return Boolean(state.approvals.copyright);
  return Boolean(state.artifacts[step.output]);
}
