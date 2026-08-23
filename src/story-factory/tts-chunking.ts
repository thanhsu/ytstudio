import { access } from "node:fs/promises";
import { buildCaptions, toSrt, type CaptionCue } from "../captions.ts";
import { findCachedVoice, ttsCacheKey } from "../tts/cache.ts";
import type { TtsProvider, TtsRequest } from "../tts/types.ts";
import { resolveProjectPath } from "../project-paths.ts";
import type { StoryTtsProfile, TtsChunk, TtsChunkManifest } from "./types.ts";

/**
 * Long-form narration never travels to the TTS provider as one request. The
 * text is split at sentence boundaries into chunks under the provider limit,
 * each chunk is cached by its content hash, and a failed chunk retries alone —
 * chunks 1..16 are never regenerated because chunk 17 failed.
 */

export type ChunkLimits = { minChars: number; maxChars: number };

export function splitIntoChunks(text: string, limits: ChunkLimits): string[] {
  const maxChars = Math.max(200, limits.maxChars);
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const pieces = sentence.length > maxChars ? splitOversizeSentence(sentence, maxChars) : [sentence];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (current.length + 1 + piece.length <= maxChars) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

/** Sentences end at ./!/?/… (plus closing quotes); paragraph breaks always split. */
function splitSentences(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    const flat = paragraph.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const parts = flat.split(/(?<=[.!?…]["'”’»]?)\s+/u);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences;
}

/** A single sentence past the limit splits at commas, then spaces — never mid-word. */
function splitOversizeSentence(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const comma = window.lastIndexOf(", ");
    const space = window.lastIndexOf(" ");
    const cut = comma > maxChars / 2 ? comma + 1 : space > 0 ? space : maxChars;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    pieces.push(remaining);
  }
  return pieces;
}

/**
 * Build the chunk manifest for a narration text. Chunk audio lives in the
 * CHANNEL's workspace/voice cache (relativePath is channel-root relative), so
 * identical chunks are shared across stories and re-renders cost nothing.
 */
export function buildChunkManifest(
  text: string,
  profile: StoryTtsProfile,
  options: {
    limits: ChunkLimits;
    audioEncoding: "MP3" | "LINEAR16";
    mergedPath: string;
    captionsPath: string;
  },
): TtsChunkManifest {
  const format = options.audioEncoding === "LINEAR16" ? "wav" : "mp3";
  const chunks: TtsChunk[] = splitIntoChunks(text, options.limits).map((chunkText, index) => {
    const cacheKey = ttsCacheKey(chunkRequest("cache-key-only", chunkText, profile, format));
    return {
      index,
      text: chunkText,
      chars: chunkText.length,
      cacheKey,
      relativePath: `workspace/voice/${cacheKey}.${format}`,
      durationSeconds: 0,
      status: "pending",
      attemptCount: 0,
    };
  });
  return {
    version: 1,
    audioEncoding: options.audioEncoding,
    voiceName: profile.voiceName,
    languageCode: profile.languageCode,
    speakingRate: profile.speakingRate,
    pitch: profile.pitch,
    chunks,
    mergedPath: options.mergedPath,
    captionsPath: options.captionsPath,
    totalDurationSeconds: 0,
    loudnormApplied: false,
  };
}

/**
 * Synthesize every chunk that is not already done. Stops at the first failure
 * (after recording it) so the operator retries one chunk, not a shotgun of
 * them; completed chunks keep their status and are skipped on the next run.
 */
export async function synthesizeChunks(
  channelId: string,
  manifest: TtsChunkManifest,
  provider: TtsProvider,
  options: {
    persist: (manifest: TtsChunkManifest) => Promise<void>;
    signal?: AbortSignal;
    update?: (completed: number, total: number) => Promise<void>;
    onlyIndex?: number;
  },
): Promise<TtsChunkManifest> {
  const format = manifest.audioEncoding === "LINEAR16" ? "wav" : "mp3";
  const total = manifest.chunks.length;
  for (const chunk of manifest.chunks) {
    if (options.onlyIndex !== undefined && chunk.index !== options.onlyIndex) continue;
    if (chunk.status === "done" && (await chunkFileExists(channelId, chunk))) continue;

    // Reuse cached audio from earlier runs or sibling stories before paying.
    const cached = await findCachedVoice(channelId, chunk.cacheKey);
    if (cached) {
      chunk.status = "done";
      chunk.durationSeconds = cached.durationSeconds;
      chunk.relativePath = cached.relativePath;
      chunk.lastError = undefined;
      await options.persist(manifest);
      await options.update?.(doneCount(manifest), total);
      continue;
    }

    try {
      const artifact = await provider.generate(
        chunkRequest(channelId, chunk.text, manifestProfile(manifest), format),
        options.signal,
      );
      chunk.status = "done";
      chunk.durationSeconds = artifact.durationSeconds;
      chunk.relativePath = artifact.relativePath;
      chunk.lastError = undefined;
    } catch (error: unknown) {
      chunk.status = "failed";
      chunk.attemptCount += 1;
      chunk.lastError = error instanceof Error ? error.message : String(error);
      await options.persist(manifest);
      throw error;
    }
    await options.persist(manifest);
    await options.update?.(doneCount(manifest), total);
  }
  return manifest;
}

/** ffmpeg concat-demuxer + loudness normalization args; pure so tests read them directly. */
export function buildMergeArgs(concatListPath: string, outputPath: string): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath,
  ];
}

/** Concat-demuxer list body: absolute paths, forward slashes, quotes escaped. */
export function buildConcatList(absolutePaths: string[]): string {
  return `${absolutePaths.map((path) => `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n")}\n`;
}

/**
 * One SRT for the whole narration from per-chunk real durations: each chunk's
 * text is cue-split against its own measured duration, then offset into place.
 * Word-proportional timing inside a 30-second chunk drifts far less than
 * inside a 30-minute file.
 */
export function buildChunkCaptionsSrt(chunks: Array<{ text: string; durationSeconds: number }>): string {
  const cues: CaptionCue[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    for (const cue of buildCaptions(chunk.text, chunk.durationSeconds)) {
      cues.push({
        index: cues.length + 1,
        text: cue.text,
        startSeconds: cue.startSeconds + offset,
        endSeconds: cue.endSeconds + offset,
      });
    }
    offset += chunk.durationSeconds;
  }
  return toSrt(cues);
}

function chunkRequest(projectId: string, text: string, profile: StoryTtsProfile, format: "mp3" | "wav"): TtsRequest {
  return {
    projectId,
    provider: "google",
    text,
    voice: profile.voiceName,
    format,
    speed: profile.speakingRate,
    instructions: "",
    confirmedPaidRequest: true,
    languageCode: profile.languageCode,
    pitch: profile.pitch,
  };
}

function manifestProfile(manifest: TtsChunkManifest): StoryTtsProfile {
  return {
    provider: "google",
    tier: "economy",
    voiceName: manifest.voiceName,
    languageCode: manifest.languageCode,
    speakingRate: manifest.speakingRate,
    pitch: manifest.pitch,
  };
}

function doneCount(manifest: TtsChunkManifest): number {
  return manifest.chunks.filter((chunk) => chunk.status === "done").length;
}

async function chunkFileExists(channelId: string, chunk: TtsChunk): Promise<boolean> {
  try {
    await access(resolveProjectPath(channelId, chunk.relativePath));
    return true;
  } catch {
    return false;
  }
}
