import type { Metadata, ScenePlan, VideoBrief } from "../types.ts";

export type ScriptGenerationRequest = {
  projectId: string;
  brief: VideoBrief;
  confirmedPaidRequest: boolean;
};

export type ScriptGenerationResult = {
  provider: string;
  model: string;
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

export type LlmProvider = {
  readonly name: string;
  generate(request: ScriptGenerationRequest, signal?: AbortSignal): Promise<ScriptGenerationResult>;
};
