import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { JobRecord, JobUpdate } from "./jobs.ts";

export type ReviewJobScope = {
  scopeId: string;
  taskKind: string;
  episodeNumber?: number;
  idempotencyKey: string;
};

export type ReviewJobOperation = (context: { update: JobUpdate }) => Promise<unknown>;

export class ReviewJobManager {
  private readonly root: string;

  constructor(root = "projects") {
    this.root = root;
  }

  async runIdempotent(scope: ReviewJobScope, operation: ReviewJobOperation): Promise<JobRecord> {
    const cached = await this.readCached(scope);
    if (cached?.status === "succeeded") {
      return { ...cached, message: "Reused cached result" };
    }

    const now = new Date().toISOString();
    const record: JobRecord = {
      id: randomUUID(),
      projectId: scope.scopeId,
      kind: "asset",
      status: "running",
      progress: 0,
      message: "Starting",
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(scope, record);

    try {
      const result = await operation({
        update: async (progress, message) => {
          record.progress = Math.max(0, Math.min(100, progress));
          record.message = message;
          record.updatedAt = new Date().toISOString();
          await this.persist(scope, record);
        },
      });
      record.status = "succeeded";
      record.progress = 100;
      record.message = "Done";
      record.result = result;
      record.updatedAt = new Date().toISOString();
      await this.persist(scope, record);
      return record;
    } catch (error: unknown) {
      record.status = "failed";
      record.message = "Failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      await this.persist(scope, record);
      return record;
    }
  }

  private async readCached(scope: ReviewJobScope): Promise<JobRecord | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(scope), "utf8")) as JobRecord;
    } catch {
      return null;
    }
  }

  private async persist(scope: ReviewJobScope, record: JobRecord): Promise<void> {
    const path = this.pathFor(scope);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private pathFor(scope: ReviewJobScope): string {
    const hash = createHash("sha256")
      .update(`${scope.scopeId}:${scope.taskKind}:${scope.episodeNumber ?? "batch"}:${scope.idempotencyKey}`)
      .digest("hex")
      .slice(0, 24);
    return join(this.root, "review-jobs", `${hash}.json`);
  }
}
