// Hand-written because the module ships as plain JavaScript: the browser loads
// it directly from /lib/phases.js, so it cannot be a .ts file.

export const STAGES: string[];

export const STAGE_TITLES: Record<string, string>;

export interface Phase {
  id: string;
  label: string;
  stages: string[];
}

export const REVIEW_PHASES: Phase[];

export const PHASE_LABELS: Record<string, string>;

export const APPROVAL_STEP_IDS: Set<string>;

export function phaseForStage(stage: string): string;

export interface WorkflowStep {
  id: string;
  stage: string;
  status: "done" | "ready" | "blocked";
}

export type PhaseState = "empty" | "pending" | "in-progress" | "needs-approval" | "done";

export function derivePhaseState(phaseStages: string[], workflowSteps?: WorkflowStep[]): PhaseState;
