import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAssetManifest, validateAssetManifest } from "./assets.ts";
import { saveCaptions, type CaptionArtifact } from "./captions.ts";
import { loadStudioConfig } from "./config.ts";
import { loadProjectState, approveStage, setArtifact, sha256 } from "./project-state.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { extractNarration } from "./narration.ts";
import { probeDuration } from "./media.ts";
import { renderDraft, type RenderArtifact } from "./render.ts";
import { loadVisualMapping } from "./visual-mapping.ts";
import { createPiperProvider } from "./tts/piper.ts";
import { createOpenAiProvider } from "./tts/openai.ts";
import { createVietnameseLocalProvider } from "./tts/vietnamese-local.ts";
import type { ArtifactRecord, CopyrightCheckResult, VideoBrief } from "./types.ts";
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
  const visualSegments = mapping?.segments.map((segment) => {
    const asset = segment.assetId ? assetsById.get(segment.assetId) : undefined;
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
    width: config.render.shortsWidth,
    height: config.render.shortsHeight,
  });
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
