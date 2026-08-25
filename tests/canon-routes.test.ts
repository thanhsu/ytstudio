import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer, type RunningStudioServer } from "../src/server.ts";
import { saveCanonSeries } from "../src/canon/series.ts";
import { updateBible, updateCharacters } from "../src/canon/entities.ts";
import { appendEvents, buildEvent } from "../src/canon/events.ts";
import { upsertMemoryRecords } from "../src/canon/memory.ts";
import { saveStoryChannel, loadStoryChannel } from "../src/story-factory/channel.ts";
import { createStory, writeStageArtifact, saveStageRun, approveStoryStage } from "../src/story-factory/story-project.ts";
import { writeStudioConfig } from "./helpers.ts";
import type { CanonChapterArtifact } from "../src/canon/types.ts";

const SERIES = "missing-floor";
const CHANNEL = "horror-es";

const ENABLED_CONFIG = {
  storyFactory: {
    enabled: true,
    canon: { enabled: true },
    models: { planner: { baseUrl: "http://127.0.0.1:9", model: "", apiKeyEnv: "", paid: false } },
  },
};

async function withServer<T>(
  fn: (helpers: { running: RunningStudioServer; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-canon-routes-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      return await fn({ running, headers: { "content-type": "application/json", origin: running.url } });
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function seedSeries(): Promise<void> {
  await saveCanonSeries(SERIES, { title: "The Missing Floor", genre: "horror", status: "ACTIVE" });
  await saveStoryChannel(SERIES, { language: "en", locale: "en-US" });
  await updateBible(SERIES, (current) => ({
    ...current,
    premise: "A hotel whose third floor appears at night.",
    locations: [{ id: "the-elevator", name: "The elevator", description: "Brass doors." }],
  }));
  await updateCharacters(SERIES, (current) => ({
    ...current,
    characters: [
      {
        id: "maria",
        name: "María Torres",
        role: "night auditor",
        staticProfile: { birthYear: 1998, appearance: "", personality: [], background: [] },
        state: {
          currentLocation: "the-elevator",
          emotionalState: "",
          health: [],
          inventory: [],
          relationships: [],
          knowledge: [],
          secretsKnown: [],
          goals: [],
          knowledgeSummary: "",
          summarizedThroughChapter: 0,
        },
        deceasedSinceChapter: null,
      },
    ],
  }));
}

test("canon entities are readable and hand-editable through the series router", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();

    const read = await fetch(`${running.url}/api/series/${SERIES}/canon/bible`);
    assert.equal(read.status, 200);
    const bible = (await read.json()).bible;
    assert.equal(bible.premise, "A hotel whose third floor appears at night.");

    const edited = await fetch(`${running.url}/api/series/${SERIES}/canon/bible`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...bible, premise: "Edited by hand." }),
    });
    assert.equal(edited.status, 200);
    const saved = (await edited.json()).bible;
    assert.equal(saved.premise, "Edited by hand.");
    assert.equal(saved.revision, bible.revision + 1, "every canon write bumps the revision");
  });
});

test("a hand edit goes through the normalizer, so a malformed paste is repaired", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();

    const response = await fetch(`${running.url}/api/series/${SERIES}/canon/bible`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ premise: "Kept.", worldRules: "not an array", locations: [{ description: "no name" }] }),
    });
    assert.equal(response.status, 200);
    const bible = (await response.json()).bible;
    assert.equal(bible.premise, "Kept.");
    assert.deepEqual(bible.worldRules, [], "a wrong-typed field becomes its default rather than persisting");
    assert.deepEqual(bible.locations, [], "a location with no name is not a location");
  });
});

test("the event ledger is served through the reader that applies retractions", async () => {
  await withServer(async ({ running }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    const event = buildEvent(
      SERIES,
      1,
      0,
      {
        eventType: "CHARACTER_EVENT",
        summary: "The elevator opened.",
        characters: ["maria"],
        locations: ["the-elevator"],
        importance: 0.9,
        storyTime: "03:17",
        facts: [],
      },
      "2026-08-25T00:00:00.000Z",
    );
    await appendEvents(SERIES, [event]);

    const response = await fetch(`${running.url}/api/series/${SERIES}/canon/events`);
    const body = await response.json();
    assert.equal(body.events.length, 1);
    assert.equal(body.tornLines, 0, "torn lines are reported, never hidden");
  });
});

test("story memory is searchable with per-item scores exposed for debugging", async () => {
  await withServer(async ({ running }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    await upsertMemoryRecords(SERIES, [
      {
        id: "event:1",
        seriesId: SERIES,
        entityType: "event",
        entityId: "1",
        chapterNumber: 1,
        text: "Diego rode the elevator to the third floor.",
        importance: 0.9,
        metadata: { characters: ["diego"], locations: ["the-elevator"], threads: [] },
      },
      {
        id: "event:2",
        seriesId: SERIES,
        entityType: "event",
        entityId: "2",
        chapterNumber: 2,
        text: "The kitchen flooded.",
        importance: 0.2,
        metadata: { characters: [], locations: [], threads: [] },
      },
    ]);

    const response = await fetch(`${running.url}/api/series/${SERIES}/canon/memory?q=${encodeURIComponent("elevator third floor")}`);
    const body = await response.json();
    assert.equal(body.results[0].id, "event:1");
    // The debugger needs the score breakdown; it must never get raw vectors.
    assert.ok("keywordScore" in body.results[0] && "finalScore" in body.results[0] && "rank" in body.results[0]);
    assert.equal(body.results[0].vectorScore, null, "embeddings are disabled by default");
    assert.equal(JSON.stringify(body).includes("embedding"), false);
  });
});

test("designing a series refuses without paid confirmation and without a brief", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();

    const unconfirmed = await fetch(`${running.url}/api/series/${SERIES}/canon/design/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ brief: "A hotel." }),
    });
    assert.equal(unconfirmed.status, 409);
    assert.equal((await unconfirmed.json()).action, "confirm-paid-request");

    const noBrief = await fetch(`${running.url}/api/series/${SERIES}/canon/design/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmedPaidRequest: true }),
    });
    assert.equal(noBrief.status, 400);
    assert.equal((await noBrief.json()).code, "canon-brief-required");
  });
});

test("an unapproved chapter cannot be published into any locale", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    const channel = await loadStoryChannel(SERIES);
    await createStory(channel, { id: "chapter-001", title: "Chapter 1", kind: "canon" });
    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX", canonSeriesId: SERIES });

    const response = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/publish-variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targets: [{ channelId: CHANNEL }] }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "canon-chapter-not-approved");
  });
});

test("an approved chapter fans out to several locales at once, reporting partial failure", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    const channel = await loadStoryChannel(SERIES);
    await createStory(channel, { id: "chapter-001", title: "Chapter 1", kind: "canon" });
    const chapter: CanonChapterArtifact = {
      version: 1,
      seriesId: SERIES,
      chapterNumber: 1,
      arcId: "arc-1",
      title: "Three Seventeen",
      canonicalText: "The elevator opened at three seventeen.",
      summary: "The elevator opened.",
      wordCount: 6,
      canonTextHash: "hash-1",
      provenance: { provider: "test", model: "test", promptVersion: "v1", generatedAt: "2026-08-25T00:00:00.000Z" },
    };
    await writeStageArtifact(SERIES, "chapter-001", "canon-write", chapter);
    // The approval anchors to a COMPLETED stage, not merely to an artifact on
    // disk, so the stage run has to be marked done before it can be approved.
    await saveStageRun(SERIES, "chapter-001", "canon-write", { status: "done" });
    await approveStoryStage(SERIES, "chapter-001", "canon", "reviewed");

    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX", canonSeriesId: SERIES });
    await saveStoryChannel("horror-fr", { language: "fr", locale: "fr-FR", canonSeriesId: SERIES });

    const response = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/publish-variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targets: [{ channelId: CHANNEL }, { channelId: "horror-fr" }, { channelId: "not-a-project" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.created.length, 2, "one canon chapter, two locales, from one call");
    assert.deepEqual(body.created.map((entry: { locale: string }) => entry.locale).sort(), ["es-MX", "fr-FR"]);
    // A fan-out reports what failed rather than losing the successes.
    assert.equal(body.failed.length, 1);

    const variants = await fetch(`${running.url}/api/series/${SERIES}/canon/variants`);
    const listed = await variants.json();
    assert.equal(listed.variants.length, 2);
    assert.ok(listed.variants.every((entry: { state: string }) => entry.state === "fresh"));
  });
});

test("locking and unlocking a chapter reports affected variants without regenerating them", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    const channel = await loadStoryChannel(SERIES);
    await createStory(channel, { id: "chapter-001", title: "Chapter 1", kind: "canon" });

    const locked = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/lock`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(locked.status, 200);
    assert.ok((await locked.json()).chapter.lockedAt);

    const refused = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/unlock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "" }),
    });
    assert.equal(refused.status, 400, "unlocking a published chapter needs a stated reason");

    const unlocked = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/unlock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "fixing a name" }),
    });
    assert.equal(unlocked.status, 200);
    const body = await unlocked.json();
    assert.equal(body.chapter.lockedAt, undefined);
    assert.ok(Array.isArray(body.affectedVariants), "impact is reported, never acted on automatically");
  });
});

test("the canon approval is a first-class gate on the existing approve route", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedSeries();
    const channel = await loadStoryChannel(SERIES);
    await createStory(channel, { id: "chapter-001", title: "Chapter 1", kind: "canon" });

    // No chapter artifact yet, so there is nothing to anchor an approval to.
    const premature = await fetch(`${running.url}/api/series/${SERIES}/stories/chapter-001/approve/canon`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "looks fine" }),
    });
    assert.equal(premature.status, 409);
    assert.equal((await premature.json()).code, "approval-anchor-missing");
  });
});

test("a project that is not a canon series says so instead of inventing one", async () => {
  await withServer(async ({ running }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const response = await fetch(`${running.url}/api/series/plain-channel/canon/series`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "canon-series-missing");
  });
});
