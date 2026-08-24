import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sourcesRoot } from "../fs.ts";

export type SourceRights = "unknown" | "own" | "licensed" | "third-party-fair-use";

export type SourceStatus = "metadata" | "downloading" | "downloaded" | "failed";

export type SourceScore = {
  /** 0-100, an ordinal hint from one model and prompt version, not a calibrated measure. */
  value: number;
  angle: string;
  hooks: string[];
  risks: string[];
  reason: string;
  provider: string;
  model: string;
  scoredAt: string;
};

export type SourceCandidate = {
  version: 1;
  id: string;
  canonicalUrl: string;
  platform: string;
  platformVideoId: string;
  title: string;
  uploader: string;
  durationSeconds: number;
  description: string;
  addedAt: string;
  /** Tracks the download lifecycle only; whether it was scored is the presence of `score`. */
  status: SourceStatus;
  rights: SourceRights;
  rightsNote: string;
  score?: SourceScore;
  media?: {
    videoRelativePath: string;
    /** The download deliberately fetched only the audio track. */
    audioOnly?: boolean;
    subtitleRelativePath?: string;
    subtitleLanguage?: string;
    downloadedAt: string;
  };
  error?: string;
};

const CANDIDATE_FILE = "candidate.json";
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function validateSourceId(id: string): string {
  const normalized = id.trim();
  if (!SOURCE_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid source id. Use 3-81 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

/**
 * Derived from the video the platform already names, so pasting one URL twice
 * finds the existing candidate instead of making a second one. Sanitising can
 * empty a platform id, so a hashed form keeps such a source addressable.
 */
export function deriveSourceId(extractorKey: string, platformVideoId: string): string {
  const platform = slug(extractorKey) || "source";
  const video = slug(platformVideoId);
  const derived = `${platform}-${video}`;
  if (video && SOURCE_ID_PATTERN.test(derived)) {
    return derived;
  }
  const digest = createHash("sha256").update(`${extractorKey}:${platformVideoId}`).digest("hex").slice(0, 10);
  return `${platform}-${digest}`;
}

export function resolveSourcePath(id: string, ...segments: string[]): string {
  const safeId = validateSourceId(id);
  const root = resolve(sourcesRoot(), safeId);
  const resolved = resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Resolved path is outside the sources directory.");
  }
  return resolved;
}

export async function saveCandidate(candidate: SourceCandidate): Promise<void> {
  const path = resolveSourcePath(candidate.id, CANDIDATE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
}

export async function loadCandidate(id: string): Promise<SourceCandidate | null> {
  try {
    return JSON.parse(await readFile(resolveSourcePath(id, CANDIDATE_FILE), "utf8")) as SourceCandidate;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Directories the store did not write stay invisible: a name that is not a valid
 * source id, or one holding no readable candidate file, is skipped rather than
 * adopted. The store must never claim files it does not own.
 */
export async function listCandidates(): Promise<SourceCandidate[]> {
  let entries: string[];
  try {
    entries = (await readdir(sourcesRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const candidates: SourceCandidate[] = [];
  for (const name of entries) {
    try {
      validateSourceId(name);
    } catch {
      continue;
    }
    const candidate = await loadCandidate(name);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export async function candidateDirectoryExists(id: string): Promise<boolean> {
  try {
    await readdir(resolveSourcePath(id));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
