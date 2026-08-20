import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type JobKind = "voice" | "captions" | "render" | "asset";
export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
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

type RunningJob = {
  record: JobRecord;
  controller: AbortController;
  done: Promise<JobRecord>;
};

export class ProjectJobManager {
  private readonly running = new Map<string, RunningJob>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly projectsRoot: string;

  constructor(projectsRoot = "projects") {
    this.projectsRoot = projectsRoot;
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

  private async persist(record: JobRecord): Promise<void> {
    const dir = this.jobsDir(record.projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private jobsDir(projectId: string): string {
    return join(this.projectsRoot, projectId, "workspace", "jobs");
  }

  private emit(projectId: string, record: JobRecord): void {
    for (const listener of this.listeners.get(projectId) ?? []) {
      listener(cloneJob(record));
    }
  }
}

function cloneJob(record: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(record)) as JobRecord;
}
