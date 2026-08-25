import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { resolveProjectPath, validateProjectId } from "../project-paths.ts";

/**
 * Storage primitives for canon entities. A canon series is a channel project,
 * so its entities live under `projects/<seriesId>/canon/` and reach disk
 * through the same traversal guard everything else uses.
 *
 * Two properties this module exists to provide:
 *
 * 1. **Atomic writes.** `fs.writeJson` is a plain writeFile. Canon entities are
 *    written by jobs AND by HTTP PUT routes that bypass jobs entirely, so two
 *    writers can interleave. Combined with normalize-on-read that failure is
 *    silent and catastrophic: a truncated-but-parseable characters.json
 *    normalizes to an empty roster, and the next chapter is written with no
 *    cast. Writing to a temp file and renaming makes a partial write
 *    impossible to observe.
 *
 * 2. **A per-series mutex.** Every canon mutation is read-modify-write
 *    (append a fact, bump a revision). One-job-per-owner does not cover the PUT
 *    routes, so serialization has to live here, at the store.
 */

const CANON_DIR = "canon";

/** Absolute path inside a series' canon directory, traversal-guarded. */
export function canonPath(seriesId: string, ...segments: string[]): string {
  const canonRoot = resolveProjectPath(validateProjectId(seriesId), CANON_DIR);
  const resolved = resolveProjectPath(validateProjectId(seriesId), CANON_DIR, ...segments);
  // resolveProjectPath only guards the project root; canon segments must not
  // climb out of the canon dir either (they could reach series.json or a story).
  if (resolved !== canonRoot && !resolved.startsWith(`${canonRoot}${sep}`)) {
    throw new Error("Resolved path is outside the canon directory.");
  }
  return resolved;
}

/** Channel-relative path, for serving canon files over the existing files route. */
export function canonRelativePath(...segments: string[]): string {
  return [CANON_DIR, ...segments].join("/");
}

/**
 * Write-then-rename. The rename is atomic on both NTFS and POSIX, so a reader
 * either sees the whole previous file or the whole new one — never a prefix.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export type JsonlReadResult<T> = {
  records: T[];
  /**
   * Lines that would not parse. Surfaced rather than swallowed: for an append
   * log a torn line is cosmetic, but for the canon event ledger it means lost
   * story history and the operator has to know.
   */
  tornLines: number;
};

export async function readJsonl<T>(path: string): Promise<JsonlReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return { records: [], tornLines: 0 };
    throw error;
  }
  const records: T[] = [];
  let tornLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      tornLines += 1;
    }
  }
  return { records, tornLines };
}

/**
 * Serializes canon mutations per series within this process. Jobs and HTTP
 * routes share one Node process, so an in-process queue is the whole story
 * here; the atomic rename above is what protects against a second process.
 */
const seriesLocks = new Map<string, Promise<unknown>>();

export async function withSeriesLock<T>(seriesId: string, operation: () => Promise<T>): Promise<T> {
  const id = validateProjectId(seriesId);
  const previous = seriesLocks.get(id) ?? Promise.resolve();
  // Chain off the previous holder's settlement rather than its value, so one
  // failed mutation does not poison every later one.
  const run = previous.then(operation, operation);
  const tail = run.catch(() => undefined);
  seriesLocks.set(id, tail);
  // Drop the entry once nothing else has queued behind this operation, so a
  // long-lived process does not retain a lock per series it ever touched.
  void tail.then(() => {
    if (seriesLocks.get(id) === tail) seriesLocks.delete(id);
  });
  return run;
}

/**
 * Load a canon entity, normalizing whatever is on disk (or nothing) into a
 * valid value. Missing file is not an error: an entity that has never been
 * written yields its documented empty shape, the same contract
 * `loadStoryChannel` offers.
 */
export async function loadCanonEntity<T>(
  seriesId: string,
  fileName: string,
  normalize: (seriesId: string, value: unknown) => T,
): Promise<T> {
  const id = validateProjectId(seriesId);
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(canonPath(id, fileName), "utf8"));
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  return normalize(id, value);
}

/**
 * Read-modify-write an entity under the series lock, bumping its revision.
 * Every canon mutation goes through here so no caller can forget the lock.
 */
export async function updateCanonEntity<T extends { revision: number; updatedAt: string }>(
  seriesId: string,
  fileName: string,
  normalize: (seriesId: string, value: unknown) => T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return withSeriesLock(seriesId, async () => {
    const current = await loadCanonEntity(seriesId, fileName, normalize);
    const next = await mutate(current);
    const saved = normalize(validateProjectId(seriesId), {
      ...next,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(canonPath(seriesId, fileName), saved);
    return saved;
  });
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Small shared normalizers. Canon entities follow the repo's normalize-on-read
// convention: a malformed field becomes its default rather than throwing, so a
// hand-edited file can always be loaded and repaired in the UI.
// ---------------------------------------------------------------------------

export function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export function boundedUnit(value: unknown, fallback = 0.5): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

export function wholeNumber(value: unknown, fallback = 0): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

export function nonNegativeNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** A stable id from a label, so hand-authored canon can omit ids entirely. */
export function slugId(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFD")
    // The combining mark must be deleted, not collapsed into the separator:
    // NFD puts it BETWEEN letters, so collapsing turns "maría" into "mari-a".
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}
