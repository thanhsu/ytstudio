import { extname } from "node:path";
import { parseSrt } from "./srt.ts";

export type TranscriptSegment = {
  episode: number;
  cueId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  language: string;
  sourceFile: string;
  confidence?: number;
};

export type ParseSubtitleInput = {
  episode: number;
  sourceFile: string;
  language: string;
  content: string;
};

type RawCue = {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
};

export function parseSubtitleToTranscript(input: ParseSubtitleInput): TranscriptSegment[] {
  const cues = parseRawCues(input);
  return cues.map((cue, index) => ({
    episode: input.episode,
    cueId: `${episodePrefix(input.episode)}-CUE${String(index + 1).padStart(4, "0")}`,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: normalizeText(cue.text),
    speaker: cue.speaker,
    language: input.language,
    sourceFile: input.sourceFile,
  }));
}

function parseRawCues(input: ParseSubtitleInput): RawCue[] {
  const extension = extname(input.sourceFile).toLowerCase();
  if (extension === ".vtt" || input.content.trimStart().startsWith("WEBVTT")) {
    return parseVtt(input.content);
  }
  if (extension === ".ass" || extension === ".ssa" || /\[Events\][\s\S]*Dialogue:/i.test(input.content)) {
    return parseAss(input.content);
  }
  return parseSrt(input.content).map((cue) => ({
    startMs: srtTimestampToMs(cue.start),
    endMs: srtTimestampToMs(cue.end),
    text: cue.text,
  }));
}

function parseVtt(content: string): RawCue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block && block !== "WEBVTT" && !block.startsWith("NOTE"));

  const cues: RawCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;
    const match = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(
      lines[timingIndex].trim(),
    );
    if (!match) continue;
    cues.push({
      startMs: webTimestampToMs(match[1]),
      endMs: webTimestampToMs(match[2]),
      text: lines.slice(timingIndex + 1).join("\n"),
    });
  }
  return cues;
}

function parseAss(content: string): RawCue[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inEvents = false;
  let format: string[] = [];
  const cues: RawCue[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[Events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (inEvents && line.startsWith("[") && !/^\[Events\]$/i.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      format = line
        .replace(/^Format:/i, "")
        .split(",")
        .map((item) => item.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    const values = splitAssDialogue(line.replace(/^Dialogue:/i, "").trim(), format.length || 10);
    const startIndex = format.indexOf("start");
    const endIndex = format.indexOf("end");
    const textIndex = format.indexOf("text");
    const nameIndex = format.indexOf("name");
    if (startIndex === -1 || endIndex === -1 || textIndex === -1) continue;
    cues.push({
      startMs: assTimestampToMs(values[startIndex]),
      endMs: assTimestampToMs(values[endIndex]),
      text: values.slice(textIndex).join(","),
      speaker: nameIndex === -1 || !values[nameIndex].trim() ? undefined : values[nameIndex].trim(),
    });
  }
  return cues;
}

function splitAssDialogue(value: string, fieldCount: number): string[] {
  const values: string[] = [];
  let cursor = "";
  for (const char of value) {
    if (char === "," && values.length < fieldCount - 1) {
      values.push(cursor);
      cursor = "";
    } else {
      cursor += char;
    }
  }
  values.push(cursor);
  return values;
}

function srtTimestampToMs(timestamp: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(timestamp);
  if (!match) throw new Error(`Invalid SRT timestamp: ${timestamp}`);
  const [, hours, minutes, seconds, millis] = match.map(Number) as [number, number, number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function webTimestampToMs(timestamp: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(timestamp);
  if (!match) throw new Error(`Invalid VTT timestamp: ${timestamp}`);
  const [, hours, minutes, seconds, millis] = match.map(Number) as [number, number, number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function assTimestampToMs(timestamp: string): number {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(timestamp.trim());
  if (!match) throw new Error(`Invalid ASS timestamp: ${timestamp}`);
  const [, hours, minutes, seconds, centiseconds] = match.map(Number) as [number, number, number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + centiseconds * 10;
}

function normalizeText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function episodePrefix(episode: number): string {
  return `EP${String(episode).padStart(2, "0")}`;
}
