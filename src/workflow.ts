import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadAssetManifest, validateAssetManifest } from "./assets.ts";
import { saveCaptions, type CaptionArtifact } from "./captions.ts";
import { loadStudioConfig } from "./config.ts";
import { loadEditManifest, type EditManifest } from "./edit-manifest.ts";
import { buildCutSrt, cutTimeline, renderEditedCut, type CutArtifact } from "./edit-render.ts";
import {
  derivePipelineStatus,
  loadProjectState,
  approveStage,
  setArtifact,
  sha256,
  type PipelineStatus,
  type SourceHashes,
} from "./project-state.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { extractNarration } from "./narration.ts";
import { probeDuration } from "./media.ts";
import { evaluateRenderGate, renderDraft, type RenderArtifact, type RenderGateResult, type RenderVisualSegment } from "./render.ts";
import { loadVisualMapping } from "./visual-mapping.ts";
import { DEFAULT_SEGMENT_EFFECTS, validateSegmentEffects } from "./visual-effects.ts";
import { createPiperProvider } from "./tts/piper.ts";
import { createOpenAiProvider } from "./tts/openai.ts";
import { createVietnameseLocalProvider } from "./tts/vietnamese-local.ts";
import type { ArtifactRecord, CopyrightCheckResult, VideoBrief, VideoFormat } from "./types.ts";
import type { TtsArtifact, TtsRequest } from "./tts/types.ts";

export type GenerateVoiceOptions = {
  projectId: string;
  provider: "piper" | "openai" | "vietnamese-local";
  voice?: string;
  confirmedPaidRequest?: boolean;
  piperExecutable?: string;
  piperPrefixArgs?: string[];
  piperModelPath?: string;
  openAiApiKey?: string;
  openAiModel?: string;
  vietnamesePythonPath?: string;
  vietnameseAppPath?: string;
  vietnamesePrefixArgs?: string[];
  probeDuration?: (filePath: string) => Promise<number>;
};

export type RenderDraftOptions = {
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
};

export async function approveCurrentScript(projectId: string): Promise<void> {
  const narration = await readProjectNarration(projectId);
  await approveStage(projectId, "script", narration.hash, "Approved current narration.");
}

/**
 * Hashes of everything an approval is taken against. An approval whose hash no
 * longer matches is stale, which is what stops edited content from riding on a
 * signature the operator gave to an earlier version.
 */
export async function currentSourceHashes(projectId: string): Promise<SourceHashes> {
  const hashes: SourceHashes = {};

  try {
    hashes.script = (await readProjectNarration(projectId)).hash;
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }

  hashes.assets = sha256(JSON.stringify(await loadAssetManifest(projectId)));

  try {
    hashes.copyright = sha256(await readFile(resolveProjectPath(projectId, "copyright-check.json"), "utf8"));
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }

  return hashes;
}

export async function projectPipelineStatus(projectId: string): Promise<PipelineStatus> {
  const state = await loadProjectState(projectId);
  return derivePipelineStatus(state, await currentSourceHashes(projectId));
}

export async function evaluateProjectRenderGate(projectId: string): Promise<RenderGateResult> {
  const status = await projectPipelineStatus(projectId);
  const manifest = await loadAssetManifest(projectId);
  const mapping = await loadVisualMapping(projectId);
  // With no assets there is nothing to grant rights over and nothing to map, so
  // both gates stand down rather than blocking a purely narrated draft.
  const hasAssets = manifest.assets.length > 0;

  return evaluateRenderGate({
    script: status.script,
    assets: hasAssets ? status.assets : "not-required",
    copyright: status.copyright,
    voice: status.voice,
    captions: status.captions,
    visualMapping: !hasAssets ? "not-required" : mapping?.status === "approved" ? "approved" : "missing",
  });
}

/**
 * The cut path answers to different gates than the narrated draft: it publishes
 * the source footage itself, so rights clearance is the whole gate, and it needs
 * a video and a set of kept cues rather than narration and captions.
 */
export async function evaluateEditRenderGate(projectId: string): Promise<RenderGateResult> {
  const reasons: string[] = [];

  const copyright = (await projectPipelineStatus(projectId)).copyright;
  if (copyright === "missing" || copyright === "stale") {
    reasons.push(`copyright-approval-${copyright}`);
  }

  const state = await loadProjectState(projectId);
  if (!state.artifacts.media) {
    reasons.push("source-media-missing");
  }

  const manifest = await loadEditManifestOrNull(projectId);
  if (!manifest) {
    reasons.push("edit-manifest-missing");
  } else if (!cutTimeline(manifest).length) {
    reasons.push("edit-manifest-keeps-no-cues");
  }

  return { allowed: reasons.length === 0, reasons };
}

export async function renderEditedCutProject(
  projectId: string,
  options: RenderDraftOptions = {},
): Promise<CutArtifact> {
  const gate = await evaluateEditRenderGate(projectId);
  if (!gate.allowed) {
    throw new Error(`Cut render is gated: ${gate.reasons.join(", ")}.`);
  }

  const config = await loadStudioConfig();
  const state = await loadProjectState(projectId);
  const manifest = requireEditManifest(await loadEditManifestOrNull(projectId));
  const outputPath = editRenderOutputPath(projectId);

  // Written before the cut so a failed encode never leaves subtitles that claim
  // to describe a file that does not exist.
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath.replace(/\.mp4$/, ".srt"), buildCutSrt(manifest), "utf8");

  return renderEditedCut({
    projectId,
    manifest,
    sourceVideoPath: resolveProjectPath(projectId, requireArtifact(state.artifacts.media, "media").relativePath),
    outputPath,
    ffmpegPath: options.ffmpegPath ?? (config.render.ffmpegPath || undefined),
    ffmpegPrefixArgs: options.ffmpegPrefixArgs,
  });
}

export function editRenderOutputPath(projectId: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const version = `${timestamp.slice(0, 8)}-${timestamp.slice(8, 14)}-${timestamp.slice(14)}`;
  return resolveProjectPath(projectId, "workspace", "renders", `cut-${version}.mp4`);
}

async function loadEditManifestOrNull(projectId: string): Promise<EditManifest | null> {
  try {
    return await loadEditManifest(projectId);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function requireEditManifest(manifest: EditManifest | null): EditManifest {
  if (!manifest) {
    throw new Error("Edit manifest is missing.");
  }
  return manifest;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function generateVoice(options: GenerateVoiceOptions): Promise<TtsArtifact> {
  const narration = await readProjectNarration(options.projectId);
  const config = await loadStudioConfig();
  const request: TtsRequest = {
    projectId: options.projectId,
    provider: options.provider,
    text: narration.text,
    voice: options.voice ?? defaultVoice(options.provider, config),
    format: options.provider === "openai" ? "mp3" : "wav",
    speed: 1,
    instructions: "",
    confirmedPaidRequest: options.confirmedPaidRequest === true,
  };

  const provider = createVoiceProvider(options, config);

  const voice = await provider.generate(request);
  await setArtifact(options.projectId, {
    kind: "voice",
    sourceHash: narration.hash,
    relativePath: voice.relativePath,
    createdAt: voice.createdAt,
    metadata: {
      provider: voice.provider,
      durationSeconds: voice.durationSeconds,
      voice: request.voice,
    },
  });
  return voice;
}

function createVoiceProvider(options: GenerateVoiceOptions, config: Awaited<ReturnType<typeof loadStudioConfig>>) {
  const durationProbe = options.probeDuration ?? configuredProbeDuration(config.render.ffprobePath);
  if (options.provider === "piper") {
    return createPiperProvider({
      executable: piperExecutable(options, config.tts.piper.executablePath),
      prefixArgs: options.piperPrefixArgs,
      modelPath: piperModelPath(options, config.tts.piper.modelPath),
      probeDuration: durationProbe,
    });
  }
  if (options.provider === "vietnamese-local") {
    return createVietnameseLocalProvider({
      pythonPath: vietnamesePythonPath(options, config.tts.vietnameseLocal.pythonPath),
      appPath: vietnameseAppPath(options, config.tts.vietnameseLocal.appPath),
      prefixArgs: options.vietnamesePrefixArgs,
      probeDuration: durationProbe,
    });
  }
  return createOpenAiProvider({
    apiKey: options.openAiApiKey ?? process.env[config.tts.openai.apiKeyEnv] ?? "",
    model: options.openAiModel ?? config.tts.openai.model,
    probeDuration: durationProbe,
  });
}

function configuredProbeDuration(ffprobePath: string): (filePath: string) => Promise<number> {
  return (filePath) => probeDuration(filePath, ffprobePath || undefined);
}

function piperExecutable(options: GenerateVoiceOptions, configValue: string): string {
  const executable = options.piperExecutable ?? process.env.PIPER_PATH ?? configValue;
  if (!executable) {
    throw new Error("PIPER_PATH is required for local Piper voice generation.");
  }
  return executable;
}

function piperModelPath(options: GenerateVoiceOptions, configValue: string): string {
  const modelPath = options.piperModelPath ?? process.env.PIPER_MODEL_PATH ?? configValue;
  if (!modelPath) {
    throw new Error("PIPER_MODEL_PATH is required for local Piper voice generation.");
  }
  return modelPath;
}

function vietnamesePythonPath(options: GenerateVoiceOptions, configValue: string): string {
  const pythonPath = options.vietnamesePythonPath ?? process.env.VIETNAMESE_TTS_PYTHON_PATH ?? configValue;
  return pythonPath;
}

function vietnameseAppPath(options: GenerateVoiceOptions, configValue: string): string {
  const appPath = options.vietnameseAppPath ?? process.env.VIETNAMESE_TTS_APP_PATH ?? configValue;
  if (!appPath) {
    throw new Error("VIETNAMESE_TTS_APP_PATH is required for local Vietnamese voice generation.");
  }
  return appPath;
}

function defaultVoice(provider: GenerateVoiceOptions["provider"], config: Awaited<ReturnType<typeof loadStudioConfig>>): string {
  if (provider === "openai") return config.tts.openai.voice;
  if (provider === "vietnamese-local") return config.tts.vietnameseLocal.voice;
  return config.tts.piper.voice;
}

export async function prepareCaptions(projectId: string, durationSeconds?: number): Promise<CaptionArtifact> {
  const narration = await readProjectNarration(projectId);
  const state = await loadProjectState(projectId);
  const duration = durationSeconds ?? Number(state.artifacts.voice?.metadata.durationSeconds ?? 75);
  return saveCaptions(projectId, narration, duration);
}

export async function approveEmptyAssetManifest(projectId: string): Promise<void> {
  const manifest = await loadAssetManifest(projectId);
  const validation = validateAssetManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Asset manifest is not approvable: ${validation.errors.join("; ")}`);
  }
  await approveStage(projectId, "assets", sha256(JSON.stringify(manifest)), "Approved current asset manifest.");
}

export async function approveCurrentCopyrightCheck(projectId: string): Promise<void> {
  const raw = await readFile(resolveProjectPath(projectId, "copyright-check.json"), "utf8");
  const check = JSON.parse(raw) as Partial<CopyrightCheckResult>;
  if (check.blocked) {
    throw new Error("Copyright check is blocked and cannot be approved for render.");
  }
  await approveStage(projectId, "copyright", sha256(raw), "Approved current copyright check.");
}

export async function renderDraftProject(projectId: string, options: RenderDraftOptions = {}): Promise<RenderArtifact> {
  const brief = JSON.parse(await readFile(resolveProjectPath(projectId, "brief.json"), "utf8")) as VideoBrief;
  const config = await loadStudioConfig();
  const state = await loadProjectState(projectId);
  const voice = requireArtifact(state.artifacts.voice, "voice");
  const captions = requireArtifact(state.artifacts.captions, "captions");
  const outputPath = draftRenderOutputPath(projectId);
  const mapping = await loadVisualMapping(projectId);
  const manifest = await loadAssetManifest(projectId);
  const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const visualSegments: RenderVisualSegment[] | undefined = mapping?.segments.map((segment) => {
    const asset = segment.assetId ? assetsById.get(segment.assetId) : undefined;
    // A mapping saved before effects existed normalizes to neutral defaults at
    // the load boundary (visual-mapping.ts), so `segment.effects` is only ever
    // absent for a legacy in-memory shape; default here as the same safety net.
    const effects = segment.effects ?? DEFAULT_SEGMENT_EFFECTS;
    const effectsValidation = validateSegmentEffects(effects, manifest.assets);
    if (!effectsValidation.valid) {
      throw new Error(`Invalid effects for segment ${segment.id}: ${effectsValidation.errors.join(" ")}`);
    }
    const watermarkAsset = effects.watermark ? assetsById.get(effects.watermark.assetId) : undefined;
    return {
      sceneId: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      assetPath: asset ? resolveProjectPath(projectId, asset.relativePath) : undefined,
      mediaType: asset?.mediaType,
      fitMode: segment.fitMode,
      sourceStartSeconds: segment.sourceStartSeconds,
      sourceDurationSeconds: segment.sourceDurationSeconds,
      muteSourceAudio: segment.muteSourceAudio,
      effects,
      watermarkAsset,
    };
  });

  return renderDraft({
    projectId,
    title: brief.topic,
    durationSeconds: Number(voice.metadata.durationSeconds ?? 75),
    voicePath: resolveProjectPath(projectId, voice.relativePath),
    captionsPath: resolveProjectPath(projectId, captions.relativePath),
    outputPath,
    assetPaths: visualSegments?.flatMap((segment) => segment.assetPath ? [segment.assetPath] : []) ?? [],
    visualSegments,
    ffmpegPath: options.ffmpegPath ?? (config.render.ffmpegPath || undefined),
    ffmpegPrefixArgs: options.ffmpegPrefixArgs,
    ...renderDimensions(brief.format, config),
  });
}

function renderDimensions(
  format: VideoFormat,
  config: Awaited<ReturnType<typeof loadStudioConfig>>,
): { width: number; height: number } {
  return format === "longform"
    ? { width: config.render.longformWidth, height: config.render.longformHeight }
    : { width: config.render.shortsWidth, height: config.render.shortsHeight };
}

export function draftRenderOutputPath(projectId: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const version = `${timestamp.slice(0, 8)}-${timestamp.slice(8, 14)}-${timestamp.slice(14)}`;
  return resolveProjectPath(projectId, "workspace", "renders", `draft-${version}.mp4`);
}

async function readProjectNarration(projectId: string) {
  const script = await readFile(resolveProjectPath(projectId, "script.md"), "utf8");
  return extractNarration(script);
}

function requireArtifact(artifact: ArtifactRecord | undefined, name: string): ArtifactRecord {
  if (!artifact) {
    throw new Error(`Missing ${name} artifact.`);
  }
  return artifact;
}
