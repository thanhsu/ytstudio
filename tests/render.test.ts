import assert from "node:assert/strict";
import test from "node:test";
import {
  renderArtifactRelativePath,
  buildShortsRenderArgs,
  evaluateRenderGate,
  type RenderGateInput,
  type RenderInput,
} from "../src/render.ts";
import { resolveProjectPath } from "../src/project-paths.ts";
import { draftRenderOutputPath } from "../src/workflow.ts";

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

