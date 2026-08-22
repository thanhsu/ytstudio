import { sha256 } from "./project-state.ts";

export type NarrationDocument = {
  text: string;
  wordCount: number;
  hash: string;
};

const SKIPPED_LINE_PREFIXES = [
  "format:",
  "target audience:",
  "language:",
  "runtime target:",
  "show:",
  "topic:",
];

/**
 * The `##` headings a generated script must use for its spoken body. The prompt
 * asks for exactly these and the response validator rejects a script that yields
 * no narration under them, so all three stay in step from this one declaration.
 */
export const SPOKEN_SECTION_HEADINGS = ["Hook", "Context", "Main Points", "Closing"] as const;

const SPOKEN_SECTIONS = new Set([
  ...SPOKEN_SECTION_HEADINGS.map((heading) => heading.toLowerCase()),
  "review",
]);

export function extractNarration(markdown: string): NarrationDocument {
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let inSpokenSection = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    const heading = parseHeading(line);

    if (heading.level === 1) {
      flushParagraph(paragraphs, currentParagraph);
      currentParagraph = [];
      inSpokenSection = false;
      continue;
    }

    if (heading.level === 2) {
      flushParagraph(paragraphs, currentParagraph);
      currentParagraph = [];
      inSpokenSection = SPOKEN_SECTIONS.has(heading.text.toLowerCase());
      continue;
    }

    if (!line) {
      flushParagraph(paragraphs, currentParagraph);
      currentParagraph = [];
      continue;
    }

    if (!inSpokenSection || shouldSkipLine(line)) {
      continue;
    }

    currentParagraph.push(stripOrderedListMarker(line));
  }

  flushParagraph(paragraphs, currentParagraph);

  const text = paragraphs.join("\n\n");
  return {
    text,
    wordCount: countWords(text),
    hash: sha256(text),
  };
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function parseHeading(line: string): { level: number; text: string } {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match) {
    return { level: 0, text: "" };
  }
  return { level: match[1].length, text: match[2].trim() };
}

function shouldSkipLine(line: string): boolean {
  const lower = line.toLowerCase();
  return SKIPPED_LINE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function stripOrderedListMarker(line: string): string {
  return line.replace(/^\d+\.\s+/, "");
}

function flushParagraph(paragraphs: string[], paragraph: string[]): void {
  const text = paragraph.join(" ").trim();
  if (text) {
    paragraphs.push(text);
  }
}

function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}'-]+/gu);
  return words?.length ?? 0;
}
