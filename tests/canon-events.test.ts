import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendEvents,
  buildEvent,
  filterEvents,
  loadEvents,
  retractEvents,
  typedFactsForChapter,
} from "../src/canon/events.ts";
import { canonPath, readJsonl, writeJsonAtomic, withSeriesLock } from "../src/canon/store.ts";
import type { NewEventDelta } from "../src/canon/types.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-canon-events-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

const SERIES = "missing-floor";

function delta(overrides: Partial<NewEventDelta> = {}): NewEventDelta {
  return {
    eventType: "CHARACTER_EVENT",
    summary: "Diego enters the elevator and disappears.",
    characters: ["diego"],
    locations: ["hotel-elevator"],
    importance: 1,
    storyTime: "03:31",
    facts: [{ kind: "time", label: "elevator opened at", value: "03:17" }],
    ...overrides,
  };
}

test("event ids are content-addressed, so replaying an interrupted extraction appends nothing new", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const first = buildEvent(SERIES, 6, 0, delta(), now);

    const initial = await appendEvents(SERIES, [first]);
    assert.deepEqual(initial.appended, [first.id]);
    assert.deepEqual(initial.skipped, []);

    // A crash between the ledger append and the stage's `done` write makes the
    // pipeline re-run the whole extraction. Rebuilding the same delta must
    // produce the same id, and appending it must be a no-op.
    const replayed = buildEvent(SERIES, 6, 0, delta(), "2026-08-25T09:99:00.000Z");
    assert.equal(replayed.id, first.id, "the id must not depend on the timestamp");

    const second = await appendEvents(SERIES, [replayed]);
    assert.deepEqual(second.appended, []);
    assert.deepEqual(second.skipped, [first.id]);

    const loaded = await loadEvents(SERIES);
    assert.equal(loaded.events.length, 1, "the chapter's event must not be duplicated");
  });
});

test("a different chapter or delta index is a different event", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const base = buildEvent(SERIES, 6, 0, delta(), now);
    const laterChapter = buildEvent(SERIES, 7, 0, delta(), now);
    const laterIndex = buildEvent(SERIES, 6, 1, delta(), now);
    assert.notEqual(base.id, laterChapter.id);
    assert.notEqual(base.id, laterIndex.id);

    await appendEvents(SERIES, [base, laterChapter, laterIndex]);
    assert.equal((await loadEvents(SERIES)).events.length, 3);
  });
});

test("a retracted event is invisible through the reader but still on disk", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const kept = buildEvent(SERIES, 6, 0, delta(), now);
    const withdrawn = buildEvent(SERIES, 6, 1, delta({ summary: "Diego was never in the lift." }), now);
    await appendEvents(SERIES, [kept, withdrawn]);

    const count = await retractEvents(SERIES, [withdrawn.id], "chapter 6 rewritten", 6);
    assert.equal(count, 1);

    const loaded = await loadEvents(SERIES);
    assert.deepEqual(
      loaded.events.map((event) => event.id),
      [kept.id],
      "every reader goes through loadEvents, so a withdrawn event can never reach a prompt",
    );
    assert.deepEqual(loaded.retracted, [withdrawn.id]);

    // The audit trail survives: the raw ledger still holds both events plus the
    // tombstone. Retraction hides history, it does not destroy it.
    const raw = await readJsonl<{ type: string }>(canonPath(SERIES, "events.jsonl"));
    assert.equal(raw.records.length, 3);
    assert.equal(raw.records.filter((record) => record.type === "event").length, 2);
    assert.equal(raw.records.filter((record) => record.type === "retract").length, 1);
  });
});

test("re-applying a chapter retracts its old contributions before appending new ones", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const original = buildEvent(SERIES, 6, 0, delta({ storyTime: "03:31" }), now);
    await appendEvents(SERIES, [original]);

    // The chapter is rewritten: the old event is withdrawn, a new one appended.
    await retractEvents(SERIES, [original.id], "chapter 6 regenerated", 6);
    const rewritten = buildEvent(SERIES, 6, 0, delta({ storyTime: "04:02" }), now);
    await appendEvents(SERIES, [rewritten]);

    const loaded = await loadEvents(SERIES);
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.events[0].storyTime, "04:02");
  });
});

test("torn lines are counted, never silently swallowed", async () => {
  await withTempCwd(async () => {
    const event = buildEvent(SERIES, 1, 0, delta(), "2026-08-25T00:00:00.000Z");
    await appendEvents(SERIES, [event]);
    // Simulate an interleaved write that produced a partial line.
    await appendFile(canonPath(SERIES, "events.jsonl"), '{"type":"event","id":"tor\n', "utf8");

    const loaded = await loadEvents(SERIES);
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.tornLines, 1, "lost story history must be reportable, not invisible");
  });
});

test("typed facts are read from the canon record, which is what alignment compares against", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const event = buildEvent(SERIES, 6, 0, delta(), now);
    await appendEvents(SERIES, [event]);

    const facts = typedFactsForChapter((await loadEvents(SERIES)).events, 6);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, "time");
    assert.equal(facts[0].value, "03:17");
    assert.ok(facts[0].id.startsWith(event.id), "a fact must be traceable to its anchoring event");
  });
});

test("filterEvents narrows by character, chapter window, and importance", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const diego = buildEvent(SERIES, 2, 0, delta({ characters: ["diego"], importance: 0.9 }), now);
    const maria = buildEvent(SERIES, 5, 0, delta({ characters: ["maria"], importance: 0.2 }), now);
    await appendEvents(SERIES, [diego, maria]);
    const events = (await loadEvents(SERIES)).events;

    assert.deepEqual(filterEvents(events, { characters: ["diego"] }).map((e) => e.id), [diego.id]);
    assert.deepEqual(filterEvents(events, { fromChapter: 3 }).map((e) => e.id), [maria.id]);
    assert.deepEqual(filterEvents(events, { minImportance: 0.5 }).map((e) => e.id), [diego.id]);
  });
});

test("the series lock serializes read-modify-write, so concurrent appends cannot lose one", async () => {
  await withTempCwd(async () => {
    const now = "2026-08-25T00:00:00.000Z";
    const events = Array.from({ length: 8 }, (_unused, index) =>
      buildEvent(SERIES, 1, index, delta({ summary: `event ${index}` }), now),
    );
    // Fire them all at once; each append reads the whole ledger first, so
    // without the lock the later writers would read a stale "already present"
    // set and the counts would disagree.
    await Promise.all(events.map((event) => appendEvents(SERIES, [event])));
    assert.equal((await loadEvents(SERIES)).events.length, 8);
  });
});

test("writeJsonAtomic never leaves a partial file where a reader can see it", async () => {
  await withTempCwd(async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = canonPath(SERIES, "bible.json");
    await writeJsonAtomic(path, { version: 1, premise: "first" });
    await writeJsonAtomic(path, { version: 1, premise: "second" });

    // The overwrite is all-or-nothing: the file parses, and holds the new value.
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, premise: "second" });
    // No stray temp file survives a successful write.
    const entries = await readdir(canonPath(SERIES));
    assert.deepEqual(entries.filter((name) => name.includes(".tmp-")), []);
  });
});

test("withSeriesLock runs queued operations in order and survives a failure", async () => {
  await withTempCwd(async () => {
    const order: string[] = [];
    const failing = withSeriesLock(SERIES, async () => {
      order.push("first");
      throw new Error("boom");
    });
    const following = withSeriesLock(SERIES, async () => {
      order.push("second");
      return "ok";
    });
    await assert.rejects(() => failing, /boom/);
    assert.equal(await following, "ok", "one failed mutation must not poison the queue");
    assert.deepEqual(order, ["first", "second"]);
  });
});
