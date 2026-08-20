export type SrtCue = {
  index: number;
  start: string;
  end: string;
  text: string;
};

export type SrtValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

const TIMESTAMP_PATTERN = /^\d{2}:\d{2}:\d{2},\d{3}$/;
const TIMING_PATTERN = /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})(?:\s+.*)?$/;
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;

export function parseSrt(input: string): SrtCue[] {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  return normalized.split(/\n{2,}/).map((block, blockIndex) => parseBlock(block, blockIndex));
}

export function stringifySrt(cues: SrtCue[]): string {
  return `${cues
    .map((cue) => `${cue.index}\n${cue.start} --> ${cue.end}\n${cue.text.trimEnd()}`)
    .join("\n\n")}\n`;
}

export function validateSrt(cues: SrtCue[], options: { requireNoChinese?: boolean } = {}): SrtValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  cues.forEach((cue, position) => {
    const expected = position + 1;
    if (cue.index !== expected) {
      errors.push(`Cue ${expected} has index ${cue.index}.`);
    }
    if (!TIMESTAMP_PATTERN.test(cue.start) || !TIMESTAMP_PATTERN.test(cue.end)) {
      errors.push(`Cue ${cue.index} has an invalid timestamp.`);
    }
    if (toMillis(cue.end) <= toMillis(cue.start)) {
      errors.push(`Cue ${cue.index} ends before it starts.`);
    }
    if (!cue.text.trim()) {
      warnings.push(`Cue ${cue.index} is empty.`);
    }
    if (options.requireNoChinese && CJK_PATTERN.test(cue.text)) {
      errors.push(`Cue ${cue.index} still contains Chinese characters.`);
    }
    const durationSeconds = (toMillis(cue.end) - toMillis(cue.start)) / 1000;
    const longestLine = cue.text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
    if (durationSeconds < 1 && longestLine > 28) {
      warnings.push(`Cue ${cue.index} is long for a sub-second block.`);
    }
    if (longestLine > 48) {
      warnings.push(`Cue ${cue.index} has a long subtitle line.`);
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

export function compareSrtStructure(source: SrtCue[], translated: SrtCue[]): SrtValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (source.length !== translated.length) {
    errors.push(`Cue count changed from ${source.length} to ${translated.length}.`);
  }

  const count = Math.min(source.length, translated.length);
  for (let index = 0; index < count; index += 1) {
    const original = source[index];
    const candidate = translated[index];
    if (original.index !== candidate.index) {
      errors.push(`Cue ${index + 1} index changed from ${original.index} to ${candidate.index}.`);
    }
    if (original.start !== candidate.start || original.end !== candidate.end) {
      errors.push(`Cue ${original.index} timestamp changed.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function parseBlock(block: string, blockIndex: number): SrtCue {
  const lines = block.split("\n");
  const index = Number(lines[0]?.trim());
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`Invalid SRT cue index at block ${blockIndex + 1}.`);
  }

  const timing = TIMING_PATTERN.exec(lines[1]?.trim() ?? "");
  if (!timing) {
    throw new Error(`Invalid SRT timing at cue ${index}.`);
  }

  return {
    index,
    start: timing[1],
    end: timing[2],
    text: lines.slice(2).join("\n").trimEnd(),
  };
}

function toMillis(timestamp: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(timestamp);
  if (!match) {
    return Number.NaN;
  }
  const [, hours, minutes, seconds, millis] = match.map(Number) as [number, number, number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}
