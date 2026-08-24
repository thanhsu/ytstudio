import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createStudioServer, startStudioServer, type RunningStudioServer } from "../src/server.ts";
import { loadStoryChannel } from "../src/story-factory/channel.ts";
import {
  createStory,
  loadStory,
  saveStageRun,
  writeStageArtifact,
} from "../src/story-factory/story-project.ts";
import { writeStudioConfig } from "./helpers.ts";

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
  const root = await mkdtemp(join(tmpdir(), "yt-story-server-"));
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

test("story factory mutations are refused until the feature flag is on", async () => {
  await withServer(async ({ running, headers }) => {
    const denied = await fetch(`${running.url}/api/series/es-horror/stories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "story-001", title: "t" }),
    });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, "story-factory-disabled");

    // Reads stay open so the UI can display state, including the flag.
    const read = await fetch(`${running.url}/api/series/es-horror/story-channel`);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).storyChannel.enabled, false);
  });
});

test("channel settings and stories round-trip over HTTP", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);

    const savedChannel = await fetch(`${running.url}/api/series/es-horror/story-channel`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, locale: "es-AR", subNiches: ["road horror"] }),
    });
    assert.equal(savedChannel.status, 200);
    assert.equal((await savedChannel.json()).storyChannel.locale, "es-AR");

    const created = await fetch(`${running.url}/api/series/es-horror/stories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "story-001", title: "La habitación 307", targetDurationMinutes: 30 }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.status, "DRAFT");
    assert.equal(createdBody.story.config.locale, "es-AR");

    const invalid = await fetch(`${running.url}/api/series/es-horror/stories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "story-001", title: "duplicate id" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "story-create-invalid");

    const list = await fetch(`${running.url}/api/series/es-horror/stories`);
    const listBody = await list.json();
    assert.equal(listBody.stories.length, 1);
    assert.equal(listBody.stories[0].targetDurationMinutes, 30);

    const patched = await fetch(`${running.url}/api/series/es-horror/stories/story-001`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "El turno de noche", maxCostPerStoryUsd: 2 }),
    });
    assert.equal((await patched.json()).story.title, "El turno de noche");

    const missing = await fetch(`${running.url}/api/series/es-horror/stories/story-404`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "story-not-found");
  });
});

test("artifact edits go through the hash path and report what they invalidated", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const channel = await loadStoryChannel("es-horror");
    await createStory(channel, { id: "story-001", title: "t" });
    await writeStageArtifact("es-horror", "story-001", "idea", { version: 1, logline: "v1" });
    await saveStageRun("es-horror", "story-001", "idea", { status: "done" });
    await saveStageRun("es-horror", "story-001", "hook", { status: "done" });

    const put = await fetch(`${running.url}/api/series/es-horror/stories/story-001/artifacts/idea`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ version: 1, logline: "v2 edited by hand" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.ok(putBody.invalidated.includes("hook"));

    const get = await fetch(`${running.url}/api/series/es-horror/stories/story-001/artifacts/idea`);
    assert.equal((await get.json()).artifact.logline, "v2 edited by hand");

    const machineOwned = await fetch(`${running.url}/api/series/es-horror/stories/story-001/artifacts/tts`, {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(machineOwned.status, 400);
    assert.equal((await machineOwned.json()).code, "stage-not-editable");

    const absent = await fetch(`${running.url}/api/series/es-horror/stories/story-001/artifacts/render`);
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).code, "artifact-missing");
  });
});

test("approvals need their anchor and go stale when the artifact changes", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const channel = await loadStoryChannel("es-horror");
    await createStory(channel, { id: "story-001", title: "t" });

    const premature = await fetch(`${running.url}/api/series/es-horror/stories/story-001/approve/script`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "too early" }),
    });
    assert.equal(premature.status, 409);
    assert.equal((await premature.json()).code, "approval-anchor-missing");

    await writeStageArtifact("es-horror", "story-001", "naturalize", { version: 1, fullText: "guion" });
    await saveStageRun("es-horror", "story-001", "naturalize", { status: "done" });
    const approved = await fetch(`${running.url}/api/series/es-horror/stories/story-001/approve/script`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "sounds native" }),
    });
    assert.equal(approved.status, 200);
    assert.equal(Boolean((await approved.json()).story.approvals.script), true);

    // Editing the anchored artifact stales the approval by hash mismatch.
    await fetch(`${running.url}/api/series/es-horror/stories/story-001/artifacts/naturalize`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ version: 1, fullText: "guion editado" }),
    });
    const story = await loadStory("es-horror", "story-001");
    const anchor = story.stages.naturalize?.artifactHash;
    assert.ok(anchor && story.approvals.script?.artifactHash !== anchor);

    const exportRefused = await fetch(`${running.url}/api/series/es-horror/stories/story-001/export`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(exportRefused.status, 409);
    const refusedBody = await exportRefused.json();
    assert.equal(refusedBody.code, "approval-required");
    assert.ok(refusedBody.details.missing.includes("media"));
  });
});

test("the pipeline runs as a channel job and reports its failure honestly", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const channel = await loadStoryChannel("es-horror");
    await createStory(channel, { id: "story-001", title: "t" });

    const unconfirmed = await fetch(`${running.url}/api/series/es-horror/stories/story-001/pipeline/run`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(unconfirmed.status, 409);
    const unconfirmedBody = await unconfirmed.json();
    assert.equal(unconfirmedBody.code, "paid-confirmation-required");
    assert.equal(unconfirmedBody.action, "confirm-paid-request");

    const started = await fetch(`${running.url}/api/series/es-horror/stories/story-001/pipeline/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmedPaidRequest: true }),
    });
    assert.equal(started.status, 202);
    const job = (await started.json()).job;
    assert.equal(job.kind, "story-pipeline");

    // No model is configured, so the job must fail naming the setting — never
    // fall back to a template.
    const record = await waitForJob(join("projects", "es-horror", "workspace", "jobs", `${job.id}.json`));
    assert.equal(record.status, "failed");
    assert.match(String(record.error), /No model configured .* planner/);

    const story = await loadStory("es-horror", "story-001");
    assert.equal(story.stages.idea?.status, "failed");
    assert.equal(story.stages.idea?.lastError?.classification, "provider");

    const log = await fetch(`${running.url}/api/series/es-horror/stories/story-001/ai-log`);
    assert.equal((await log.json()).ok, true);
    const cost = await fetch(`${running.url}/api/series/es-horror/stories/story-001/cost`);
    assert.equal((await cost.json()).cost.totalUsd, 0);
  });
});

test("two stories on one channel run pipeline jobs concurrently; the same story still 409s", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const channel = await loadStoryChannel("es-horror");
    await createStory(channel, { id: "story-001", title: "t" });
    await createStory(channel, { id: "story-002", title: "t2" });

    const runPipeline = (storyId: string) =>
      fetch(`${running.url}/api/series/es-horror/stories/${storyId}/pipeline/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmedPaidRequest: true }),
      });

    const firstStory = await runPipeline("story-001");
    assert.equal(firstStory.status, 202);
    const firstJob = (await firstStory.json()).job;

    // A different story on the same channel is a different composite owner,
    // so it must be free to start its own job concurrently.
    const secondStory = await runPipeline("story-002");
    assert.equal(secondStory.status, 202);
    const secondJob = (await secondStory.json()).job;

    // The same story is still one job at a time.
    const repeatStory = await runPipeline("story-001");
    assert.equal(repeatStory.status, 409);
    assert.equal((await repeatStory.json()).code, "job-already-running");

    // Both stories' jobs persist under the same channel jobs directory.
    await waitForJob(join("projects", "es-horror", "workspace", "jobs", `${firstJob.id}.json`));
    await waitForJob(join("projects", "es-horror", "workspace", "jobs", `${secondJob.id}.json`));
  });
});

test("voice lab requests are gated and name their missing configuration", async () => {
  await withServer(async ({ running, headers }) => {
    await writeStudioConfig(ENABLED_CONFIG);

    const sample = await fetch(`${running.url}/api/series/es-horror/voice-lab/sample`, {
      method: "POST",
      headers,
      body: JSON.stringify({ voiceName: "es-US-Standard-A", languageCode: "es-US" }),
    });
    assert.equal(sample.status, 409);
    assert.equal((await sample.json()).code, "paid-confirmation-required");

    delete process.env.GOOGLE_TTS_API_KEY;
    const voices = await fetch(`${running.url}/api/series/es-horror/voice-lab/voices?languageCode=es-US`);
    assert.equal(voices.status, 500);
    assert.match((await voices.json()).message, /GOOGLE_TTS_API_KEY/);
  });
});

test("story factory mutations still require same-origin", async () => {
  await withServer(async ({ running }) => {
    await writeStudioConfig(ENABLED_CONFIG);
    const response = await fetch(`${running.url}/api/series/es-horror/stories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "story-001", title: "t" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "same-origin-required");
  });
});

async function waitForJob(path: string): Promise<{ status: string; error?: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as { status: string; error?: string };
      if (record.status !== "running") {
        return record;
      }
    } catch {
      // The job file appears shortly after the 202.
    }
    await delay(50);
  }
  throw new Error(`Job at ${path} never finished.`);
}
