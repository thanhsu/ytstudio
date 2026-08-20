import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAssetManifest, validateAssetManifest } from "./assets.ts";
import { saveCaptions, type CaptionArtifact } from "./captions.ts";
import { loadProjectState, approveStage, setArtifact, sha256 } from "./project-state.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { extractNarration } from "./narration.ts";
import { renderDraft, type RenderArtifact } from "./render.ts";
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
  const request: TtsRequest = {
    projectId: options.projectId,
    provider: options.provider,
    text: narration.text,
    voice: options.voice ?? "default",
    format: options.provider === "openai" ? "mp3" : "wav",
    speed: 1,
    instructions: "",
    confirmedPaidRequest: options.confirmedPaidRequest === true,
  };

  const provider = createVoiceProvider(options);

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

function createVoiceProvider(options: GenerateVoiceOptions) {
  if (options.provider === "piper") {
    return createPiperProvider({
      executable: piperExecutable(options),
      prefixArgs: options.piperPrefixArgs,
      modelPath: piperModelPath(options),
      probeDuration: options.probeDuration,
    });
  }
  if (options.provider === "vietnamese-local") {
    return createVietnameseLocalProvider({
      pythonPath: vietnamesePythonPath(options),
      appPath: vietnameseAppPath(options),
      prefixArgs: options.vietnamesePrefixArgs,
      probeDuration: options.probeDuration,
    });
  }
  return createOpenAiProvider({
    apiKey: options.openAiApiKey ?? process.env.OPENAI_API_KEY ?? "",
    probeDuration: options.probeDuration,
  });
}

function piperExecutable(options: GenerateVoiceOptions): string {
  const executable = options.piperExecutable ?? process.env.PIPER_PATH;
  if (!executable) {
    throw new Error("PIPER_PATH is required for local Piper voice generation.");
  }
  return executable;
}

function piperModelPath(options: GenerateVoiceOptions): string {
  const modelPath = options.piperModelPath ?? process.env.PIPER_MODEL_PATH;
  if (!modelPath) {
    throw new Error("PIPER_MODEL_PATH is required for local Piper voice generation.");
  }
  return modelPath;
}

function vietnamesePythonPath(options: GenerateVoiceOptions): string {
  const pythonPath = options.vietnamesePythonPath ?? process.env.VIETNAMESE_TTS_PYTHON_PATH ?? "python";
  return pythonPath;
}

function vietnameseAppPath(options: GenerateVoiceOptions): string {
  const appPath = options.vietnameseAppPath ?? process.env.VIETNAMESE_TTS_APP_PATH;
  if (!appPath) {
    throw new Error("VIETNAMESE_TTS_APP_PATH is required for local Vietnamese voice generation.");
  }
  return appPath;
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
  const state = await loadProjectState(projectId);
  const voice = requireArtifact(state.artifacts.voice, "voice");
  const captions = requireArtifact(state.artifacts.captions, "captions");
  const outputPath = join("projects", projectId, "workspace", "renders", "draft.mp4");

  return renderDraft({
    projectId,
    title: brief.topic,
    durationSeconds: Number(voice.metadata.durationSeconds ?? 75),
    voicePath: join("projects", projectId, voice.relativePath),
    captionsPath: join("projects", projectId, captions.relativePath),
    outputPath,
    assetPaths: [],
    ffmpegPath: options.ffmpegPath,
    ffmpegPrefixArgs: options.ffmpegPrefixArgs,
  });
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
