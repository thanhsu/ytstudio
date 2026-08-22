import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import { parseSrt, stringifySrt } from "./srt.ts";

export type CutMode = "reencode" | "stream-copy";

export type EditManifestSegment = {
  id: string;
  /** Always source-video time, so dropping one segment never moves another. */
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  keep: boolean;
  text: string;
};

export type EditManifest = {
  version: 1;
  projectId: string;
  sourceVideoPath: string;
  sourceSubtitlePath: string;
  sourceHash: string;
  cutMode: CutMode;
  generatedAt: string;
  /** Dropped segments stay listed, because this file is also the editor save file. */
  segments: EditManifestSegment[];
};

export type OutputSegment = EditManifestSegment & {
  outputStartSeconds: number;
  outputEndSeconds: number;
};

export type EditManifestValidation = { valid: boolean; errors: string[] };

export type BuildEditManifestInput = {
  projectId: string;
  sourceVideoPath: string;
  sourceSubtitlePath: string;
  sourceHash: string;
  srt: string;
  cutMode?: CutMode;
};

export function buildEditManifest(input: BuildEditManifestInput): EditManifest {
  return {
    version: 1,
    projectId: input.projectId,
    sourceVideoPath: input.sourceVideoPath,
    sourceSubtitlePath: input.sourceSubtitlePath,
    sourceHash: input.sourceHash,
    // Subtitle boundaries almost never land on a keyframe, so an accurate cut is
    // the default and a stream copy stays an explicit, recorded choice.
    cutMode: input.cutMode ?? "reencode",
    generatedAt: new Date().toISOString(),
    segments: parseSrt(input.srt).map((cue, index) => ({
      id: `cue-${String(index + 1).padStart(3, "0")}`,
      sourceStartSeconds: secondsFromTimestamp(cue.start),
      sourceEndSeconds: secondsFromTimestamp(cue.end),
      keep: true,
      text: cue.text,
    })),
  };
}

export function keptSegments(manifest: EditManifest): EditManifestSegment[] {
  return manifest.segments.filter((segment) => segment.keep);
}

/**
 * Derived on demand and never stored: a second copy of the same timeline would
 * disagree with the first the moment someone toggles a segment.
 */
export function outputTimeline(manifest: EditManifest): OutputSegment[] {
  let cursorMs = 0;
  return keptSegments(manifest).map((segment) => {
    const startMs = cursorMs;
    cursorMs += millis(segment.sourceEndSeconds) - millis(segment.sourceStartSeconds);
    return { ...segment, outputStartSeconds: startMs / 1000, outputEndSeconds: cursorMs / 1000 };
  });
}

export function buildCleanSrt(manifest: EditManifest): string {
  return stringifySrt(
    outputTimeline(manifest).map((segment, index) => ({
      index: index + 1,
      start: timestampFromSeconds(segment.outputStartSeconds),
      end: timestampFromSeconds(segment.outputEndSeconds),
      text: segment.text,
    })),
  );
}

export function validateEditManifest(manifest: EditManifest): EditManifestValidation {
  const errors: string[] = [];
  let previous: EditManifestSegment | undefined;

  for (const segment of manifest.segments) {
    if (segment.sourceEndSeconds <= segment.sourceStartSeconds) {
      errors.push(`${segment.id} ends before it starts.`);
    }
    if (previous && segment.sourceStartSeconds < previous.sourceEndSeconds) {
      errors.push(`${segment.id} starts before ${previous.id} ends.`);
    }
    previous = segment;
  }

  if (!keptSegments(manifest).length) {
    errors.push("Manifest keeps no segments.");
  }

  return { valid: errors.length === 0, errors };
}

export function parseEditManifest(value: unknown): EditManifest {
  const record = asRecord(value, "Edit manifest");
  if (record.version !== 1) {
    throw new Error(`Edit manifest version must be 1, received ${JSON.stringify(record.version)}.`);
  }
  const cutMode = record.cutMode;
  if (cutMode !== "reencode" && cutMode !== "stream-copy") {
    throw new Error(`Edit manifest cutMode must be "reencode" or "stream-copy", received ${JSON.stringify(cutMode)}.`);
  }

  const manifest: EditManifest = {
    version: 1,
    projectId: requireString(record, "projectId"),
    sourceVideoPath: requireString(record, "sourceVideoPath"),
    sourceSubtitlePath: requireString(record, "sourceSubtitlePath"),
    sourceHash: requireString(record, "sourceHash"),
    cutMode,
    generatedAt: requireString(record, "generatedAt"),
    segments: requireArray(record, "segments").map(parseSegment),
  };

  const validation = validateEditManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Edit manifest is not renderable: ${validation.errors.join(" ")}`);
  }
  return manifest;
}

export async function saveEditManifest(projectId: string, manifest: EditManifest): Promise<void> {
  const path = manifestPath(projectId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function loadEditManifest(projectId: string): Promise<EditManifest | null> {
  try {
    return parseEditManifest(JSON.parse(await readFile(manifestPath(projectId), "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function manifestPath(projectId: string): string {
  return resolveProjectPath(projectId, "workspace/editing/edit-manifest.json");
}

function parseSegment(value: unknown, index: number): EditManifestSegment {
  const record = asRecord(value, `Edit manifest segment ${index + 1}`);
  if (typeof record.keep !== "boolean") {
    throw new Error(`Edit manifest segment ${index + 1} needs a boolean keep.`);
  }
  return {
    id: requireString(record, "id"),
    sourceStartSeconds: requireNumber(record, "sourceStartSeconds"),
    sourceEndSeconds: requireNumber(record, "sourceEndSeconds"),
    keep: record.keep,
    text: requireString(record, "text"),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Edit manifest needs a non-empty ${field}.`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Edit manifest needs a non-negative ${field}.`);
  }
  return value;
}

function requireArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`Edit manifest needs a non-empty ${field}.`);
  }
  return value;
}

function millis(seconds: number): number {
  return Math.round(seconds * 1000);
}

function secondsFromTimestamp(timestamp: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(timestamp);
  if (!match) {
    throw new Error(`Invalid subtitle timestamp ${timestamp}.`);
  }
  const [, hours, minutes, seconds, fraction] = match.map(Number) as [number, number, number, number, number];
  return (((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction) / 1000;
}

function timestampFromSeconds(value: number): string {
  const totalMs = millis(value);
  const fraction = totalMs % 1000;
  const totalSeconds = (totalMs - fraction) / 1000;
  const pad = (input: number, length = 2) => String(input).padStart(length, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)},${pad(fraction, 3)}`;
}
