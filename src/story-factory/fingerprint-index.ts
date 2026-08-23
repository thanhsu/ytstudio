import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { channelStoryFactoryPath } from "./paths.ts";
import type { ChannelFingerprintIndex, StoryFingerprints } from "./types.ts";

/**
 * The channel-wide index of story fingerprints the duplicate check compares
 * against. One file per channel; entries are upserted by storyId as stories
 * progress (idea signature first, script signature after QA).
 */

const INDEX_FILE = "fingerprints.json";

export async function loadChannelFingerprintIndex(channelId: string): Promise<ChannelFingerprintIndex> {
  try {
    const raw = await readFile(channelStoryFactoryPath(channelId, INDEX_FILE), "utf8");
    return normalizeIndex(JSON.parse(raw));
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

export async function upsertStoryFingerprints(
  channelId: string,
  entry: StoryFingerprints,
): Promise<ChannelFingerprintIndex> {
  const index = await loadChannelFingerprintIndex(channelId);
  const existing = index.entries.findIndex((candidate) => candidate.storyId === entry.storyId);
  if (existing >= 0) {
    index.entries[existing] = { ...index.entries[existing], ...entry };
  } else {
    index.entries.push(entry);
  }
  const path = channelStoryFactoryPath(channelId, INDEX_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

function normalizeIndex(value: unknown): ChannelFingerprintIndex {
  const candidate = value && typeof value === "object" ? (value as Partial<ChannelFingerprintIndex>) : {};
  const entries: StoryFingerprints[] = [];
  if (Array.isArray(candidate.entries)) {
    for (const item of candidate.entries) {
      if (!item || typeof item !== "object") continue;
      const record = item as Partial<StoryFingerprints>;
      if (typeof record.storyId !== "string" || !record.storyId) continue;
      entries.push({
        version: 1,
        storyId: record.storyId,
        title: typeof record.title === "string" ? record.title : "",
        logline: typeof record.logline === "string" ? record.logline : "",
        ideaSignature: numberArray(record.ideaSignature),
        scriptSignature: record.scriptSignature ? numberArray(record.scriptSignature) : undefined,
      });
    }
  }
  return { version: 1, entries };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
