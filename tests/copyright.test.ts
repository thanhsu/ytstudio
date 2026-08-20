import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCopyrightRisk } from "../src/copyright.ts";

test("copyright guard returns low risk for commentary-led usage", () => {
  const result = evaluateCopyrightRisk({
    projectId: "sample-project",
    commentaryPercent: 75,
    footagePercent: 12,
    longestClipSeconds: 4,
    usesFullScene: false,
    thumbnailFromCopyrightFrame: false,
    clipsHaveCommentaryPurpose: true,
  });

  assert.equal(result.risk, "low");
  assert.equal(result.blocked, false);
});

test("copyright guard blocks full-scene usage", () => {
  const result = evaluateCopyrightRisk({
    projectId: "sample-project",
    commentaryPercent: 30,
    footagePercent: 55,
    longestClipSeconds: 35,
    usesFullScene: true,
    thumbnailFromCopyrightFrame: true,
    clipsHaveCommentaryPurpose: false,
  });

  assert.equal(result.risk, "blocked");
  assert.equal(result.blocked, true);
  assert.ok(result.findings.length >= 4);
});
