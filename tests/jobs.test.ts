import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectJobManager, type JobOperation } from "../src/jobs.ts";

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
