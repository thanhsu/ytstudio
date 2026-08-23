import assert from "node:assert/strict";
import test from "node:test";
import { parseIdea } from "../src/story-factory/stages/idea.ts";
import { parseHook } from "../src/story-factory/stages/hook.ts";
import { parseOutline, planSectionCount } from "../src/story-factory/stages/outline.ts";
import { applyBibleUpdates, parseBible } from "../src/story-factory/stages/bible.ts";
import { parseSection, sectionTail } from "../src/story-factory/stages/sections.ts";
import { parseContinuity } from "../src/story-factory/stages/continuity-qa.ts";
import { parseNaturalization } from "../src/story-factory/stages/naturalize.ts";
import { parseOriginality } from "../src/story-factory/stages/originality-qa.ts";
import { assignSceneTimings, parseScenes, planSceneCount } from "../src/story-factory/stages/scenes.ts";
import { parseMetadata } from "../src/story-factory/stages/metadata.ts";
import type { BibleArtifact } from "../src/story-factory/types.ts";

test("idea parsing requires the narrative fields and tolerates fences", () => {
  const parsed = parseIdea(
    '```json\n{"logline":"L","premise":"P","themes":["miedo"],"whyItWorks":"W"}\n```',
  );
  assert.equal(parsed.logline, "L");
  assert.deepEqual(parsed.themes, ["miedo"]);
  assert.throws(() => parseIdea('{"logline":"L","themes":[]}'), /premise/);
  assert.throws(() => parseIdea("plain prose"), /not JSON/);
});

test("hook parsing needs text and a positive estimated length", () => {
  const parsed = parseHook('{"hookText":"H","altHooks":["a","b"],"estimatedSeconds":25}');
  assert.equal(parsed.estimatedSeconds, 25);
  assert.throws(() => parseHook('{"hookText":"H","estimatedSeconds":0}'), /estimatedSeconds/);
});

test("outlines index their sections and refuse a one-section story", () => {
  const raw = JSON.stringify({
    sections: [
      { title: "Uno", goal: "g1", beats: ["b"], targetWords: 500 },
      { title: "Dos", goal: "g2", beats: ["b"], targetWords: "not-a-number" },
    ],
  });
  const sections = parseOutline(raw);
  assert.equal(sections[0].index, 1);
  assert.equal(sections[1].index, 2);
  // An unusable word target falls back instead of poisoning duration math.
  assert.equal(sections[1].targetWords, 600);
  assert.throws(
    () => parseOutline(JSON.stringify({ sections: [{ title: "Solo", goal: "g", beats: ["b"], targetWords: 100 }] })),
    /at least 2/,
  );
});

test("section counts scale with duration inside sane bounds", () => {
  assert.equal(planSectionCount(10), 3);
  assert.equal(planSectionCount(30), 6);
  assert.equal(planSectionCount(240), 12);
});

test("bible parsing keeps structure and updates append without duplicates", () => {
  const bible: BibleArtifact = {
    version: 1,
    ...parseBible(
      JSON.stringify({
        setting: "S",
        characters: [{ name: "Marisol", role: "guardia", description: "34 años", arc: "a" }],
        locations: [{ name: "Hospital", description: "d" }],
        timeline: ["t1"],
        supernaturalRules: ["r1"],
        knownFacts: ["f1"],
        openQuestions: ["q1"],
        endingConstraints: ["e1"],
      }),
    ),
    provenance: { provider: "p", model: "m", promptVersion: "v", generatedAt: "t" },
  };
  const updated = applyBibleUpdates(bible, { knownFacts: ["f1", "F1", "f2"], timeline: ["t2"] });
  assert.deepEqual(updated.knownFacts, ["f1", "f2"]);
  assert.deepEqual(updated.timeline, ["t1", "t2"]);
  // The original is not mutated.
  assert.deepEqual(bible.knownFacts, ["f1"]);
});

test("sections parse with optional bible updates and expose a bounded tail", () => {
  const parsed = parseSection('{"title":"T","text":"Una noche más en el hospital."}');
  assert.deepEqual(parsed.bibleUpdates, { timeline: [], knownFacts: [], openQuestions: [], supernaturalRules: [] });
  const withUpdates = parseSection('{"title":"T","text":"x","bibleUpdates":{"knownFacts":["nuevo"]}}');
  assert.deepEqual(withUpdates.bibleUpdates.knownFacts, ["nuevo"]);

  const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  assert.equal(sectionTail(words, 150).split(" ").length, 150);
  assert.equal(sectionTail("corto", 150), "corto");
});

test("continuity verdicts never pass while a major issue exists", () => {
  const clean = parseContinuity('{"issues":[],"pass":true}');
  assert.equal(clean.pass, true);
  const contradicted = parseContinuity(
    JSON.stringify({
      issues: [{ severity: "major", sectionIndex: 3, description: "d", suggestion: "s" }],
      pass: true,
    }),
  );
  assert.equal(contradicted.pass, false);
  const minor = parseContinuity(
    JSON.stringify({ issues: [{ severity: "minor", sectionIndex: 1, description: "d", suggestion: "s" }], pass: true }),
  );
  assert.equal(minor.pass, true);
});

test("naturalization returns text plus English notes", () => {
  const parsed = parseNaturalization('{"text":"mejor","notes":["rhythm"]}');
  assert.equal(parsed.text, "mejor");
  assert.throws(() => parseNaturalization('{"notes":[]}'), /text/);
});

test("originality clamps the score and treats publishable strictly", () => {
  const parsed = parseOriginality('{"score":1.7,"issues":[],"safetyIssues":[],"publishable":true}');
  assert.equal(parsed.score, 1);
  assert.equal(parseOriginality('{"score":0.4,"publishable":"yes"}').publishable, false);
});

test("scenes parse, count by interval, and receive even provisional timings", () => {
  const parsed = parseScenes(
    JSON.stringify({
      scenes: [
        { summary: "s1", imagePrompt: "p1", continuityRefs: ["Marisol"] },
        { summary: "s2", imagePrompt: "p2" },
      ],
    }),
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1].continuityRefs, []);

  assert.equal(planSceneCount(1500, 75), 20);
  assert.equal(planSceneCount(60, 75), 3);
  assert.equal(planSceneCount(100000, 45), 40);

  const timed = assignSceneTimings(parsed, 100);
  assert.equal(timed[0].sceneId, "SC-001");
  assert.equal(timed[0].startSeconds, 0);
  assert.equal(timed[0].endSeconds, 50);
  assert.equal(timed[1].endSeconds, 100);
});

test("metadata demands five scored titles and a mobile-short overlay", () => {
  const titles = Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, score: 0.5, rationale: "r" }));
  const valid = parseMetadata(
    JSON.stringify({
      titles,
      chosenTitle: "T0",
      description: "D",
      tags: ["terror"],
      thumbnailText: "NO ESTABA SOLA",
      thumbnailConcept: "corridor",
    }),
  );
  assert.equal(valid.titles.length, 5);
  assert.throws(
    () =>
      parseMetadata(
        JSON.stringify({
          titles: titles.slice(0, 4),
          chosenTitle: "T0",
          description: "D",
          tags: ["x"],
          thumbnailText: "OK",
          thumbnailConcept: "c",
        }),
      ),
    /at least 5/,
  );
  assert.throws(
    () =>
      parseMetadata(
        JSON.stringify({
          titles,
          chosenTitle: "T0",
          description: "D",
          tags: ["x"],
          thumbnailText: "seis palabras es demasiado texto aquí",
          thumbnailConcept: "c",
        }),
      ),
    /2-5 words/,
  );
});
