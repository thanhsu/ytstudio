import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCaptions, saveCaptions, toSrt } from "../src/captions.ts";
import { extractNarration } from "../src/narration.ts";
import { loadProjectState } from "../src/project-state.ts";

test("caption cues cover the audio without overlap", () => {
  const cues = buildCaptions("One short sentence. A second sentence with more words.", 8);

  assert.equal(cues[0].startSeconds, 0);
  assert.equal(cues.at(-1)?.endSeconds, 8);
  assert.ok(cues.every((cue, index) => index === 0 || cue.startSeconds >= cues[index - 1].endSeconds));
  assert.ok(cues[1].endSeconds - cues[1].startSeconds > cues[0].endSeconds - cues[0].startSeconds);
});

test("writes valid SRT timestamps", () => {
  assert.match(toSrt([{ index: 1, text: "Hello", startSeconds: 0, endSeconds: 1.25 }]), /00:00:01,250/);
});

test("saves captions and records the artifact", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);

    const narration = extractNarration("## Hook\n\nHello world.");
    const artifact = await saveCaptions("sample-project", narration, 2);
    const state = await loadProjectState("sample-project");

    assert.equal(artifact.kind, "captions");
    assert.equal(state.artifacts.captions?.sourceHash, narration.hash);
    assert.match(artifact.relativePath, /^workspace\/captions\/.+\.srt$/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
