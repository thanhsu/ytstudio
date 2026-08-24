import { access, readFile, stat } from "node:fs/promises";
import { currentSourceHashes, projectPipelineStatus } from "../workflow.ts";
import { loadProjectState } from "../project-state.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { loadCompilation, compilationPath } from "../story-factory/compilation.ts";
import { approvalState, loadStory, readStageArtifact } from "../story-factory/story-project.ts";
import type { ExportManifest, StoryMetadataArtifact, ThumbnailArtifact } from "../story-factory/types.ts";
import { loadReviewProject } from "../review-project.ts";

export type PublishSourceKind = "story" | "review" | "compilation";
export type ApprovalState = "missing" | "current" | "stale" | "not-required";
export type ApprovalMatrixResult = Record<string, ApprovalState>;
export type PublishReadiness = {
  ready: boolean;
  matrix: ApprovalMatrixResult;
  exportPath: string | null;
  thumbnailPath: string | null;
  metadata: { title: string; description: string; tags: string[] } | null;
};

export class YouTubeReadinessError extends Error {
  readonly code: "youtube-export-missing" | "youtube-approval-required" | "source-not-found";
  readonly matrix: ApprovalMatrixResult;
  constructor(code: "youtube-export-missing" | "youtube-approval-required" | "source-not-found", message: string, matrix: ApprovalMatrixResult) {
    super(message);
    this.code = code;
    this.matrix = matrix;
    this.name = "YouTubeReadinessError";
  }
}

export async function evaluatePublishReadiness(seriesId: string, sourceKind: PublishSourceKind, sourceId: string): Promise<PublishReadiness> {
  try {
    if (sourceKind === "story") return await storyReadiness(seriesId, sourceId);
    if (sourceKind === "compilation") return await compilationReadiness(seriesId, sourceId);
    return await reviewReadiness(seriesId, sourceId);
  } catch (error: unknown) {
    if (error instanceof YouTubeReadinessError) throw error;
    if (isNotFound(error)) {
      throw new YouTubeReadinessError("source-not-found", "The publish source could not be found.", missingMatrix(sourceKind));
    }
    throw error;
  }
}

async function storyReadiness(seriesId: string, storyId: string): Promise<PublishReadiness> {
  const story = await loadStory(seriesId, storyId);
  const matrix: ApprovalMatrixResult = Object.fromEntries((['script', 'media', 'final'] as const).map((key) => {
    const state = approvalState(story, key);
    return [key, state === "approved" ? "current" : state];
  }));
  matrix.export = story.stages.export?.status === "done" ? "current" : "missing";
  if (Object.values(matrix).some((value) => value === "missing" || value === "stale")) {
    throw new YouTubeReadinessError("youtube-approval-required", "Current script, media, and final approvals are required before publishing.", matrix);
  }
  const manifest = await readStageArtifact<ExportManifest>(seriesId, storyId, "export");
  return await materializeExport(seriesId, manifest, matrix);
}

async function compilationReadiness(seriesId: string, compilationId: string): Promise<PublishReadiness> {
  const compilation = await loadCompilation(seriesId, compilationId);
  const candidate = compilation as unknown as { approvals?: Record<string, { artifactHash?: string }>; stages?: Record<string, { status?: string; artifactHash?: string }> };
  const matrix: ApprovalMatrixResult = {};
  for (const key of ["script", "media", "final"] as const) {
    const approval = candidate.approvals?.[key];
    const stage = candidate.stages?.[key === "final" ? "render" : key];
    matrix[key] = approval?.artifactHash && stage?.artifactHash && approval.artifactHash === stage.artifactHash ? "current" : approval ? "stale" : "missing";
  }
  matrix.export = candidate.stages?.export?.status === "done" || await fileExists(compilationPath(seriesId, compilationId, "export.json")) ? "current" : "missing";
  if (Object.values(matrix).some((value) => value === "missing" || value === "stale")) {
    throw new YouTubeReadinessError("youtube-approval-required", "Current compilation script, media, and final approvals are required before publishing.", matrix);
  }
  const manifest = JSON.parse(await readFile(compilationPath(seriesId, compilationId, "export.json"), "utf8")) as ExportManifest;
  return materializeExport(seriesId, manifest, matrix);
}

async function reviewReadiness(seriesId: string, reviewId: string): Promise<PublishReadiness> {
  const project = await loadReviewProject(seriesId, reviewId);
  const projectId = seriesId;
  const state = await loadProjectState(projectId);
  const hashes = await currentSourceHashes(projectId);
  const pipeline = await projectPipelineStatus(projectId);
  const matrix: ApprovalMatrixResult = {
    script: pipeline.script === "approved" ? "current" : pipeline.script === "stale" ? "stale" : "missing",
    assets: pipeline.assets === "approved" ? "current" : pipeline.assets === "stale" ? "stale" : "missing",
    copyright: pipeline.copyright === "approved" ? "current" : pipeline.copyright === "stale" ? "stale" : "missing",
    final: "not-required",
    export: state.artifacts.render ? "current" : "missing",
  };
  void hashes;
  if (["script", "assets", "copyright"].some((key) => matrix[key] !== "current")) {
    throw new YouTubeReadinessError("youtube-approval-required", "Current review script, assets, and copyright approvals are required before publishing.", matrix);
  }
  if (!state.artifacts.render?.relativePath || !(await fileExists(resolveProjectPath(projectId, state.artifacts.render.relativePath)))) {
    throw new YouTubeReadinessError("youtube-export-missing", "A completed review render/export is required before publishing.", matrix);
  }
  const metadata = await readReviewMetadata(seriesId, project.outputs.youtubeMetadata);
  return { ready: true, matrix, exportPath: state.artifacts.render.relativePath, thumbnailPath: null, metadata };
}

async function materializeExport(seriesId: string, manifest: ExportManifest | null, matrix: ApprovalMatrixResult): Promise<PublishReadiness> {
  if (!manifest?.videoPath || !manifest.thumbnailPath) throw new YouTubeReadinessError("youtube-export-missing", "The completed export package is missing video or thumbnail output.", { ...matrix, export: "missing" });
  const paths = [manifest.videoPath, manifest.thumbnailPath, manifest.titlePath, manifest.descriptionPath, manifest.tagsPath];
  if (!(await Promise.all(paths.map((path) => fileExists(resolveProjectPath(seriesId, path))))).every(Boolean)) {
    throw new YouTubeReadinessError("youtube-export-missing", "The completed export package is incomplete.", { ...matrix, export: "missing" });
  }
  const [title, description, tags] = await Promise.all([
    readFile(resolveProjectPath(seriesId, manifest.titlePath), "utf8"),
    readFile(resolveProjectPath(seriesId, manifest.descriptionPath), "utf8"),
    readFile(resolveProjectPath(seriesId, manifest.tagsPath), "utf8"),
  ]);
  return { ready: true, matrix, exportPath: manifest.videoPath, thumbnailPath: manifest.thumbnailPath, metadata: { title: title.trim(), description, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) } };
}

async function readReviewMetadata(seriesId: string, path: string | undefined): Promise<{ title: string; description: string; tags: string[] }> {
  if (path) {
    try {
      const value = JSON.parse(await readFile(resolveProjectPath(seriesId, path), "utf8")) as { titles?: unknown; description?: unknown };
      return { title: Array.isArray(value.titles) ? String(value.titles[0] ?? "Review") : "Review", description: typeof value.description === "string" ? value.description : "", tags: [] };
    } catch { /* use safe defaults */ }
  }
  return { title: "Review", description: "", tags: [] };
}

async function fileExists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
function missingMatrix(kind: PublishSourceKind): ApprovalMatrixResult { return kind === "review" ? { script: "missing", assets: "missing", copyright: "missing", final: "not-required", export: "missing" } : { script: "missing", media: "missing", final: "missing", export: "missing" }; }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
