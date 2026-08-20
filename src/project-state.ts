import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import type { ArtifactRecord, ApprovalStage, ProjectState, StageApproval } from "./types.ts";

export type SourceHashes = {
  script?: string;
  assets?: string;
  copyright?: string;
};

export type PipelineStageStatus = "missing" | "approved" | "ready" | "stale" | "blocked";

export type PipelineStatus = {
  script: PipelineStageStatus;
  assets: PipelineStageStatus;
  copyright: PipelineStageStatus;
  voice: PipelineStageStatus;
  captions: PipelineStageStatus;
  render: PipelineStageStatus;
};

const STATE_FILE = "project-state.json";

export function emptyProjectState(): ProjectState {
  return {
    version: 1,
    approvals: {},
    artifacts: {},
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadProjectState(projectId: string): Promise<ProjectState> {
  const path = resolveProjectPath(projectId, STATE_FILE);

  try {
    const raw = await readFile(path, "utf8");
    return normalizeProjectState(JSON.parse(raw));
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return emptyProjectState();
    }
    throw error;
  }
}

export async function approveStage(
  projectId: string,
  stage: ApprovalStage,
  sourceHash: string,
  note = "",
): Promise<ProjectState> {
  const state = await loadProjectState(projectId);
  state.approvals[stage] = {
    sourceHash,
    note,
    approvedAt: new Date().toISOString(),
  };
  await saveProjectState(projectId, state);
  return state;
}

export async function setArtifact(projectId: string, artifact: ArtifactRecord): Promise<ProjectState> {
  const state = await loadProjectState(projectId);
  state.artifacts[artifact.kind] = artifact;
  await saveProjectState(projectId, state);
  return state;
}

export function derivePipelineStatus(state: ProjectState, currentHashes: SourceHashes): PipelineStatus {
  const script = approvalStatus(state.approvals.script, currentHashes.script);
  const assets = approvalStatus(state.approvals.assets, currentHashes.assets);
  const copyright = approvalStatus(state.approvals.copyright, currentHashes.copyright);
  const voice = artifactStatus(state.artifacts.voice, currentHashes.script, script);
  const captions = artifactStatus(state.artifacts.captions, currentHashes.script, script);
  const render = deriveRenderStatus(state, { script, assets, copyright, voice, captions });

  return {
    script,
    assets,
    copyright,
    voice,
    captions,
    render,
  };
}

async function saveProjectState(projectId: string, state: ProjectState): Promise<void> {
  const path = resolveProjectPath(projectId, STATE_FILE);
  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalizeProjectState(state), null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function approvalStatus(approval: StageApproval | undefined, currentHash: string | undefined): PipelineStageStatus {
  if (!approval) {
    return "missing";
  }
  if (currentHash && approval.sourceHash !== currentHash) {
    return "stale";
  }
  return "approved";
}

function artifactStatus(
  artifact: ArtifactRecord | undefined,
  sourceHash: string | undefined,
  dependencyStatus: PipelineStageStatus,
): PipelineStageStatus {
  if (dependencyStatus === "missing") {
    return "blocked";
  }
  if (dependencyStatus === "stale") {
    return "stale";
  }
  if (!artifact) {
    return "missing";
  }
  if (sourceHash && artifact.sourceHash !== sourceHash) {
    return "stale";
  }
  return "ready";
}

function deriveRenderStatus(
  state: ProjectState,
  statuses: Pick<PipelineStatus, "script" | "assets" | "copyright" | "voice" | "captions">,
): PipelineStageStatus {
  if (Object.values(statuses).some((status) => status === "stale")) {
    return "blocked";
  }
  if (statuses.script !== "approved" || statuses.assets !== "approved" || statuses.copyright !== "approved") {
    return "blocked";
  }
  if (statuses.voice !== "ready" || statuses.captions !== "ready") {
    return "blocked";
  }
  return state.artifacts.render ? "ready" : "missing";
}

function normalizeProjectState(value: unknown): ProjectState {
  if (!value || typeof value !== "object") {
    return emptyProjectState();
  }

  const candidate = value as Partial<ProjectState>;
  return {
    version: 1,
    approvals: candidate.approvals ?? {},
    artifacts: candidate.artifacts ?? {},
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
