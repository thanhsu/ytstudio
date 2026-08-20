import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { loadStudioConfig, type StudioConfig } from "./config.ts";
import { runProcess } from "./process.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { parseSrt, stringifySrt, validateSrt } from "./srt.ts";

export type AsrProvider = StudioConfig["asr"]["provider"];

export type GenerateAsrOptions = {
  projectId: string;
  audioRelativePath?: string;
  provider?: AsrProvider;
  executablePath?: string;
  model?: string;
  modelPath?: string;
  language?: string;
  prefixArgs?: string[];
};

export type AsrArtifact = {
  projectId: string;
  provider: Exclude<AsrProvider, "disabled">;
  relativePath: string;
  cueCount: number;
  createdAt: string;
};

export async function generateSourceSrtFromAsr(options: GenerateAsrOptions): Promise<AsrArtifact> {
  const config = await loadStudioConfig();
  const provider = options.provider ?? config.asr.provider;
  if (provider === "disabled") {
    throw new Error("ASR provider is disabled. Set asr.provider in Studio Config first.");
  }

  const audioRelativePath = options.audioRelativePath ?? join("workspace", "media", "asr-audio.wav");
  const audioPath = resolveProjectPath(options.projectId, audioRelativePath);
  const workspaceRelativeDir = join("workspace", "subtitles");
  const workspaceDir = resolveProjectPath(options.projectId, workspaceRelativeDir);
  await mkdir(workspaceDir, { recursive: true });

  const rawSrt =
    provider === "faster-whisper"
      ? await runFasterWhisper(options, config, audioPath, workspaceDir)
      : await runWhisperCpp(options, config, audioPath, workspaceDir);

  const cues = parseSrt(rawSrt);
  const normalized = stringifySrt(cues);
  const validation = validateSrt(cues);
  if (!validation.valid) {
    throw new Error(`ASR produced invalid SRT: ${validation.errors.join("; ")}`);
  }

  const outputRelativePath = join(workspaceRelativeDir, "source.asr.srt");
  const outputPath = resolveProjectPath(options.projectId, outputRelativePath);
  await writeFile(outputPath, normalized, "utf8");

  const createdAt = new Date().toISOString();
  await setArtifact(options.projectId, {
    kind: "source-subtitles",
    sourceHash: sha256(normalized),
    relativePath: outputRelativePath,
    createdAt,
    metadata: {
      provider,
      cueCount: cues.length,
      language: options.language ?? config.asr.language,
    },
  });

  return {
    projectId: options.projectId,
    provider,
    relativePath: outputRelativePath,
    cueCount: cues.length,
    createdAt,
  };
}

async function runFasterWhisper(
  options: GenerateAsrOptions,
  config: StudioConfig,
  audioPath: string,
  outputDir: string,
): Promise<string> {
  const executable = configuredExecutable(
    options.executablePath,
    config.asr.executablePath,
    process.env.FASTER_WHISPER_PATH,
    "faster-whisper",
  );
  const language = options.language ?? config.asr.language;
  const model = options.model ?? config.asr.model;
  await runProcess(executable, [
    ...(options.prefixArgs ?? []),
    audioPath,
    "--model",
    model,
    "--language",
    language,
    "--output_format",
    "srt",
    "--output_dir",
    outputDir,
  ]);
  return readNewestSrt(outputDir);
}

async function runWhisperCpp(
  options: GenerateAsrOptions,
  config: StudioConfig,
  audioPath: string,
  outputDir: string,
): Promise<string> {
  const executable = configuredExecutable(
    options.executablePath,
    config.asr.executablePath,
    process.env.WHISPER_CPP_PATH,
    "whisper-cli",
  );
  const language = options.language ?? config.asr.language;
  const modelPath = options.modelPath ?? config.asr.modelPath;
  if (!modelPath) {
    throw new Error("asr.modelPath is required for whisper.cpp.");
  }

  const outputBase = join(outputDir, basename(audioPath, extname(audioPath)));
  await runProcess(executable, [
    ...(options.prefixArgs ?? []),
    "-m",
    modelPath,
    "-f",
    audioPath,
    "-l",
    language,
    "-osrt",
    "-of",
    outputBase,
  ]);
  return readFile(`${outputBase}.srt`, "utf8");
}

async function readNewestSrt(outputDir: string): Promise<string> {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const srtEntries = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".srt"))
    .sort((left, right) => right.name.localeCompare(left.name));
  if (srtEntries.length === 0) {
    throw new Error("ASR completed but no SRT file was produced.");
  }
  return readFile(join(outputDir, srtEntries[0].name), "utf8");
}

function configuredExecutable(
  optionValue: string | undefined,
  configValue: string,
  envValue: string | undefined,
  fallback: string,
): string {
  return optionValue || configValue || envValue || fallback;
}
