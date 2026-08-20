import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import { setArtifact } from "./project-state.ts";
import type { ArtifactRecord } from "./types.ts";
import type { NarrationDocument } from "./narration.ts";

export type CaptionCue = {
  index: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type CaptionArtifact = ArtifactRecord & {
  kind: "captions";
};

const MAX_WORDS_PER_CUE = 9;
const MIN_CUE_SECONDS = 0.8;

export function buildCaptions(text: string, durationSeconds: number): CaptionCue[] {
  if (durationSeconds <= 0) {
    throw new Error("Caption duration must be greater than zero.");
  }

  const phrases = splitIntoPhrases(text);
  if (phrases.length === 0) {
    return [];
  }

  const wordCounts = phrases.map((phrase) => countWords(phrase));
  const durations = allocateDurations(wordCounts, durationSeconds);
  let cursor = 0;

  return phrases.map((phrase, index) => {
    const startSeconds = roundMillis(cursor);
    cursor += durations[index];
    const endSeconds = index === phrases.length - 1 ? durationSeconds : roundMillis(cursor);

    return {
      index: index + 1,
      text: phrase,
      startSeconds,
      endSeconds,
    };
  });
}

export function toSrt(cues: CaptionCue[]): string {
  return `${cues
    .map((cue) => `${cue.index}\n${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}\n${cue.text}`)
    .join("\n\n")}\n`;
}

export async function saveCaptions(
  projectId: string,
  narration: NarrationDocument,
  durationSeconds: number,
): Promise<CaptionArtifact> {
  const cues = buildCaptions(narration.text, durationSeconds);
  const relativePath = `workspace/captions/${narration.hash.slice(0, 12)}.srt`;
  const path = resolveProjectPath(projectId, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, toSrt(cues), "utf8");

  const artifact: CaptionArtifact = {
    kind: "captions",
    sourceHash: narration.hash,
    relativePath,
    createdAt: new Date().toISOString(),
    metadata: {
      durationSeconds,
      cueCount: cues.length,
      wordCount: narration.wordCount,
    },
  };
  await setArtifact(projectId, artifact);
  return artifact;
}

function splitIntoPhrases(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .flatMap((sentence) => splitLongPhrase(sentence.trim()))
    .filter(Boolean);
}

function splitLongPhrase(phrase: string): string[] {
  const words = phrase.match(/\S+/g) ?? [];
  if (words.length <= MAX_WORDS_PER_CUE) {
    return phrase ? [phrase] : [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += MAX_WORDS_PER_CUE) {
    chunks.push(words.slice(index, index + MAX_WORDS_PER_CUE).join(" "));
  }
  return chunks;
}

function allocateDurations(wordCounts: number[], totalSeconds: number): number[] {
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  let durations = wordCounts.map((count) => (count / totalWords) * totalSeconds);

  if (durations.every((duration) => duration >= MIN_CUE_SECONDS)) {
    return durations;
  }

  durations = durations.map((duration) => Math.max(duration, MIN_CUE_SECONDS));
  const excess = durations.reduce((sum, duration) => sum + duration, 0) - totalSeconds;
  if (excess <= 0) {
    return durations;
  }

  const adjustable = durations
    .map((duration, index) => ({ duration, index, room: duration - MIN_CUE_SECONDS }))
    .filter((item) => item.room > 0);
  const totalRoom = adjustable.reduce((sum, item) => sum + item.room, 0);

  if (totalRoom <= 0) {
    return durations.map(() => totalSeconds / durations.length);
  }

  for (const item of adjustable) {
    durations[item.index] -= excess * (item.room / totalRoom);
  }

  return durations;
}

function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}'-]+/gu);
  return words?.length ?? 0;
}

function roundMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function formatSrtTime(seconds: number): string {
  const totalMillis = Math.round(seconds * 1000);
  const millis = totalMillis % 1000;
  const totalSeconds = Math.floor(totalMillis / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${pad(hours)}:${pad(mins)}:${pad(secs)},${String(millis).padStart(3, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
