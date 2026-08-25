import assert from "node:assert/strict";
import test from "node:test";
import {
  alignmentPassed,
  checkAlignment,
  checkNames,
  extractDates,
  extractNumbers,
  extractTimes,
  mergeAdvisoryIssues,
  sectionsToFix,
} from "../src/canon/alignment.ts";
import type { AlignmentIssue, CanonTypedFact } from "../src/canon/types.ts";

function fact(overrides: Partial<CanonTypedFact> = {}): CanonTypedFact {
  return { id: "evt-1-f1", kind: "time", label: "elevator opened at", value: "03:17", ...overrides };
}

function input(text: string, locale: string, exemptions: string[] = [], facts: CanonTypedFact[] = [fact()]) {
  return { facts, sections: [{ index: 1, text }], locale, exemptions };
}

// ---------------------------------------------------------------------------
// Spoken-form parsing. This is what makes a deterministic gate possible at all:
// tts-normalize turns digits into words on purpose, so the checker has to read
// the words a narrator actually says.
// ---------------------------------------------------------------------------

test("times are parsed from digits and from spoken words in each locale", () => {
  assert.deepEqual(extractTimes("The elevator opened at 03:17.", "en-US"), ["03:17"]);
  assert.deepEqual(extractTimes("El ascensor se abrió a las tres y diecisiete.", "es-MX"), ["03:17"]);
  assert.deepEqual(extractTimes("Der Aufzug öffnete sich um drei Uhr siebzehn.", "de-DE"), ["03:17"]);
  assert.deepEqual(extractTimes("L'ascenseur s'est ouvert à trois heures dix-sept.", "fr-FR"), ["03:17"]);
  assert.deepEqual(extractTimes("L'ascensore si aprì alle tre e diciassette.", "it-IT"), ["03:17"]);
});

test("an hour with no stated minutes reads as o'clock, not as a missing value", () => {
  assert.deepEqual(extractTimes("a las tres de la madrugada", "es-MX"), ["03:00"]);
  assert.deepEqual(extractTimes("um drei Uhr", "de-DE"), ["03:00"]);
});

test("numbers are parsed from digits and words", () => {
  assert.deepEqual(extractNumbers("Room 307 and 12 keys", "en-US"), [307, 12]);
  assert.deepEqual(extractNumbers("veintitrés llaves", "es-MX"), [23]);
  assert.deepEqual(extractNumbers("siebzehn Schlüssel", "de-DE"), [17]);
});

test("dates are parsed in each locale's own order", () => {
  assert.deepEqual(extractDates("on March 4 the lights failed", "en-US"), ["03-04"]);
  assert.deepEqual(extractDates("el 4 de marzo fallaron las luces", "es-MX"), ["03-04"]);
  assert.deepEqual(extractDates("am 4. März fielen die Lichter aus", "de-DE"), ["03-04"]);
  assert.deepEqual(extractDates("le 4 mars les lumières ont lâché", "fr-FR"), ["03-04"]);
});

// ---------------------------------------------------------------------------
// The gate itself.
// ---------------------------------------------------------------------------

test("a genuinely altered time FAILS, in words as well as digits", () => {
  const outcome = checkAlignment(input("El ascensor se abrió a las tres y media.", "es-MX"));
  assert.equal(alignmentPassed(outcome.issues), false);
  assert.equal(outcome.issues[0].severity, "FAIL");
  assert.equal(outcome.issues[0].canonValue, "03:17");
  assert.equal(outcome.issues[0].localizedValue, "03:30");
  assert.equal(outcome.issues[0].canonAnchor, "evt-1-f1", "every issue names the canon record it contradicts");
});

test("a faithful localization PASSES even though every surface form changed", () => {
  // Digits became words, the sentence was restructured, the name declined.
  const outcome = checkAlignment(input("El ascensor se abrió a las tres y diecisiete de la madrugada.", "es-MX"));
  assert.equal(alignmentPassed(outcome.issues), true);
  assert.equal(outcome.checkedFacts, 1);
});

test("a locale's date order is not a canon violation", () => {
  // This is the false positive that makes a naive string diff unusable: the
  // same day, written the way the target language writes it.
  const dateFact = fact({ id: "evt-2-f1", kind: "date", label: "the lights failed on", value: "03-04" });
  const outcome = checkAlignment(input("El 4 de marzo fallaron las luces.", "es-MX", [], [dateFact]));
  assert.equal(alignmentPassed(outcome.issues), true);
});

test("a declined or respelled name is not a canon violation", () => {
  const nameFact = fact({ id: "evt-3-f1", kind: "name", label: "character present", value: "Marcos" });
  // German declines the surname; the character is unmistakably present.
  const issues = checkNames({
    facts: [nameFact],
    sections: [{ index: 1, text: "Sie fanden Marcos' Schlüssel im Aufzug." }],
    locale: "de-DE",
    exemptions: [],
  });
  assert.deepEqual(issues, []);
});

test("a character the narration dropped entirely still FAILS", () => {
  const nameFact = fact({ id: "evt-3-f1", kind: "name", label: "character present", value: "Marcos" });
  const issues = checkNames({
    facts: [nameFact],
    sections: [{ index: 1, text: "Sie fanden einen Schlüssel im Aufzug." }],
    locale: "de-DE",
    exemptions: [],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "FAIL");
});

test("a declared exemption silences intentional divergence", () => {
  // A TTS respelling the channel has declared once, rather than fighting it on
  // every chapter for the life of the series.
  const outcome = checkAlignment(
    input("El ascensor se abrió a las tres y media.", "es-MX", ["elevator opened at"]),
  );
  assert.equal(alignmentPassed(outcome.issues), true);
  assert.equal(outcome.checkedFacts, 1, "the fact is still counted as considered");
});

test("a fact stated in another section counts as stated", () => {
  // Sections are localized independently and a translator may legitimately move
  // a clause across a paragraph boundary.
  const outcome = checkAlignment({
    facts: [fact()],
    sections: [
      { index: 1, text: "Todo estaba en silencio." },
      { index: 2, text: "El ascensor se abrió a las tres y diecisiete." },
    ],
    locale: "es-MX",
    exemptions: [],
  });
  assert.equal(alignmentPassed(outcome.issues), true);
});

test("remediation targets only the offending sections", () => {
  const outcome = checkAlignment({
    facts: [fact(), fact({ id: "evt-1-f2", label: "keys found", kind: "number", value: "17" })],
    sections: [
      { index: 1, text: "Todo estaba en silencio." },
      { index: 2, text: "El ascensor se abrió a las tres y media, y encontraron doce llaves." },
    ],
    locale: "es-MX",
    exemptions: [],
  });
  assert.deepEqual(sectionsToFix(outcome.issues), [2], "never re-localize the whole chapter");
});

test("an LLM finding is downgraded to WARN and never forces rework", () => {
  const deterministic: AlignmentIssue[] = [];
  const advisory: AlignmentIssue[] = [
    {
      severity: "FAIL",
      kind: "llm",
      canonAnchor: "evt-1-f1",
      label: "tone",
      canonValue: "ominous",
      localizedValue: "cheerful",
      sectionIndex: 1,
      description: "The mood feels different.",
    },
  ];
  const merged = mergeAdvisoryIssues(deterministic, advisory, new Set(["evt-1-f1"]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, "WARN");
  assert.equal(alignmentPassed(merged), true, "an advisory finding must never burn the retry budget");
});

test("an unanchored model finding is discarded", () => {
  const merged = mergeAdvisoryIssues(
    [],
    [
      {
        severity: "FAIL",
        kind: "llm",
        canonAnchor: "not-a-real-fact",
        label: "vibes",
        canonValue: "",
        localizedValue: "",
        sectionIndex: 1,
        description: "Something feels off.",
      },
    ],
    new Set(["evt-1-f1"]),
  );
  assert.deepEqual(merged, [], "an issue that cannot name a canon record cannot be acted on");
});

test("a fact the narration never states at all FAILS as absent", () => {
  const outcome = checkAlignment(input("Todo estaba en silencio.", "es-MX"));
  assert.equal(alignmentPassed(outcome.issues), false);
  assert.equal(outcome.issues[0].localizedValue, "(absent)");
});
