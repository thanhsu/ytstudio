import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { parseSrt, stringifySrt } from "./srt.ts";

export type EditDecision = "keep" | "remove";

export type EditSegment = {
  cueIndex: number;
  start: string;
  end: string;
  text: string;
  decision: EditDecision;
};

export type EditManifest = {
  version: 1;
  sourceRelativePath: string;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
  segments: EditSegment[];
};

export type EditExportResult = {
  manifest: EditManifest;
  cleanSrtRelativePath: string;
  csvRelativePath: string;
  keptCueCount: number;
  removedCueCount: number;
};

export class EditManifestConflictError extends Error {
  constructor() {
    super("An edit manifest already exists. Explicit replacement is required to reset human decisions.");
    this.name = "EditManifestConflictError";
  }
}

export class EditManifestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditManifestInputError";
  }
}

export class EditSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditSelectionError";
  }
}

const MANIFEST_RELATIVE_PATH = "workspace/edit/segments.json";
const CLEAN_SRT_RELATIVE_PATH = "workspace/edit/clean.srt";
const CSV_RELATIVE_PATH = "workspace/edit/segments.csv";

export function parseCueSelection(input: string, maxCueIndex: number): number[] {
  if (!Number.isInteger(maxCueIndex) || maxCueIndex < 0) {
    throw new EditSelectionError("Maximum cue index must be a non-negative integer.");
  }

  const selection = new Set<number>();
  const normalized = input.trim();
  if (!normalized) {
    return [];
  }

  for (const rawToken of normalized.split(",")) {
    const token = rawToken.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) {
      throw new EditSelectionError(`Invalid cue selection token: ${token || "(empty)"}.`);
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start <= 0 || end <= 0) {
      throw new EditSelectionError("Cue numbers must be positive integers.");
    }
    if (end < start) {
      throw new EditSelectionError(`Cue range ${token} must not be reversed.`);
    }
    if (end > maxCueIndex) {
      throw new EditSelectionError(`Cue ${end} is outside the available range 1-${maxCueIndex}.`);
    }
    for (let cueIndex = start; cueIndex <= end; cueIndex += 1) {
      selection.add(cueIndex);
    }
  }

  return [...selection].sort((left, right) => left - right);
}

export async function createEditManifest(
  projectId: string,
  sourceRelativePath: string,
  options: { replace?: boolean } = {},
): Promise<EditManifest> {
  if (!options.replace && await manifestExists(projectId)) {
    throw new EditManifestConflictError();
  }
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  let sourcePath: string;
  try {
    sourcePath = resolveProjectPath(projectId, ...normalizedSourcePath.split("/"));
  } catch (error: unknown) {
    throw new EditManifestInputError(error instanceof Error ? error.message : String(error));
  }
  const source = await readFile(sourcePath, "utf8");
  let cues;
  try {
    cues = parseSrt(source);
  } catch (error: unknown) {
    throw new EditManifestInputError(error instanceof Error ? error.message : String(error));
  }
  if (cues.length === 0) {
    throw new EditManifestInputError("Source SRT must contain at least one cue.");
  }

  const now = new Date().toISOString();
  const manifest: EditManifest = {
    version: 1,
    sourceRelativePath: normalizedSourcePath,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    createdAt: now,
    updatedAt: now,
    segments: cues.map((cue) => ({
      cueIndex: cue.index,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      decision: "keep",
    })),
  };

  await saveEditManifest(projectId, manifest);
  return manifest;
}

async function manifestExists(projectId: string): Promise<boolean> {
  try {
    await access(resolveProjectPath(projectId, ...MANIFEST_RELATIVE_PATH.split("/")));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function loadEditManifest(projectId: string): Promise<EditManifest> {
  const manifest = await readJson<EditManifest>(resolveProjectPath(projectId, ...MANIFEST_RELATIVE_PATH.split("/")));
  if (manifest.version !== 1 || !Array.isArray(manifest.segments)) {
    throw new Error("Unsupported or invalid edit manifest.");
  }
  return manifest;
}

export async function applyRemoveSelection(projectId: string, selection: string): Promise<EditManifest> {
  const manifest = await loadEditManifest(projectId);
  const maxCueIndex = manifest.segments.reduce((maximum, segment) => Math.max(maximum, segment.cueIndex), 0);
  const removed = new Set(parseCueSelection(selection, maxCueIndex));
  const available = new Set(manifest.segments.map((segment) => segment.cueIndex));
  for (const cueIndex of removed) {
    if (!available.has(cueIndex)) {
      throw new EditSelectionError(`Cue ${cueIndex} does not exist in the edit manifest.`);
    }
  }

  const updated: EditManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    segments: manifest.segments.map((segment) => ({
      ...segment,
      decision: removed.has(segment.cueIndex) ? "remove" : "keep",
    })),
  };
  await saveEditManifest(projectId, updated);
  return updated;
}

export async function exportEditManifest(projectId: string): Promise<EditExportResult> {
  const manifest = await loadEditManifest(projectId);
  const kept = manifest.segments.filter((segment) => segment.decision === "keep");
  const cleanSrt = stringifySrt(
    kept.map((segment, index) => ({
      index: index + 1,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    })),
  );
  const csv = [
    "cueIndex,start,end,decision,text",
    ...manifest.segments.map((segment) =>
      [segment.cueIndex, segment.start, segment.end, segment.decision, segment.text]
        .map((value) => csvCell(String(value)))
        .join(","),
    ),
  ].join("\n") + "\n";

  await writeText(projectId, CLEAN_SRT_RELATIVE_PATH, cleanSrt);
  await writeText(projectId, CSV_RELATIVE_PATH, csv);

  return {
    manifest,
    cleanSrtRelativePath: CLEAN_SRT_RELATIVE_PATH,
    csvRelativePath: CSV_RELATIVE_PATH,
    keptCueCount: kept.length,
    removedCueCount: manifest.segments.length - kept.length,
  };
}

async function saveEditManifest(projectId: string, manifest: EditManifest): Promise<void> {
  const path = resolveProjectPath(projectId, ...MANIFEST_RELATIVE_PATH.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, manifest);
}

async function writeText(projectId: string, relativePath: string, content: string): Promise<void> {
  const path = resolveProjectPath(projectId, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw new EditManifestInputError("Source SRT path must be relative to the project directory.");
  }
  return normalized;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
