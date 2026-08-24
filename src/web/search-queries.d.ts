// Hand-written because the module ships as plain JavaScript: the browser loads
// it directly from /search-queries.js, so it cannot be a .ts file.

export type SourceQueryAlias = { match: string[]; queries: string[] };

export type SourceQueryValues = {
  query?: string;
  platform?: string;
  expandedQueries?: string;
  expandBilibiliQuery?: boolean;
  aliases?: SourceQueryAlias[];
};

export function buildSourceSearchQueries(
  values: SourceQueryValues,
  options?: { ignoreEditedQueryList?: boolean },
): string[];

export function expandSourceAliases(query: string, aliases?: SourceQueryAlias[]): string[];

export function splitEpisode(query: string): { title: string; episode: string };

export function stripDiacritics(value: string): string;

export function lines(value: unknown): string[];

export function unique<T>(values: Iterable<T>): T[];
