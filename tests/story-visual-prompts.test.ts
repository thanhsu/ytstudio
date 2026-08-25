import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisualPromptArtifact,
  buildVisualPromptSourceHash,
} from "../src/story-factory/visual-prompts.ts";

test("buildVisualPromptArtifact creates one cue per scene from source text", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 30,
    text: "The door opened slowly. A cold voice whispered from the hallway.",
    scenes: [
      { sceneId: "SC-001", startSeconds: 0, endSeconds: 10 },
      { sceneId: "SC-002", startSeconds: 10, endSeconds: 30 },
    ],
  });

  assert.equal(artifact.version, 1);
  assert.equal(artifact.sourceHash, "abc");
  assert.equal(artifact.cues.length, 2);
  assert.equal(artifact.cues[0].sceneId, "SC-001");
  assert.ok(artifact.cues[0].visualPrompt.includes("door"));
  assert.ok(["mysterious", "tense", "calm", "reveal", "action"].includes(artifact.cues[0].mood));
});

test("overlay text only uses words present in the source text", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 8,
    text: "Never open the red door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
  });
  const sourceWords = new Set("never open the red door".split(" "));
  for (const word of artifact.cues[0].overlayText.toLowerCase().split(/\s+/)) {
    assert.equal(sourceWords.has(word), true);
  }
});

test("cue timing is clamped to narration duration", () => {
  const artifact = buildVisualPromptArtifact({
    sourceHash: "abc",
    durationSeconds: 12,
    text: "A short scene",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 99 }],
  });

  assert.equal(artifact.cues[0].endSeconds, 12);
});

test("source hash changes when approved text or scene timing changes", () => {
  const first = buildVisualPromptSourceHash({
    naturalizedText: "Never open the red door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
    ttsChunks: [{ index: 0, startSeconds: 0, endSeconds: 8 }],
    captions: [{ startSeconds: 0, endSeconds: 8, text: "Never open the red door" }],
  });
  const second = buildVisualPromptSourceHash({
    naturalizedText: "Never open the blue door",
    scenes: [{ sceneId: "SC-001", startSeconds: 0, endSeconds: 8 }],
    ttsChunks: [{ index: 0, startSeconds: 0, endSeconds: 8 }],
    captions: [{ startSeconds: 0, endSeconds: 8, text: "Never open the red door" }],
  });

  assert.notEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
