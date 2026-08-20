import assert from "node:assert/strict";
import test from "node:test";
import { parseSubtitleToTranscript } from "../src/transcript.ts";

test("normalizes SRT cues to transcript segments with milliseconds", () => {
  const transcript = parseSubtitleToTranscript({
    episode: 2,
    sourceFile: "ep02.srt",
    language: "zh",
    content: "1\n00:00:01,500 --> 00:00:03,000\n牧神记开始了\n\n2\n00:00:04,000 --> 00:00:05,250\n秦牧回来了\n",
  });

  assert.deepEqual(transcript.map((segment) => segment.cueId), ["EP02-CUE0001", "EP02-CUE0002"]);
  assert.equal(transcript[0].startMs, 1500);
  assert.equal(transcript[1].endMs, 5250);
  assert.equal(transcript[0].text, "牧神记开始了");
});

test("normalizes VTT cues to transcript segments", () => {
  const transcript = parseSubtitleToTranscript({
    episode: 3,
    sourceFile: "ep03.vtt",
    language: "zh",
    content: "WEBVTT\n\n00:00:10.000 --> 00:00:12.400\nThe darkness is coming...\n\n00:00:13.000 --> 00:00:15.000\nRun before nightfall.\n",
  });

  assert.deepEqual(
    transcript.map((segment) => [segment.cueId, segment.startMs, segment.endMs, segment.text]),
    [
      ["EP03-CUE0001", 10000, 12400, "The darkness is coming..."],
      ["EP03-CUE0002", 13000, 15000, "Run before nightfall."],
    ],
  );
});

test("normalizes ASS dialogue events to transcript segments", () => {
  const transcript = parseSubtitleToTranscript({
    episode: 4,
    sourceFile: "ep04.ass",
    language: "zh",
    content: `[Script Info]
Title: sample

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:02.30,0:01:04.60,Default,Qin Mu,0,0,0,,We cannot stay here.
Dialogue: 0,0:01:05.00,0:01:07.00,Default,Granny Si,0,0,0,,Then move before sunset.
`,
  });

  assert.equal(transcript[0].speaker, "Qin Mu");
  assert.equal(transcript[0].startMs, 62300);
  assert.equal(transcript[1].endMs, 67000);
  assert.equal(transcript[1].text, "Then move before sunset.");
});
