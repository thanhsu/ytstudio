import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureProjectDir, writeJson } from "./fs.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { normalizeWorkflowType } from "./workflow-templates.ts";
import type { VideoBrief, VideoFormat } from "./types.ts";

export type CreateBriefInput = {
  id: string;
  topic: string;
  show: string;
  format: VideoFormat;
  workflowType?: unknown;
  audience: string;
  language: string;
  notes?: string;
};

export function validateBrief(input: CreateBriefInput): void {
  const missing = Object.entries(input)
    .filter(([key, value]) => key !== "notes" && key !== "workflowType" && String(value ?? "").trim() === "")
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required brief fields: ${missing.join(", ")}`);
  }

  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(input.id)) {
    throw new Error("Project id must be 3-81 lowercase letters, numbers, or hyphens.");
  }

  if (input.format !== "shorts" && input.format !== "longform") {
    throw new Error("Format must be either shorts or longform.");
  }
}

export async function createBrief(input: CreateBriefInput): Promise<VideoBrief> {
  validateBrief(input);

  const brief: VideoBrief = {
    id: input.id,
    topic: input.topic.trim(),
    show: input.show.trim(),
    format: input.format,
    workflowType: normalizeWorkflowType(input.workflowType),
    audience: input.audience.trim(),
    language: input.language.trim(),
    notes: input.notes?.trim() ?? "",
    createdAt: new Date().toISOString(),
  };

  const dir = await ensureProjectDir(brief.id);
  await writeJson(join(dir, "brief.json"), brief);
  return brief;
}

export type UpdateBriefInput = Partial<Pick<CreateBriefInput, "topic" | "show" | "format" | "audience" | "language" | "notes">>;

export async function loadBrief(projectId: string): Promise<VideoBrief> {
  return JSON.parse(await readFile(resolveProjectPath(projectId, "brief.json"), "utf8")) as VideoBrief;
}

export async function updateBrief(projectId: string, update: UpdateBriefInput): Promise<VideoBrief> {
  const brief = await loadBrief(projectId);
  const input: CreateBriefInput = {
    id: brief.id,
    topic: update.topic ?? brief.topic,
    show: update.show ?? brief.show,
    format: update.format ?? brief.format,
    workflowType: brief.workflowType,
    audience: update.audience ?? brief.audience,
    language: update.language ?? brief.language,
    notes: update.notes ?? brief.notes,
  };
  validateBrief(input);

  const updated: VideoBrief = {
    ...brief,
    topic: input.topic.trim(),
    show: input.show.trim(),
    format: input.format,
    audience: input.audience.trim(),
    language: input.language.trim(),
    notes: input.notes?.trim() ?? "",
  };
  await writeJson(resolveProjectPath(projectId, "brief.json"), updated);
  return updated;
}
