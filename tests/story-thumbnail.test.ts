import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeVisualStyle } from "../src/story-factory/channel.ts";
import {
  buildThumbnailBackgroundPrompt,
  buildThumbnailOverlayArgs,
  generateThumbnail,
} from "../src/story-factory/thumbnail.ts";
import { storyPath } from "../src/story-factory/paths.ts";
import type { ImageProvider, ImageRequest } from "../src/images/types.ts";
import { makeFakeExecutable } from "./helpers.ts";

const STYLE = normalizeVisualStyle({});

function stubImageProvider(): ImageProvider & { requests: ImageRequest[] } {
  const requests: ImageRequest[] = [];
  return {
    name: "gemini",
    requests,
    async generate(request: ImageRequest) {
      requests.push(request);
      await mkdir(join(request.outputPath, ".."), { recursive: true });
      await writeFile(request.outputPath, "png-bytes", "utf8");
      return { provider: "gemini", model: "m", mimeType: "image/png", createdAt: new Date().toISOString() };
    },
  };
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-thumb-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("the background prompt forbids text so typography stays with ffmpeg", () => {
  const prompt = buildThumbnailBackgroundPrompt(STYLE, "an empty hospital elevator, doors half open");
  assert.match(prompt, /hospital elevator/);
  assert.match(prompt, /cinematic horror/);
  assert.match(prompt, /no text, no letters, no captions/);
});

test("the overlay args escape Windows paths and draw centered bordered text", () => {
  const args = buildThumbnailOverlayArgs({
    backgroundPath: "C:\\projects\\ch\\bg.png",
    overlayText: "no abras la puerta",
    outputPath: "C:\\projects\\ch\\thumb.png",
    fontFilePath: "C:\\Windows\\Fonts\\arialbd.ttf",
    fontColor: "#ff2a2a",
  });
  const vf = args[args.indexOf("-vf") + 1];
  // Drive-letter colon must be escaped inside the filter, or ffmpeg splits on it.
  assert.match(vf, /fontfile='C\\:\/Windows\/Fonts\/arialbd\.ttf'/);
  assert.match(vf, /text='NO ABRAS LA PUERTA'/);
  assert.match(vf, /fontcolor=#ff2a2a/);
  assert.match(vf, /scale=1280:720/);
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
});

test("an existing background is reused — only the cheap overlay pass re-runs", async () => {
  await withTempCwd(async () => {
    const provider = stubImageProvider();
    const fakeFfmpeg = await makeFakeExecutable("process.exit(0);");
    const options = {
      channelId: "es-horror",
      storyId: "story-001",
      concept: "a dark hotel corridor",
      overlayText: "Habitación 307",
      style: STYLE,
      imageProvider: provider,
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    };

    const first = await generateThumbnail(options);
    assert.equal(provider.requests.length, 1);
    assert.match(first.overlayText, /Habitación 307/);
    assert.match(first.finalPath, /stories\/story-001\/workspace\/thumbnail\/thumbnail\.png/);

    // Second run (metadata edit changed the overlay): background is not repaid.
    await generateThumbnail({ ...options, overlayText: "No estaba sola" });
    assert.equal(provider.requests.length, 1);
  });
});

test("blank overlay text is refused before any generation", async () => {
  await withTempCwd(async () => {
    const provider = stubImageProvider();
    await assert.rejects(
      () =>
        generateThumbnail({
          channelId: "es-horror",
          storyId: "story-001",
          concept: "c",
          overlayText: "  ",
          style: STYLE,
          imageProvider: provider,
        }),
      /overlay text/i,
    );
    assert.equal(provider.requests.length, 0);
    // Nothing was written either.
    await assert.rejects(async () => {
      const { access } = await import("node:fs/promises");
      await access(storyPath("es-horror", "story-001", "workspace", "thumbnail", "background.png"));
    });
  });
});
