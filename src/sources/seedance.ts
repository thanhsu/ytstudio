import { createHash } from "node:crypto";
import type { SourceSearchResult } from "./yt-dlp.ts";

export type SeedanceSearchResult = SourceSearchResult & {
  sourcePageUrl: string;
  description: string;
  categories: string[];
};

export type SeedanceSearchOptions = {
  limit: number;
  fetch?: SeedanceFetch;
  signal?: AbortSignal;
};

type SeedanceFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

type PromptRecord = {
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  authorName?: unknown;
  thumbnail?: unknown;
  videoUrl?: unknown;
  githubVideoUrl?: unknown;
  categories?: unknown;
};

const SEEDANCE_BASE_URL = "https://www.bestseedanceprompts.com/";

export async function searchSeedanceVideoAssets(
  query: string,
  options: SeedanceSearchOptions,
): Promise<SeedanceSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("A Seedance asset search query is required.");
  }
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(SEEDANCE_BASE_URL, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`BestSeedancePrompts returned HTTP ${response.status}.`);
  }

  const prompts = extractPromptRecords(await response.text());
  const needle = trimmed.toLowerCase();
  return prompts
    .map(promptToResult)
    .filter((result): result is SeedanceSearchResult => result !== null)
    .filter((result) => searchableText(result).includes(needle))
    .slice(0, clampLimit(options.limit));
}

function extractPromptRecords(html: string): PromptRecord[] {
  const records: PromptRecord[] = [];
  const seen = new Set<string>();

  for (const objectText of candidateJsonObjects(html)) {
    for (const candidate of parseCandidateObjects(objectText)) {
      collectPromptRecords(candidate, records, seen);
    }
  }

  return records;
}

function* candidateJsonObjects(html: string): Generator<string> {
  const markers = ['"videoUrl"'];
  const yielded = new Set<string>();
  const sources = [html, decodeReactStreamEscapes(html)];
  for (const source of sources) {
    for (const marker of markers) {
      let index = 0;
      while ((index = source.indexOf(marker, index)) >= 0) {
        const start = source.lastIndexOf("{", index);
        if (start < 0) {
          index += marker.length;
          continue;
        }
        const objectText = balancedObjectAt(source, start);
        if (objectText && !yielded.has(objectText)) {
          yielded.add(objectText);
          yield decodeHtmlEntities(objectText);
        }
        index += marker.length;
      }
    }
  }
}

function parseCandidateObjects(objectText: string): unknown[] {
  const values: unknown[] = [];
  const attempts = [objectText, decodeReactStreamEscapes(objectText)];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt)) continue;
    seen.add(attempt);
    try {
      values.push(JSON.parse(attempt));
    } catch {
      // React streams contain many non-JSON fragments; the next object may be usable.
    }
  }
  return values;
}

function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function collectPromptRecords(value: unknown, records: PromptRecord[], seen: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectPromptRecords(entry, records, seen);
    return;
  }

  const record = value as PromptRecord;
  const videoUrl = text(record.videoUrl) || text(record.githubVideoUrl);
  if (videoUrl) {
    const slug = text(record.slug) || stableAssetId(videoUrl);
    if (!seen.has(slug)) {
      seen.add(slug);
      records.push(record);
    }
  }

  for (const entry of Object.values(record)) {
    collectPromptRecords(entry, records, seen);
  }
}

function promptToResult(record: PromptRecord): SeedanceSearchResult | null {
  const videoUrl = text(record.videoUrl) || text(record.githubVideoUrl);
  if (!/^https?:\/\//i.test(videoUrl)) return null;
  const slug = text(record.slug) || stableAssetId(videoUrl);
  const title = text(record.title) || slug;
  return {
    platform: "SeedancePrompt",
    platformVideoId: slug,
    url: videoUrl,
    title,
    uploader: text(record.authorName) || "BestSeedancePrompts",
    durationSeconds: 0,
    viewCount: 0,
    thumbnailUrl: text(record.thumbnail),
    sourcePageUrl: new URL(`prompts/${slug}`, SEEDANCE_BASE_URL).toString(),
    description: text(record.description),
    categories: stringArray(record.categories),
  };
}

function stableAssetId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function searchableText(result: SeedanceSearchResult): string {
  return `${result.title} ${result.description} ${result.uploader} ${result.categories.join(" ")}`.toLowerCase();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampLimit(value: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 5;
  return Math.min(number, 25);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeReactStreamEscapes(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
