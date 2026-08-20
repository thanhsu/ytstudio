import assert from "node:assert/strict";
import test from "node:test";
import { buildSceneMap } from "../src/scene-map.ts";
import type { TranscriptSegment } from "../src/transcript.ts";

test("groups transcript segments into stable episode scene ids", () => {
  const transcript: TranscriptSegment[] = [
    segment(3, 1, 0, 2000, "Qin Mu returns to the village."),
    segment(3, 2, 2300, 5000, "Granny Si warns him before nightfall."),
    segment(3, 3, 14000, 17000, "The darkness is coming."),
  ];

  const scenes = buildSceneMap(transcript, { maxGapMs: 5000, targetSceneMs: 30000 });

  assert.equal(scenes.length, 2);
  assert.deepEqual(
    scenes.map((scene) => [scene.sceneId, scene.startMs, scene.endMs, scene.sourceCueIds]),
    [
      ["EP03-SC001", 0, 5000, ["EP03-CUE0001", "EP03-CUE0002"]],
      ["EP03-SC002", 14000, 17000, ["EP03-CUE0003"]],
    ],
  );
  assert.match(scenes[0].dialogue, /Qin Mu returns/);
  assert.equal(scenes[0].importance > scenes[1].importance, true);
});

function segment(episode: number, cue: number, startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    episode,
    cueId: `EP${String(episode).padStart(2, "0")}-CUE${String(cue).padStart(4, "0")}`,
    startMs,
    endMs,
    text,
    language: "zh",
    sourceFile: `ep${episode}.srt`,
  };
}
