import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { storyPath } from "./paths.ts";
import type { AiLogEntry } from "./types.ts";

/**
 * Append-only JSONL log of every AI call a story makes. One line per call so a
 * crashed write can at worst lose its own line, never corrupt earlier entries.
 */

const LOG_FILE = "ai-log.jsonl";

export async function appendAiLog(channelId: string, storyId: string, entry: AiLogEntry): Promise<void> {
  const path = storyPath(channelId, storyId, LOG_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readAiLog(channelId: string, storyId: string, limit = 200): Promise<AiLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(storyPath(channelId, storyId, LOG_FILE), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const entries: AiLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as AiLogEntry);
    } catch {
      // A torn line (crash mid-append) is dropped rather than poisoning the log view.
    }
  }
  return entries.slice(-limit);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
