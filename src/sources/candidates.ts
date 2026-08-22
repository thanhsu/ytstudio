import {
  candidateDirectoryExists,
  deriveSourceId,
  loadCandidate,
  saveCandidate,
  validateSourceId,
  type SourceCandidate,
  type SourceRights,
} from "./store.ts";
import { fetchSourceMetadata, type YtDlpOptions } from "./yt-dlp.ts";

export type AddCandidateResult = { candidate: SourceCandidate; created: boolean };

const RIGHTS_VALUES: readonly SourceRights[] = ["unknown", "own", "licensed", "third-party-fair-use"];

/**
 * Serialises read-modify-write cycles for one candidate. The job manager keeps two
 * jobs off the same candidate, but nothing stops two HTTP requests from
 * interleaving a load and a save of candidate.json.
 */
const locks = new Map<string, Promise<unknown>>();

export async function withCandidateLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  // Both handlers run the work: one caller failing must not cancel the next.
  const current = previous.then(run, run);
  // The map holds a settled-only chain so a rejection never poisons the queue.
  const guard = current.then(noop, noop);
  locks.set(id, guard);
  try {
    return await current;
  } finally {
    if (locks.get(id) === guard) locks.delete(id);
  }
}

export async function addCandidate(url: string, options: YtDlpOptions): Promise<AddCandidateResult> {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("A source URL is required.");
  }

  const metadata = await fetchSourceMetadata(trimmed, options);
  const id = deriveSourceId(metadata.platform, metadata.platformVideoId);

  return withCandidateLock(id, async () => {
    const existing = await loadCandidate(id);
    if (existing) {
      if (existing.platform === metadata.platform && existing.platformVideoId === metadata.platformVideoId) {
        return { candidate: existing, created: false };
      }
      throw new Error(
        `Source id ${id} already holds ${existing.platform}:${existing.platformVideoId}, ` +
          `which is not ${metadata.platform}:${metadata.platformVideoId}.`,
      );
    }

    // A directory the store did not write is never adopted: it may hold files
    // this studio knows nothing about.
    if (await candidateDirectoryExists(id)) {
      throw new Error(`The directory for source ${id} exists but holds no candidate file.`);
    }

    const candidate: SourceCandidate = {
      version: 1,
      id,
      canonicalUrl: metadata.canonicalUrl,
      platform: metadata.platform,
      platformVideoId: metadata.platformVideoId,
      title: metadata.title,
      uploader: metadata.uploader,
      durationSeconds: metadata.durationSeconds,
      description: metadata.description,
      addedAt: new Date().toISOString(),
      status: "metadata",
      rights: "unknown",
      rightsNote: "",
    };
    await saveCandidate(candidate);
    return { candidate, created: true };
  });
}

export async function requireCandidate(id: string): Promise<SourceCandidate> {
  const candidate = await loadCandidate(validateSourceId(id));
  if (!candidate) {
    throw new Error(`No source candidate ${id}.`);
  }
  return candidate;
}

export async function setCandidateRights(
  id: string,
  rights: SourceRights,
  rightsNote: string,
): Promise<SourceCandidate> {
  if (!RIGHTS_VALUES.includes(rights)) {
    throw new Error(`Unknown rights value ${JSON.stringify(rights)}. Use one of ${RIGHTS_VALUES.join(", ")}.`);
  }

  return withCandidateLock(validateSourceId(id), async () => {
    const candidate = await requireCandidate(id);
    const updated: SourceCandidate = { ...candidate, rights, rightsNote: rightsNote.trim() };
    await saveCandidate(updated);
    return updated;
  });
}

/**
 * Permission to download, and nothing more. A project still needs its own
 * approved copyright checklist before anything is rendered.
 */
export function assertDownloadable(candidate: SourceCandidate): void {
  if (candidate.rights === "unknown") {
    throw new Error(`Declare the rights for source ${candidate.id} before downloading it.`);
  }
}

function noop(): void {}
