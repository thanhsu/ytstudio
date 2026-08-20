import assert from "node:assert/strict";
import test from "node:test";
import { extractNarration } from "../src/narration.ts";

test("extracts only spoken review sections", () => {
  const narration = extractNarration(`# Title

Format: shorts
Runtime target: 75 seconds

## Hook

Qin Mu breaks the usual cultivation pattern.

## Main Points

1. His confidence hides uncertainty.
`);

  assert.equal(narration.text, "Qin Mu breaks the usual cultivation pattern.\n\nHis confidence hides uncertainty.");
  assert.equal(narration.wordCount, 11);
});

test("normalizes metadata, list markers, and whitespace", () => {
  const narration = extractNarration(`# Draft

Target audience: EU donghua viewers
Language: English

## Context

  This is   spoken.

2.   This is also spoken.

## Visual Notes

Use a card here.
`);

  assert.equal(narration.text, "This is spoken.\n\nThis is also spoken.");
  assert.match(narration.hash, /^[a-f0-9]{64}$/);
});
