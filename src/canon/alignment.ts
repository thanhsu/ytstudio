import { normalizeText } from "../story-factory/fingerprint.ts";
import type { AlignmentIssue, CanonTypedFact } from "./types.ts";

/**
 * Canon alignment: does a localized narration still say what the canon says?
 *
 * The obvious design — have a model extract facts from the translation and diff
 * them against facts extracted from the canon prose — fails, and fails in the
 * worst direction. It fires on exactly the transformations localization is
 * INSTRUCTED to perform:
 *
 *   - pronunciation respelling for TTS, and languages that decline names
 *   - digits written as words (tts-normalize exists precisely for this)
 *   - locale date order: "March 4" becomes "4 de marzo"
 *
 * And detecting a real error like 03:17 -> 03:30 would mean reliably parsing
 * "las tres y diecisiete" or "drei Uhr siebzehn" out of a small local model.
 * Every false positive re-localizes a section that has nothing wrong with it,
 * fails again for the same reason, burns the whole escalation budget, and parks
 * the variant. At four locales times forty chapters that is not a rare event.
 *
 * So the polarity is inverted:
 *
 *   1. A DETERMINISTIC typed comparison is the only thing allowed to hard-FAIL.
 *      The canon side comes from typed CanonEvent facts recorded at canon time,
 *      never re-extracted from prose — comparing two lossy parses would double
 *      the error rate instead of measuring it.
 *   2. An LLM pass may only ever add WARNs. Advisory, never automatic rework.
 *   3. Declared exemptions silence intentional divergence once, per channel.
 *   4. Every issue must name the canon record it contradicts. An issue that
 *      cannot is dropped, because it cannot be acted on.
 */

// ---------------------------------------------------------------------------
// Number words, per language. Only what a narrator actually says aloud.
// ---------------------------------------------------------------------------

const UNITS: Record<string, Record<string, number>> = {
  en: {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
    midnight: 0, noon: 12,
  },
  es: {
    cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
    diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22,
    veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
    veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
    setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, mil: 1000,
    medianoche: 0, mediodia: 12,
  },
  fr: {
    zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
    neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
    vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100, mille: 1000,
    minuit: 0, midi: 12,
  },
  de: {
    null: 0, eins: 1, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7,
    acht: 8, neun: 9, zehn: 10, elf: 11, zwolf: 12, dreizehn: 13, vierzehn: 14, funfzehn: 15,
    sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, dreissig: 30,
    vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
    hundert: 100, tausend: 1000, mitternacht: 0, mittag: 12,
  },
  it: {
    zero: 0, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8,
    nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15,
    sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30,
    quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
    cento: 100, mille: 1000, mezzanotte: 0, mezzogiorno: 12,
  },
};

const MONTHS: Record<string, string[]> = {
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  fr: ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"],
  de: ["januar", "februar", "marz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  it: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
};

/** Strips accents so "diecisiete" matches "diecisiéte" and "März" matches "marz". */
function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function languageOf(locale: string): string {
  return (locale.split("-")[0] || "en").toLowerCase();
}

function wordsFor(locale: string): Record<string, number> {
  return UNITS[languageOf(locale)] ?? UNITS.en;
}

function tokens(text: string): string[] {
  return foldAccents(normalizeText(text)).split(" ").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const TENS = new Set([10, 20, 30, 40, 50, 60, 70, 80, 90]);

/**
 * Read one spoken number starting at `index`, composing a tens-plus-unit run.
 * French and Italian write seventeen as "dix-sept" / "diciassette"; the hyphen
 * is punctuation, so normalization splits the French form into two tokens and a
 * naive reader would take the minute of "trois heures dix-sept" to be ten.
 */
function readNumberRun(
  list: string[],
  index: number,
  words: Record<string, number>,
): { value: number; nextIndex: number } | null {
  const token = list[index];
  if (token === undefined) return null;
  const first = /^\d+$/.test(token) ? Number(token) : words[token];
  if (first === undefined) return null;

  const second = list[index + 1] !== undefined ? words[list[index + 1]] : undefined;
  if (TENS.has(first) && second !== undefined && second >= 1 && second <= 9) {
    return { value: first + second, nextIndex: index + 2 };
  }
  return { value: first, nextIndex: index + 1 };
}

/** Every number the text states, in digits or in words. */
export function extractNumbers(text: string, locale: string): number[] {
  const words = wordsFor(locale);
  const list = tokens(text);
  const found: number[] = [];
  let index = 0;
  while (index < list.length) {
    const run = readNumberRun(list, index, words);
    if (!run) {
      index += 1;
      continue;
    }
    found.push(run.value);
    index = run.nextIndex;
  }
  return found;
}

/**
 * Times as HH:MM. Handles digit forms (03:17, 3.17) and spoken forms in each
 * supported language, including the "y"/"et"/"e" and bare-adjacency joins
 * ("las tres y diecisiete", "drei Uhr siebzehn").
 */
export function extractTimes(text: string, locale: string): string[] {
  const results = new Set<string>();
  for (const match of text.matchAll(/\b(\d{1,2})\s*[:.]\s*(\d{2})\b/g)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) results.add(formatTime(hour, minute));
  }

  const words = wordsFor(locale);
  const list = tokens(text);
  // "three o'clock", "drei Uhr", "trois heures", "las tres horas".
  const HOUR_MARKERS = new Set(["oclock", "hours", "heures", "heure", "uhr", "horas", "hora", "ore", "ora"]);
  const JOINERS = new Set(["y", "et", "e", "and", "und"]);
  // Spanish and Italian normally omit the hour marker entirely — "a las tres y
  // diecisiete", "alle tre e diciassette" — so the article that introduces the
  // hour is what marks this as a time. Requiring it keeps "three and seventeen
  // survivors" from being read as 03:17.
  const TIME_PREFIXES = new Set(["las", "la", "alle", "alla", "le", "alas"]);
  // "de la madrugada", "in the morning", "del mattino" — what turns a bare
  // "las tres" into a time rather than "the three keys".
  const DAYPARTS = new Set([
    "madrugada", "manana", "tarde", "noche", "morning", "afternoon", "evening", "night",
    "am", "pm", "mattino", "mattina", "pomeriggio", "sera", "notte", "matin", "soir", "nuit",
    "morgens", "abends", "nachts", "fruh",
  ]);
  // Fractions a narrator speaks in the minute position. German is deliberately
  // absent: "halb drei" means half BEFORE three, and it precedes the hour, so
  // it can never land here and be misread as three-thirty.
  const MINUTE_WORDS: Record<string, number> = {
    media: 30, medias: 30, mezza: 30, demie: 30, half: 30,
    cuarto: 15, quarto: 15, quart: 15, quarter: 15,
  };

  for (let index = 0; index < list.length; index += 1) {
    const hour = words[list[index]];
    if (hour === undefined || hour > 23) continue;
    const introduced = index > 0 && TIME_PREFIXES.has(list[index - 1]);

    let cursor = index + 1;
    let sawMarker = false;
    let sawJoiner = false;
    while (cursor < list.length && (HOUR_MARKERS.has(list[cursor]) || JOINERS.has(list[cursor]))) {
      if (HOUR_MARKERS.has(list[cursor])) sawMarker = true;
      else sawJoiner = true;
      cursor += 1;
    }
    // A bare "las tres" counts only when a part of day follows close behind.
    const daypartNearby =
      introduced && list.slice(index + 1, index + 5).some((token) => DAYPARTS.has(token));
    if (!sawMarker && !(sawJoiner && introduced) && !daypartNearby) continue;

    const fraction = MINUTE_WORDS[list[cursor] ?? ""];
    const run = fraction === undefined ? readNumberRun(list, cursor, words) : null;
    const minute = fraction ?? (run && run.value <= 59 ? run.value : undefined);
    // "at three o'clock" with nothing after it is a real, complete time.
    results.add(formatTime(hour, minute ?? 0));
  }
  return [...results];
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Dates as MM-DD, which is what a story actually asserts; the year is compared
 * separately as a number when the canon states one. Handles "March 4",
 * "4 de marzo", "4 marzo", "4. März" — the same day in each locale's order.
 */
export function extractDates(text: string, locale: string): string[] {
  const months = MONTHS[languageOf(locale)] ?? MONTHS.en;
  const list = tokens(text);
  const results = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const monthIndex = months.indexOf(list[index]);
    if (monthIndex < 0) continue;
    // Day after the month ("March 4") or before it ("4 de marzo", "4. März"),
    // possibly separated by a preposition.
    const after = list[index + 1];
    const before = list[index - 1];
    const beforeSkippingParticle =
      before && ["de", "of", "del"].includes(before) ? list[index - 2] : before;
    const day = dayValue(after, locale) ?? dayValue(beforeSkippingParticle, locale);
    if (day !== undefined) {
      results.add(`${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return [...results];
}

function dayValue(token: string | undefined, locale: string): number | undefined {
  if (!token) return undefined;
  if (/^\d{1,2}$/.test(token)) {
    const value = Number(token);
    return value >= 1 && value <= 31 ? value : undefined;
  }
  const value = wordsFor(locale)[token];
  return value !== undefined && value >= 1 && value <= 31 ? value : undefined;
}

/** Whether a proper name still appears, tolerant of case and accents. */
export function mentionsName(text: string, name: string): boolean {
  const haystack = ` ${foldAccents(normalizeText(text))} `;
  // Any word of the name is enough: languages decline surnames and TTS
  // respellings alter them, so requiring the exact full string is a false-
  // positive factory. A wholly absent character still fails every word.
  return foldAccents(normalizeText(name))
    .split(" ")
    .filter((part) => part.length > 2)
    .some((part) => haystack.includes(` ${part}`));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type AlignmentInput = {
  /** Typed facts recorded at canon time — never re-parsed from canon prose. */
  facts: CanonTypedFact[];
  /** The localized narration, per section, as TTS will read it. */
  sections: Array<{ index: number; text: string }>;
  locale: string;
  /** Declared intentional divergence, matched case-insensitively as substrings. */
  exemptions: string[];
};

export type AlignmentOutcome = {
  issues: AlignmentIssue[];
  checkedFacts: number;
};

/**
 * A fact is satisfied if ANY section states it. Sections are localized
 * independently and a translator may legitimately move a clause across a
 * paragraph boundary, so per-section matching would fail on correct work.
 */
export function checkAlignment(input: AlignmentInput): AlignmentOutcome {
  const issues: AlignmentIssue[] = [];
  const exemptions = input.exemptions.map((entry) => foldAccents(normalizeText(entry))).filter(Boolean);
  const checkable = input.facts.filter((fact) => fact.value.trim().length > 0);

  for (const fact of checkable) {
    if (isExempt(fact, exemptions)) continue;
    const match = findFact(fact, input);
    if (match.found) continue;
    issues.push({
      severity: "FAIL",
      kind: fact.kind,
      canonAnchor: fact.id,
      label: fact.label,
      canonValue: fact.value,
      localizedValue: match.nearest ?? "(absent)",
      sectionIndex: match.sectionIndex,
      description:
        match.nearest === undefined
          ? `The canon states ${fact.label} = ${fact.value}, and the narration never states it.`
          : `The canon states ${fact.label} = ${fact.value}, but the narration states ${match.nearest}.`,
    });
  }

  return { issues, checkedFacts: checkable.length };
}

function isExempt(fact: CanonTypedFact, exemptions: string[]): boolean {
  if (exemptions.length === 0) return false;
  const haystack = foldAccents(normalizeText(`${fact.label} ${fact.value}`));
  return exemptions.some((entry) => haystack.includes(entry));
}

type FactMatch = { found: boolean; nearest?: string; sectionIndex: number };

function findFact(fact: CanonTypedFact, input: AlignmentInput): FactMatch {
  const observedBySection = input.sections.map((section) => ({
    index: section.index,
    values: observedValues(fact.kind, section.text, input.locale),
  }));
  for (const section of observedBySection) {
    if (section.values.includes(canonicalValue(fact))) {
      return { found: true, sectionIndex: section.index };
    }
  }
  // Report against the section that came closest to stating something of this
  // kind, so remediation re-localizes the right section rather than all of them.
  const candidate = observedBySection.find((section) => section.values.length > 0);
  return {
    found: false,
    nearest: candidate?.values[0],
    sectionIndex: candidate?.index ?? input.sections[0]?.index ?? 0,
  };
}

function canonicalValue(fact: CanonTypedFact): string {
  if (fact.kind === "number") return String(Number(fact.value));
  return fact.value.trim();
}

function observedValues(kind: CanonTypedFact["kind"], text: string, locale: string): string[] {
  if (kind === "time") return extractTimes(text, locale);
  if (kind === "date") return extractDates(text, locale);
  if (kind === "number") return extractNumbers(text, locale).map(String);
  return [];
}

/** Name facts are checked by presence, which is all that is meaningful. */
export function checkNames(input: AlignmentInput): AlignmentIssue[] {
  const joined = input.sections.map((section) => section.text).join("\n");
  const exemptions = input.exemptions.map((entry) => foldAccents(normalizeText(entry))).filter(Boolean);
  return input.facts
    .filter((fact) => fact.kind === "name" && fact.value.trim())
    .filter((fact) => !isExempt(fact, exemptions))
    .filter((fact) => !mentionsName(joined, fact.value))
    .map((fact) => ({
      severity: "FAIL" as const,
      kind: "name" as const,
      canonAnchor: fact.id,
      label: fact.label,
      canonValue: fact.value,
      localizedValue: "(absent)",
      sectionIndex: input.sections[0]?.index ?? 0,
      description: `The canon names ${fact.value} in this chapter, and the narration never mentions them.`,
    }));
}

/**
 * Fold an advisory model pass in. Anything the model reports is a WARN and any
 * finding that cannot name a canon record is discarded: an unanchored issue
 * cannot be acted on, and acting on it would mean rewriting correct prose.
 */
export function mergeAdvisoryIssues(
  deterministic: AlignmentIssue[],
  advisory: AlignmentIssue[],
  knownAnchors: Set<string>,
): AlignmentIssue[] {
  const anchored = advisory
    .filter((issue) => knownAnchors.has(issue.canonAnchor))
    .map((issue) => ({ ...issue, severity: "WARN" as const }));
  return [...deterministic, ...anchored];
}

/** Only a FAIL forces rework; WARNs are shown and otherwise ignored. */
export function alignmentPassed(issues: AlignmentIssue[]): boolean {
  return !issues.some((issue) => issue.severity === "FAIL");
}

/** Sections needing re-localization — never the whole chapter. */
export function sectionsToFix(issues: AlignmentIssue[]): number[] {
  return [...new Set(issues.filter((issue) => issue.severity === "FAIL").map((issue) => issue.sectionIndex))].sort(
    (left, right) => left - right,
  );
}
