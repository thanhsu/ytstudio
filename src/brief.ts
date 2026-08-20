import { join } from "node:path";
import { ensureProjectDir, writeJson } from "./fs.ts";
import type { VideoBrief, VideoFormat } from "./types.ts";

export type CreateBriefInput = {
  id: string;
  topic: string;
  show: string;
  format: VideoFormat;
  audience: string;
  language: string;
  notes?: string;
};

export function validateBrief(input: CreateBriefInput): void {
  const missing = Object.entries(input)
    .filter(([key, value]) => key !== "notes" && String(value ?? "").trim() === "")
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
    audience: input.audience.trim(),
    language: input.language.trim(),
    notes: input.notes?.trim() ?? "",
    createdAt: new Date().toISOString(),
  };

  const dir = await ensureProjectDir(brief.id);
  await writeJson(join(dir, "brief.json"), brief);
  return brief;
}
