/**
 * Embedding-free duplicate detection: normalized token shingles hashed into a
 * MinHash signature. Two stories that retell the same premise share shingles,
 * so their signatures agree in many positions; estimateJaccard turns that into
 * a 0..1 similarity the pipeline compares against a configurable threshold.
 * Everything here is pure and deterministic — the same text always produces the
 * same signature, which is what makes the stored channel index comparable.
 */

export const SIGNATURE_SIZE = 128;
const SHINGLE_SIZE = 5;

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return new Set();
  }
  if (tokens.length <= size) {
    return new Set([tokens.join(" ")]);
  }
  const result = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i += 1) {
    result.add(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

export function minhashSignature(text: string, size = SIGNATURE_SIZE): number[] {
  const grams = shingles(text);
  const signature = new Array<number>(size).fill(0x7fffffff);
  for (const gram of grams) {
    const base = fnv1a(gram);
    for (let seed = 0; seed < size; seed += 1) {
      const mixed = mix(base, seed);
      if (mixed < signature[seed]) {
        signature[seed] = mixed;
      }
    }
  }
  return signature;
}

/** Fraction of agreeing signature positions — an estimate of shingle-set Jaccard similarity. */
export function estimateJaccard(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) {
      matches += 1;
    }
  }
  return matches / a.length;
}

export type DuplicateCandidate = {
  storyId: string;
  signature: number[];
};

export type DuplicateCheckResult = {
  checkedAgainst: number;
  nearest: Array<{ storyId: string; similarity: number }>;
  flagged: boolean;
};

export function checkDuplicate(
  candidateText: string,
  existing: DuplicateCandidate[],
  threshold: number,
): DuplicateCheckResult {
  const signature = minhashSignature(candidateText);
  const scored = existing
    .map((entry) => ({ storyId: entry.storyId, similarity: estimateJaccard(signature, entry.signature) }))
    .sort((a, b) => b.similarity - a.similarity);
  const nearest = scored.slice(0, 3);
  return {
    checkedAgainst: existing.length,
    nearest,
    flagged: nearest.some((entry) => entry.similarity >= threshold),
  };
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic per-seed remix of a base hash (murmur-style finalizer). */
function mix(base: number, seed: number): number {
  let h = (base ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
