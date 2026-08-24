import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectsRoot as defaultProjectsRoot } from "./fs.ts";

export type JobKind =
  | "voice"
  | "captions"
  | "render"
  | "asset"
  | "asr"
  | "script"
  | "download"
  | "score"
  | "story-pipeline"
  | "story-stage"
  | "story-export";
export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  /**
   * The owner of the job: a project id under the projects root, or a source
   * candidate id when the manager is rooted at the sources store. The name is
   * kept because renaming it would invalidate every job record already on disk.
   */
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type JobUpdate = (progress: number, message: string) => Promise<void>;

export type JobOperation = (context: {
  signal: AbortSignal;
  update: JobUpdate;
}) => Promise<unknown>;

export type JobListener = (job: JobRecord) => void;

/**
 * Composite owner ids let two stories on one channel run jobs concurrently
 * while still sharing the channel's job persistence and SSE stream. `::` can
 * never appear inside a plain project or channel id, so "<channelId>::<suffix>"
 * never collides with one. The suffix may itself contain "::" (e.g. a future
 * "comp::abc" compilation suffix), so the channel is always the first segment.
 */
export function ownerChannel(ownerId: string): string {
  return ownerId.split("::")[0];
}

export function compositeOwner(channelId: string, suffix: string): string {
  return `${channelId}::${suffix}`;
}

type RunningJob = {
  record: JobRecord;
  controller: AbortController;
  done: Promise<JobRecord>;
};

export class ProjectJobManager {
  private readonly running = new Map<string, RunningJob>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly resolveProjectsRoot: () => string;

  /**
   * Accepts a resolver so the manager follows a projects root that is decided per
   * call, rather than freezing whatever the root happened to be at construction.
   */
  constructor(projectsRoot: string | (() => string) = defaultProjectsRoot) {
    this.resolveProjectsRoot = typeof projectsRoot === "string" ? () => projectsRoot : projectsRoot;
  }

  isBusy(projectId: string): boolean {
    return this.running.has(projectId);
  }

  async start(projectId: string, kind: JobKind, operation: JobOperation): Promise<JobRecord> {
    if (this.running.has(projectId)) {
      throw new Error(`Project ${projectId} already running a job.`);
    }

    const controller = new AbortController();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: randomUUID(),
      projectId,
      kind,
      status: "running",
      progress: 0,
      message: "Starting",
      createdAt: now,
      updatedAt: now,
    };

    const runningJob: RunningJob = {
      record,
      controller,
      done: Promise.resolve(record),
    };
    this.running.set(projectId, runningJob);
    await this.persist(record);
    this.emit(projectId, record);

    runningJob.done = this.runOperation(runningJob, operation);
    return cloneJob(record);
  }

  async cancel(projectId: string, jobId: string): Promise<JobRecord> {
    const running = this.running.get(projectId);
    if (!running || running.record.id !== jobId) {
      throw new Error(`No running job ${jobId} for project ${projectId}.`);
    }

    running.controller.abort();
    running.record.status = "cancelled";
    running.record.progress = running.record.progress || 0;
    running.record.message = "Cancelled";
    running.record.updatedAt = new Date().toISOString();
    await this.persist(running.record);
    this.emit(projectId, running.record);
    return cloneJob(running.record);
  }

  subscribe(projectId: string, listener: JobListener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) {
      set = new Set<JobListener>();
      this.listeners.set(projectId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  async waitForIdle(projectId: string): Promise<JobRecord | null> {
    const running = this.running.get(projectId);
    if (!running) {
      return null;
    }
    return running.done;
  }

  async recoverInterrupted(projectId: string): Promise<JobRecord[]> {
    const records = await this.listJobs(projectId);
    const interrupted: JobRecord[] = [];

    for (const job of records.filter((record) => record.status === "running")) {
      job.status = "failed";
      job.error = "Interrupted process recovered on startup.";
      job.message = "Interrupted";
      job.updatedAt = new Date().toISOString();
      await this.persist(job);
      interrupted.push(cloneJob(job));
    }

    return interrupted;
  }

  private async runOperation(running: RunningJob, operation: JobOperation): Promise<JobRecord> {
    const { record, controller } = running;

    try {
      const result = await operation({
        signal: controller.signal,
        update: async (progress, message) => {
          if (record.status !== "running") return;
          record.progress = Math.max(0, Math.min(100, progress));
          record.message = message;
          record.updatedAt = new Date().toISOString();
          await this.persist(record);
          this.emit(record.projectId, record);
        },
      });

      if (record.status === "running") {
        record.status = "succeeded";
        record.progress = 100;
        record.message = "Done";
        record.result = result;
        record.updatedAt = new Date().toISOString();
        await this.persist(record);
        this.emit(record.projectId, record);
      }
    } catch (error: unknown) {
      if (record.status !== "cancelled") {
        record.status = controller.signal.aborted ? "cancelled" : "failed";
        record.error = error instanceof Error ? error.message : String(error);
        record.message = record.status === "cancelled" ? "Cancelled" : "Failed";
        record.updatedAt = new Date().toISOString();
        await this.persist(record);
        this.emit(record.projectId, record);
      }
    } finally {
      this.running.delete(record.projectId);
    }

    return cloneJob(record);
  }

  private async listJobs(projectId: string): Promise<JobRecord[]> {
    const dir = this.jobsDir(projectId);
    try {
      const names = await readdir(dir);
      return Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")) as JobRecord),
      );
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Bookkeeping is a record of the run, not the run itself. A failed write is
   * reported and dropped so it cannot reject out of the detached operation
   * promise and take the studio down with an unhandled rejection.
   */
  private async persist(record: JobRecord): Promise<void> {
    try {
      const dir = this.jobsDir(record.projectId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (error: unknown) {
      console.error(`Unable to record job ${record.id} for ${record.projectId}:`, error);
    }
  }

  /**
   * Jobs for a composite owner persist under the channel's own jobs dir, never
   * a literal "<channel>::<suffix>" directory, so recovery on startup only
   * ever has to scan one directory per channel.
   */
  private jobsDir(projectId: string): string {
    return join(this.resolveProjectsRoot(), ownerChannel(projectId), "workspace", "jobs");
  }

  /**
   * Fans events out to listeners on the exact owner and, for a composite
   * owner, also to listeners on the plain channel id -- so the one per-channel
   * SSE stream keeps receiving every story job regardless of which story
   * suffix started it.
   */
  private emit(ownerId: string, record: JobRecord): void {
    for (const listener of this.listeners.get(ownerId) ?? []) {
      listener(cloneJob(record));
    }
    const channel = ownerChannel(ownerId);
    if (channel !== ownerId) {
      for (const listener of this.listeners.get(channel) ?? []) {
        listener(cloneJob(record));
      }
    }
  }
}

function cloneJob(record: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(record)) as JobRecord;
}
