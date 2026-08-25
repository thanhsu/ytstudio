import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import { loadProjectState, setArtifact, sha256 } from "./project-state.ts";
import { runProcess } from "./process.ts";

export type BrandingPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type BrandingConfig = {
  version: 1;
  position: BrandingPosition;
  logoHeight: number;
  margin: number;
  logoFile?: string;
  coverFile?: string;
  watermarkText: string;
  watermarkOpacity: number;
  watermarkSize: number;
  burnSubtitles: boolean;
  subtitleSize: number;
  /** Painted behind the new subtitles to hide hardsubs burned into the source. */
  subtitleBackdrop: "none" | "box" | "bar";
  /** Bar height as percent of the video height (bar backdrop only). */
  backdropHeight: number;
  /** Keep the video's own audio (music/effects bed) mixed under the voiceover. */
  keepOriginalAudio: boolean;
  originalAudioVolume: number;
  updatedAt: string;
};

export type BrandingImageKind = "logo" | "cover";

const BRANDING_DIR = join("workspace", "branding");
const BRANDING_CONFIG = join(BRANDING_DIR, "branding.json");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const POSITIONS = new Set<BrandingPosition>(["top-left", "top-right", "bottom-left", "bottom-right"]);

function defaultBranding(): BrandingConfig {
  return {
    version: 1,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    watermarkText: "",
    watermarkOpacity: 0.25,
    watermarkSize: 36,
    burnSubtitles: false,
    subtitleSize: 18,
    subtitleBackdrop: "none",
    backdropHeight: 14,
    keepOriginalAudio: true,
    originalAudioVolume: 1,
    updatedAt: "",
  };
}

export async function loadBranding(projectId: string): Promise<BrandingConfig> {
  try {
    return { ...defaultBranding(), ...JSON.parse(await readFile(resolveProjectPath(projectId, BRANDING_CONFIG), "utf8")) as BrandingConfig };
  } catch {
    return defaultBranding();
  }
}

async function saveBranding(projectId: string, branding: BrandingConfig): Promise<void> {
  await mkdir(resolveProjectPath(projectId, BRANDING_DIR), { recursive: true });
  await writeFile(resolveProjectPath(projectId, BRANDING_CONFIG), `${JSON.stringify(branding, null, 2)}\n`, "utf8");
}

export async function saveBrandingImage(
  projectId: string,
  kind: BrandingImageKind,
  sourcePath: string,
  originalName: string,
): Promise<{ branding: BrandingConfig; relativePath: string }> {
  const extension = extname(originalName).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported ${kind} image extension: ${extension || "(none)"}. Use png, jpg, or webp.`);
  }
  const filename = `${kind}${extension}`;
  const branding = await loadBranding(projectId);
  const previous = kind === "logo" ? branding.logoFile : branding.coverFile;
  await mkdir(resolveProjectPath(projectId, BRANDING_DIR), { recursive: true });
  if (previous && previous !== filename) {
    await rm(resolveProjectPath(projectId, join(BRANDING_DIR, previous)), { force: true });
  }
  await copyFile(sourcePath, resolveProjectPath(projectId, join(BRANDING_DIR, filename)));
  if (kind === "logo") branding.logoFile = filename;
  else branding.coverFile = filename;
  branding.updatedAt = new Date().toISOString();
  await saveBranding(projectId, branding);
  return { branding, relativePath: `workspace/branding/${filename}` };
}

export async function updateBrandingSettings(
  projectId: string,
  update: {
    position?: string;
    logoHeight?: number;
    margin?: number;
    watermarkText?: string;
    watermarkOpacity?: number;
    watermarkSize?: number;
    burnSubtitles?: boolean;
    subtitleSize?: number;
    subtitleBackdrop?: string;
    backdropHeight?: number;
    keepOriginalAudio?: boolean;
    originalAudioVolume?: number;
  },
): Promise<BrandingConfig> {
  const branding = await loadBranding(projectId);
  if (update.position !== undefined) {
    if (!POSITIONS.has(update.position as BrandingPosition)) {
      throw new Error(`Invalid position: ${update.position}. Use top-left, top-right, bottom-left, or bottom-right.`);
    }
    branding.position = update.position as BrandingPosition;
  }
  if (update.logoHeight !== undefined) {
    branding.logoHeight = Math.min(1024, Math.max(16, Math.round(update.logoHeight)));
  }
  if (update.margin !== undefined) {
    branding.margin = Math.min(512, Math.max(0, Math.round(update.margin)));
  }
  if (update.watermarkText !== undefined) {
    branding.watermarkText = update.watermarkText.trim().slice(0, 120);
  }
  if (update.watermarkOpacity !== undefined && Number.isFinite(update.watermarkOpacity)) {
    branding.watermarkOpacity = Math.min(1, Math.max(0.05, Math.round(update.watermarkOpacity * 100) / 100));
  }
  if (update.watermarkSize !== undefined && Number.isFinite(update.watermarkSize)) {
    branding.watermarkSize = Math.min(200, Math.max(12, Math.round(update.watermarkSize)));
  }
  if (update.burnSubtitles !== undefined) {
    branding.burnSubtitles = update.burnSubtitles === true;
  }
  if (update.subtitleSize !== undefined && Number.isFinite(update.subtitleSize)) {
    branding.subtitleSize = Math.min(72, Math.max(8, Math.round(update.subtitleSize)));
  }
  if (update.subtitleBackdrop !== undefined) {
    if (update.subtitleBackdrop !== "none" && update.subtitleBackdrop !== "box" && update.subtitleBackdrop !== "bar") {
      throw new Error(`Invalid subtitleBackdrop: ${update.subtitleBackdrop}. Use none, box, or bar.`);
    }
    branding.subtitleBackdrop = update.subtitleBackdrop;
  }
  if (update.backdropHeight !== undefined && Number.isFinite(update.backdropHeight)) {
    branding.backdropHeight = Math.min(40, Math.max(5, Math.round(update.backdropHeight)));
  }
  if (update.keepOriginalAudio !== undefined) {
    branding.keepOriginalAudio = update.keepOriginalAudio === true;
  }
  if (update.originalAudioVolume !== undefined && Number.isFinite(update.originalAudioVolume)) {
    branding.originalAudioVolume = Math.min(2, Math.max(0, Math.round(update.originalAudioVolume * 100) / 100));
  }
  branding.updatedAt = new Date().toISOString();
  await saveBranding(projectId, branding);
  return branding;
}

export type FinalRenderArgsInput = {
  sourcePath: string;
  voiceoverPath: string;
  voiceoverIsAac: boolean;
  logoPath?: string;
  coverPath?: string;
  position: BrandingPosition;
  logoHeight: number;
  margin: number;
  watermarkText?: string;
  watermarkOpacity?: number;
  watermarkSize?: number;
  watermarkFontFile?: string;
  subtitlePath?: string;
  subtitleSize?: number;
  subtitleBackdrop?: "none" | "box" | "bar";
  backdropHeight?: number;
  mixOriginalAudio?: boolean;
  originalAudioVolume?: number;
  videoEncoderArgs: string[];
  outputPath: string;
};

// drawtext parses its own mini-language, so the burned text must not carry
// characters that would end the quoted value or start a new option.
function drawtextSafe(text: string): string {
  return text.replace(/['\\:;%]/g, " ").trim();
}

export function buildFinalRenderArgs(input: FinalRenderArgsInput): string[] {
  const args = ["-y", "-i", input.sourcePath, "-i", input.voiceoverPath];
  let nextInput = 2;
  let logoIndex = -1;
  let coverIndex = -1;
  if (input.logoPath) {
    args.push("-i", input.logoPath);
    logoIndex = nextInput;
    nextInput += 1;
  }
  if (input.coverPath) {
    args.push("-i", input.coverPath);
    coverIndex = nextInput;
    nextInput += 1;
  }

  const watermarkText = drawtextSafe(input.watermarkText ?? "");
  const filters: string[] = [];
  let videoLabel = "0:v";
  if (input.subtitlePath) {
    if (input.subtitleBackdrop === "bar") {
      // A full-width strip that hides subtitles hardcoded into the source;
      // the new subtitles then render on top of it.
      const ratio = Math.round((input.backdropHeight ?? 14)) / 100;
      filters.push(
        `[${videoLabel}]drawbox=x=0:y=ih*${1 - ratio}:w=iw:h=ih*${ratio}:color=black:t=fill[bar]`,
      );
      videoLabel = "bar";
    }
    // libass parses the filename option itself, so the path keeps forward
    // slashes and escapes the drive colon; single quotes guard the spaces.
    const subtitleFile = input.subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:");
    const boxStyle = input.subtitleBackdrop === "box" ? ",BorderStyle=3,BackColour=&H00000000" : "";
    filters.push(
      `[${videoLabel}]subtitles=filename='${subtitleFile}':force_style='FontName=Arial,FontSize=${input.subtitleSize ?? 18},Outline=1,MarginV=20${boxStyle}'[sub]`,
    );
    videoLabel = "sub";
  }
  if (watermarkText) {
    const font = input.watermarkFontFile
      ? `fontfile='${input.watermarkFontFile.replace(/\\/g, "/").replace(/:/g, "\\:")}'`
      : "font=sans";
    filters.push(
      `[${videoLabel}]drawtext=${font}:text='${watermarkText}':fontsize=${input.watermarkSize ?? 36}:` +
        `fontcolor=white@${input.watermarkOpacity ?? 0.25}:x=(w-text_w)/2:y=(h-text_h)/2[wm]`,
    );
    videoLabel = "wm";
  }
  if (logoIndex >= 0) {
    const m = input.margin;
    const coords: Record<BrandingPosition, string> = {
      "top-left": `${m}:${m}`,
      "top-right": `main_w-overlay_w-${m}:${m}`,
      "bottom-left": `${m}:main_h-overlay_h-${m}`,
      "bottom-right": `main_w-overlay_w-${m}:main_h-overlay_h-${m}`,
    };
    filters.push(
      `[${logoIndex}:v]scale=-1:${input.logoHeight}[logo]`,
      `[${videoLabel}][logo]overlay=${coords[input.position]}[vout]`,
    );
  } else if (filters.length > 0) {
    const last = filters.pop() as string;
    filters.push(last.replace(`[${videoLabel}]`, "[vout]"));
  }
  const hasVideoFilters = filters.length > 0;

  const audioFilters: string[] = [];
  if (input.mixOriginalAudio) {
    audioFilters.push(
      `[0:a]volume=${input.originalAudioVolume ?? 1}[bga]`,
      "[bga][1:a:0]amix=inputs=2:duration=first:normalize=0[aout]",
    );
  }

  const graph = [...filters, ...audioFilters];
  if (graph.length > 0) {
    args.push("-filter_complex", graph.join(";"));
  }

  if (hasVideoFilters) {
    args.push("-map", "[vout]", ...input.videoEncoderArgs);
  } else {
    args.push("-map", "0:v:0", "-c:v:0", "copy");
  }

  if (input.mixOriginalAudio) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-map", "1:a:0");
    if (input.voiceoverIsAac) {
      args.push("-c:a", "copy");
    } else {
      args.push("-c:a", "aac", "-b:a", "192k");
    }
  }

  if (coverIndex >= 0) {
    args.push("-map", `${coverIndex}:v`, "-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic");
  }

  args.push("-movflags", "+faststart", input.outputPath);
  return args;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export type FinalRenderPrerequisites = {
  ready: boolean;
  reasons: string[];
  sourcePath?: string;
  voiceoverPath?: string;
  voiceoverIsAac?: boolean;
};

export async function checkFinalRenderPrerequisites(projectId: string): Promise<FinalRenderPrerequisites> {
  const reasons: string[] = [];
  const state = await loadProjectState(projectId);
  const mediaRelative = state.artifacts.media?.relativePath;
  let sourcePath: string | undefined;
  if (mediaRelative && (await fileExists(resolveProjectPath(projectId, mediaRelative)))) {
    sourcePath = resolveProjectPath(projectId, mediaRelative);
  } else {
    reasons.push("Import the source video in the Media stage first.");
  }

  const m4a = resolveProjectPath(projectId, join("workspace", "voiceover", "voiceover.m4a"));
  const wav = resolveProjectPath(projectId, join("workspace", "voiceover", "voiceover.wav"));
  let voiceoverPath: string | undefined;
  let voiceoverIsAac = false;
  if (await fileExists(m4a)) {
    voiceoverPath = m4a;
    voiceoverIsAac = true;
  } else if (await fileExists(wav)) {
    voiceoverPath = wav;
  } else {
    reasons.push("Render the voiceover track before the final render.");
  }

  return { ready: reasons.length === 0, reasons, sourcePath, voiceoverPath, voiceoverIsAac };
}

export type FinalRenderResult = {
  projectId: string;
  relativePath: string;
  logoApplied: boolean;
  coverApplied: boolean;
  encoder: string;
};

export async function renderFinalVideo(input: {
  projectId: string;
  ffmpegPath: string;
  onProgress?: (progress: number, message: string) => Promise<void>;
}): Promise<FinalRenderResult> {
  const prerequisites = await checkFinalRenderPrerequisites(input.projectId);
  if (!prerequisites.ready || !prerequisites.sourcePath || !prerequisites.voiceoverPath) {
    throw new Error(prerequisites.reasons.join(" "));
  }

  const branding = await loadBranding(input.projectId);
  const logoPath = branding.logoFile
    ? resolveProjectPath(input.projectId, join(BRANDING_DIR, branding.logoFile))
    : undefined;
  const coverPath = branding.coverFile
    ? resolveProjectPath(input.projectId, join(BRANDING_DIR, branding.coverFile))
    : undefined;
  const logoReady = logoPath !== undefined && (await fileExists(logoPath));
  const coverReady = coverPath !== undefined && (await fileExists(coverPath));
  const watermarkReady = branding.watermarkText.trim() !== "";
  let subtitlePath: string | undefined;
  if (branding.burnSubtitles) {
    const state = await loadProjectState(input.projectId);
    const subtitleRelative = state.artifacts["source-subtitles"]?.relativePath;
    if (!subtitleRelative) {
      throw new Error("Burn subtitles is on, but the project has no source SRT. Import one in Subtitles first.");
    }
    const resolved = resolveProjectPath(input.projectId, subtitleRelative);
    if (!(await fileExists(resolved))) {
      throw new Error("The registered source SRT file is missing on disk. Re-import it in Subtitles.");
    }
    subtitlePath = resolved;
  }
  let watermarkFontFile: string | undefined;
  if (watermarkReady) {
    for (const candidate of ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf"]) {
      if (await fileExists(candidate)) {
        watermarkFontFile = candidate;
        break;
      }
    }
  }

  const relativePath = "workspace/render/final.mp4";
  await mkdir(resolveProjectPath(input.projectId, join("workspace", "render")), { recursive: true });
  const outputPath = resolveProjectPath(input.projectId, relativePath);

  // Without an overlay the video stream is copied, so only logo/watermark need
  // an encoder; QSV is tried first and libx264 covers machines without it.
  const needsEncode = logoReady || watermarkReady || subtitlePath !== undefined;
  const encoderCandidates: Array<{ name: string; args: string[] }> = needsEncode
    ? [
        { name: "h264_qsv", args: ["-c:v:0", "h264_qsv", "-global_quality", "23"] },
        { name: "libx264", args: ["-c:v:0", "libx264", "-preset", "veryfast", "-crf", "21"] },
      ]
    : [{ name: "copy", args: [] }];

  let encoder = "";
  let lastError: unknown;
  for (const candidate of encoderCandidates) {
    if (input.onProgress) {
      await input.onProgress(
        10,
        needsEncode ? `Encoding with ${candidate.name} (overlay burn-in)` : "Muxing voiceover into the video",
      );
    }
    const args = buildFinalRenderArgs({
      sourcePath: prerequisites.sourcePath,
      voiceoverPath: prerequisites.voiceoverPath,
      voiceoverIsAac: prerequisites.voiceoverIsAac === true,
      logoPath: logoReady ? logoPath : undefined,
      coverPath: coverReady ? coverPath : undefined,
      position: branding.position,
      logoHeight: branding.logoHeight,
      margin: branding.margin,
      watermarkText: watermarkReady ? branding.watermarkText : undefined,
      watermarkOpacity: branding.watermarkOpacity,
      watermarkSize: branding.watermarkSize,
      watermarkFontFile,
      subtitlePath,
      subtitleSize: branding.subtitleSize,
      subtitleBackdrop: branding.subtitleBackdrop,
      backdropHeight: branding.backdropHeight,
      mixOriginalAudio: branding.keepOriginalAudio,
      originalAudioVolume: branding.originalAudioVolume,
      videoEncoderArgs: candidate.args,
      outputPath,
    });
    try {
      await runProcess(input.ffmpegPath, args);
      encoder = candidate.name;
      lastError = undefined;
      break;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  if (!encoder) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (input.onProgress) {
    await input.onProgress(95, "Registering the final render");
  }
  const createdAt = new Date().toISOString();
  await setArtifact(input.projectId, {
    kind: "render",
    sourceHash: sha256(`${relativePath}:${createdAt}`),
    relativePath,
    createdAt,
    metadata: { voiceover: true, logo: logoReady, cover: coverReady, watermark: watermarkReady, subtitles: subtitlePath !== undefined, originalAudio: branding.keepOriginalAudio, encoder },
  });

  return { projectId: input.projectId, relativePath, logoApplied: logoReady, coverApplied: coverReady, encoder };
}
