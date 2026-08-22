import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadStudioConfig } from "./config.ts";
import { loadAssetManifest, saveAssetManifest, type AssetManifest, type AssetRecord } from "./assets.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { runProcess } from "./process.ts";

export type SubtitleStream = { index: number; codecName: string; language?: string };
export type ProbeMetadata = {
  durationSeconds?: number; width?: number; height?: number; hasAudio: boolean; subtitleStreams: SubtitleStream[];
};
type AsrConfig = Awaited<ReturnType<typeof loadStudioConfig>>["asr"];

type ProbeJson = {
  format?: { duration?: string };
  streams?: Array<{ index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; tags?: { language?: string } }>;
};

const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text"]);
const STOP_WORDS = new Set(["the", "and", "that", "this", "with", "from", "into", "every", "his", "her", "their", "for", "are", "was", "were", "in", "of", "to", "a", "an"]);

export function normalizeProbeResult(probe: ProbeJson): ProbeMetadata {
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const duration = Number(probe.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : undefined,
    width: video?.width,
    height: video?.height,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    subtitleStreams: streams
      .filter((stream) => stream.codec_type === "subtitle" && TEXT_SUBTITLE_CODECS.has(stream.codec_name ?? ""))
      .map((stream) => ({ index: stream.index ?? 0, codecName: stream.codec_name ?? "", language: stream.tags?.language?.toLowerCase() })),
  };
}

export function selectSubtitleStream(streams: SubtitleStream[], projectLanguage?: string): SubtitleStream | undefined {
  const language = normalizeLanguage(projectLanguage);
  return streams.find((stream) => normalizeLanguage(stream.language) === language)
    ?? streams.find((stream) => normalizeLanguage(stream.language) === "en")
    ?? streams[0];
}

export function extractAssetKeywords(text: string, limit = 12): string[] {
  const counts = new Map<string, { count: number; order: number }>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  words.forEach((word, order) => {
    if (word.length < 2 || STOP_WORDS.has(word)) return;
    const current = counts.get(word);
    counts.set(word, { count: (current?.count ?? 0) + 1, order: current?.order ?? order });
  });
  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].order - right[1].order)
    .slice(0, limit)
    .map(([word]) => word);
}

export function buildAssetAsrCommand(config: AsrConfig, audioPath: string, outputBase: string): { executable: string; args: string[] } {
  if (config.provider === "whisper-cpp") {
    if (!config.modelPath) throw new Error("asr.modelPath is required for whisper.cpp.");
    return {
      executable: config.executablePath || process.env.WHISPER_CPP_PATH || "whisper-cli",
      args: ["-m", config.modelPath, "-f", audioPath, "-l", config.language, "-osrt", "-of", outputBase],
    };
  }
  if (config.provider === "faster-whisper") {
    return {
      executable: config.executablePath || process.env.FASTER_WHISPER_PATH || "faster-whisper",
      args: [audioPath, "--model", config.model, "--language", config.language, "--output_format", "srt", "--output_dir", dirname(outputBase)],
    };
  }
  throw new Error("ASR provider is disabled.");
}

/**
 * Analysis writes "running" to the manifest before spawning FFmpeg, so a crash or
 * restart leaves assets permanently excluded from visual mapping. Any asset still
 * marked running without a live job owning it is reported as failed and retryable.
 */
export async function recoverInterruptedAnalysis(
  projectId: string,
  activeAssetIds: Iterable<string> = [],
): Promise<AssetManifest> {
  const manifest = await loadAssetManifest(projectId);
  const active = new Set(activeAssetIds);
  let recovered = false;

  for (const asset of manifest.assets) {
    if (asset.analysisStatus === "running" && !active.has(asset.id)) {
      asset.analysisStatus = "failed";
      asset.analysisError = "Analysis was interrupted before it finished. Run it again.";
      asset.analysisUpdatedAt = new Date().toISOString();
      recovered = true;
    }
  }

  if (recovered) {
    await saveAssetManifest(projectId, manifest);
  }
  return manifest;
}

export async function analyzeAsset(projectId: string, assetId: string, projectLanguage?: string): Promise<AssetRecord> {
  const manifest = await loadAssetManifest(projectId);
  const asset = manifest.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  asset.analysisStatus = "running";
  delete asset.analysisError;
  await saveAssetManifest(projectId, manifest);

  try {
    if (asset.mediaType === "image") {
      asset.analysisStatus = "limited";
      asset.subtitleSource = "none";
    } else {
      const config = await loadStudioConfig();
      const inputPath = resolveProjectPath(projectId, asset.relativePath);
      const probe = await runProcess(config.render.ffprobePath || process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath,
      ]);
      const metadata = normalizeProbeResult(JSON.parse(probe.stdout) as ProbeJson);
      Object.assign(asset, metadata);
      const subtitle = selectSubtitleStream(metadata.subtitleStreams, projectLanguage);
      if (subtitle) {
        const relativePath = `workspace/asset-context/${asset.id}.srt`;
        const outputPath = resolveProjectPath(projectId, relativePath);
        await mkdir(dirname(outputPath), { recursive: true });
        await runProcess(config.render.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg", [
          "-y", "-i", inputPath, "-map", `0:${subtitle.index}`, outputPath,
        ]);
        const transcript = await readFile(outputPath, "utf8");
        asset.transcriptPath = relativePath;
        asset.subtitleSource = "embedded";
        asset.keywords = extractAssetKeywords(transcript.replace(/\d+|-->|\d{2}:\d{2}:\d{2},\d{3}/g, " "));
        asset.contextSummary = asset.keywords.slice(0, 8).join(", ");
        asset.analysisStatus = "ready";
      } else if (metadata.hasAudio && config.asr.provider !== "disabled") {
        const contextBase = resolveProjectPath(projectId, `workspace/asset-context/${asset.id}`);
        const audioPath = `${contextBase}.wav`;
        await mkdir(dirname(audioPath), { recursive: true });
        await runProcess(config.render.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg", [
          "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath,
        ]);
        try {
          const command = buildAssetAsrCommand(config.asr, audioPath, contextBase);
          await runProcess(command.executable, command.args);
          const relativePath = `workspace/asset-context/${asset.id}.srt`;
          const transcript = await readFile(resolveProjectPath(projectId, relativePath), "utf8");
          asset.transcriptPath = relativePath;
          asset.subtitleSource = "asr";
          asset.keywords = extractAssetKeywords(transcript.replace(/\d+|-->|\d{2}:\d{2}:\d{2},\d{3}/g, " "));
          asset.contextSummary = asset.keywords.slice(0, 8).join(", ");
          asset.analysisStatus = "ready";
        } finally {
          await rm(audioPath, { force: true });
        }
      } else {
        asset.subtitleSource = "none";
        asset.keywords = extractAssetKeywords(`${asset.filename} ${asset.usagePurpose}`);
        asset.contextSummary = asset.usagePurpose || asset.filename;
        asset.analysisStatus = "limited";
      }
    }
    asset.analysisUpdatedAt = new Date().toISOString();
    const contextPath = `workspace/asset-context/${asset.id}.json`;
    asset.contextPath = contextPath;
    const absoluteContextPath = resolveProjectPath(projectId, contextPath);
    await mkdir(dirname(absoluteContextPath), { recursive: true });
    await writeFile(absoluteContextPath, `${JSON.stringify({ assetId: asset.id, keywords: asset.keywords ?? [], summary: asset.contextSummary ?? "", transcriptPath: asset.transcriptPath }, null, 2)}\n`, "utf8");
  } catch (error) {
    asset.analysisStatus = "failed";
    asset.analysisError = error instanceof Error ? error.message : String(error);
    asset.analysisUpdatedAt = new Date().toISOString();
  }
  await saveAssetManifest(projectId, manifest);
  return asset;
}

function normalizeLanguage(language?: string): string {
  const value = language?.toLowerCase() ?? "";
  if (value.startsWith("vi") || value === "vie") return "vi";
  if (value.startsWith("en") || value === "eng") return "en";
  return value;
}
