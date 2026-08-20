import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import Busboy from "busboy";
import { saveAsset, type AssetMediaType } from "./assets.ts";
import { generateSourceSrtFromAsr } from "./asr.ts";
import { createBrief } from "./brief.ts";
import { loadStudioConfig, saveStudioConfig } from "./config.ts";
import { saveCopyrightCheck } from "./copyright.ts";
import { extractAudioForAsr, importMedia } from "./media-ingest.ts";
import { loadProjectState } from "./project-state.ts";
import { resolveProjectPath, validateProjectId } from "./project-paths.ts";
import {
  createReviewProject,
  listReviewProjects,
  loadReviewProject,
  updateReviewProject,
} from "./review-project.ts";
import { generateDryRunScript } from "./script.ts";
import {
  createSeriesProject,
  generateEpisodePlan,
  listSeriesProjects,
  loadSeriesProject,
  updateSeriesEpisode,
  type EpisodeStatus,
} from "./series.ts";
import {
  buildTranslationDraft,
  importSubtitle,
  TRANSLATION_PRESETS,
  type TranslationGenre,
  type TranslationLanguage,
} from "./translation.ts";
import {
  approveCurrentScript,
  approveCurrentCopyrightCheck,
  approveEmptyAssetManifest,
  generateVoice,
  prepareCaptions,
  renderDraftProject,
} from "./workflow.ts";
import { deriveWorkflowStepStates, getWorkflowTemplate, WORKFLOW_TEMPLATES } from "./workflow-templates.ts";

export type StudioServerOptions = {
  projectsRoot?: string;
  staticRoot?: string;
};

export type RunningStudioServer = {
  server: http.Server;
  address: { address: string; port: number };
  url: string;
  close(): Promise<void>;
};

type ApiError = {
  code: string;
  message: string;
  action?: string;
  details?: unknown;
};

export function createStudioServer(options: StudioServerOptions = {}): http.Server {
  const projectsRoot = options.projectsRoot ?? "projects";
  const staticRoot = options.staticRoot ?? process.cwd();

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, projectsRoot, staticRoot);
    } catch (error: unknown) {
      sendError(response, 500, {
        code: "internal-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function startStudioServer(
  server = createStudioServer(),
  options: { port?: number; host?: string } = {},
): Promise<RunningStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to read server address.");
  }

  return {
    server,
    address: { address: address.address, port: address.port },
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projectsRoot: string,
  staticRoot: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/styles.css" || url.pathname === "/app.js")) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }

  if (method !== "GET" && !isSameOrigin(request)) {
    sendError(response, 403, { code: "same-origin-required", message: "Mutating requests require same-origin." });
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    await sendProjects(response, projectsRoot);
    return;
  }

  if (method === "GET" && url.pathname === "/api/series") {
    const ids = await listSeriesProjects();
    const series = await Promise.all(ids.map((id) => loadSeriesProject(id)));
    sendJson(response, 200, { series });
    return;
  }

  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody(request);
    const brief = await createBrief({
      id: requiredString(body.id, "id"),
      topic: requiredString(body.topic, "topic"),
      show: requiredString(body.show, "show"),
      format: body.format === "longform" ? "longform" : "shorts",
      workflowType: body.workflowType,
      audience: requiredString(body.audience, "audience"),
      language: requiredString(body.language, "language"),
      notes: typeof body.notes === "string" ? body.notes : "",
    });
    sendJson(response, 200, { ok: true, brief });
    return;
  }

  if (method === "POST" && url.pathname === "/api/series") {
    const body = await readJsonBody(request);
    const series = await createSeriesProject({
      id: requiredString(body.id, "id"),
      title: requiredString(body.title, "title"),
      show: requiredString(body.show, "show"),
      originalTitle: typeof body.originalTitle === "string" ? body.originalTitle : "",
      workflowType: body.workflowType,
      audience: requiredString(body.audience, "audience"),
      language: requiredString(body.language, "language"),
      brandNotes: typeof body.brandNotes === "string" ? body.brandNotes : "",
      titleStyle: typeof body.titleStyle === "string" ? body.titleStyle : "",
      thumbnailStyle: typeof body.thumbnailStyle === "string" ? body.thumbnailStyle : "",
      scheduleNotes: typeof body.scheduleNotes === "string" ? body.scheduleNotes : "",
    });
    sendJson(response, 200, { ok: true, series });
    return;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { config: await loadStudioConfig() });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    sendJson(response, 200, { config: await saveStudioConfig(body) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/translation-presets") {
    sendJson(response, 200, {
      presets: Object.values(TRANSLATION_PRESETS),
      genres: ["cultivation", "fantasy-system", "modern-drama"],
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/workflow-templates") {
    sendJson(response, 200, { templates: WORKFLOW_TEMPLATES });
    return;
  }

  const seriesMatch = /^\/api\/series\/([a-z0-9-]+)(?:\/(.+))?$/.exec(url.pathname);
  if (seriesMatch) {
    const seriesId = validateProjectId(seriesMatch[1]);
    const rest = seriesMatch[2] ?? "";
    if (method === "GET" && rest === "") {
      sendJson(response, 200, { series: await loadSeriesProject(seriesId) });
      return;
    }
    if (method === "POST" && rest === "episode-plan") {
      const body = await readJsonBody(request);
      const series = await generateEpisodePlan(seriesId, {
        count: numberBody(body.count, 20),
        startEpisode: numberBody(body.startEpisode, 1),
      });
      sendJson(response, 200, { ok: true, series });
      return;
    }
    if (method === "GET" && rest === "review-projects") {
      sendJson(response, 200, { reviewProjects: await listReviewProjects(seriesId) });
      return;
    }
    if (method === "POST" && rest === "review-projects") {
      const body = await readJsonBody(request);
      const reviewProject = await createReviewProject({
        seriesId,
        id: requiredString(body.id, "id"),
        title: requiredString(body.title, "title"),
        sourceRange: requiredString(body.sourceRange, "sourceRange"),
        episodeNumbers: numberArrayBody(body.episodeNumbers),
        targetLanguage: "English",
        reviewStyle: "story-review",
        targetDurationMinutes: numberBody(body.targetDurationMinutes, 20),
        spoilerMode: body.spoilerMode === "novel-spoilers" ? "novel-spoilers" : "donghua-only",
      });
      sendJson(response, 200, { ok: true, reviewProject });
      return;
    }
    const reviewProjectMatch = /^review-projects\/([a-z0-9-]+)$/.exec(rest);
    if (method === "GET" && reviewProjectMatch) {
      sendJson(response, 200, { reviewProject: await loadReviewProject(seriesId, reviewProjectMatch[1]) });
      return;
    }
    if (method === "PATCH" && reviewProjectMatch) {
      const body = await readJsonBody(request);
      const reviewProject = await updateReviewProject(seriesId, reviewProjectMatch[1], {
        title: optionalString(body.title),
        sourceRange: optionalString(body.sourceRange),
        episodeNumbers: Array.isArray(body.episodeNumbers) ? numberArrayBody(body.episodeNumbers) : undefined,
        targetDurationMinutes:
          body.targetDurationMinutes === undefined ? undefined : numberBody(body.targetDurationMinutes, 20),
        spoilerMode: body.spoilerMode === "novel-spoilers" || body.spoilerMode === "donghua-only" ? body.spoilerMode : undefined,
        status: reviewProjectStatusBody(body.status),
        outputs: recordStringBody(body.outputs),
      });
      sendJson(response, 200, { ok: true, reviewProject });
      return;
    }
    const episodeMatch = /^episodes\/([a-z0-9-]+)$/.exec(rest);
    if (method === "PATCH" && episodeMatch) {
      const body = await readJsonBody(request);
      const series = await updateSeriesEpisode(seriesId, episodeMatch[1], {
        sourceTitle: optionalString(body.sourceTitle),
        workingTitle: optionalString(body.workingTitle),
        angle: optionalString(body.angle),
        hook: optionalString(body.hook),
        outline: stringArrayBody(body.outline),
        titleOptions: stringArrayBody(body.titleOptions),
        description: optionalString(body.description),
        hashtags: stringArrayBody(body.hashtags),
        pinnedComment: optionalString(body.pinnedComment),
        priority: body.priority === "high" || body.priority === "medium" || body.priority === "low" ? body.priority : undefined,
        status: episodeStatusBody(body.status),
      });
      const episode = series.episodes.find((item) => item.id === episodeMatch[1]);
      sendJson(response, 200, { ok: true, series, episode });
      return;
    }
    sendError(response, 404, { code: "not-found", message: "Series route not found." });
    return;
  }

  const projectMatch = /^\/api\/projects\/([a-z0-9-]+)(?:\/(.+))?$/.exec(url.pathname);
  if (!projectMatch) {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
    return;
  }

  const projectId = validateProjectId(projectMatch[1]);
  const rest = projectMatch[2] ?? "";

  if (method === "GET" && rest === "") {
    await sendProject(response, projectsRoot, projectId);
    return;
  }

  if (method === "GET" && rest === "events") {
    await sendProjectEvents(response, projectId);
    return;
  }

  const fileMatch = /^files\/(.+)$/.exec(rest);
  if (method === "GET" && fileMatch) {
    await sendProjectFile(response, projectId, decodeURIComponent(fileMatch[1]));
    return;
  }

  if (method === "POST" && rest === "voice") {
    const body = await readJsonBody(request);
    if (body.provider === "openai" && body.confirmedPaidRequest !== true) {
      sendError(response, 409, {
        code: "paid-confirmation-required",
        message: "OpenAI voice generation requires explicit paid confirmation.",
        action: "confirm-paid-request",
      });
      return;
    }
    await approveCurrentScript(projectId);
    const artifact = await generateVoice({
      projectId,
      provider: voiceProvider(body.provider),
      voice: typeof body.voice === "string" ? body.voice : undefined,
      confirmedPaidRequest: body.confirmedPaidRequest === true,
    });
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "script") {
    await generateDryRunScript(projectId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && rest === "captions") {
    const artifact = await prepareCaptions(projectId);
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "render") {
    const state = await loadProjectState(projectId);
    const reasons: string[] = [];
    if (!state.approvals.script) reasons.push("script-approval-missing");
    if (!state.approvals.copyright) reasons.push("copyright-approval-missing");
    if (state.approvals.script && !state.artifacts.voice) reasons.push("voice-missing");
    if (state.approvals.script && !state.artifacts.captions) reasons.push("captions-missing");

    if (reasons.length > 0) {
      sendError(response, 409, {
        code: "render-gates-unmet",
        message: "Render cannot start until required approvals and artifacts are ready.",
        details: { reasons },
      });
      return;
    }
    await approveEmptyAssetManifest(projectId);
    await approveCurrentCopyrightCheck(projectId);
    const artifact = await renderDraftProject(projectId);
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "assets") {
    const uploaded = await saveMultipartUpload(request, projectId, "asset-upload");
    try {
      const asset = await saveAsset(projectId, {
        filename: uploaded.filename,
        stream: createReadStream(uploaded.path),
        mediaType: assetMediaType(uploaded.fields.mediaType),
        mimeType: uploaded.mimeType,
        rightsConfirmed: uploaded.fields.rightsConfirmed === "true",
        usagePurpose: uploaded.fields.usagePurpose,
      });
      sendJson(response, 200, { ok: true, asset });
    } finally {
      await rm(uploaded.path, { force: true });
    }
    return;
  }

  if (method === "POST" && rest === "assets/approve") {
    await approveEmptyAssetManifest(projectId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && rest === "copyright-check") {
    const body = await readJsonBody(request);
    const check = await saveCopyrightCheck({
      projectId,
      commentaryPercent: numberBody(body.commentaryPercent, 70),
      footagePercent: numberBody(body.footagePercent, 15),
      longestClipSeconds: numberBody(body.longestClipSeconds, 5),
      usesFullScene: body.usesFullScene === true,
      thumbnailFromCopyrightFrame: body.thumbnailFromCopyrightFrame === true,
      clipsHaveCommentaryPurpose: body.clipsHaveCommentaryPurpose !== false,
    });
    sendJson(response, 200, { ok: true, check });
    return;
  }

  if (method === "POST" && rest === "copyright/approve") {
    await approveCurrentCopyrightCheck(projectId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && rest === "media") {
    const uploaded = await saveMultipartUpload(request, projectId, "media-upload");
    try {
      const artifact = await importMedia(projectId, uploaded.path);
      sendJson(response, 200, { ok: true, artifact });
    } finally {
      await rm(uploaded.path, { force: true });
    }
    return;
  }

  if (method === "POST" && rest === "media/audio") {
    const body = await readJsonBody(request);
    const artifact = await extractAudioForAsr(
      projectId,
      typeof body.media === "string" ? body.media : "workspace/media/source.mp4",
    );
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "asr") {
    const body = await readJsonBody(request);
    const artifact = await generateSourceSrtFromAsr({
      projectId,
      provider:
        body.provider === "faster-whisper" || body.provider === "whisper-cpp" ? body.provider : undefined,
      audioRelativePath: typeof body.audio === "string" ? body.audio : undefined,
    });
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "subtitles/source") {
    const uploaded = await saveMultipartUpload(request, projectId, "subtitle-upload");
    try {
      const artifact = await importSubtitle(projectId, uploaded.path);
      sendJson(response, 200, { ok: true, artifact });
    } finally {
      await rm(uploaded.path, { force: true });
    }
    return;
  }

  if (method === "POST" && rest === "subtitles/translation-prompt") {
    const body = await readJsonBody(request);
    const source = typeof body.source === "string" ? body.source : "workspace/subtitles/source.asr.srt";
    const config = await loadStudioConfig();
    const target = (typeof body.target === "string" ? body.target : config.translation.defaultTarget) as TranslationLanguage;
    const genre = (typeof body.genre === "string" ? body.genre : config.translation.defaultGenre) as TranslationGenre;
    const draft = await buildTranslationDraft(projectId, source, target, genre);
    sendJson(response, 200, { ok: true, draft });
    return;
  }

  sendError(response, 404, { code: "not-found", message: "Route not found." });
}

async function sendProjects(response: ServerResponse, projectsRoot: string): Promise<void> {
  let ids: string[] = [];
  try {
    const candidates = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          validateProjectId(name);
          return true;
        } catch {
          return false;
        }
      });
    for (const id of candidates) {
      try {
        await readFile(join(projectsRoot, id, "brief.json"), "utf8");
        ids.push(id);
      } catch {
        // Series roots and incomplete folders are managed by other endpoints.
      }
    }
  } catch {
    ids = [];
  }
  sendJson(response, 200, { projects: ids });
}

async function sendProject(response: ServerResponse, projectsRoot: string, projectId: string): Promise<void> {
  const briefPath = join(projectsRoot, projectId, "brief.json");
  const brief = JSON.parse(await readFile(briefPath, "utf8")) as unknown;
  const state = await loadProjectState(projectId);
  const workflowType = typeof brief === "object" && brief !== null && "workflowType" in brief ? brief.workflowType : undefined;
  const template = getWorkflowTemplate(workflowType);
  sendJson(response, 200, {
    brief,
    state,
    workflow: {
      ...template,
      steps: deriveWorkflowStepStates(template.type, state),
    },
  });
}

async function sendProjectFile(response: ServerResponse, projectId: string, relativePath: string): Promise<void> {
  const filePath = resolveProjectPath(projectId, relativePath);
  const info = await stat(filePath);
  if (!info.isFile()) {
    sendError(response, 404, { code: "not-found", message: "File not found." });
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw new Error("JSON request body is too large.");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function consumeUpload(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const busboy = Busboy({ headers: request.headers, limits: { fileSize: 250 * 1024 * 1024 } });
    busboy.on("file", (_name, file) => file.resume());
    busboy.on("error", reject);
    busboy.on("finish", resolve);
    request.pipe(busboy);
  });
}

async function saveMultipartUpload(
  request: IncomingMessage,
  projectId: string,
  purpose: string,
): Promise<{ path: string; filename: string; mimeType: string; fields: Record<string, string> }> {
  const uploadDir = resolveProjectPath(projectId, join("workspace", "uploads"));
  await mkdir(uploadDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: request.headers, limits: { fileSize: 3 * 1024 * 1024 * 1024 } });
    let saved = false;
    let outputPath = "";
    let originalName = "upload.bin";
    let mimeType = "application/octet-stream";
    const fields: Record<string, string> = {};

    busboy.on("file", (_name, file, info) => {
      if (saved) {
        file.resume();
        return;
      }
      saved = true;
      originalName = basename(info.filename || "upload.bin");
      mimeType = info.mimeType || mimeType;
      outputPath = resolveProjectPath(
        projectId,
        join("workspace", "uploads", `${Date.now()}-${purpose}-${safeFileName(originalName)}`),
      );
      const output = createWriteStream(outputPath);
      file.pipe(output);
      output.on("error", reject);
    });
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (!saved || !outputPath) {
        reject(new Error("No upload file was provided."));
        return;
      }
      resolve({ path: outputPath, filename: originalName, mimeType, fields });
    });
    request.pipe(busboy);
  });
}

function voiceProvider(value: unknown): "piper" | "openai" | "vietnamese-local" {
  if (value === "openai" || value === "vietnamese-local" || value === "piper") {
    return value;
  }
  return "piper";
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload.bin";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function numberBody(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayBody(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}

function numberArrayBody(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("episodeNumbers must be an array.");
  }
  return value.map(Number);
}

function recordStringBody(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [key, String(item)]),
  );
}

function episodeStatusBody(value: unknown): EpisodeStatus | undefined {
  if (
    value === "idea" ||
    value === "script" ||
    value === "voice" ||
    value === "caption" ||
    value === "render" ||
    value === "ready" ||
    value === "published"
  ) {
    return value;
  }
  return undefined;
}

function reviewProjectStatusBody(value: unknown) {
  if (
    value === "draft" ||
    value === "sources" ||
    value === "analyzed" ||
    value === "story" ||
    value === "script" ||
    value === "editing-plan" ||
    value === "exported"
  ) {
    return value;
  }
  return undefined;
}

function assetMediaType(value: unknown): AssetMediaType {
  return value === "video" ? "video" : "image";
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const host = request.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendError(response: ServerResponse, status: number, error: ApiError): void {
  sendJson(response, status, error);
}

async function sendStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const relativePath = pathname === "/" ? "src/web/index.html" : `src/web${pathname}`;
  const root = resolve(staticRoot);
  const filePath = resolve(root, relativePath);

  if (!filePath.startsWith(root)) {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
  }
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".srt") return "text/plain; charset=utf-8";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function sendProjectEvents(response: ServerResponse, projectId: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify({ projectId, jobs: [] })}\n\n`);

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);

  response.on("close", () => clearInterval(heartbeat));
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 3000);
  const running = await startStudioServer(createStudioServer(), { port });
  console.log(`YT Review Studio listening on ${running.url}`);
}
