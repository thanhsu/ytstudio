import { randomUUID } from "node:crypto";
import { loadStudioConfig } from "../config.ts";
import { ProjectJobManager, compositeOwner } from "../jobs.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { getFreshAccessToken } from "./token-store.ts";
import { uploadVideo, setThumbnail } from "./upload.ts";
import { loadYouTubeStore, upsertPublishJob, upsertVideoLink, type YouTubePublishJob, type YouTubeVideoLink, type PrivacyStatus, type SourceKind } from "./youtube-store.ts";
import { evaluatePublishReadiness, type PublishReadiness } from "./publish-readiness.ts";
import { loadCalendar } from "../story-factory/calendar.ts";
import { saveStageRun, writeStageArtifact } from "../story-factory/story-project.ts";
import type { PublishArtifact } from "../story-factory/types.ts";

export type YouTubePublishInput = {
  sourceKind: SourceKind;
  sourceId: string;
  exportPath?: string;
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailPath?: string;
  privacyStatus?: PrivacyStatus;
  publishAt?: string;
};

export type YouTubePublishDeps = {
  jobManager?: ProjectJobManager;
  readiness?: (seriesId: string, sourceKind: SourceKind, sourceId: string) => Promise<PublishReadiness>;
  accessToken?: (seriesId: string) => Promise<string>;
  upload?: typeof uploadVideo;
  thumbnail?: typeof setThumbnail;
  now?: () => Date;
  calendar?: typeof loadCalendar;
};

export class YouTubePublishError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly action?: string;
  constructor(code: string, message: string, retryable = false, action?: string) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.action = action;
    this.name = "YouTubePublishError";
  }
}

export function normalizePublishAt(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new YouTubePublishError("youtube-metadata-invalid", "publishAt must be a valid date.", false, "fix-publish-time");
  return date.toISOString();
}

export function normalizePublishInput(input: YouTubePublishInput): YouTubePublishInput & { privacyStatus: PrivacyStatus; publishAt?: string } {
  if (!isSource(input.sourceKind) || !input.sourceId?.trim()) throw new YouTubePublishError("youtube-metadata-invalid", "A valid publish source is required.");
  const publishAt = normalizePublishAt(input.publishAt);
  if (publishAt && Date.parse(publishAt) <= Date.now()) throw new YouTubePublishError("youtube-metadata-invalid", "publishAt must be in the future.", false, "fix-publish-time");
  if (input.title !== undefined && (!input.title.trim() || input.title.length > 100)) throw new YouTubePublishError("youtube-metadata-invalid", "Title must be 1-100 characters.", false, "fix-metadata");
  if (input.description !== undefined && input.description.length > 5000) throw new YouTubePublishError("youtube-metadata-invalid", "Description is too long.", false, "fix-metadata");
  const privacyStatus = publishAt ? "private" : input.privacyStatus ?? "private";
  if (!isPrivacy(privacyStatus)) throw new YouTubePublishError("youtube-metadata-invalid", "Unsupported privacy status.", false, "fix-visibility");
  return { ...input, privacyStatus, publishAt };
}

export async function startYouTubePublish(seriesId: string, rawInput: YouTubePublishInput, deps: YouTubePublishDeps = {}): Promise<YouTubePublishJob> {
  const input = normalizePublishInput(rawInput);
  const readiness = deps.readiness ?? evaluatePublishReadiness;
  const ready = await readiness(seriesId, input.sourceKind, input.sourceId);
  const metadata = { ...ready.metadata, title: input.title ?? ready.metadata?.title ?? "Untitled", description: input.description ?? ready.metadata?.description ?? "", tags: input.tags ?? ready.metadata?.tags ?? [] };
  if (!metadata.title.trim()) throw new YouTubePublishError("youtube-metadata-invalid", "A title is required.", false, "fix-metadata");
  const store = await loadYouTubeStore(seriesId);
  const remoteChannelId = store.remoteChannelId;
  if (!remoteChannelId) throw new YouTubePublishError("youtube-not-connected", "Connect a YouTube channel before publishing.", false, "connect-youtube");
  const existing = store.links.find((link) => link.sourceKind === input.sourceKind && link.sourceId === input.sourceId);
  const recordedJob = store.jobs.find((candidate) => candidate.sourceKind === input.sourceKind && candidate.sourceId === input.sourceId && candidate.videoId);
  const existingJob = store.jobs.find((job) => job.sourceKind === input.sourceKind && job.sourceId === input.sourceId && ["queued", "uploading", "thumbnail-uploading"].includes(job.status));
  if (existingJob) throw new YouTubePublishError("youtube-publish-running", "This source is already being published.", false, "wait-for-publish");
  const publishAt = input.publishAt ?? await calendarFallback(seriesId, input, deps.calendar ?? loadCalendar);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const recordedVideoId = existing?.videoId ?? recordedJob?.videoId ?? null;
  const job: YouTubePublishJob = { version: 1, id: randomUUID(), channelId: remoteChannelId, sourceKind: input.sourceKind, sourceId: input.sourceId, status: "queued", requestedPrivacy: publishAt ? "private" : input.privacyStatus, requestedPublishAt: publishAt ?? null, videoId: recordedVideoId, progress: 0, error: null, createdAt: now, updatedAt: now };
  await upsertPublishJob(seriesId, job);
  const manager = deps.jobManager ?? defaultManager;
  const owner = compositeOwner(seriesId, `youtube-publish::${input.sourceKind}::${input.sourceId}`);
  try {
    const managerJob = await manager.start(owner, "youtube-publish", async ({ signal, update }) => {
      const set = async (status: YouTubePublishJob["status"], progress: number) => { job.status = status; job.progress = progress; job.updatedAt = (deps.now ?? (() => new Date()))().toISOString(); await upsertPublishJob(seriesId, job); await update(progress, status); };
      try {
        await set(recordedVideoId ? "thumbnail-uploading" : "uploading", 5);
        const token = await (deps.accessToken ?? defaultAccessToken)(seriesId);
        const videoId = recordedVideoId ?? (await (deps.upload ?? uploadVideo)({ accessToken: token, filePath: resolveProjectPath(seriesId, input.exportPath ?? ready.exportPath ?? ""), snippet: metadata, status: { privacyStatus: publishAt ? "private" : input.privacyStatus, ...(publishAt ? { publishAt } : {}) }, signal, update: async (done, total) => update(total ? Math.min(85, Math.round(done / total * 85)) : 25, "Uploading video") })).videoId;
        job.videoId = videoId;
        await set("thumbnail-uploading", 90);
        const thumbnailPath = input.thumbnailPath ?? ready.thumbnailPath;
        if (thumbnailPath) await (deps.thumbnail ?? setThumbnail)({ accessToken: token, videoId, filePath: resolveProjectPath(seriesId, thumbnailPath), signal });
        const link: YouTubeVideoLink = { version: 1, videoId, channelId: remoteChannelId, sourceKind: input.sourceKind, sourceId: input.sourceId, exportPath: input.exportPath ?? ready.exportPath ?? "", title: metadata.title, privacyStatus: publishAt ? "private" : input.privacyStatus, publishAt: publishAt ?? null, createdAt: existing?.createdAt ?? now, updatedAt: (deps.now ?? (() => new Date()))().toISOString() };
        await upsertVideoLink(seriesId, link);
        job.status = "completed"; job.progress = 100; job.updatedAt = (deps.now ?? (() => new Date()))().toISOString(); await upsertPublishJob(seriesId, job);
        if (input.sourceKind === "story") await writeStoryPublishCompatibility(seriesId, input.sourceId, {
          version: 1,
          videoId,
          uploadedAt: job.updatedAt,
          privacyStatus: publishAt ? "private" : input.privacyStatus,
          ...(publishAt ? { publishAt } : {}),
          thumbnailSet: Boolean(thumbnailPath),
          title: metadata.title,
        });
      } catch (error: unknown) {
        if (signal.aborted) { job.status = "cancelled"; job.updatedAt = new Date().toISOString(); await upsertPublishJob(seriesId, job); return; }
        const mapped = mapPublishError(error); job.status = "failed"; job.error = { code: mapped.code, message: mapped.message, retryable: mapped.retryable }; job.updatedAt = new Date().toISOString(); await upsertPublishJob(seriesId, job);
      }
    });
    activeManagerJobs.set(job.id, { manager, owner, id: managerJob.id });
  } catch (error: unknown) { throw mapPublishError(error); }
  return job;
}

export async function cancelYouTubePublish(seriesId: string, jobId: string, deps: YouTubePublishDeps = {}): Promise<YouTubePublishJob> {
  const jobs = await loadYouTubeStore(seriesId);
  const job = jobs.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new YouTubePublishError("youtube-job-not-found", "Publish job not found.");
  const manager = deps.jobManager ?? defaultManager;
  const owner = compositeOwner(seriesId, `youtube-publish::${job.sourceKind}::${job.sourceId}`);
  const active = activeManagerJobs.get(jobId);
  await (active?.manager ?? manager).cancel(owner, active?.id ?? jobId).catch(() => undefined);
  await (active?.manager ?? manager).waitForIdle(owner);
  activeManagerJobs.delete(jobId);
  return (await loadYouTubeStore(seriesId)).jobs.find((candidate) => candidate.id === jobId) ?? job;
}

const defaultManager = new ProjectJobManager();
const activeManagerJobs = new Map<string, { manager: ProjectJobManager; owner: string; id: string }>();
async function defaultAccessToken(seriesId: string): Promise<string> { const config = await loadStudioConfig(); const clientId = process.env[config.youtube.clientIdEnv]?.trim() ?? ""; const clientSecret = process.env[config.youtube.clientSecretEnv]?.trim() ?? ""; return getFreshAccessToken(seriesId, { clientId, clientSecret }); }
async function calendarFallback(seriesId: string, input: YouTubePublishInput, load: typeof loadCalendar): Promise<string | undefined> { const calendar = await load(seriesId); const entry = calendar.entries.find((candidate) => candidate.storyId === input.sourceId && candidate.plannedPublishAt && Date.parse(candidate.plannedPublishAt) > Date.now()); return normalizePublishAt(entry?.plannedPublishAt ?? undefined); }
async function writeStoryPublishCompatibility(seriesId: string, storyId: string, artifact: PublishArtifact): Promise<void> {
  try {
    await writeStageArtifact(seriesId, storyId, "publish", artifact);
    await saveStageRun(seriesId, storyId, "publish", { status: "done", finishedAt: artifact.uploadedAt });
  } catch {
    // The YouTube store/job is authoritative. A legacy Story Factory artifact
    // must never turn an already completed remote publish into a false failure.
  }
}
function mapPublishError(error: unknown): YouTubePublishError { const message = error instanceof Error ? error.message : String(error); if (message.includes("youtube-quota-exceeded") || message.includes("quotaExceeded") || message.includes("uploadLimitExceeded")) return new YouTubePublishError("youtube-quota-exceeded", "YouTube quota has been exceeded.", false, "wait-for-quota-reset"); if (message.startsWith("youtube-")) return new YouTubePublishError(message.split(":", 1)[0], message.slice(message.indexOf(":") + 1).trim() || message, !message.includes("not-found") && !message.includes("invalid") && !message.includes("quota")); return new YouTubePublishError("youtube-upload-failed", "YouTube upload failed.", true, "retry-publish"); }
function isSource(value: unknown): value is SourceKind { return value === "story" || value === "review" || value === "compilation"; }
function isPrivacy(value: unknown): value is PrivacyStatus { return value === "public" || value === "private" || value === "unlisted"; }
