import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShortsRenderArgs,
  evaluateRenderGate,
  type RenderGateInput,
  type RenderInput,
} from "../src/render.ts";

function readyRenderInput(): RenderGateInput {
  return {
    briefFormat: "shorts",
    scriptApprovalCurrent: true,
    assetsApprovalCurrent: true,
    copyrightApprovalCurrent: true,
    voiceReady: true,
    captionsReady: true,
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
  const result = evaluateRenderGate({ ...readyRenderInput(), copyrightApprovalCurrent: false });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("copyright-approval-stale"));
});

test("render reports missing approval gates", () => {
  const result = evaluateRenderGate({
    ...readyRenderInput(),
    scriptApprovalCurrent: false,
    copyrightApprovalCurrent: false,
  });

  assert.deepEqual(result.reasons, ["script-approval-stale", "copyright-approval-stale"]);
});

test("shorts render targets vertical H264 MP4", () => {
  const input = sampleRenderInput();
  const args = buildShortsRenderArgs(input);

  assert.ok(args.includes("1080x1920"));
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.equal(args.at(-1), input.outputPath);
});

test("shorts render accepts configured output dimensions", () => {
  const args = buildShortsRenderArgs({ ...sampleRenderInput(), width: 720, height: 1280 });

  assert.ok(args.includes("720x1280"));
});
