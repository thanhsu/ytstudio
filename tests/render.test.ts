import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  renderArtifactRelativePath,
  buildShortsRenderArgs,
  buildSegmentArgs,
  evaluateRenderGate,
  renderDraft,
  type RenderGateInput,
  type RenderInput,
  type RenderVisualSegment,
} from "../src/render.ts";
import { DEFAULT_SEGMENT_EFFECTS } from "../src/visual-effects.ts";
import type { AssetRecord } from "../src/assets.ts";
import { resolveProjectPath } from "../src/project-paths.ts";
import { draftRenderOutputPath } from "../src/workflow.ts";
import { makeFakeExecutable } from "./helpers.ts";

const imageSegment: RenderVisualSegment = {
  sceneId: "scene-001",
  startSeconds: 0,
  endSeconds: 4,
  assetPath: "projects/sample-project/assets/images/card.png",
  mediaType: "image",
  fitMode: "cover",
  sourceStartSeconds: 0,
  sourceDurationSeconds: 4,
  muteSourceAudio: true,
};

const videoSegment: RenderVisualSegment = {
  sceneId: "scene-001",
  startSeconds: 0,
  endSeconds: 8,
  assetPath: "projects/sample-project/assets/clips/training.mp4",
  mediaType: "video",
  fitMode: "cover",
  sourceStartSeconds: 3,
  sourceDurationSeconds: 5,
  muteSourceAudio: true,
};

function eligibleLogoAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "logo-1",
    filename: "logo.png",
    relativePath: "assets/images/logo-1.png",
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 1024,
    rightsConfirmed: true,
    usagePurpose: "brand watermark",
    createdAt: "2026-08-24T00:00:00.000Z",
    role: "logo",
    rightsStatus: "owned",
    ...overrides,
  };
}

async function fakeFfmpeg(): Promise<string> {
  return makeFakeExecutable(
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import { dirname } from "node:path";',
      "const outputPath = process.argv.at(-1);",
      "await mkdir(dirname(outputPath), { recursive: true });",
      'await writeFile(outputPath, "video", "utf8");',
    ].join("\n"),
  );
}

function readyRenderInput(): RenderGateInput {
  return {
    script: "approved",
    assets: "approved",
    copyright: "approved",
    voice: "ready",
    captions: "ready",
    visualMapping: "not-required",
  };
}

function sampleRenderInput(): RenderInput {
  return {
    projectId: "sample-project",
    title: "Why Qin Mu feels different",
    durationSeconds: 8,
    voicePath: "projects/sample-project/workspace/voice/draft.wav",
    captionsPath: "projects/sample-project/workspace/captions/draft.srt",
    outputPath: "projects/sample-project/workspace/renders/draft.mp4",
    assetPaths: [],
  };
}

test("render is blocked by stale copyright approval", () => {
  const result = evaluateRenderGate({ ...readyRenderInput(), copyright: "stale" });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("copyright-approval-stale"));
});

test("render separates missing approvals from stale ones", () => {
  const result = evaluateRenderGate({
    ...readyRenderInput(),
    script: "stale",
    copyright: "missing",
  });

  assert.deepEqual(result.reasons, ["script-approval-stale", "copyright-approval-missing"]);
});

test("render blames the upstream gate instead of artifacts it blocks", () => {
  const result = evaluateRenderGate({
    script: "missing",
    assets: "not-required",
    copyright: "missing",
    voice: "blocked",
    captions: "blocked",
    visualMapping: "not-required",
  });

  assert.deepEqual(result.reasons, ["script-approval-missing", "copyright-approval-missing"]);
});

test("render requires an approved visual mapping once assets exist", () => {
  const result = evaluateRenderGate({ ...readyRenderInput(), visualMapping: "missing" });

  assert.deepEqual(result.reasons, ["visual-mapping-not-approved"]);
});

test("render allows a fully approved project", () => {
  assert.equal(evaluateRenderGate(readyRenderInput()).allowed, true);
});

test("shorts render targets vertical H264 MP4", () => {
  const input = sampleRenderInput();
  const args = buildShortsRenderArgs(input);

  assert.ok(args.includes("1080x1920"));
  assert.ok(args.includes("libx264"));
  assert.equal(args[args.indexOf("-threads") + 1], "2");
  assert.equal(args[args.indexOf("-filter_complex_threads") + 1], "1");
  assert.ok(args.includes("aac"));
  assert.equal(args.at(-1), input.outputPath);
});

test("shorts render accepts configured output dimensions", () => {
  const args = buildShortsRenderArgs({ ...sampleRenderInput(), width: 720, height: 1280 });

  assert.ok(args.includes("720x1280"));
});

test("shorts render uses explicit font paths for portable FFmpeg", () => {
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    fontFilePath: "C:/Windows/Fonts/arial.ttf",
    fontDirectory: "C:/Windows/Fonts",
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  assert.match(filter, /fontfile='C\\:\/Windows\/Fonts\/arial\.ttf'/);
  assert.match(filter, /fontsdir='C\\:\/Windows\/Fonts'/);
  assert.match(filter, /FontName=Arial/);
  assert.match(filter, /fps=30/);
});

test("shorts render consumes mapped video safely and fills remaining scene time", () => {
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{
      sceneId: "scene-001", startSeconds: 0, endSeconds: 8, assetPath: "projects/sample-project/assets/clips/training.mp4",
      mediaType: "video", fitMode: "cover", sourceStartSeconds: 3, sourceDurationSeconds: 5, muteSourceAudio: true,
    }],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.ok(args.includes("projects/sample-project/assets/clips/training.mp4"));
  assert.ok(args.includes("-an"));
  assert.match(filter, /trim=duration=5/);
  assert.match(filter, /color=c=#111827:s=1080x1920:d=3/);
  assert.match(filter, /concat=n=2:v=1:a=0/);
});

test("shorts render bounds each reused asset input to its scene excerpt", () => {
  const assetPath = "projects/sample-project/assets/clips/training.mp4";
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [
      { sceneId: "scene-001", startSeconds: 0, endSeconds: 5, assetPath, mediaType: "video", fitMode: "cover", sourceStartSeconds: 0, sourceDurationSeconds: 5, muteSourceAudio: true },
      { sceneId: "scene-003", startSeconds: 10, endSeconds: 15, assetPath, mediaType: "video", fitMode: "cover", sourceStartSeconds: 5, sourceDurationSeconds: 5, muteSourceAudio: true },
    ],
  });
  assert.equal(args.filter((argument) => argument === assetPath).length, 2);
  assert.equal(args.filter((argument) => argument === "-ss").length, 2);
});

test("render artifact path is project-relative with URL-safe separators", () => {
  assert.equal(
    renderArtifactRelativePath(
      "muc-than-ky-review-001",
      "projects\\muc-than-ky-review-001\\workspace\\renders\\draft.mp4",
    ),
    "workspace/renders/draft.mp4",
  );
  assert.equal(
    renderArtifactRelativePath(
      "muc-than-ky-review-001",
      "D:\\studio\\projects\\muc-than-ky-review-001\\workspace\\renders\\draft.mp4",
    ),
    "workspace/renders/draft.mp4",
  );
});

test("draft render output is versioned to avoid overwriting an open preview", () => {
  assert.equal(
    draftRenderOutputPath("sample-project", new Date("2026-08-21T02:40:00.123Z")),
    resolveProjectPath("sample-project", "workspace", "renders", "draft-20260821-024000-123.mp4"),
  );
});

test("background video input index follows any mapped scene inputs", () => {
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{
      sceneId: "scene-001", startSeconds: 0, endSeconds: 4, assetPath: "projects/sample-project/assets/images/card.png",
      mediaType: "image", fitMode: "cover", sourceStartSeconds: 0, sourceDurationSeconds: 4, muteSourceAudio: true,
    }],
    backgroundVideoPath: "projects/sample-project/workspace/renders/timeline.mp4",
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  assert.match(filter, /\[3:v\]trim=duration=8/);
});

// --- Task 5: effects integration ---

test("image speed is a no-op and video speed uses a bounded source slice", () => {
  const imageArgs = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{ ...imageSegment, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 2 } }],
  });
  assert.doesNotMatch(imageArgs.join(";"), /setpts=PTS\/2/);

  const videoArgs = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{ ...videoSegment, endSeconds: 10, sourceDurationSeconds: 10, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 2 } }],
  });
  assert.match(videoArgs.join(";"), /-t.*5/);
  assert.match(videoArgs.join(";"), /setpts=PTS\/2/);
  assert.match(videoArgs.join(";"), /fill/);
});

test("neutral default effects leave the existing filter graph intact (allowing only a null passthrough)", () => {
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{ ...videoSegment, effects: DEFAULT_SEGMENT_EFFECTS }],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /trim=duration=5/);
  assert.match(filter, /color=c=#111827:s=1080x1920:d=3/);
  assert.match(filter, /concat=n=2:v=1:a=0/);
  // At most a harmless identity hop is tolerated for the neutral-effects case.
  assert.equal((filter.match(/null/g) ?? []).length, 1);
});

test("video zoom, color, and blur apply between fit/crop and trim, and fades stay inside the clip", () => {
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{
      ...videoSegment,
      endSeconds: 10,
      sourceDurationSeconds: 10,
      effects: { ...DEFAULT_SEGMENT_EFFECTS, blur: 6, transitionIn: "fade", transitionOut: "fade" },
    }],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /scale=[^,]+,crop=1080:1920,setsar=1\[fit0\]/);
  assert.match(filter, /boxblur=6/);
  assert.match(filter, /fade=t=in:st=0/);
  assert.match(filter, /fade=t=out/);
  const boxblurIndex = filter.indexOf("boxblur=6");
  const trimIndex = filter.indexOf("trim=duration=5,setpts=PTS-STARTPTS[clip0]");
  assert.ok(boxblurIndex >= 0 && trimIndex >= 0 && boxblurIndex < trimIndex, "effects must apply before the segment trim");
});

test("watermark effects overlay a resolved logo asset without an extra ffmpeg input", () => {
  const logo = eligibleLogoAsset();
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{
      ...imageSegment,
      effects: {
        ...DEFAULT_SEGMENT_EFFECTS,
        watermark: { assetId: logo.id, position: "top-right", scale: 0.12, opacity: 0.2 },
      },
      watermarkAsset: logo,
    }],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /movie=/);
  assert.match(filter, /overlay=W-w-24:24/);
  // Base (silent+voice) + the segment's own image asset = 3 -i flags; the
  // watermark logo loads via the movie= filter and adds no extra -i.
  assert.equal(args.filter((argument) => argument === "-i").length, 3);
});

test("a watermarked segment does not corrupt the ffmpeg input index of a later segment", () => {
  const logo = eligibleLogoAsset();
  const secondAssetPath = "projects/sample-project/assets/clips/second.mp4";
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [
      {
        ...imageSegment,
        effects: {
          ...DEFAULT_SEGMENT_EFFECTS,
          watermark: { assetId: logo.id, position: "top-left", scale: 0.12, opacity: 0.2 },
        },
        watermarkAsset: logo,
      },
      {
        sceneId: "scene-002",
        startSeconds: 4,
        endSeconds: 9,
        assetPath: secondAssetPath,
        mediaType: "video",
        fitMode: "cover",
        sourceStartSeconds: 0,
        sourceDurationSeconds: 5,
        muteSourceAudio: true,
      },
    ],
  });
  // Real -i order: 0 = silent base, 1 = voice, 2 = watermarked image asset,
  // 3 = the second segment's video asset (4 -i flags total). The watermark's
  // internal movie= filter label must not shift this numbering.
  assert.equal(args.filter((argument) => argument === "-i").length, 4);
  assert.equal(args[args.indexOf(secondAssetPath) - 1], "-i"); // sanity: the second segment's asset is a real -i input
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /\[3:v\]scale=/);
  assert.doesNotMatch(filter, /\[4:v\]/);
});

test("a watermarked segment does not corrupt the backgroundVideoPath ffmpeg input index", () => {
  const logo = eligibleLogoAsset();
  const args = buildShortsRenderArgs({
    ...sampleRenderInput(),
    visualSegments: [{
      ...imageSegment,
      effects: {
        ...DEFAULT_SEGMENT_EFFECTS,
        watermark: { assetId: logo.id, position: "top-left", scale: 0.12, opacity: 0.2 },
      },
      watermarkAsset: logo,
    }],
    backgroundVideoPath: "projects/sample-project/workspace/renders/timeline.mp4",
  });
  // Real -i order: 0 = silent base, 1 = voice, 2 = watermarked image asset,
  // 3 = the background video. The watermark's internal movie= filter label
  // must not shift this numbering.
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /\[3:v\]trim=duration=8/);
  assert.doesNotMatch(filter, /\[4:v\]/);
});

test("buildSegmentArgs applies the same effect chain for the per-segment concat path", () => {
  const args = buildSegmentArgs(
    { ...videoSegment, endSeconds: 10, sourceDurationSeconds: 10, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 2, transitionOut: "fade" } },
    "segment-000.mp4",
    1080,
    1920,
    "sample-project",
  );
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(args.join(";"), /-t.*5/);
  assert.match(filter, /setpts=PTS\/2/);
  assert.match(filter, /fade=t=out/);
  assert.match(filter, /fill/);
  assert.equal(args.at(-1), "segment-000.mp4");
});

test("buildSegmentArgs leaves image speed untouched", () => {
  const args = buildSegmentArgs(
    { ...imageSegment, effects: { ...DEFAULT_SEGMENT_EFFECTS, speed: 1.5 } },
    "segment-000.mp4",
    1080,
    1920,
    "sample-project",
  );
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(filter, /setpts=PTS\//);
});

test("normalized visual effects change the render artifact source hash", async () => {
  const previousRoot = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-render-effects-hash-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const shared = {
      ...sampleRenderInput(),
      outputPath: join(root, "sample-project", "workspace", "renders", "draft.mp4"),
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [await fakeFfmpeg()],
    };

    const first = await renderDraft({ ...shared, visualSegments: [{ ...imageSegment, effects: DEFAULT_SEGMENT_EFFECTS }] });
    const second = await renderDraft({ ...shared, visualSegments: [{ ...imageSegment, effects: { ...DEFAULT_SEGMENT_EFFECTS, blur: 4 } }] });

    assert.notEqual(first.sourceHash, second.sourceHash);
  } finally {
    if (previousRoot === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

