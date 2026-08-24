import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compositeOwner, ownerChannel, ProjectJobManager, type JobOperation } from "../src/jobs.ts";

test("only one mutating job runs per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);
  let release!: () => void;
  const blockingOperation: JobOperation = () =>
    new Promise((resolve) => {
      release = () => resolve({ message: "done" });
    });

  try {
    await manager.start("sample-project", "voice", blockingOperation);
    await assert.rejects(() => manager.start("sample-project", "render", async () => ({})), /already running/i);
    release();
    await manager.waitForIdle("sample-project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a job aborts its operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);
  const operationWatchingSignal: JobOperation = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

  try {
    const job = await manager.start("sample-project", "render", operationWatchingSignal);
    const cancelled = await manager.cancel("sample-project", job.id);

    assert.equal(cancelled.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscribers receive immutable job snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);
  const snapshots: string[] = [];

  try {
    const unsubscribe = manager.subscribe("sample-project", (job) => {
      snapshots.push(job.status);
    });
    await manager.start("sample-project", "captions", async ({ update }) => {
      await update(50, "halfway");
      return { ok: true };
    });
    await manager.waitForIdle("sample-project");
    unsubscribe();

    assert.ok(snapshots.includes("running"));
    assert.ok(snapshots.includes("succeeded"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownerChannel and compositeOwner split and join on the :: separator", () => {
  assert.equal(ownerChannel("ch::st"), "ch");
  assert.equal(ownerChannel("ch"), "ch");
  assert.equal(compositeOwner("ch", "st"), "ch::st");
});

test("two composite owners on the same channel run jobs concurrently; the same owner still serializes", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);
  const releases: Array<() => void> = [];
  const blockingOperation: JobOperation = () =>
    new Promise((resolve) => {
      releases.push(() => resolve({ ok: true }));
    });

  try {
    await manager.start(compositeOwner("ch", "a"), "story-pipeline", blockingOperation);
    await manager.start(compositeOwner("ch", "b"), "story-pipeline", blockingOperation);

    await assert.rejects(
      () => manager.start(compositeOwner("ch", "a"), "story-stage", async () => ({})),
      /already running/i,
    );

    releases.forEach((release) => release());
    await manager.waitForIdle(compositeOwner("ch", "a"));
    await manager.waitForIdle(compositeOwner("ch", "b"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a channel listener receives events for a composite owner on that channel, and the exact owner still does too", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);
  const channelSnapshots: string[] = [];
  const exactSnapshots: string[] = [];

  try {
    const unsubscribeChannel = manager.subscribe("ch", (job) => channelSnapshots.push(job.status));
    const unsubscribeExact = manager.subscribe(compositeOwner("ch", "a"), (job) => exactSnapshots.push(job.status));

    await manager.start(compositeOwner("ch", "a"), "story-pipeline", async ({ update }) => {
      await update(50, "halfway");
      return { ok: true };
    });
    await manager.waitForIdle(compositeOwner("ch", "a"));

    unsubscribeChannel();
    unsubscribeExact();

    assert.ok(channelSnapshots.includes("running"));
    assert.ok(channelSnapshots.includes("succeeded"));
    assert.ok(exactSnapshots.includes("running"));
    assert.ok(exactSnapshots.includes("succeeded"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job records for a composite owner persist under the channel's jobs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  const manager = new ProjectJobManager(root);

  try {
    const job = await manager.start(compositeOwner("ch", "a"), "story-pipeline", async () => ({ ok: true }));
    await manager.waitForIdle(compositeOwner("ch", "a"));

    const dir = join(root, "ch", "workspace", "jobs");
    const names = await readdir(dir);
    assert.ok(names.includes(`${job.id}.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a job whose bookkeeping cannot be written still settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-jobs-"));
  // A file where the jobs directory should go makes every persist attempt fail.
  const blocked = join(root, "blocked");
  await writeFile(blocked, "not a directory", "utf8");
  const manager = new ProjectJobManager(blocked);

  try {
    await manager.start("sample-project", "render", async () => ({ ok: true }));
    const settled = await manager.waitForIdle("sample-project");

    assert.equal(settled?.status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
