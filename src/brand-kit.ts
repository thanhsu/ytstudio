import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { ensureProjectDir, writeJson } from "./fs.ts";
import { validateProjectId } from "./project-paths.ts";
import type { WorkflowType } from "./types.ts";
import { normalizeWorkflowType } from "./workflow-templates.ts";

export type BrandAssetType = "logo-round" | "logo-text" | "watermark" | "reference" | "background";

export type ThumbnailPreset = "character-focus" | "story-arc" | "audio-cover" | "clean-news";

export type BrandKit = {
  version: 1;
  seriesId: string;
  channelName: string;
  handle: string;
  logoRoundPath: string;
  logoTextPath: string;
  watermarkPath: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontStyle: string;
  thumbnailPreset: ThumbnailPreset;
  titleStyle: string;
  thumbnailStyle: string;
  watermarkOpacity: number;
  safeTextRules: string[];
  cta: string;
  updatedAt: string;
};

export type SaveBrandKitInput = Partial<
  Omit<BrandKit, "version" | "seriesId" | "updatedAt" | "thumbnailPreset" | "watermarkOpacity" | "safeTextRules">
> & {
  thumbnailPreset?: unknown;
  watermarkOpacity?: unknown;
  safeTextRules?: unknown;
};

export type BrandAsset = {
  assetType: BrandAssetType;
  filename: string;
  mimeType: string;
  relativePath: string;
  createdAt: string;
};

export type SaveBrandAssetInput = {
  filename: string;
  bytes: Buffer;
  mimeType: string;
  assetType: BrandAssetType;
};

export type ThumbnailBrief = {
  version: 1;
  seriesId: string;
  channelName: string;
  workflowType: WorkflowType;
  videoTitle: string;
  episodeLabel: string;
  hook: string;
  preset: ThumbnailPreset;
  textLines: string[];
  layout: string;
  prompt: string;
  negativePrompt: string;
  brand: Pick<BrandKit, "primaryColor" | "secondaryColor" | "accentColor" | "fontStyle" | "watermarkPath" | "watermarkOpacity">;
  createdAt: string;
};

export type GenerateThumbnailBriefInput = {
  workflowType?: unknown;
  videoTitle: string;
  episodeLabel: string;
  hook: string;
};

export async function loadBrandKit(seriesIdValue: string): Promise<BrandKit> {
  const seriesId = validateProjectId(seriesIdValue);
  const existing = await readOptionalBrandKit(seriesId);
  return existing ?? defaultBrandKit(seriesId);
}

export async function saveBrandKit(seriesIdValue: string, input: SaveBrandKitInput): Promise<BrandKit> {
  const seriesId = validateProjectId(seriesIdValue);
  const current = await loadBrandKit(seriesId);
  const kit: BrandKit = {
    ...current,
    channelName: text(input.channelName, current.channelName),
    handle: text(input.handle, current.handle),
    logoRoundPath: text(input.logoRoundPath, current.logoRoundPath),
    logoTextPath: text(input.logoTextPath, current.logoTextPath),
    watermarkPath: text(input.watermarkPath, current.watermarkPath),
    primaryColor: color(input.primaryColor, current.primaryColor),
    secondaryColor: color(input.secondaryColor, current.secondaryColor),
    accentColor: color(input.accentColor, current.accentColor),
    fontStyle: text(input.fontStyle, current.fontStyle),
    thumbnailPreset: thumbnailPreset(input.thumbnailPreset, current.thumbnailPreset),
    titleStyle: text(input.titleStyle, current.titleStyle),
    thumbnailStyle: text(input.thumbnailStyle, current.thumbnailStyle),
    watermarkOpacity: opacity(input.watermarkOpacity, current.watermarkOpacity),
    safeTextRules: stringArray(input.safeTextRules, current.safeTextRules),
    cta: text(input.cta, current.cta),
    updatedAt: new Date().toISOString(),
  };
  await ensureBrandDir(seriesId);
  await writeJson(brandKitPath(seriesId), kit);
  return kit;
}

export async function saveBrandAsset(seriesIdValue: string, input: SaveBrandAssetInput): Promise<BrandAsset> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureBrandDir(seriesId);
  const filename = safeFileName(input.filename, input.assetType);
  const relativePath = ["brand", "assets", `${Date.now()}-${input.assetType}-${filename}`].join("/");
  await writeFile(join("projects", seriesId, relativePath), input.bytes);
  const asset: BrandAsset = {
    assetType: input.assetType,
    filename,
    mimeType: input.mimeType,
    relativePath,
    createdAt: new Date().toISOString(),
  };

  const pathUpdate =
    input.assetType === "logo-round"
      ? { logoRoundPath: relativePath }
      : input.assetType === "logo-text"
        ? { logoTextPath: relativePath }
        : input.assetType === "watermark"
          ? { watermarkPath: relativePath }
          : {};
  if (Object.keys(pathUpdate).length > 0) {
    await saveBrandKit(seriesId, pathUpdate);
  }
  return asset;
}

export async function generateThumbnailBrief(
  seriesIdValue: string,
  input: GenerateThumbnailBriefInput,
): Promise<ThumbnailBrief> {
  const seriesId = validateProjectId(seriesIdValue);
  const kit = await loadBrandKit(seriesId);
  const workflowType = normalizeWorkflowType(input.workflowType);
  const videoTitle = required(input.videoTitle, "videoTitle");
  const episodeLabel = text(input.episodeLabel, "");
  const hook = required(input.hook, "hook");
  const textLines = buildTextLines(videoTitle, episodeLabel, hook);
  const brief: ThumbnailBrief = {
    version: 1,
    seriesId,
    channelName: kit.channelName,
    workflowType,
    videoTitle,
    episodeLabel,
    hook,
    preset: kit.thumbnailPreset,
    textLines,
    layout: layoutFor(kit.thumbnailPreset),
    prompt: [
      `Create a YouTube thumbnail for ${kit.channelName}.`,
      `Video: ${videoTitle}.`,
      `Hook: ${hook}.`,
      `Layout: ${layoutFor(kit.thumbnailPreset)}.`,
      `Use brand colors ${kit.primaryColor}, ${kit.secondaryColor}, and accent ${kit.accentColor}.`,
      `Typography: ${kit.fontStyle}.`,
      kit.watermarkPath ? `Add watermark from ${kit.watermarkPath} at opacity ${kit.watermarkOpacity}.` : "Reserve a small watermark area.",
      `Text lines: ${textLines.join(" / ")}.`,
      `Rules: ${kit.safeTextRules.join("; ")}.`,
    ].join(" "),
    negativePrompt: "No misleading copyrighted frames, no tiny unreadable text, no copied character likeness, no clutter.",
    brand: {
      primaryColor: kit.primaryColor,
      secondaryColor: kit.secondaryColor,
      accentColor: kit.accentColor,
      fontStyle: kit.fontStyle,
      watermarkPath: kit.watermarkPath,
      watermarkOpacity: kit.watermarkOpacity,
    },
    createdAt: new Date().toISOString(),
  };
  await ensureBrandDir(seriesId);
  const outputPath = ["brand", "thumbnail-briefs", `${safeSlug(videoTitle)}.json`].join("/");
  await mkdir(join("projects", seriesId, "brand", "thumbnail-briefs"), { recursive: true });
  await writeJson(join("projects", seriesId, outputPath), brief);
  return brief;
}

function defaultBrandKit(seriesId: string): BrandKit {
  const now = new Date().toISOString();
  return {
    version: 1,
    seriesId,
    channelName: seriesId,
    handle: "",
    logoRoundPath: "",
    logoTextPath: "",
    watermarkPath: "",
    primaryColor: "#f4c430",
    secondaryColor: "#1b1f2a",
    accentColor: "#e5484d",
    fontStyle: "bold condensed sans",
    thumbnailPreset: "story-arc",
    titleStyle: "Clear curiosity title with consistent channel language.",
    thumbnailStyle: "Large readable text, high contrast, no misleading copyrighted frames.",
    watermarkOpacity: 0.2,
    safeTextRules: ["Use three to five words max", "Keep faces and key objects unobstructed"],
    cta: "Subscribe for the next story",
    updatedAt: now,
  };
}

async function readOptionalBrandKit(seriesId: string): Promise<BrandKit | undefined> {
  try {
    return normalizeBrandKit(JSON.parse(await readFile(brandKitPath(seriesId), "utf8")), seriesId);
  } catch {
    return undefined;
  }
}

function normalizeBrandKit(value: unknown, seriesId: string): BrandKit {
  const candidate = value as Partial<BrandKit>;
  const defaults = defaultBrandKit(seriesId);
  return {
    ...defaults,
    channelName: text(candidate.channelName, defaults.channelName),
    handle: text(candidate.handle, defaults.handle),
    logoRoundPath: text(candidate.logoRoundPath, defaults.logoRoundPath),
    logoTextPath: text(candidate.logoTextPath, defaults.logoTextPath),
    watermarkPath: text(candidate.watermarkPath, defaults.watermarkPath),
    primaryColor: color(candidate.primaryColor, defaults.primaryColor),
    secondaryColor: color(candidate.secondaryColor, defaults.secondaryColor),
    accentColor: color(candidate.accentColor, defaults.accentColor),
    fontStyle: text(candidate.fontStyle, defaults.fontStyle),
    thumbnailPreset: thumbnailPreset(candidate.thumbnailPreset, defaults.thumbnailPreset),
    titleStyle: text(candidate.titleStyle, defaults.titleStyle),
    thumbnailStyle: text(candidate.thumbnailStyle, defaults.thumbnailStyle),
    watermarkOpacity: opacity(candidate.watermarkOpacity, defaults.watermarkOpacity),
    safeTextRules: stringArray(candidate.safeTextRules, defaults.safeTextRules),
    cta: text(candidate.cta, defaults.cta),
    updatedAt: text(candidate.updatedAt, defaults.updatedAt),
  };
}

async function ensureBrandDir(seriesId: string): Promise<void> {
  await ensureProjectDir(seriesId);
  await mkdir(join("projects", seriesId, "brand", "assets"), { recursive: true });
}

function brandKitPath(seriesId: string): string {
  return join("projects", validateProjectId(seriesId), "brand-kit.json");
}

function buildTextLines(videoTitle: string, episodeLabel: string, hook: string): string[] {
  const main = titleWords(videoTitle).slice(0, 3).join(" ");
  const hookWords = titleWords(hook).slice(0, 3).join(" ");
  return [main, episodeLabel || "NEW ARC", hookWords].filter(Boolean);
}

function titleWords(value: string): string[] {
  return value.replace(/[^\w\s-]+/g, "").split(/\s+/).map((word) => word.trim()).filter(Boolean);
}

function layoutFor(preset: ThumbnailPreset): string {
  return {
    "character-focus": "large subject on one side, title block opposite, small watermark in lower corner",
    "story-arc": "dramatic background, bold center-left title, episode badge, channel watermark",
    "audio-cover": "cover-art composition, title at top, chapter badge, clean space for channel mark",
    "clean-news": "plain high-contrast layout, title first, small source/episode label",
  }[preset];
}

function required(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function color(value: unknown, fallback: string): string {
  const textValue = text(value, fallback);
  return /^#[0-9a-fA-F]{6}$/.test(textValue) ? textValue : fallback;
}

function opacity(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map(String).map((item) => item.trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function thumbnailPreset(value: unknown, fallback: ThumbnailPreset): ThumbnailPreset {
  if (value === "character-focus" || value === "story-arc" || value === "audio-cover" || value === "clean-news") {
    return value;
  }
  return fallback;
}

function safeFileName(value: string, fallback: string): string {
  const extension = extname(value);
  const base = value.replace(extension, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || fallback}${extension || ".bin"}`;
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "thumbnail";
}
