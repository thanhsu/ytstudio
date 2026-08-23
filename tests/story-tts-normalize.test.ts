import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPronunciations,
  buildTtsNormalizedText,
  normalizeForTts,
} from "../src/story-factory/tts-normalize.ts";

test("pronunciations replace whole words only", () => {
  const result = applyPronunciations("Sam saw Samuel. Sam ran.", [{ original: "Sam", pronunciation: "Sahm" }]);
  assert.equal(result.text, "Sahm saw Samuel. Sahm ran.");
  assert.equal(result.applied, 1);
});

test("accented names replace cleanly", () => {
  const result = applyPronunciations("Ixchel entró.", [{ original: "Ixchel", pronunciation: "Ish-chel" }]);
  assert.equal(result.text, "Ish-chel entró.");
});

test("blank pronunciation rules are skipped rather than deleting text", () => {
  const result = applyPronunciations("Hola mundo", [{ original: "Hola", pronunciation: "  " }]);
  assert.equal(result.text, "Hola mundo");
  assert.equal(result.applied, 0);
});

test("generic normalization cleans markdown, quotes, dashes, and ellipses", () => {
  const { text, normalizations } = normalizeForTts("El **pasillo** — vacío… “Hola”", "es-MX");
  assert.equal(text, 'El pasillo, vacío... "Hola"');
  assert.ok(normalizations.includes("strip-markdown"));
  assert.ok(normalizations.includes("dash-to-comma"));
  assert.ok(normalizations.includes("ellipsis"));
});

test("Spanish locales expand percent signs; other locales leave them alone", () => {
  assert.match(normalizeForTts("El 40% del pueblo", "es-MX").text, /40 por ciento/);
  assert.match(normalizeForTts("40% of the town", "en-US").text, /40%/);
});

test("paragraph breaks survive whitespace collapsing", () => {
  const { text } = normalizeForTts("Primera   línea.\n\n\n\nSegunda línea.", "es-MX");
  assert.equal(text, "Primera línea.\n\nSegunda línea.");
});

test("the combined artifact reports what it did without touching the source text", () => {
  const source = "Ixchel miró el 50%… nada.";
  const artifact = buildTtsNormalizedText(source, [{ original: "Ixchel", pronunciation: "Ish-chel" }], "es-MX");
  assert.equal(artifact.version, 1);
  assert.match(artifact.text, /Ish-chel/);
  assert.match(artifact.text, /50 por ciento/);
  assert.equal(artifact.appliedPronunciations, 1);
  assert.ok(artifact.normalizations.length > 0);
  // The caller's string is untouched — the stage writes a separate artifact.
  assert.match(source, /Ixchel/);
});
