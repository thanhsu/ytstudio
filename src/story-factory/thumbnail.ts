import { access } from "node:fs/promises";
import { runProcess } from "../process.ts";
import { defaultFontFilePath, escapeDrawText, escapeFilterPath } from "../render.ts";
import type { ImageProvider } from "../images/types.ts";
import { storyPath, storyRelativePath } from "./paths.ts";
import type { ThumbnailArtifact, VisualStyleProfile } from "./types.ts";

/**
 * Thumbnails are two independent layers: a generated background that must
 * contain no text (image models render text badly), and a short overlay drawn
 * by ffmpeg where the typography is deterministic. Editing the overlay reuses
 * the existing background, so a metadata tweak never pays for a new image.
 */

const WIDTH = 1280;
const HEIGHT = 720;

export function buildThumbnailBackgroundPrompt(style: VisualStyleProfile, concept: string): string {
  return [
    concept.trim(),
    style.stylePrompt,
    "single strong focal point, simple composition, high contrast, readable at thumbnail size",
    "no text, no letters, no captions, no watermark",
  ]
    .filter(Boolean)
    .join(", ");
}

export function buildThumbnailOverlayArgs(options: {
  backgroundPath: string;
  overlayText: string;
  outputPath: string;
  fontFilePath?: string;
  fontColor?: string;
}): string[] {
  const fontFile = escapeFilterPath(options.fontFilePath ?? defaultFontFilePath());
  const text = escapeDrawText(options.overlayText.toUpperCase());
  const color = options.fontColor ?? "#ffffff";
  const draw =
    `drawtext=fontfile='${fontFile}':text='${text}':fontcolor=${color}:fontsize=110:` +
    `borderw=6:bordercolor=black:x=(w-text_w)/2:y=h-text_h-64`;
  return [
    "-y",
    "-i",
    options.backgroundPath,
    "-vf",
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},${draw}`,
    "-frames:v",
    "1",
    options.outputPath,
  ];
}

export type GenerateThumbnailOptions = {
  channelId: string;
  storyId: string;
  concept: string;
  overlayText: string;
  style: VisualStyleProfile;
  imageProvider: ImageProvider;
  fontColor?: string;
  fontFilePath?: string;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  signal?: AbortSignal;
};

export async function generateThumbnail(options: GenerateThumbnailOptions): Promise<ThumbnailArtifact> {
  const overlayText = options.overlayText.trim();
  if (!overlayText) {
    throw new Error("Thumbnail overlay text is required (2-5 short words).");
  }
  const backgroundRelative = storyRelativePath(options.storyId, "workspace", "thumbnail", "background.png");
  const backgroundPath = storyPath(options.channelId, options.storyId, "workspace", "thumbnail", "background.png");
  const backgroundPrompt = buildThumbnailBackgroundPrompt(options.style, options.concept);

  // The background is the expensive layer; regenerate it only when absent.
  if (!(await exists(backgroundPath))) {
    await options.imageProvider.generate(
      { prompt: backgroundPrompt, aspectRatio: "16:9", outputPath: backgroundPath, confirmedPaidRequest: true },
      options.signal,
    );
  }

  const finalRelative = storyRelativePath(options.storyId, "workspace", "thumbnail", "thumbnail.png");
  const finalPath = storyPath(options.channelId, options.storyId, "workspace", "thumbnail", "thumbnail.png");
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  await runProcess(
    ffmpeg,
    [
      ...(options.ffmpegPrefixArgs ?? []),
      ...buildThumbnailOverlayArgs({
        backgroundPath,
        overlayText,
        outputPath: finalPath,
        fontFilePath: options.fontFilePath,
        fontColor: options.fontColor,
      }),
    ],
    { signal: options.signal },
  );

  return {
    version: 1,
    backgroundPrompt,
    backgroundPath: backgroundRelative,
    overlayText,
    finalPath: finalRelative,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
