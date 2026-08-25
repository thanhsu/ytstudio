import { createHash } from "node:crypto";
import type {
  StoryScene,
  VisualPromptArtifact,
  VisualPromptMood,
  VisualPromptMotion,
} from "./types.ts";

export type VisualPromptSource = {
  naturalizedText: string;
  scenes: Array<Pick<StoryScene, "sceneId" | "startSeconds" | "endSeconds">>;
  ttsChunks: Array<{ index: number; startSeconds?: number; endSeconds?: number; durationSeconds?: number }>;
  captions: Array<{ startSeconds: number; endSeconds: number; text: string }>;
};

export type BuildVisualPromptInput = {
  sourceHash: string;
  durationSeconds: number;
  text: string;
  scenes: Array<Pick<StoryScene, "sceneId" | "startSeconds" | "endSeconds">>;
};

const MOOD_KEYWORDS: Array<[VisualPromptMood, RegExp]> = [
  ["action", /\b(run|fight|escape|chase|attack|scream|running|fighting|escaped|chased|attacked|screamed)\b/i],
  ["tense", /\b(afraid|fear|danger|blood|shadow|locked|cold|threat|terrified|panic)\b/i],
  ["mysterious", /\b(whisper|door|hallway|unknown|secret|vanished|strange|mystery|hidden)\b/i],
  ["reveal", /\b(realized|revealed|truth|saw|found|discovered|opened|appeared)\b/i],
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "but",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "slowly",
  "the",
  "to",
  "was",
  "were",
  "with",
]);

export function buildVisualPromptSourceHash(input: VisualPromptSource): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeVisualPromptSource(input)))
    .digest("hex");
}

export function buildVisualPromptArtifact(input: BuildVisualPromptInput): VisualPromptArtifact {
  const chunks = splitTextForScenes(input.text, input.scenes.length);
  return {
    version: 1,
    sourceHash: input.sourceHash,
    cues: input.scenes.map((scene, index) => {
      const excerpt = clampWords(chunks[index] ?? input.text, 32);
      const mood = pickMood(excerpt);
      return {
        sceneId: scene.sceneId,
        startSeconds: clampSeconds(scene.startSeconds, input.durationSeconds),
        endSeconds: Math.max(clampSeconds(scene.startSeconds, input.durationSeconds), clampSeconds(scene.endSeconds, input.durationSeconds)),
        narrationExcerpt: excerpt,
        visualPrompt: `${mood} cinematic frame based on: ${excerpt}`,
        mood,
        captionEmphasis: pickEmphasisWords(excerpt),
        motion: pickMotion(index, mood),
        overlayText: pickOverlayText(excerpt),
      };
    }),
  };
}

function canonicalizeVisualPromptSource(input: VisualPromptSource): VisualPromptSource {
  return {
    naturalizedText: input.naturalizedText,
    scenes: input.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startSeconds: roundSeconds(scene.startSeconds),
      endSeconds: roundSeconds(scene.endSeconds),
    })),
    ttsChunks: input.ttsChunks.map((chunk) => ({
      index: chunk.index,
      startSeconds: chunk.startSeconds === undefined ? undefined : roundSeconds(chunk.startSeconds),
      endSeconds: chunk.endSeconds === undefined ? undefined : roundSeconds(chunk.endSeconds),
      durationSeconds: chunk.durationSeconds === undefined ? undefined : roundSeconds(chunk.durationSeconds),
    })),
    captions: input.captions.map((caption) => ({
      startSeconds: roundSeconds(caption.startSeconds),
      endSeconds: roundSeconds(caption.endSeconds),
      text: caption.text,
    })),
  };
}

function splitTextForScenes(text: string, count: number): string[] {
  if (count <= 0) return [];
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const source = sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
  const buckets = Array.from({ length: count }, () => [] as string[]);
  source.forEach((sentence, index) => buckets[Math.min(count - 1, Math.floor((index * count) / source.length))].push(sentence));
  return buckets.map((bucket) => bucket.join(" ").trim());
}

function clampWords(text: string, maxWords: number): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}

function pickMood(text: string): VisualPromptMood {
  return MOOD_KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "calm";
}

function pickMotion(index: number, mood: VisualPromptMood): VisualPromptMotion {
  if (mood === "action") return "drift-right";
  if (mood === "reveal") return "slow-push";
  const cycle: VisualPromptMotion[] = ["slow-push", "slow-pull", "drift-left", "drift-right", "hold"];
  return cycle[index % cycle.length];
}

function pickEmphasisWords(text: string): string[] {
  return uniqueWords(text).slice(0, 5);
}

function pickOverlayText(text: string): string {
  const words = uniqueWords(text).slice(0, 4);
  return words.length > 0 ? words.join(" ") : clampWords(text, 4);
}

function uniqueWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
  return [...new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

function clampSeconds(value: number, max: number): number {
  return roundSeconds(Math.max(0, Math.min(Number.isFinite(value) ? value : 0, max)));
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
