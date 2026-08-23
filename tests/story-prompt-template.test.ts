import assert from "node:assert/strict";
import test from "node:test";
import { interpolate, renderList, renderOptionalBlock } from "../src/story-factory/prompts/template.ts";

test("variables interpolate and repeated slots all fill", () => {
  const result = interpolate("Write a {{niche}} story in {{locale}}. Keep it {{niche}}.", {
    niche: "horror",
    locale: "es-MX",
  });
  assert.equal(result, "Write a horror story in es-MX. Keep it horror.");
});

test("a missing variable throws with its name instead of shipping a gap", () => {
  assert.throws(() => interpolate("Tone: {{tone}}", {}), /\{\{tone\}\}/);
});

test("an empty-string value is a value, not a missing variable", () => {
  assert.equal(interpolate("Notes: {{notes}}.", { notes: "" }), "Notes: .");
});

test("lists render as dash bullets and empty lists stay visibly empty", () => {
  assert.equal(renderList(["one", "two"]), "- one\n- two");
  assert.equal(renderList([]), "(none)");
});

test("optional blocks vanish when their content is blank", () => {
  assert.equal(renderOptionalBlock("Constraints", "  "), "");
  assert.equal(renderOptionalBlock("Constraints", "no gore"), "Constraints:\nno gore\n");
});
