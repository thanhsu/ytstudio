// Pure query-expansion logic, kept out of the screen modules so it can be unit tested.
// The browser loads it from /search-queries.js; the tests import it directly.

const MAX_QUERIES = 6;

const EPISODE_PATTERN = /\s*(?:tập|tap|episode|ep|第)\s*0*(\d{1,4})\s*(?:集|话|話)?\s*$/i;

/**
 * The queries a search will actually run. An edited list always wins: once the
 * operator has written their own, generated guesses must not overwrite them.
 */
export function buildSourceSearchQueries(values, options = {}) {
  const edited = lines(values.expandedQueries);
  if (!options.ignoreEditedQueryList && edited.length) {
    return unique(edited).slice(0, MAX_QUERIES);
  }

  const query = String(values.query ?? "").trim();
  if (!query) return [];

  const expandable = values.platform === "bilibili" || values.platform === "douyin";
  if (!expandable || values.expandBilibiliQuery === false) return [query];

  return unique([query, ...expandSourceAliases(query, values.aliases)]).slice(0, MAX_QUERIES);
}

/**
 * Extra spellings of the SAME query. Everything here is derived from what the
 * operator typed — a title is never substituted for another one. An earlier
 * version appended one hardcoded show to every episode query, so searching for
 * anything else quietly returned that show instead.
 */
export function expandSourceAliases(query, aliases = []) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return [];

  const candidates = [];
  const haystack = trimmed.toLowerCase();
  const plainHaystack = stripDiacritics(haystack);

  // Operator-supplied spellings, matched against the query they belong to.
  for (const entry of Array.isArray(aliases) ? aliases : []) {
    const matches = (entry?.match ?? []).some((term) => {
      const needle = String(term).toLowerCase();
      return haystack.includes(needle) || plainHaystack.includes(stripDiacritics(needle));
    });
    if (matches) candidates.push(...(entry?.queries ?? []));
  }

  const { title, episode } = splitEpisode(trimmed);
  if (episode) {
    const base = title || trimmed;
    candidates.push(`${base} 第${episode}集`, `${base} EP${episode}`, `${base} ${episode.padStart(2, "0")}`);
  }

  // Chinese and Japanese sites index romanised titles far more often than
  // Vietnamese ones, so an unaccented spelling is worth trying alongside.
  const plain = stripDiacritics(trimmed);
  if (plain !== trimmed) candidates.push(plain);

  return unique(candidates.map((entry) => String(entry).trim()).filter(Boolean)).filter((entry) => entry !== trimmed);
}

/** Splits a trailing episode marker off a title, in the forms people type. */
export function splitEpisode(query) {
  const trimmed = String(query ?? "").trim();
  const match = EPISODE_PATTERN.exec(trimmed);
  if (!match) return { title: trimmed, episode: "" };
  return { title: trimmed.slice(0, match.index).trim(), episode: String(Number(match[1])) };
}

/** Latin diacritics only: CJK is left exactly as it is. */
export function stripDiacritics(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function lines(value) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function unique(values) {
  return [...new Set(values)];
}
