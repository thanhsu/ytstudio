import assert from "node:assert/strict";
import test from "node:test";
import { ideaDirective } from "../src/story-factory/performance.ts";
import { buildIdeaMessages } from "../src/story-factory/prompts/idea.ts";

const context = {
  language: "es", locale: "es-MX", niche: "horror", subNiche: "night shift", tone: "tense",
  promptStyle: "natural", targetDurationMinutes: 25,
};

test("ideaDirective deterministically allocates approximately 30% exploration slots", () => {
  const directives = Array.from({ length: 100 }, (_, index) => ideaDirective(`story-${String(index).padStart(3, "0")}`));
  const explore = directives.filter((value) => value === "explore").length;
  assert.ok(explore >= 15 && explore <= 45);
  assert.equal(ideaDirective("story-001"), ideaDirective("story-001"));
});

test("idea prompt renders proven and exploration performance blocks", () => {
  const proven = buildIdeaMessages(context, { avoidPremises: [], performance: { provenThemes: ["isolation", "memory"], directive: "proven" } });
  assert.match(proven[1].content, /Performance data/);
  assert.match(proven[1].content, /isolation/);
  const explore = buildIdeaMessages(context, { avoidPremises: [], performance: { provenThemes: ["isolation"], directive: "explore" } });
  assert.match(explore[1].content, /Exploration slot/);
});
