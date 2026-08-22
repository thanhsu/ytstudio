import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceScore } from "../src/sources/score-parse.ts";
import { buildScorePrompt } from "../src/sources/score-prompt.ts";
import { scoreCandidate, type SourceScorer } from "../src/sources/score.ts";
import { loadCandidate, saveCandidate } from "../src/sources/store.ts";
import { sampleCandidate, withSourcesRoot } from "./helpers.ts";

const GOOD = JSON.stringify({
  value: 72,
  angle: "How the training arc breaks the usual pattern",
  hooks: ["The mentor lies in episode one"],
  risks: ["Heavy spoilers past the midpoint"],
  reason: "Clear arc with a contrarian read available.",
});

function scorerReturning(raw: string): SourceScorer {
  return { name: "stub", model: "stub-model", generate: async () => raw };
}

test("the prompt carries metadata only, because nothing is downloaded yet", () => {
  const text = JSON.stringify(buildScorePrompt(sampleCandidate("youtube-abc")));

  assert.match(text, /Episode 1/);
  assert.match(text, /Studio/);
  assert.match(text, /First episode\./);
  assert.ok(!/video\.mp4/.test(text));
});

test("the prompt asks for review worth and forbids proposing a republish", () => {
  const text = JSON.stringify(buildScorePrompt(sampleCandidate("youtube-abc"))).toLowerCase();

  assert.match(text, /commentary|review|analysis/);
  assert.match(text, /never propose/);
  assert.match(text, /republish|re-upload/);
});

test("the prompt tells the model it has not watched anything", () => {
  const text = JSON.stringify(buildScorePrompt(sampleCandidate("youtube-abc"))).toLowerCase();

  assert.match(text, /metadata only|not been downloaded|have not watched/);
});

test("a score records the provider and model that produced it", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));

    const updated = await scoreCandidate("youtube-abc", { scorer: scorerReturning(GOOD) });

    assert.equal(updated.score?.value, 72);
    assert.equal(updated.score?.provider, "stub");
    assert.equal(updated.score?.model, "stub-model");
    assert.ok(updated.score?.scoredAt);
    assert.deepEqual(updated.score?.risks, ["Heavy spoilers past the midpoint"]);
    assert.equal((await loadCandidate("youtube-abc"))?.score?.value, 72);
  });
});

test("scoring never disturbs the download lifecycle", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate({ ...sampleCandidate("youtube-abc"), status: "downloaded" });

    const updated = await scoreCandidate("youtube-abc", { scorer: scorerReturning(GOOD) });

    assert.equal(updated.status, "downloaded");
  });
});

test("a value outside 0-100 is refused, naming the field", () => {
  assert.throws(() => parseSourceScore(JSON.stringify({ ...JSON.parse(GOOD), value: 140 })), /value/);
  assert.throws(() => parseSourceScore(JSON.stringify({ ...JSON.parse(GOOD), value: -1 })), /value/);
  assert.throws(() => parseSourceScore(JSON.stringify({ ...JSON.parse(GOOD), value: "high" })), /value/);
});

test("a missing angle is refused rather than defaulted to an empty string", () => {
  const { angle, ...withoutAngle } = JSON.parse(GOOD);
  assert.throws(() => parseSourceScore(JSON.stringify(withoutAngle)), /angle/);
});

test("a fenced json block is accepted, since models keep sending them", () => {
  const parsed = parseSourceScore("```json\n" + GOOD + "\n```");
  assert.equal(parsed.value, 72);
});

test("a malformed response leaves the previous score intact", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    await scoreCandidate("youtube-abc", { scorer: scorerReturning(GOOD) });

    await assert.rejects(() => scoreCandidate("youtube-abc", { scorer: scorerReturning("not json") }));

    assert.equal((await loadCandidate("youtube-abc"))?.score?.value, 72);
  });
});

test("the dry-run scorer needs no model and says what it is", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));

    const updated = await scoreCandidate("youtube-abc", {});

    assert.equal(updated.score?.provider, "dry-run");
    assert.match(updated.score?.reason ?? "", /dry-run|template|not a model/i);
  });
});
