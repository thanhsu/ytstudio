import type { TtsNormalizedText } from "./types.ts";

/**
 * Prepares final narration text for the TTS provider. The stored script is
 * never altered: this stage reads the naturalized script and writes a separate
 * tts-normalized artifact, so pronunciation tweaks never leak back into the
 * text a human approved. Everything here is pure.
 *
 * Digits, dates, and times are deliberately left to the TTS engine: Google
 * voices read them in the voice's own locale, and a hand-rolled expander that
 * gets one Spanish ordinal wrong sounds worse than no expander at all.
 */

export type PronunciationRule = { original: string; pronunciation: string };

export function applyPronunciations(
  text: string,
  rules: PronunciationRule[],
): { text: string; applied: number } {
  let result = text;
  let applied = 0;
  for (const rule of rules) {
    const original = rule.original.trim();
    const pronunciation = rule.pronunciation.trim();
    if (!original || !pronunciation) {
      continue;
    }
    // Unicode-aware "whole word": not butted against another letter/number, so
    // "Sam" never rewrites the middle of "Samuel".
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(original)}(?![\\p{L}\\p{N}])`, "gu");
    const before = result;
    result = result.replace(pattern, pronunciation);
    if (result !== before) {
      applied += 1;
    }
  }
  return { text: result, applied };
}

type NormalizationStep = {
  id: string;
  locales?: string[];
  apply: (text: string) => string;
};

const STEPS: NormalizationStep[] = [
  {
    id: "strip-markdown",
    apply: (text) => text.replace(/[*_`#]+/g, ""),
  },
  {
    id: "straight-quotes",
    apply: (text) => text.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'"),
  },
  {
    // A spoken pause reads better as a comma than as a dash the engine skips.
    id: "dash-to-comma",
    apply: (text) => text.replace(/\s+[–—-]\s+/g, ", "),
  },
  {
    id: "ellipsis",
    apply: (text) => text.replace(/…/g, "..."),
  },
  {
    id: "percent-es",
    locales: ["es"],
    apply: (text) => text.replace(/(\d)\s*%/g, "$1 por ciento"),
  },
  {
    id: "ampersand-es",
    locales: ["es"],
    apply: (text) => text.replace(/\s&\s/g, " y "),
  },
  {
    id: "collapse-whitespace",
    apply: (text) =>
      text
        .replace(/[^\S\n]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
  },
];

export function normalizeForTts(text: string, locale: string): { text: string; normalizations: string[] } {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  let result = text;
  const normalizations: string[] = [];
  for (const step of STEPS) {
    if (step.locales && !step.locales.includes(language)) {
      continue;
    }
    const before = result;
    result = step.apply(result);
    if (result !== before) {
      normalizations.push(step.id);
    }
  }
  return { text: result, normalizations };
}

export function buildTtsNormalizedText(
  text: string,
  rules: PronunciationRule[],
  locale: string,
): TtsNormalizedText {
  const pronounced = applyPronunciations(text, rules);
  const normalized = normalizeForTts(pronounced.text, locale);
  return {
    version: 1,
    text: normalized.text,
    appliedPronunciations: pronounced.applied,
    normalizations: normalized.normalizations,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
