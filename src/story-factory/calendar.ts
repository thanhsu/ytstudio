import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeJson } from "../fs.ts";
import { mkdir } from "node:fs/promises";
import { channelStoryFactoryPath } from "./paths.ts";

export type ChannelCalendar = {
  version: 1;
  entries: Array<{ id: string; date: string; storyId: string | null; plannedPublishAt: string | null; note: string }>;
};

const FILE = "calendar.json";

export async function loadCalendar(channelId: string): Promise<ChannelCalendar> {
  try {
    const value = JSON.parse(await readFile(channelStoryFactoryPath(channelId, FILE), "utf8")) as Partial<ChannelCalendar>;
    return normalize(value);
  } catch (error: unknown) {
    if (isNotFound(error)) return { version: 1, entries: [] };
    throw error;
  }
}

export async function upsertCalendarEntry(channelId: string, input: { id?: string; date: string; storyId?: string | null; plannedPublishAt?: string | null; note?: string }): Promise<ChannelCalendar> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Calendar date must match YYYY-MM-DD.");
  const calendar = await loadCalendar(channelId);
  const id = input.id?.trim() || randomUUID();
  const entry = { id, date: input.date, storyId: input.storyId ?? null, plannedPublishAt: input.plannedPublishAt ?? null, note: input.note?.trim() ?? "" };
  const index = calendar.entries.findIndex((candidate) => candidate.id === id);
  if (index >= 0) calendar.entries[index] = entry;
  else calendar.entries.push(entry);
  await save(channelId, calendar);
  return calendar;
}

export async function deleteCalendarEntry(channelId: string, id: string): Promise<ChannelCalendar> {
  const calendar = await loadCalendar(channelId);
  calendar.entries = calendar.entries.filter((entry) => entry.id !== id);
  await save(channelId, calendar);
  return calendar;
}

function normalize(value: Partial<ChannelCalendar>): ChannelCalendar {
  const entries = Array.isArray(value.entries) ? value.entries.filter((entry): entry is ChannelCalendar["entries"][number] => Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date))) : [];
  return { version: 1, entries: entries.map((entry) => ({ id: entry.id, date: entry.date, storyId: typeof entry.storyId === "string" ? entry.storyId : null, plannedPublishAt: typeof entry.plannedPublishAt === "string" ? entry.plannedPublishAt : null, note: typeof entry.note === "string" ? entry.note : "" })) };
}

async function save(channelId: string, calendar: ChannelCalendar): Promise<void> {
  await mkdir(channelStoryFactoryPath(channelId), { recursive: true });
  await writeJson(channelStoryFactoryPath(channelId, FILE), calendar);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
