import { importMedia, type MediaArtifact } from "./media-ingest.ts";
import { requireCandidate } from "./sources/candidates.ts";
import { resolveSourcePath, validateSourceId } from "./sources/store.ts";
import { importSubtitle, type ImportedSubtitle } from "./translation.ts";

export type SourceImportResult = {
  media: MediaArtifact;
  /** Absent when the source has no subtitle or only a non-SRT one. */
  subtitle: ImportedSubtitle | null;
};

/**
 * Copies a downloaded source candidate into a project's media stage so the
 * existing audio-extraction -> ASR -> translation -> script pipeline can run
 * on it. Only an .srt subtitle is imported alongside; other formats are
 * skipped because the project subtitle stage validates SRT cues.
 */
export async function importSourceIntoProject(projectId: string, sourceId: string): Promise<SourceImportResult> {
  const safeId = validateSourceId(sourceId);
  const candidate = await requireCandidate(safeId);
  if (candidate.status !== "downloaded" || !candidate.media) {
    throw new Error(`Source ${safeId} has no downloaded media yet. Download it before sending it to a project.`);
  }

  const media = await importMedia(projectId, resolveSourcePath(safeId, candidate.media.videoRelativePath));

  const subtitleRelativePath = candidate.media.subtitleRelativePath;
  const subtitle = subtitleRelativePath?.toLowerCase().endsWith(".srt")
    ? await importSubtitle(projectId, resolveSourcePath(safeId, subtitleRelativePath))
    : null;

  return { media, subtitle };
}
