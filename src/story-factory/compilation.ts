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
import { runLlmCall, stageEndpoint, type ChatFn } from "./stage-llm.ts";
import { parseMetadata } from "./stages/metadata.ts";
import { buildMetadataMessages } from "./prompts/metadata.ts";
import { buildThumbnailOverlayArgs } from "./thumbnail.ts";

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
export type CompilationMetadataDeps = { config: Parameters<typeof stageEndpoint>[0]; chat?: ChatFn; confirmedPaidRequest: boolean; signal?: AbortSignal };

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

export async function runCompilationMetadata(channelId: string, compilationId: string, deps: CompilationMetadataDeps): Promise<StoryMetadataArtifact> {
  const project = await loadCompilation(channelId, compilationId);
  const members = await Promise.all(project.storyIds.map(async (storyId) => {
    const story = await loadStory(channelId, storyId);
    const idea = await readStageArtifact<{ logline?: string; premise?: string }>(channelId, storyId, "idea");
    return { title: story.title, logline: idea?.logline ?? story.title, premise: idea?.premise ?? "" };
  }));
  const result = await runLlmCall({
    channelId,
    storyId: compilationId,
    stage: "metadata",
    promptName: "story.compilation-metadata",
    promptVersion: "comp-meta-v1",
    endpoint: stageEndpoint(deps.config, "metadata"),
    messages: buildMetadataMessages({ language: "en", locale: "en-US", niche: "compilation", subNiche: "", tone: "cinematic", promptStyle: "honest", targetDurationMinutes: 60 }, {
      logline: members.map((member, index) => `Chapter ${index + 1}: ${member.title} — ${member.logline}`).join("\n"),
      hookText: "A curated compilation of original audio stories.",
      synopsis: members.map((member) => member.premise || member.title).join("\n"),
    }),
    parse: parseMetadata,
    pricing: deps.config.storyFactory.llmPricing,
    confirmedPaidRequest: deps.confirmedPaidRequest,
    chat: deps.chat,
    signal: deps.signal,
  });
  const render = JSON.parse(await readFile(compilationPath(channelId, compilationId, "render.json"), "utf8")) as CompilationRenderArtifact;
  const chapterLines = render.chapters.map((chapter) => `${formatTimestamp(chapter.startSeconds)} ${chapter.title}`).join("\n");
  const artifact: StoryMetadataArtifact = { version: 1, ...result.value, description: `${result.value.description}\n\nChapters:\n${chapterLines}`, language: "en", provenance: result.provenance };
  await writeJson(compilationPath(channelId, compilationId, "metadata.json"), artifact);
  const projectUpdated = await loadCompilation(channelId, compilationId);
  projectUpdated.stages.metadata = { status: "done", attemptCount: (projectUpdated.stages.metadata?.attemptCount ?? 0) + 1, costUsd: result.costUsd, finishedAt: new Date().toISOString() };
  projectUpdated.updatedAt = new Date().toISOString();
  await writeJson(compilationPath(channelId, compilationId, "compilation.json"), projectUpdated);
  return artifact;
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
  await createCompilationThumbnail(channelId, project, metadata, dir);
  await copyFile(join(dir, "thumbnail.png"), resolveProjectPath(channelId, manifest.thumbnailPath));
  await writeFile(resolveProjectPath(channelId, manifest.titlePath), `${metadata.chosenTitle}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.descriptionPath), `${metadata.description}\n`, "utf8");
  await writeFile(resolveProjectPath(channelId, manifest.tagsPath), `${metadata.tags.join(", ")}\n`, "utf8");
  await writeJson(compilationPath(channelId, compilationId, "export.json"), manifest);
  return manifest;
}

async function createCompilationThumbnail(channelId: string, project: CompilationProject, metadata: StoryMetadataArtifact, exportDir: string): Promise<void> {
  const first = await readStageArtifact<{ backgroundPath?: string; finalPath?: string }>(channelId, project.storyIds[0], "thumbnail");
  const source = first?.backgroundPath ?? first?.finalPath;
  if (!source) throw new Error("Compilation export needs a completed thumbnail on the first member story.");
  const thumbnailDir = compilationPath(channelId, project.id, "workspace", "thumbnail");
  await mkdir(thumbnailDir, { recursive: true });
  const background = join(thumbnailDir, "background.png");
  await copyFile(resolveProjectPath(channelId, source), background);
  const output = join(thumbnailDir, "thumbnail.png");
  if (first?.backgroundPath) {
    await runProcess("ffmpeg", buildThumbnailOverlayArgs({ backgroundPath: background, overlayText: metadata.thumbnailText, outputPath: output }));
  } else {
    // Older stories may only have the final thumbnail artifact. Reuse it as-is
    // instead of forcing a paid regeneration or requiring ffmpeg during export.
    await copyFile(background, output);
  }
  await copyFile(join(thumbnailDir, "thumbnail.png"), join(exportDir, "thumbnail.png"));
  await writeJson(compilationPath(channelId, project.id, "thumbnail.json"), { version: 1, backgroundPath: `compilations/${project.id}/workspace/thumbnail/background.png`, overlayText: metadata.thumbnailText, finalPath: `compilations/${project.id}/workspace/thumbnail/thumbnail.png` });
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function readOptionalMetadata(channelId: string, id: string): Promise<StoryMetadataArtifact> {
  try { return JSON.parse(await readFile(compilationPath(channelId, id, "metadata.json"), "utf8")) as StoryMetadataArtifact; } catch { return { version: 1, titles: [], chosenTitle: "Compilation", description: "", tags: [], thumbnailText: "Compilation", thumbnailConcept: "", language: "en", provenance: { provider: "local", model: "local", promptVersion: "comp-meta-v1", generatedAt: new Date().toISOString() } }; }
}

async function artifactHash(channelId: string, id: string, file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(compilationPath(channelId, id, file))).digest("hex");
}

function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
