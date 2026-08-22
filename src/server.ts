import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createReadStream } from "node:fs";
import Busboy from "busboy";
import {
  loadAssetManifest,
  saveAsset,
  updateAssetMetadata,
  validateAssetManifest,
  type AssetMediaType,
} from "./assets.ts";
import { analyzeAsset, recoverInterruptedAnalysis } from "./asset-analysis.ts";
import {
  checkStoryContinuity,
  createStoryBible,
  exportAudioStoryPackage,
  generateStoryChapter,
  generateStoryOutline,
  loadAudioStoryWorkspace,
} from "./audio-story.ts";
import { generateSourceSrtFromAsr } from "./asr.ts";
import { generateThumbnailBrief, loadBrandKit, saveBrandAsset, saveBrandKit, type BrandAssetType } from "./brand-kit.ts";
import { createBrief } from "./brief.ts";
import { loadStudioConfig, saveStudioConfig } from "./config.ts";
import { saveCopyrightCheck } from "./copyright.ts";
import { saveEditingPlan } from "./editing-plan.ts";
import {
  applyRemoveSelection,
  createEditManifest,
  EditManifestConflictError,
  EditManifestInputError,
  EditSelectionError,
  exportEditManifest,
  loadEditManifest,
} from "./edit-manifest.ts";
import { saveEpisodeAnalysis, type EpisodeAnalysis } from "./episode-analysis.ts";
import { addCandidate, assertDownloadable, requireCandidate, setCandidateRights } from "./sources/candidates.ts";
import { downloadCandidate } from "./sources/download.ts";
import { scoreCandidate } from "./sources/score.ts";
import { listCandidates, resolveSourcePath, type SourceRights } from "./sources/store.ts";
import { searchSourceMetadata, type SourceSearchPlatform, type YtDlpOptions } from "./sources/yt-dlp.ts";
import { exportReviewPackage } from "./export-package.ts";
import { ProjectJobManager, type JobKind, type JobOperation } from "./jobs.ts";
import { extractAudioForAsr, importMedia } from "./media-ingest.ts";
import { projectsRoot, sourcesRoot } from "./fs.ts";
import { loadProjectState } from "./project-state.ts";
import { resolveProjectPath, validateProjectId } from "./project-paths.ts";
import {
  createReviewProject,
  listReviewProjects,
  loadReviewProject,
  updateReviewProject,
} from "./review-project.ts";
import { importReviewEpisodeMedia, importReviewEpisodeSubtitle } from "./review-source.ts";
import { regenerateScriptSegment, saveReviewScript, type ReviewScript } from "./review-script.ts";
import { saveReviewEpisodeSceneMap } from "./scene-map.ts";
import { generateScript } from "./script.ts";
import { saveStoryArc } from "./story-arc.ts";
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
  evaluateEditRenderGate,
  evaluateProjectRenderGate,
  generateVoice,
  prepareCaptions,
  projectPipelineStatus,
  renderDraftProject,
  renderEditedCutProject,
} from "./workflow.ts";
import { deriveWorkflowStepStates, getWorkflowTemplate, WORKFLOW_TEMPLATES } from "./workflow-templates.ts";
import {
  buildNarrationScenes,
  generateVisualMapping,
  loadVisualMapping,
  saveVisualMapping,
  validateVisualMapping,
} from "./visual-mapping.ts";

export type StudioServerOptions = {
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

const jobs = new ProjectJobManager();

/**
 * A second manager rooted at the sources store. It keeps its own running and
 * listener maps, so a source job never lands in a project's job directory and the
 * two event streams stay apart.
 */
const sourceJobs = new ProjectJobManager(sourcesRoot);

async function startSourceJob(
  response: ServerResponse,
  sourceId: string,
  kind: JobKind,
  operation: JobOperation,
): Promise<void> {
  if (sourceJobs.isBusy(sourceId)) {
    sendError(response, 409, {
      code: "source-job-running",
      message: "This source already has a job running. Wait for it to finish or cancel it.",
    });
    return;
  }
  sendJson(response, 202, { ok: true, job: await sourceJobs.start(sourceId, kind, operation) });
}

async function sendSourceEvents(response: ServerResponse, sourceId: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify({ sourceId, busy: sourceJobs.isBusy(sourceId) })}\n\n`);

  const unsubscribe = sourceJobs.subscribe(sourceId, (job) => {
    response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * Runs a slow operation as a tracked job so the HTTP request returns immediately
 * and progress reaches the studio over the project event stream instead of being
 * lost to a request timeout.
 */
async function startProjectJob(
  response: ServerResponse,
  projectId: string,
  kind: JobKind,
  operation: JobOperation,
): Promise<void> {
  if (jobs.isBusy(projectId)) {
    sendError(response, 409, {
      code: "job-already-running",
      message: "This project already has a job running. Wait for it to finish or cancel it.",
    });
    return;
  }
  sendJson(response, 202, { ok: true, job: await jobs.start(projectId, kind, operation) });
}

export function createStudioServer(options: StudioServerOptions = {}): http.Server {
  const staticRoot = options.staticRoot ?? process.cwd();

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, staticRoot);
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
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Event-stream clients hold their sockets open indefinitely, so close them
        // explicitly instead of waiting for a keep-alive that never ends.
        server.closeAllConnections();
      }),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
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

  if (url.pathname === "/api/sources" || url.pathname.startsWith("/api/sources/")) {
    await routeSourceRequest(request, response, method, url);
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    await sendProjects(response);
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
    if (method === "GET" && rest === "brand-kit") {
      sendJson(response, 200, { brandKit: await loadBrandKit(seriesId) });
      return;
    }
    if (method === "PUT" && rest === "brand-kit") {
      const body = await readJsonBody(request);
      const brandKit = await saveBrandKit(seriesId, {
        channelName: optionalString(body.channelName),
        handle: optionalString(body.handle),
        logoRoundPath: optionalString(body.logoRoundPath),
        logoTextPath: optionalString(body.logoTextPath),
        watermarkPath: optionalString(body.watermarkPath),
        primaryColor: optionalString(body.primaryColor),
        secondaryColor: optionalString(body.secondaryColor),
        accentColor: optionalString(body.accentColor),
        fontStyle: optionalString(body.fontStyle),
        thumbnailPreset: body.thumbnailPreset,
        titleStyle: optionalString(body.titleStyle),
        thumbnailStyle: optionalString(body.thumbnailStyle),
        watermarkOpacity: body.watermarkOpacity,
        safeTextRules: stringArrayBody(body.safeTextRules),
        cta: optionalString(body.cta),
      });
      sendJson(response, 200, { ok: true, brandKit });
      return;
    }
    if (method === "POST" && rest === "brand-kit/assets") {
      const uploaded = await saveMultipartUpload(request, seriesId, "brand-asset-upload");
      try {
        const asset = await saveBrandAsset(seriesId, {
          filename: uploaded.filename,
          bytes: await readFile(uploaded.path),
          mimeType: uploaded.mimeType,
          assetType: brandAssetType(uploaded.fields.assetType),
        });
        sendJson(response, 200, { ok: true, asset, brandKit: await loadBrandKit(seriesId) });
      } finally {
        await rm(uploaded.path, { force: true });
      }
      return;
    }
    if (method === "POST" && rest === "brand-kit/thumbnail-brief") {
      const body = await readJsonBody(request);
      const thumbnailBrief = await generateThumbnailBrief(seriesId, {
        workflowType: body.workflowType,
        videoTitle: requiredString(body.videoTitle, "videoTitle"),
        episodeLabel: typeof body.episodeLabel === "string" ? body.episodeLabel : "",
        hook: requiredString(body.hook, "hook"),
      });
      sendJson(response, 200, { ok: true, thumbnailBrief });
      return;
    }
    if (method === "GET" && rest === "audio-story") {
      sendJson(response, 200, { workspace: await loadAudioStoryWorkspace(seriesId) });
      return;
    }
    if (method === "POST" && rest === "audio-story/bible") {
      const body = await readJsonBody(request);
      const bible = await createStoryBible(seriesId, {
        title: requiredString(body.title, "title"),
        genre: requiredString(body.genre, "genre"),
        premise: requiredString(body.premise, "premise"),
        tone: requiredString(body.tone, "tone"),
        audience: requiredString(body.audience, "audience"),
        language: requiredString(body.language, "language"),
        rules: stringArrayBody(body.rules),
        characters: storyCharactersBody(body.characters),
        locations: stringArrayBody(body.locations),
      });
      sendJson(response, 200, { ok: true, bible, workspace: await loadAudioStoryWorkspace(seriesId) });
      return;
    }
    if (method === "POST" && rest === "audio-story/outline") {
      const body = await readJsonBody(request);
      const outline = await generateStoryOutline(seriesId, {
        chapterCount: numberBody(body.chapterCount, 10),
        targetMinutesPerChapter: numberBody(body.targetMinutesPerChapter, 12),
      });
      sendJson(response, 200, { ok: true, outline, workspace: await loadAudioStoryWorkspace(seriesId) });
      return;
    }
    const audioStoryChapterMatch = /^audio-story\/chapters\/(\d+)$/.exec(rest);
    if (method === "POST" && audioStoryChapterMatch) {
      const chapterNumber = numberBody(audioStoryChapterMatch[1], 1);
      const chapter = await generateStoryChapter(seriesId, chapterNumber);
      sendJson(response, 200, { ok: true, chapter, workspace: await loadAudioStoryWorkspace(seriesId) });
      return;
    }
    const audioStoryContinuityMatch = /^audio-story\/chapters\/(\d+)\/continuity$/.exec(rest);
    if (method === "POST" && audioStoryContinuityMatch) {
      const chapterNumber = numberBody(audioStoryContinuityMatch[1], 1);
      const report = await checkStoryContinuity(seriesId, chapterNumber);
      sendJson(response, 200, { ok: true, report, workspace: await loadAudioStoryWorkspace(seriesId) });
      return;
    }
    if (method === "POST" && rest === "audio-story/export") {
      const exported = await exportAudioStoryPackage(seriesId);
      sendJson(response, 200, { ok: true, exported, workspace: await loadAudioStoryWorkspace(seriesId) });
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
    const reviewEpisodeSourceMatch = /^review-projects\/([a-z0-9-]+)\/episodes\/(\d+)\/(media|subtitle)$/.exec(rest);
    if (method === "POST" && reviewEpisodeSourceMatch) {
      const [, reviewProjectId, episodeNumberText, kind] = reviewEpisodeSourceMatch;
      const episodeNumber = numberBody(episodeNumberText, 0);
      const uploaded = await saveMultipartUpload(request, seriesId, `review-${kind}-upload`);
      try {
        if (kind === "media") {
          const imported = await importReviewEpisodeMedia({
            seriesId,
            reviewProjectId,
            episodeNumber,
            sourcePath: uploaded.path,
          });
          sendJson(response, 200, {
            ok: true,
            imported,
            reviewProject: await loadReviewProject(seriesId, reviewProjectId),
          });
          return;
        }
        const imported = await importReviewEpisodeSubtitle({
          seriesId,
          reviewProjectId,
          episodeNumber,
          sourcePath: uploaded.path,
          language: uploaded.fields.language || "zh",
        });
        sendJson(response, 200, {
          ok: true,
          imported,
          reviewProject: await loadReviewProject(seriesId, reviewProjectId),
        });
      } finally {
        await rm(uploaded.path, { force: true });
      }
      return;
    }
    const reviewEpisodeSceneMapMatch = /^review-projects\/([a-z0-9-]+)\/episodes\/(\d+)\/scene-map$/.exec(rest);
    if (method === "POST" && reviewEpisodeSceneMapMatch) {
      const [, reviewProjectId, episodeNumberText] = reviewEpisodeSceneMapMatch;
      const episodeNumber = numberBody(episodeNumberText, 0);
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      const episode = reviewProject.episodes.find((item) => item.episodeNumber === episodeNumber);
      if (!episode?.transcriptPath) {
        sendError(response, 409, {
          code: "transcript-required",
          message: `Episode ${episodeNumber} needs a transcript before scene mapping.`,
        });
        return;
      }
      const sceneMap = await saveReviewEpisodeSceneMap(seriesId, reviewProjectId, episodeNumber, episode.transcriptPath);
      sendJson(response, 200, {
        ok: true,
        sceneMap,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
      return;
    }
    const reviewEpisodeAnalysisMatch = /^review-projects\/([a-z0-9-]+)\/episodes\/(\d+)\/analysis$/.exec(rest);
    if (method === "POST" && reviewEpisodeAnalysisMatch) {
      const [, reviewProjectId, episodeNumberText] = reviewEpisodeAnalysisMatch;
      const episodeNumber = numberBody(episodeNumberText, 0);
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      const episode = reviewProject.episodes.find((item) => item.episodeNumber === episodeNumber);
      if (!episode?.sceneMapPath) {
        sendError(response, 409, {
          code: "scene-map-required",
          message: `Episode ${episodeNumber} needs a scene map before analysis.`,
        });
        return;
      }
      const saved = await saveEpisodeAnalysis(seriesId, reviewProjectId, episodeNumber, episode.sceneMapPath, {
        title: reviewProject.title,
        spoilerMode: reviewProject.spoilerMode,
      });
      const analysis = JSON.parse(await readFile(join("projects", seriesId, saved.analysisPath), "utf8")) as EpisodeAnalysis;
      sendJson(response, 200, {
        ok: true,
        analysis,
        saved,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
      return;
    }
    const reviewStoryArcMatch = /^review-projects\/([a-z0-9-]+)\/story-arc$/.exec(rest);
    if (method === "POST" && reviewStoryArcMatch) {
      const [, reviewProjectId] = reviewStoryArcMatch;
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      const missing = reviewProject.episodes.filter((episode) => !episode.analysisPath).map((episode) => episode.episodeNumber);
      if (missing.length > 0) {
        sendError(response, 409, {
          code: "analysis-required",
          message: `Episodes need analysis before story merge: ${missing.join(", ")}.`,
          details: { missingEpisodes: missing },
        });
        return;
      }
      const storyArc = await saveStoryArc(seriesId, reviewProjectId);
      sendJson(response, 200, {
        ok: true,
        storyArc,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
      return;
    }
    const reviewScriptMatch = /^review-projects\/([a-z0-9-]+)\/script$/.exec(rest);
    if (method === "POST" && reviewScriptMatch) {
      const [, reviewProjectId] = reviewScriptMatch;
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      if (!reviewProject.outputs.storyArc) {
        sendError(response, 409, {
          code: "story-arc-required",
          message: "Story arc is required before review script generation.",
        });
        return;
      }
      const saved = await saveReviewScript(seriesId, reviewProjectId);
      const script = JSON.parse(await readFile(join("projects", seriesId, saved.scriptPath), "utf8")) as ReviewScript;
      sendJson(response, 200, {
        ok: true,
        script,
        saved,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
      return;
    }
    const scriptSegmentMatch = /^review-projects\/([a-z0-9-]+)\/script\/segments\/(SEG-\d{3})$/.exec(rest);
    if (method === "PATCH" && scriptSegmentMatch) {
      const [, reviewProjectId, segmentId] = scriptSegmentMatch;
      const body = await readJsonBody(request);
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      const scriptPath = reviewProject.outputs.reviewScript;
      if (!scriptPath) {
        sendError(response, 409, {
          code: "script-required",
          message: "Review script is required before editing a segment.",
        });
        return;
      }
      const script = JSON.parse(await readFile(join("projects", seriesId, scriptPath), "utf8")) as ReviewScript;
      const updated = regenerateScriptSegment(script, segmentId, requiredString(body.narration, "narration"));
      await writeFile(join("projects", seriesId, scriptPath), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      sendJson(response, 200, { ok: true, script: updated, reviewProject });
      return;
    }
    const editingPlanMatch = /^review-projects\/([a-z0-9-]+)\/editing-plan$/.exec(rest);
    if (method === "POST" && editingPlanMatch) {
      const [, reviewProjectId] = editingPlanMatch;
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      if (!reviewProject.outputs.reviewScript) {
        sendError(response, 409, {
          code: "script-required",
          message: "Review script is required before editing plan generation.",
        });
        return;
      }
      const editingPlan = await saveEditingPlan(seriesId, reviewProjectId);
      sendJson(response, 200, {
        ok: true,
        editingPlan,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
      return;
    }
    const exportMatch = /^review-projects\/([a-z0-9-]+)\/export$/.exec(rest);
    if (method === "POST" && exportMatch) {
      const [, reviewProjectId] = exportMatch;
      const reviewProject = await loadReviewProject(seriesId, reviewProjectId);
      if (!reviewProject.outputs.editingPlan) {
        sendError(response, 409, {
          code: "editing-plan-required",
          message: "Editing plan is required before export.",
        });
        return;
      }
      const exported = await exportReviewPackage(seriesId, reviewProjectId);
      sendJson(response, 200, {
        ok: true,
        exported,
        reviewProject: await loadReviewProject(seriesId, reviewProjectId),
      });
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
    await sendProject(response, projectId);
    return;
  }

  if (method === "GET" && rest === "events") {
    await sendProjectEvents(response, projectId);
    return;
  }

  if (method === "GET" && rest === "edit-manifest") {
    try {
      sendJson(response, 200, { ok: true, manifest: await loadEditManifest(projectId) });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, { code: "edit-manifest-missing", message: "Create an edit manifest for this project first." });
      } else {
        throw error;
      }
    }
    return;
  }

  if (method === "POST" && rest === "edit-manifest") {
    const body = await readJsonBody(request);
    if (typeof body.source !== "string" || !body.source.trim()) {
      sendError(response, 400, { code: "edit-source-required", message: "A project-relative source SRT path is required." });
      return;
    }
    try {
      const manifest = await createEditManifest(projectId, body.source, { replace: body.replace === true });
      sendJson(response, 200, { ok: true, manifest });
    } catch (error: unknown) {
      if (error instanceof EditManifestConflictError) {
        sendError(response, 409, { code: "edit-manifest-exists", message: error.message });
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, { code: "edit-source-missing", message: "The source SRT file does not exist in this project." });
      } else if (error instanceof EditManifestInputError) {
        sendError(response, 400, { code: "edit-source-invalid", message: error.message });
      } else {
        throw error;
      }
    }
    return;
  }

  if (method === "POST" && rest === "edit-manifest/remove-list") {
    const body = await readJsonBody(request);
    try {
      const manifest = await applyRemoveSelection(projectId, typeof body.remove === "string" ? body.remove : "");
      sendJson(response, 200, { ok: true, manifest });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, { code: "edit-manifest-missing", message: "Create an edit manifest for this project first." });
      } else if (error instanceof EditSelectionError) {
        sendError(response, 400, { code: "edit-selection-invalid", message: error.message });
      } else {
        throw error;
      }
    }
    return;
  }

  if (method === "POST" && rest === "edit-manifest/export") {
    try {
      const exported = await exportEditManifest(projectId);
      sendJson(response, 200, { ok: true, exported });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, { code: "edit-manifest-missing", message: "Create an edit manifest for this project first." });
      } else {
        throw error;
      }
    }
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
    const scriptStatus = (await projectPipelineStatus(projectId)).script;
    if (scriptStatus !== "approved") {
      sendError(response, 409, {
        code: "script-approval-required",
        message: "Approve the current script before generating narration.",
        action: "approve-script",
        details: { reasons: [`script-approval-${scriptStatus === "stale" ? "stale" : "missing"}`] },
      });
      return;
    }
    await startProjectJob(response, projectId, "voice", () =>
      generateVoice({
        projectId,
        provider: voiceProvider(body.provider),
        voice: typeof body.voice === "string" ? body.voice : undefined,
        confirmedPaidRequest: body.confirmedPaidRequest === true,
      }));
    return;
  }

  if (method === "POST" && rest === "script") {
    const body = await readJsonBody(request);
    const config = await loadStudioConfig();
    // The offline template spends nothing, so a leftover `paid: true` beside
    // `provider: "dry-run"` must not raise a spend dialog for a local string.
    if (config.script.provider === "openai-compatible" && config.script.paid && body.confirmedPaidRequest !== true) {
      sendError(response, 409, {
        code: "paid-confirmation-required",
        message: "The configured script model is paid and requires explicit confirmation.",
        action: "confirm-paid-request",
      });
      return;
    }
    await startProjectJob(response, projectId, "script", ({ signal }) =>
      generateScript(projectId, {
        confirmedPaidRequest: body.confirmedPaidRequest === true,
        signal,
      }));
    return;
  }

  if (method === "POST" && rest === "script/approve") {
    await approveCurrentScript(projectId);
    sendJson(response, 200, { ok: true, state: await loadProjectState(projectId) });
    return;
  }

  if (method === "POST" && rest === "captions") {
    const artifact = await prepareCaptions(projectId);
    sendJson(response, 200, { ok: true, artifact });
    return;
  }

  if (method === "POST" && rest === "render") {
    const gate = await evaluateProjectRenderGate(projectId);
    if (!gate.allowed) {
      sendError(response, 409, {
        code: "render-gates-unmet",
        message: "Render cannot start until required approvals and artifacts are ready.",
        details: { reasons: gate.reasons },
      });
      return;
    }
    await startProjectJob(response, projectId, "render", () => renderDraftProject(projectId));
    return;
  }

  if (method === "POST" && rest === "edit-render") {
    const gate = await evaluateEditRenderGate(projectId);
    if (!gate.allowed) {
      sendError(response, 409, {
        code: "edit-render-gates-unmet",
        message: "The cut cannot start until rights are cleared and cues are kept.",
        details: { reasons: gate.reasons },
      });
      return;
    }
    await startProjectJob(response, projectId, "render", () => renderEditedCutProject(projectId));
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
      const analyzedAsset = await analyzeAsset(projectId, asset.id);
      sendJson(response, 200, { ok: true, asset: analyzedAsset });
    } finally {
      await rm(uploaded.path, { force: true });
    }
    return;
  }

  const assetAnalysisMatch = /^assets\/([a-zA-Z0-9-]+)\/analyze$/.exec(rest);
  if (method === "POST" && assetAnalysisMatch) {
    const asset = await analyzeAsset(projectId, assetAnalysisMatch[1]);
    sendJson(response, 200, { ok: true, asset });
    return;
  }

  if (method === "POST" && rest === "visual-mapping/generate") {
    const state = await loadProjectState(projectId);
    const captionsPath = state.artifacts.captions?.relativePath;
    if (!captionsPath) {
      sendError(response, 409, { code: "visual-mapping-missing-captions", message: "Generate captions before visual mapping." });
      return;
    }
    const captions = await readFile(resolveProjectPath(projectId, captionsPath), "utf8");
    const manifest = await loadAssetManifest(projectId);
    const mapping = generateVisualMapping(buildNarrationScenes(captions), manifest.assets);
    await saveVisualMapping(projectId, mapping);
    sendJson(response, 200, { ok: true, mapping });
    return;
  }

  if (method === "GET" && rest === "visual-mapping") {
    sendJson(response, 200, { ok: true, mapping: await loadVisualMapping(projectId) });
    return;
  }

  const mappingSegmentMatch = /^visual-mapping\/segments\/([a-zA-Z0-9-]+)$/.exec(rest);
  if (method === "PATCH" && mappingSegmentMatch) {
    const mapping = await loadVisualMapping(projectId);
    if (!mapping) {
      sendError(response, 404, { code: "visual-mapping-missing", message: "Generate visual mapping first." });
      return;
    }
    const segment = mapping.segments.find((candidate) => candidate.id === mappingSegmentMatch[1]);
    if (!segment) {
      sendError(response, 404, { code: "visual-mapping-segment-missing", message: "Mapping segment not found." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.assetId === "string" || body.assetId === null) segment.assetId = body.assetId as string | null;
    if (body.fitMode === "cover" || body.fitMode === "contain") segment.fitMode = body.fitMode;
    if (typeof body.sourceStartSeconds === "number") segment.sourceStartSeconds = Math.max(0, body.sourceStartSeconds);
    if (typeof body.sourceDurationSeconds === "number") segment.sourceDurationSeconds = Math.max(0, body.sourceDurationSeconds);
    if (typeof body.muteSourceAudio === "boolean") segment.muteSourceAudio = body.muteSourceAudio;
    const asset = (await loadAssetManifest(projectId)).assets.find((candidate) => candidate.id === segment.assetId);
    segment.mediaType = asset?.mediaType;
    segment.fallback = segment.assetId ? undefined : "generated-background";
    segment.selectionMode = "manual";
    mapping.status = "draft";
    await saveVisualMapping(projectId, mapping);
    sendJson(response, 200, { ok: true, segment, mapping });
    return;
  }

  if (method === "POST" && rest === "visual-mapping/approve") {
    const mapping = await loadVisualMapping(projectId);
    if (!mapping) {
      sendError(response, 404, { code: "visual-mapping-missing", message: "Generate visual mapping first." });
      return;
    }
    const manifest = await loadAssetManifest(projectId);
    const validation = validateVisualMapping(mapping, manifest.assets);
    if (!validation.valid) {
      sendError(response, 409, { code: "visual-mapping-invalid", message: validation.errors.join("; "), details: validation });
      return;
    }
    mapping.status = "approved";
    await saveVisualMapping(projectId, mapping);
    sendJson(response, 200, { ok: true, mapping });
    return;
  }

  const assetMetadataMatch = /^assets\/([a-zA-Z0-9-]+)$/.exec(rest);
  if (method === "PATCH" && assetMetadataMatch) {
    const body = await readJsonBody(request);
    const usagePurpose = typeof body.usagePurpose === "string" ? body.usagePurpose.trim() : "";
    if (!usagePurpose) {
      sendError(response, 400, {
        code: "asset-metadata-invalid",
        message: "Asset usage purpose is required.",
        action: "edit-asset-purpose",
      });
      return;
    }
    const asset = await updateAssetMetadata(projectId, assetMetadataMatch[1], {
      usagePurpose,
      rightsConfirmed: body.rightsConfirmed === true,
    });
    sendJson(response, 200, { ok: true, asset });
    return;
  }

  if (method === "POST" && rest === "assets/approve") {
    const manifest = await loadAssetManifest(projectId);
    const validation = validateAssetManifest(manifest);
    if (!validation.valid) {
      sendError(response, 409, {
        code: "asset-manifest-invalid",
        message: validation.errors.join("; "),
        action: "edit-asset-details",
        details: { errors: validation.errors },
      });
      return;
    }
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
    await startProjectJob(response, projectId, "asr", () =>
      generateSourceSrtFromAsr({
        projectId,
        provider:
          body.provider === "faster-whisper" || body.provider === "whisper-cpp" ? body.provider : undefined,
        audioRelativePath: typeof body.audio === "string" ? body.audio : undefined,
      }));
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

/**
 * Every source route reads its yt-dlp path and arguments from configuration.
 * Taking either from a request body would turn a same-origin POST into arbitrary
 * command execution, so no route here accepts them.
 */
async function ytDlpOptionsFromConfig(): Promise<YtDlpOptions> {
  const config = await loadStudioConfig();
  return { ytDlpPath: config.sources.ytDlpPath || undefined, ytDlpArgs: config.sources.ytDlpArgs };
}

async function routeSourceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  if (method === "GET" && url.pathname === "/api/sources") {
    sendJson(response, 200, { sources: await listCandidates() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/sources/search") {
    const body = await readJsonBody(request);
    const config = await loadStudioConfig();
    try {
      const results = await searchSourceMetadata(requiredString(body.query, "query"), {
        platform: sourceSearchPlatformBody(body.platform, config.sources.defaultSearchPlatform),
        limit: numberBody(body.limit, config.sources.searchLimit),
        ytDlpPath: config.sources.ytDlpPath || undefined,
        ytDlpArgs: config.sources.ytDlpArgs,
        searchPrefixes: config.sources.searchPrefixes,
      });
      sendJson(response, 200, { ok: true, results });
    } catch (error: unknown) {
      sendSourceError(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/sources") {
    const body = await readJsonBody(request);
    if (typeof body.url !== "string" || !body.url.trim()) {
      sendError(response, 400, { code: "source-url-required", message: "A source URL is required." });
      return;
    }
    try {
      const result = await addCandidate(body.url, await ytDlpOptionsFromConfig());
      sendJson(response, 200, { ok: true, created: result.created, candidate: result.candidate });
    } catch (error: unknown) {
      sendSourceError(response, error);
    }
    return;
  }

  const actionMatch = /^\/api\/sources\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (actionMatch) {
    const sourceId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];

    if (method === "GET" && action === "events") {
      await sendSourceEvents(response, sourceId);
      return;
    }

    if (method === "POST" && action === "score") {
      try {
        await requireCandidate(sourceId);
      } catch (error: unknown) {
        sendSourceError(response, error);
        return;
      }
      await startSourceJob(response, sourceId, "score", ({ signal }) => scoreCandidate(sourceId, { signal }));
      return;
    }

    if (method === "POST" && action === "download") {
      try {
        assertDownloadable(await requireCandidate(sourceId));
      } catch (error: unknown) {
        sendSourceError(response, error);
        return;
      }
      await startSourceJob(response, sourceId, "download", ({ signal, update }) =>
        downloadCandidate(sourceId, { signal, update }));
      return;
    }

    if (method === "POST" && action === "cancel") {
      const body = await readJsonBody(request);
      try {
        const job = await sourceJobs.cancel(sourceId, String(body.jobId ?? ""));
        // The manager clears its running entry inside the operation's finally,
        // which runs after the abort propagates. Returning before that leaves a
        // caller unable to act on its own cancellation — a delete issued next
        // would still be refused as busy.
        await sourceJobs.waitForIdle(sourceId);
        sendJson(response, 200, { ok: true, job });
      } catch (error: unknown) {
        sendError(response, 409, {
          code: "source-job-not-running",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    sendError(response, 404, { code: "not-found", message: "Unknown source route." });
    return;
  }

  const idMatch = /^\/api\/sources\/([^/]+)$/.exec(url.pathname);
  if (!idMatch) {
    sendError(response, 404, { code: "not-found", message: "Unknown source route." });
    return;
  }
  const sourceId = decodeURIComponent(idMatch[1]);

  if (method === "GET") {
    try {
      sendJson(response, 200, { candidate: await requireCandidate(sourceId) });
    } catch (error: unknown) {
      sendSourceError(response, error);
    }
    return;
  }

  if (method === "PATCH") {
    const body = await readJsonBody(request);
    try {
      const candidate = await setCandidateRights(
        sourceId,
        body.rights as SourceRights,
        typeof body.rightsNote === "string" ? body.rightsNote : "",
      );
      sendJson(response, 200, { ok: true, candidate });
    } catch (error: unknown) {
      sendSourceError(response, error);
    }
    return;
  }

  if (method === "DELETE") {
    // The job writes into the directory about to be removed, so it is stopped
    // deliberately rather than raced.
    if (sourceJobs.isBusy(sourceId)) {
      sendError(response, 409, {
        code: "source-job-running",
        message: "Cancel the running job before deleting this source.",
      });
      return;
    }
    try {
      await requireCandidate(sourceId);
      await rm(resolveSourcePath(sourceId), { recursive: true, force: true });
      sendJson(response, 200, { ok: true, id: sourceId });
    } catch (error: unknown) {
      sendSourceError(response, error);
    }
    return;
  }

  sendError(response, 405, { code: "method-not-allowed", message: `${method} is not allowed here.` });
}

function sendSourceError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /source search query|required/.test(message) ||
    /^Unsupported source search platform/.test(message) ||
    /does not have keyword search configured/.test(message)
  ) {
    sendError(response, 400, { code: "source-search-invalid", message });
    return;
  }
  if (/^No source candidate /.test(message) || /^Invalid source id/.test(message)) {
    sendError(response, 404, { code: "source-missing", message });
    return;
  }
  if (/^Unknown rights value/.test(message)) {
    sendError(response, 400, { code: "source-rights-invalid", message });
    return;
  }
  if (/already holds/.test(message)) {
    sendError(response, 409, { code: "source-id-collision", message });
    return;
  }
  if (/holds no candidate file/.test(message)) {
    sendError(response, 409, { code: "source-directory-occupied", message });
    return;
  }
  if (/sources\.ytDlpPath/.test(message)) {
    sendError(response, 400, { code: "source-tool-missing", message });
    return;
  }
  sendError(response, 400, { code: "source-request-failed", message });
}

async function sendProjects(response: ServerResponse): Promise<void> {
  const root = projectsRoot();
  let ids: string[] = [];
  try {
    const candidates = (await readdir(root, { withFileTypes: true }))
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
        await readFile(join(root, id, "brief.json"), "utf8");
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

async function sendProject(response: ServerResponse, projectId: string): Promise<void> {
  const briefPath = resolveProjectPath(projectId, "brief.json");
  const brief = JSON.parse(await readFile(briefPath, "utf8")) as unknown;
  const state = await loadProjectState(projectId);
  const assetManifest = await recoverInterruptedAnalysis(projectId);
  const visualMapping = await loadVisualMapping(projectId);
  const workflowType = typeof brief === "object" && brief !== null && "workflowType" in brief ? brief.workflowType : undefined;
  const template = getWorkflowTemplate(workflowType);
  sendJson(response, 200, {
    brief,
    state,
    metadata: await loadProjectMetadata(projectId),
    assetManifest,
    visualMapping,
    pipeline: await projectPipelineStatus(projectId),
    renderGate: await evaluateProjectRenderGate(projectId),
    editRenderGate: await evaluateEditRenderGate(projectId),
    workflow: {
      ...template,
      steps: deriveWorkflowStepStates(template.type, state),
    },
  });
}

/**
 * The generated metadata, including which provider and model actually wrote the
 * current script. Absent until a script has been generated, which the client
 * reports as such rather than falling back to the live configuration.
 */
async function loadProjectMetadata(projectId: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolveProjectPath(projectId, "metadata.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
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
    let writeDone: Promise<void> = Promise.resolve();

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
      writeDone = new Promise((resolveWrite, rejectWrite) => {
        output.on("finish", resolveWrite);
        output.on("error", rejectWrite);
      });
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
      writeDone.then(
        () => resolve({ path: outputPath, filename: originalName, mimeType, fields }),
        reject,
      );
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

function storyCharactersBody(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const candidate = item as Record<string, unknown>;
      return {
        name: typeof candidate.name === "string" ? candidate.name : "Unnamed",
        role: typeof candidate.role === "string" ? candidate.role : "supporting role",
        traits: Array.isArray(candidate.traits) ? candidate.traits.map(String) : [],
        voiceNotes: typeof candidate.voiceNotes === "string" ? candidate.voiceNotes : "",
      };
    });
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

function sourceSearchPlatformBody(value: unknown, fallback: SourceSearchPlatform): SourceSearchPlatform {
  if (value === "youtube" || value === "bilibili" || value === "tiktok" || value === "douyin") return value;
  if (value === undefined || value === null || value === "") return fallback;
  throw new Error(`Unsupported source search platform ${JSON.stringify(value)}.`);
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

function brandAssetType(value: unknown): BrandAssetType {
  if (
    value === "logo-round" ||
    value === "logo-text" ||
    value === "watermark" ||
    value === "reference" ||
    value === "background"
  ) {
    return value;
  }
  return "reference";
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return false;
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

export function resolveStaticFilePath(staticRoot: string, pathname: string): string | null {
  const relativePath = pathname === "/" ? "src/web/index.html" : `src/web${pathname}`;
  const root = resolve(staticRoot);
  const filePath = resolve(root, relativePath);

  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    return null;
  }
  return filePath;
}

async function sendStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const filePath = resolveStaticFilePath(staticRoot, pathname);

  if (!filePath) {
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
  response.write(`event: snapshot\ndata: ${JSON.stringify({ projectId, busy: jobs.isBusy(projectId) })}\n\n`);

  const unsubscribe = jobs.subscribe(projectId, (job) => {
    response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 3000);
  const running = await startStudioServer(createStudioServer(), { port });
  console.log(`YT Review Studio listening on ${running.url}`);
}
