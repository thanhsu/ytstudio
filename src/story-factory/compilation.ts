import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveProjectPath } from "../project-paths.ts";
import { runProcess } from "../process.ts";
import { writeJson } from "../fs.ts";
import { loadStory, readStageArtifact } from "./story-project.ts";
import { storyPath, validateStoryId } from "./paths.ts";
import type { ExportManifest, StoryMetadataArtifact, StageRun, StoryApproval } from "./types.ts";
import type { RenderStageArtifact } from "./export.ts";

export type CompilationProject = {
  version: 1;
  id: string;
  channelId: string;
  title: string;
  storyIds: string[];
  stages: Partial<Record<"metadata" | "render" | "thumbnail" | "export", StageRun>>;
  approvals: Partial<Record<"final", StoryApproval>>;
  createdAt: string;
  updatedAt: string;
};

export type CompilationRenderArtifact = RenderStageArtifact & { chapters: Array<{ title: string; startSeconds: number }> };

export function compilationPath(channelId: string, compilationId: string, ...segments: string[]): string {
  return resolveProjectPath(channelId, "compilations", validateStoryId(compilationId), ...segments);
}

export async function createCompilation(channelId: string, input: { id: string; title: string; storyIds: string[] }): Promise<CompilationProject> {
  const id = validateStoryId(input.id);
  const storyIds = [...new Set(input.storyIds.map(validateStoryId))];
  if (storyIds.length < 4 || storyIds.length > 6) throw new Error("A compilation needs 4-6 stories.");
  for (const storyId of storyIds) {
    const story = await loadStory(channelId, storyId);
    if (story.stages.render?.status !== "done") throw new Error(`Story ${storyId} needs a completed render.`);
    const render = await readStageArtifact<RenderStageArtifact>(channelId, storyId, "render");
    if (!render?.videoPath) throw new Error(`Story ${storyId} has no render artifact.`);
  }
  const now = new Date().toISOString();
  const project: CompilationProject = { version: 1, id, channelId, title: input.title.trim() || "Untitled compilation", storyIds, stages: {}, approvals: {}, createdAt: now, updatedAt: now };
  await mkdir(compilationPath(channelId, id), { recursive: true });
  await writeJson(compilationPath(channelId, id, "compilation.json"), project);
  return project;
}

export async function listCompilations(channelId: string): Promise<CompilationProject[]> {
  let names: string[] = [];
  try { names = await readdir(resolveProjectPath(channelId, "compilations")); } catch (error: unknown) { if (isNotFound(error)) return []; throw error; }
  const result: CompilationProject[] = [];
  for (const name of names) {
    try { result.push(JSON.parse(await readFile(compilationPath(channelId, name, "compilation.json"), "utf8")) as CompilationProject); } catch { /* broken dirs are ignored */ }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadCompilation(channelId: string, compilationId: string): Promise<CompilationProject> {
  return JSON.parse(await readFile(compilationPath(channelId, compilationId, "compilation.json"), "utf8")) as CompilationProject;
}

export async function renderCompilation(channelId: string, compilationId: string, deps: { config: { render: { ffmpegPath: string } }; ffmpegPath?: string; ffmpegPrefixArgs?: string[]; probeDuration?: (path: string) => Promise<number>; signal?: AbortSignal; update?: (progress: number, message: string) => Promise<void> }): Promise<void> {
  const project = await loadCompilation(channelId, compilationId);
  const workspace = compilationPath(channelId, compilationId, "workspace");
  await mkdir(workspace, { recursive: true });
  const listPath = join(workspace, "concat.txt");
  const chapters: Array<{ title: string; startSeconds: number }> = [];
  let offset = 0;
  const lines: string[] = [];
  for (const storyId of project.storyIds) {
    const story = await loadStory(channelId, storyId);
    const render = await readStageArtifact<RenderStageArtifact>(channelId, storyId, "render");
    if (!render?.videoPath) throw new Error(`Story ${storyId} has no render artifact.`);
    const path = resolveProjectPath(channelId, render.videoPath);
    lines.push(`file '${path.replace(/'/g, "'\\''")}'`);
    chapters.push({ title: story.title, startSeconds: offset });
    offset += await (deps.probeDuration ? deps.probeDuration(path) : Promise.resolve(render.durationSeconds));
  }
  await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
  const outputPath = join(workspace, "compilation.mp4");
  await runProcess(deps.ffmpegPath ?? deps.config.render.ffmpegPath ?? "ffmpeg", [...(deps.ffmpegPrefixArgs ?? []), "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath], { signal: deps.signal });
  const artifact: CompilationRenderArtifact = { version: 1, videoPath: `compilations/${compilationId}/workspace/compilation.mp4`, durationSeconds: offset, width: 1920, height: 1080, chapters };
  await writeJson(compilationPath(channelId, compilationId, "render.json"), artifact);
  project.stages.render = { status: "done", attemptCount: (project.stages.render?.attemptCount ?? 0) + 1, costUsd: 0, finishedAt: new Date().toISOString() };
  project.updatedAt = new Date().toISOString();
  await writeJson(compilationPath(channelId, compilationId, "compilation.json"), project);
  await deps.update?.(100, "Compilation rendered");
}

export async function exportCompilation(channelId: string, compilationId: string): Promise<ExportManifest> {
  const project = await loadCompilation(channelId, compilationId);
  if (!project.approvals.final || project.approvals.final.artifactHash !== await artifactHash(channelId, compilationId, "render.json")) throw new Error("Compilation export requires final approval.");
  const render = JSON.parse(await readFile(compilationPath(channelId, compilationId, "render.json"), "utf8")) as CompilationRenderArtifact;
  const metadata = await readOptionalMetadata(channelId, compilationId);
  const dir = compilationPath(channelId, compilationId, "workspace", "export");
  await mkdir(dir, { recursive: true });
  const manifest: ExportManifest = { version: 1, videoPath: `compilations/${compilationId}/workspace/export/story.mp4`, thumbnailPath: `compilations/${compilationId}/workspace/export/thumbnail.png`, titlePath: `compilations/${compilationId}/workspace/export/title.txt`, descriptionPath: `compilations/${compilationId}/workspace/export/description.txt`, tagsPath: `compilations/${compilationId}/workspace/export/tags.txt`, srtPath: `compilations/${compilationId}/workspace/export/captions.srt`, packagedAt: new Date().toISOString() };
  await copyFile(resolveProjectPath(channelId, render.videoPath), resolveProjectPath(channelId, manifest.videoPath));
  await writeFile(resolveProjectPath(channelId, manifest.titlePath), `${metadata.chosenTitle}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.descriptionPath), `${metadata.description}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.tagsPath), `${metadata.tags.join(", ")}\n`, "utf8");
  await writeJson(compilationPath(channelId, compilationId, "export.json"), manifest);
  return manifest;
}

async function readOptionalMetadata(channelId: string, id: string): Promise<StoryMetadataArtifact> {
  try { return JSON.parse(await readFile(compilationPath(channelId, id, "metadata.json"), "utf8")) as StoryMetadataArtifact; } catch { return { version: 1, titles: [], chosenTitle: "Compilation", description: "", tags: [], thumbnailText: "Compilation", thumbnailConcept: "", language: "en", provenance: { provider: "local", model: "local", promptVersion: "comp-meta-v1", generatedAt: new Date().toISOString() } }; }
}

async function artifactHash(channelId: string, id: string, file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(compilationPath(channelId, id, file))).digest("hex");
}

function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
