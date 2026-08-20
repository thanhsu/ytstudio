import assert from "node:assert/strict";
import test from "node:test";
import { compareSrtStructure, parseSrt, stringifySrt, validateSrt } from "../src/srt.ts";

const SAMPLE = `1
00:00:00,000 --> 00:00:01,200
你是谁？

2
00:00:01,300 --> 00:00:03,000
我不会输。
`;

test("parses and serializes SRT cues without changing timing", () => {
  const cues = parseSrt(SAMPLE);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, "00:00:00,000");
  assert.equal(cues[1].end, "00:00:03,000");
  assert.match(stringifySrt(cues), /00:00:01,300 --> 00:00:03,000/);
});

test("validates translated SRT has no Chinese when required", () => {
  const cues = parseSrt(SAMPLE);
  const result = validateSrt(cues, { requireNoChinese: true });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Chinese characters/);
});

test("compares cue structure between source and translation", () => {
  const source = parseSrt(SAMPLE);
  const translated = parseSrt(`1
00:00:00,000 --> 00:00:01,200
Who are you?
`);

  const result = compareSrtStructure(source, translated);

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Cue count changed/);
});
