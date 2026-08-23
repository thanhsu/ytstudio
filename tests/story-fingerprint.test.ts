import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDuplicate,
  estimateJaccard,
  minhashSignature,
  normalizeText,
  shingles,
  SIGNATURE_SIZE,
} from "../src/story-factory/fingerprint.ts";

const PREMISE_A =
  "A night-shift security guard at an abandoned hospital in Monterrey hears the elevator " +
  "arrive on a floor that has been sealed for years, and the cameras show a little girl " +
  "standing behind him in every recording.";

const PREMISE_A_VARIANT =
  "A night-shift security guard at an abandoned hospital in Monterrey hears the elevator " +
  "arrive on a floor that has been sealed for years, and the cameras show a little girl " +
  "standing behind him in each recording he checks.";

const PREMISE_B =
  "A long-haul trucker on the road to Chihuahua keeps passing the same hitchhiker every " +
  "hundred kilometers, and the radio begins to describe an accident that has not happened yet.";

test("normalization strips punctuation and case so paraphrase-level noise cancels out", () => {
  assert.equal(normalizeText("¡La PUERTA — se abrió!  \n Sola."), "la puerta se abrió sola");
});

test("shingling is deterministic and short texts collapse to a single shingle", () => {
  assert.deepEqual(shingles("one two three"), new Set(["one two three"]));
  const grams = shingles("a b c d e f g");
  assert.equal(grams.size, 3);
  assert.ok(grams.has("a b c d e"));
});

test("the same text always produces the same signature", () => {
  const first = minhashSignature(PREMISE_A);
  const second = minhashSignature(PREMISE_A);
  assert.equal(first.length, SIGNATURE_SIZE);
  assert.deepEqual(first, second);
});

test("a near-duplicate premise scores high and a distinct one scores low", () => {
  const original = minhashSignature(PREMISE_A);
  const variant = minhashSignature(PREMISE_A_VARIANT);
  const distinct = minhashSignature(PREMISE_B);

  assert.ok(estimateJaccard(original, variant) > 0.6, "variant should read as a duplicate");
  assert.ok(estimateJaccard(original, distinct) < 0.2, "a different story should not");
});

test("checkDuplicate flags at the threshold and reports the nearest stories", () => {
  const existing = [
    { storyId: "story-elevator", signature: minhashSignature(PREMISE_A) },
    { storyId: "story-trucker", signature: minhashSignature(PREMISE_B) },
  ];

  const flagged = checkDuplicate(PREMISE_A_VARIANT, existing, 0.6);
  assert.equal(flagged.checkedAgainst, 2);
  assert.equal(flagged.flagged, true);
  assert.equal(flagged.nearest[0].storyId, "story-elevator");

  const fresh = checkDuplicate(PREMISE_B, [existing[0]], 0.6);
  assert.equal(fresh.flagged, false);
});

test("an empty channel index never flags", () => {
  const result = checkDuplicate(PREMISE_A, [], 0.6);
  assert.equal(result.checkedAgainst, 0);
  assert.equal(result.flagged, false);
  assert.deepEqual(result.nearest, []);
});
