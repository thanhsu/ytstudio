import { readFile } from "node:fs/promises";
import { writeJson } from "../fs.ts";
import { ensureProjectDir } from "../fs.ts";
import { validateProjectId } from "../project-paths.ts";
import { resolveProjectPath } from "../project-paths.ts";
import type { StoryChannelConfig, StoryMode, StoryTtsProfile, TtsQualityTier, VisualStyleProfile } from "./types.ts";

/**
 * Channel-level story-factory settings, a sidecar beside series.json so the
 * series lifecycle stays untouched (the brand-kit pattern). Loading returns
 * normalized defaults when the file is missing; saving validates at the
 * boundary. The defaults describe the first planned channel — neutral Latin
 * American Spanish horror — and every field is operator-editable, so nothing
 * downstream may assume the language or the niche.
 */

const CHANNEL_FILE = "story-channel.json";

export type SaveStoryChannelInput = Partial<Omit<StoryChannelConfig, "version" | "channelId" | "updatedAt">>;

export async function loadStoryChannel(channelId: string): Promise<StoryChannelConfig> {
  const id = validateProjectId(channelId);
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(resolveProjectPath(id, CHANNEL_FILE), "utf8"));
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  return normalizeStoryChannel(id, value);
}

export async function saveStoryChannel(channelId: string, input: SaveStoryChannelInput): Promise<StoryChannelConfig> {
  const id = validateProjectId(channelId);
  const current = await loadStoryChannel(id);
  const next = normalizeStoryChannel(id, { ...current, ...input, updatedAt: new Date().toISOString() });
  validateStoryChannel(next);
  await ensureProjectDir(id);
  await writeJson(resolveProjectPath(id, CHANNEL_FILE), next);
  return next;
}

export function normalizeStoryChannel(channelId: string, value: unknown): StoryChannelConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<StoryChannelConfig>) : {};
  return {
    version: 1,
    channelId,
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : false,
    language: stringOr(candidate.language, "es"),
    locale: stringOr(candidate.locale, "es-MX"),
    niche: stringOr(candidate.niche, "horror"),
    subNiches: stringArray(candidate.subNiches, ["paranormal encounters", "night shift horror", "urban legends"]),
    promptStyle: stringOr(
      candidate.promptStyle,
      "Conversational cinematic storytelling for listening: suspenseful, natural, simple vocabulary, short and medium sentences.",
    ),
    defaultTargetDurationMinutes: boundedMinutes(candidate.defaultTargetDurationMinutes, 25),
    mode: normalizeMode(candidate.mode),
    ttsProfile: normalizeTtsProfile(candidate.ttsProfile),
    visualStyleProfile: normalizeVisualStyle(candidate.visualStyleProfile),
    bgm: {
      ambienceTrackPath: stringOr(candidate.bgm?.ambienceTrackPath, ""),
      volumeDb: rangeOr(candidate.bgm?.volumeDb, -22, -60, 0),
      sfx: normalizeBgmSfx(candidate.bgm?.sfx),
    },
    pronunciations: normalizePronunciations(candidate.pronunciations),
    budget: { maxCostPerStoryUsd: rangeOr(candidate.budget?.maxCostPerStoryUsd, 5, 0, 10000) },
    updatedAt: stringOr(candidate.updatedAt, new Date(0).toISOString()),
  };
}

export function normalizeMode(value: unknown): StoryMode {
  return value === "manual" ? "manual" : "assisted";
}

export function normalizeTtsProfile(value: unknown): StoryTtsProfile {
  const candidate = value && typeof value === "object" ? (value as Partial<StoryTtsProfile>) : {};
  return {
    provider: "google",
    tier: normalizeTier(candidate.tier),
    voiceName: stringOr(candidate.voiceName, ""),
    languageCode: stringOr(candidate.languageCode, "es-US"),
    speakingRate: rangeOr(candidate.speakingRate, 0.95, 0.25, 4),
    pitch: rangeOr(candidate.pitch, 0, -20, 20),
  };
}

export function normalizeTier(value: unknown): TtsQualityTier {
  return value === "standard" || value === "premium" ? value : "economy";
}

export function normalizeVisualStyle(value: unknown): VisualStyleProfile {
  const candidate = value && typeof value === "object" ? (value as Partial<VisualStyleProfile>) : {};
  return {
    stylePrompt: stringOr(
      candidate.stylePrompt,
      "cinematic horror, dark atmospheric lighting, realistic photography, subtle film grain, moody shadows",
    ),
    negativePrompt: stringOr(candidate.negativePrompt, "text, letters, captions, watermark, logo, cartoon"),
    imageIntervalSeconds: rangeOr(candidate.imageIntervalSeconds, 75, 45, 120),
    aspectRatio: "16:9",
  };
}

function normalizeBgmSfx(value: unknown): StoryChannelConfig["bgm"]["sfx"] {
  const candidate = value && typeof value === "object" ? (value as Partial<StoryChannelConfig["bgm"]["sfx"]>) : {};
  return {
    sceneChange: normalizeSfxCue(candidate.sceneChange),
    events: normalizeSfxEvents(candidate.events),
  };
}

function normalizeSfxCue(value: unknown): { path: string; volumeDb: number } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { path?: unknown; volumeDb?: unknown };
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) return null;
  return { path, volumeDb: rangeOr(candidate.volumeDb, -18, -60, 0) };
}

function normalizeSfxEvents(value: unknown): Array<{ path: string; atSeconds: number; volumeDb: number }> {
  if (!Array.isArray(value)) return [];
  const events: Array<{ path: string; atSeconds: number; volumeDb: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { path?: unknown; atSeconds?: unknown; volumeDb?: unknown };
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    const atSeconds = Number(candidate.atSeconds);
    if (!path || !Number.isFinite(atSeconds) || atSeconds < 0) continue;
    events.push({ path, atSeconds, volumeDb: rangeOr(candidate.volumeDb, -18, -60, 0) });
  }
  return events;
}

function validateStoryChannel(config: StoryChannelConfig): void {
  if (!config.language.trim()) throw new Error("language is required.");
  if (!config.locale.trim()) throw new Error("locale is required.");
  if (!config.niche.trim()) throw new Error("niche is required.");
}

function normalizePronunciations(value: unknown): Array<{ original: string; pronunciation: string }> {
  if (!Array.isArray(value)) return [];
  const rules: Array<{ original: string; pronunciation: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { original?: unknown; pronunciation?: unknown };
    const original = typeof candidate.original === "string" ? candidate.original.trim() : "";
    const pronunciation = typeof candidate.pronunciation === "string" ? candidate.pronunciation.trim() : "";
    if (original && pronunciation) {
      rules.push({ original, pronunciation });
    }
  }
  return rules;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length ? entries.map((entry) => entry.trim()) : [...fallback];
}

function boundedMinutes(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 5) return fallback;
  return Math.min(number, 60);
}

function rangeOr(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
