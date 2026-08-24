import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteCalendarEntry, loadCalendar, upsertCalendarEntry } from "../src/story-factory/calendar.ts";

test("calendar CRUD persists entries and rejects malformed dates", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-calendar-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const created = await upsertCalendarEntry("es-horror", { date: "2026-09-01", storyId: "story-001", plannedPublishAt: "2026-09-01T18:00:00.000Z", note: "launch" });
    assert.equal(created.entries.length, 1);
    assert.equal(created.entries[0].date, "2026-09-01");
    await assert.rejects(() => upsertCalendarEntry("es-horror", { date: "01-09-2026" }));
    const removed = await deleteCalendarEntry("es-horror", created.entries[0].id);
    assert.deepEqual(removed.entries, []);
    assert.deepEqual(await loadCalendar("es-horror"), { version: 1, entries: [] });
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
