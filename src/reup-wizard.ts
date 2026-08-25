import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createBrief } from "./brief.ts";
import { loadBranding, renderFinalVideo, saveBrandingImage, updateBrandingSettings } from "./final-render.ts";
import { importMedia } from "./media-ingest.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { importSubtitle } from "./translation.ts";
import { importVoiceoverSegments, renderVoiceoverTrack } from "./voiceover.ts";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm"]);
const COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export type ReupScan = {
  videoPath?: string;
  srtPath?: string;
  audioDir?: string;
  coverPath?: string;
  missing: string[];
};

async function findSegmentDir(dir: string, depth: number): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "0001.wav")) {
    return dir;
  }
  if (depth <= 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSegmentDir(join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

export async function scanReupFolder(folderPath: string): Promise<ReupScan> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const scan: ReupScan = { missing: [] };

  let largestVideo = -1;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const fullPath = join(folderPath, entry.name);
    if (VIDEO_EXTENSIONS.has(extension)) {
      const size = (await stat(fullPath)).size;
      if (size > largestVideo) {
        largestVideo = size;
        scan.videoPath = fullPath;
      }
    } else if (extension === ".srt" && !scan.srtPath) {
      scan.srtPath = fullPath;
    } else if (COVER_EXTENSIONS.has(extension)) {
      // Prefer a file literally named cover.*; otherwise the first image wins.
      if (!scan.coverPath || entry.name.toLowerCase().startsWith("cover.")) {
        if (!scan.coverPath?.toLowerCase().includes("cover.")) {
          scan.coverPath = fullPath;
        }
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSegmentDir(join(folderPath, entry.name), 1);
    if (found) {
      scan.audioDir = found;
      break;
    }
  }

  if (!scan.videoPath) scan.missing.push("video (.mp4/.mkv/.mov/.webm)");
  if (!scan.srtPath) scan.missing.push("subtitle (.srt)");
  if (!scan.audioDir) scan.missing.push("audio segment folder (0001.wav, 0002.wav, ...)");
  return scan;
}

export type ReupWizardInput = {
  projectId: string;
  folderPath: string;
  topic?: string;
  show?: string;
  audience?: string;
  language?: string;
  /** Copy branding settings and the logo from this existing project. */
  templateProjectId?: string;
  finalRender?: boolean;
  ffmpegPath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => Promise<void>;
};

export type ReupWizardSummary = {
  projectId: string;
  cueCount: number;
  segmentCount: number;
  missingCues: number;
  coverApplied: boolean;
  brandingTemplate: string | null;
  finalRendered: boolean;
};

export async function runReupWizard(input: ReupWizardInput): Promise<ReupWizardSummary> {
  const report = input.onProgress ?? (async () => {});

  await report(2, "Scanning the source folder");
  const scan = await scanReupFolder(input.folderPath);
  if (scan.missing.length > 0 || !scan.videoPath || !scan.srtPath || !scan.audioDir) {
    throw new Error(`The folder is missing: ${scan.missing.join(", ")}.`);
  }

  const topic = input.topic?.trim() || basename(scan.videoPath, extname(scan.videoPath));
  await report(5, `Creating project ${input.projectId}`);
  await createBrief({
    id: input.projectId,
    topic,
    show: input.show?.trim() || topic,
    format: "longform",
    workflowType: "subtitle-render",
    audience: input.audience?.trim() || "YouTube recap viewers",
    language: input.language?.trim() || "English",
    notes: `Created by the reup wizard from ${input.folderPath}`,
  });

  await report(10, `Copying the source video (${Math.round((await stat(scan.videoPath)).size / 1024 / 1024)} MB)`);
  await importMedia(input.projectId, scan.videoPath);

  await report(32, "Importing the source SRT");
  const subtitle = await importSubtitle(input.projectId, scan.srtPath);

  await report(36, "Importing the voiceover segments");
  const voiceover = await importVoiceoverSegments({ projectId: input.projectId, folderPath: scan.audioDir });

  await report(42, "Rendering the voiceover track");
  const track = await renderVoiceoverTrack({
    projectId: input.projectId,
    ffmpegPath: input.ffmpegPath,
    onProgress: async (progress, message) => report(42 + Math.round(progress * 0.28), message),
  });

  let brandingTemplate: string | null = null;
  if (input.templateProjectId) {
    await report(72, `Copying branding from ${input.templateProjectId}`);
    const template = await loadBranding(input.templateProjectId);
    await updateBrandingSettings(input.projectId, {
      position: template.position,
      logoHeight: template.logoHeight,
      margin: template.margin,
      watermarkText: template.watermarkText,
      watermarkOpacity: template.watermarkOpacity,
      watermarkSize: template.watermarkSize,
      burnSubtitles: template.burnSubtitles,
      subtitleSize: template.subtitleSize,
      subtitleBackdrop: template.subtitleBackdrop,
      backdropHeight: template.backdropHeight,
      keepOriginalAudio: template.keepOriginalAudio,
      originalAudioVolume: template.originalAudioVolume,
    });
    if (template.logoFile) {
      const logoPath = resolveProjectPath(input.templateProjectId, join("workspace", "branding", template.logoFile));
      try {
        await saveBrandingImage(input.projectId, "logo", logoPath, template.logoFile);
      } catch {
        // A missing template logo must not sink the whole wizard.
      }
    }
    brandingTemplate = input.templateProjectId;
  }

  let coverApplied = false;
  if (scan.coverPath) {
    await report(74, "Attaching the cover image");
    await saveBrandingImage(input.projectId, "cover", scan.coverPath, basename(scan.coverPath));
    coverApplied = true;
  }

  let finalRendered = false;
  if (input.finalRender !== false) {
    await report(76, "Rendering the final video");
    await renderFinalVideo({
      projectId: input.projectId,
      ffmpegPath: input.ffmpegPath ?? "ffmpeg",
      onProgress: async (progress, message) => report(76 + Math.round(progress * 0.23), message),
    });
    finalRendered = true;
  }

  await report(100, "Reup wizard finished");
  return {
    projectId: input.projectId,
    cueCount: subtitle.cueCount ?? voiceover.cueCount,
    segmentCount: voiceover.segmentCount,
    missingCues: voiceover.missingCues.length,
    coverApplied,
    brandingTemplate,
    finalRendered,
  };
}
