import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStoryChannel } from "../src/story-factory/channel.ts";
import {
  createStory,
  loadStory,
  readStageArtifact,
  saveStageRun,
  writeStageArtifact,
} from "../src/story-factory/story-project.ts";
import { assembleScriptArtifact, writeSectionFile } from "../src/story-factory/stages/sections.ts";
import { editSectionText, listSections, readSection } from "../src/story-factory/section-edit.ts";
import { createStudioServer, startStudioServer, type RunningStudioServer } from "../src/server.ts";
import { writeStudioConfig } from "./helpers.ts";
import type { ScriptArtifact, SectionArtifact } from "../src/story-factory/types.ts";

const CHANNEL_ID = "es-horror";
const STORY_ID = "story-001";

function makeSection(index: number, title: string, text: string): SectionArtifact {
  return {
    version: 1,
    index,
    title,
    text,
    wordCount: text.trim().split(/\s+/).length,
    bibleUpdates: {},
    provenance: { provider: "p", model: "m", promptVersion: "v", generatedAt: "2026-08-24T00:00:00.000Z" },
  };
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-section-edit-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

/** Seeds a story with two written sections plus the script.json they assemble to. */
async function seedStory(): Promise<void> {
  const channel = await loadStoryChannel(CHANNEL_ID);
  await createStory(channel, { id: STORY_ID, title: "La habitación 307" });
  const section1 = makeSection(1, "El comienzo", "Una noche mas en el hospital vacio.");
  const section2 = makeSection(2, "El pasillo", "El pasillo se extendia sin final a la vista.");
  await writeSectionFile(CHANNEL_ID, STORY_ID, section1);
  await writeSectionFile(CHANNEL_ID, STORY_ID, section2);
  const script = assembleScriptArtifact([section1, section2]);
  await writeStageArtifact(CHANNEL_ID, STORY_ID, "sections", script);
  await saveStageRun(CHANNEL_ID, STORY_ID, "sections", { status: "done" });
  for (const stage of ["continuity-qa", "naturalize", "scenes", "metadata"] as const) {
    await saveStageRun(CHANNEL_ID, STORY_ID, stage, { status: "done" });
  }
}

test("listSections reads every section named in script.json, in order", async () => {
  await withTempCwd(async () => {
    await seedStory();
    const sections = await listSections(CHANNEL_ID, STORY_ID);
    assert.deepEqual(
      sections.map((section) => section.index),
      [1, 2],
    );
    assert.equal(sections[0].title, "El comienzo");
  });
});

test("listSections is empty before the sections stage has produced script.json", async () => {
  await withTempCwd(async () => {
    const channel = await loadStoryChannel(CHANNEL_ID);
    await createStory(channel, { id: STORY_ID, title: "t" });
    assert.deepEqual(await listSections(CHANNEL_ID, STORY_ID), []);
  });
});

test("readSection returns the section, or null for a missing index", async () => {
  await withTempCwd(async () => {
    await seedStory();
    const section = await readSection(CHANNEL_ID, STORY_ID, 2);
    assert.equal(section?.title, "El pasillo");
    assert.equal(await readSection(CHANNEL_ID, STORY_ID, 99), null);
  });
});

test("editSectionText rewrites the section, reassembles script.json honestly, and cascades staleness", async () => {
  await withTempCwd(async () => {
    await seedStory();
    const before = await readStageArtifact<ScriptArtifact>(CHANNEL_ID, STORY_ID, "sections");

    const newText = "Una noche distinta en el hospital, todo cambio de repente.";
    const { section, invalidated } = await editSectionText(CHANNEL_ID, STORY_ID, 1, newText);

    assert.equal(section.text, newText);
    assert.equal(section.wordCount, newText.trim().split(/\s+/).length);

    const stored = await readSection(CHANNEL_ID, STORY_ID, 1);
    assert.equal(stored?.text, newText);

    const after = await readStageArtifact<ScriptArtifact>(CHANNEL_ID, STORY_ID, "sections");
    assert.notEqual(after?.sourceHash, before?.sourceHash);
    assert.ok(after?.fullText.includes(newText));
    assert.notEqual(after?.sections[0].textHash, before?.sections[0].textHash);
    // The untouched section's own hash does not move.
    assert.equal(after?.sections[1].textHash, before?.sections[1].textHash);

    // The sections artifact's own hash moved, so the stage run's hash must too.
    const story = await loadStory(CHANNEL_ID, STORY_ID);
    assert.notEqual(story.stages.sections?.artifactHash, undefined);

    assert.ok(invalidated.includes("continuity-qa"));
    assert.ok(invalidated.includes("naturalize"));
    assert.ok(invalidated.includes("scenes"));
    assert.ok(invalidated.includes("metadata"));
    assert.equal(story.stages["continuity-qa"]?.status, "stale");
    assert.equal(story.stages.naturalize?.status, "stale");
    assert.equal(story.stages.scenes?.status, "stale");
    assert.equal(story.stages.metadata?.status, "stale");
  });
});

test("editSectionText rejects empty or whitespace-only text", async () => {
  await withTempCwd(async () => {
    await seedStory();
    await assert.rejects(() => editSectionText(CHANNEL_ID, STORY_ID, 1, "   "), /required/i);
    await assert.rejects(() => editSectionText(CHANNEL_ID, STORY_ID, 1, ""), /required/i);
  });
});

test("editSectionText rejects an index that has no section on disk", async () => {
  await withTempCwd(async () => {
    await seedStory();
    await assert.rejects(() => editSectionText(CHANNEL_ID, STORY_ID, 99, "algo"), /not found/i);
  });
});

const ENABLED_CONFIG = {
  storyFactory: {
    enabled: true,
    models: {
      planner: { baseUrl: "http://127.0.0.1:9", model: "", apiKeyEnv: "", paid: false },
    },
  },
};

async function withServer<T>(
  fn: (helpers: { running: RunningStudioServer; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-section-edit-server-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      return await fn({
        running,
        headers: { "content-type": "application/json", origin: running.url },
      });
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("GET/PUT sections over HTTP edit a section with honest invalidation", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    await seedStory();

    const list = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections`);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.deepEqual(
      listBody.sections.map((s: { index: number }) => s.index),
      [1, 2],
    );

    const get = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections/1`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).section.title, "El comienzo");

    const missing = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections/404`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "section-not-found");

    const put = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections/1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "Texto editado a mano para la seccion uno." }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.section.text, "Texto editado a mano para la seccion uno.");
    assert.ok(putBody.invalidated.includes("scenes"));

    const badPut = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections/1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(badPut.status, 400);
    assert.equal((await badPut.json()).code, "section-text-required");

    const putMissing = await fetch(`${running.url}/api/series/${CHANNEL_ID}/stories/${STORY_ID}/sections/404`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "algo" }),
    });
    assert.equal(putMissing.status, 404);
    assert.equal((await putMissing.json()).code, "section-not-found");
  });
});
