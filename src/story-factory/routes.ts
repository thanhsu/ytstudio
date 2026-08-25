import { randomUUID } from "node:crypto";
import type { JobKind } from "../jobs.ts";
import { loadStudioConfig, type StudioConfig } from "../config.ts";
import { readAiLog } from "./ai-log.ts";
import { loadAnalytics } from "./analytics.ts";
import { deleteCalendarEntry, loadCalendar, upsertCalendarEntry } from "./calendar.ts";
import { loadPromptOverrides, savePromptOverride, PROMPT_CATALOG } from "./prompt-overrides.ts";
import { loadChannelCosts, loadStoryCost } from "./cost.ts";
import { exportStoryPackage, StoryApprovalRequiredError } from "./export.ts";
import { loadStoryChannel, saveStoryChannel, normalizeTtsProfile } from "./channel.ts";
import { classifyError, runSingleStage, runStoryPipeline, type StoryPipelineDeps } from "./pipeline.ts";
import { STAGE_ROLES } from "./stage-llm.ts";
import {
  approveStoryStage,
  createStory,
  deriveStoryStatus,
  invalidateDependents,
  listStories,
  loadStory,
  readStageArtifact,
  saveStory,
  saveStageRun,
  updateStory,
  writeStageArtifact,
  STAGE_ARTIFACT_FILES,
} from "./story-project.ts";
import { storyRelativePath } from "./paths.ts";
import { editSectionText, listSections, readSection } from "./section-edit.ts";
import { generateVoiceSample, listVoiceLabVoices } from "./voice-lab.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveProjectPath } from "../project-paths.ts";
import { createCompilation, exportCompilation, listCompilations, loadCompilation, renderCompilation, runCompilationMetadata } from "./compilation.ts";
import { isStoryStageId, type StoryApprovalStage, type StoryProject, type StoryStageId } from "./types.ts";
import { startYouTubePublish, type YouTubePublishInput } from "../youtube/publish.ts";
import { routeCanon, routeCanonChapter, type CanonRouteTools } from "../canon/routes.ts";
import { listProjectIds } from "../fs.ts";

/**
 * The story-factory HTTP surface, mounted inside the series router:
 * /api/series/:channelId/{story-channel | stories/... | voice-lab/...}.
 * Server-private helpers arrive injected as tools so they stay private.
 */

export type ApiErrorBody = {
  code: string;
  message: string;
  action?: string;
  details?: unknown;
};

export type StoryFactoryTools = {
  sendJson: (status: number, body: unknown) => void;
  sendError: (status: number, error: ApiErrorBody) => void;
  readBody: () => Promise<Record<string, unknown>>;
  startChannelJob: (
    kind: JobKind,
    operation: (context: {
      signal: AbortSignal;
      update: (progress: number, message: string) => Promise<void>;
    }) => Promise<unknown>,
    // Distinguishes concurrent jobs on the same channel (one per story) while
    // they still persist and stream under the shared channel owner.
    ownerSuffix?: string,
  ) => Promise<void>;
  startYouTubePublish?: (seriesId: string, input: YouTubePublishInput) => Promise<unknown>;
};

/** Artifacts an operator may edit by hand. Media manifests and QA reports are machine-owned. */
const EDITABLE_STAGES: StoryStageId[] = ["idea", "hook", "outline", "bible", "naturalize", "metadata"];

export async function routeStoryFactory(options: {
  method: string;
  rest: string;
  url: URL;
  channelId: string;
  tools: StoryFactoryTools;
}): Promise<void> {
  const { method, rest, url, channelId, tools } = options;
  const config = await loadStudioConfig();

  // The feature flag gates mutations; reads stay open so the UI can show state
  // (including the flag itself) without flipping anything on.
  if (method !== "GET" && !config.storyFactory.enabled) {
    tools.sendError(404, {
      code: "story-factory-disabled",
      message: "The story factory is disabled. Enable storyFactory.enabled in the studio config first.",
    });
    return;
  }

  if (rest === "story-channel") {
    if (method === "GET") {
      tools.sendJson(200, { ok: true, storyChannel: await loadStoryChannel(channelId) });
      return;
    }
    if (method === "PUT") {
      const body = await tools.readBody();
      tools.sendJson(200, { ok: true, storyChannel: await saveStoryChannel(channelId, body) });
      return;
    }
  }

  if (rest === "prompts" && method === "GET") {
    const overrides = await loadPromptOverrides(channelId);
    tools.sendJson(200, { ok: true, prompts: PROMPT_CATALOG.map((prompt) => ({ ...prompt, override: overrides.entries[prompt.name]?.system ?? null, overrideVersion: overrides.entries[prompt.name]?.updatedAt ?? null })) });
    return;
  }
  const promptMatch = /^prompts\/([^/]+)$/.exec(rest);
  if (promptMatch && method === "PUT") {
    const name = decodeURIComponent(promptMatch[1]);
    if (!PROMPT_CATALOG.some((prompt) => prompt.name === name)) {
      tools.sendError(404, { code: "unknown-prompt", message: `Unknown prompt ${name}.` });
      return;
    }
    const body = await tools.readBody();
    try {
      const overrides = await savePromptOverride(channelId, name, typeof body.system === "string" ? body.system : "");
      tools.sendJson(200, { ok: true, prompts: overrides });
    } catch (error: unknown) {
      tools.sendError(400, { code: "prompt-invalid", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (rest === "compilations" && method === "GET") {
    tools.sendJson(200, { ok: true, compilations: await listCompilations(channelId) });
    return;
  }
  if (rest === "compilations" && method === "POST") {
    const body = await tools.readBody();
    try {
      const compilation = await createCompilation(channelId, { id: String(body.id ?? ""), title: String(body.title ?? ""), storyIds: Array.isArray(body.storyIds) ? body.storyIds.map(String) : [] });
      tools.sendJson(200, { ok: true, compilation });
    } catch (error: unknown) {
      tools.sendError(400, { code: "compilation-invalid", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const compilationMatch = /^compilations\/([a-z0-9-]+)(?:\/(.*))?$/.exec(rest);
  if (compilationMatch) {
    const compilationId = compilationMatch[1];
    const compilationRest = compilationMatch[2] ?? "";
    if (!compilationRest && method === "GET") {
      tools.sendJson(200, { ok: true, compilation: await loadCompilation(channelId, compilationId) });
      return;
    }
    if (compilationRest === "render/run" && method === "POST") {
      await tools.startChannelJob("compilation-render", ({ signal, update }) => renderCompilation(channelId, compilationId, { config, signal, update }), `comp::${compilationId}`);
      return;
    }
    if (compilationRest === "metadata/run" && method === "POST") {
      const body = await tools.readBody();
      await runCompilationMetadata(channelId, compilationId, { config, confirmedPaidRequest: body.confirmedPaidRequest === true });
      tools.sendJson(200, { ok: true, compilation: await loadCompilation(channelId, compilationId) });
      return;
    }
    if (compilationRest === "approve/final" && method === "POST") {
      const compilation = await loadCompilation(channelId, compilationId);
      const render = await readFile(resolveProjectPath(channelId, "compilations", compilationId, "render.json"));
      const artifactHash = createHash("sha256").update(render).digest("hex");
      compilation.approvals.final = { artifactHash, approvedAt: new Date().toISOString(), note: "" };
      compilation.updatedAt = new Date().toISOString();
      await (await import("../fs.ts")).writeJson(resolveProjectPath(channelId, "compilations", compilationId, "compilation.json"), compilation);
      tools.sendJson(200, { ok: true, compilation });
      return;
    }
    if (compilationRest === "export" && method === "POST") {
      tools.sendJson(200, { ok: true, exported: await exportCompilation(channelId, compilationId) });
      return;
    }
  }

  if (rest === "calendar" && method === "GET") {
    tools.sendJson(200, { ok: true, calendar: await loadCalendar(channelId) });
    return;
  }
  if (rest === "calendar" && method === "POST") {
    const body = await tools.readBody();
    try {
      const calendar = await upsertCalendarEntry(channelId, {
        id: optionalString(body.id),
        date: String(body.date ?? ""),
        storyId: typeof body.storyId === "string" ? body.storyId : null,
        plannedPublishAt: typeof body.plannedPublishAt === "string" ? body.plannedPublishAt : null,
        note: typeof body.note === "string" ? body.note : "",
      });
      tools.sendJson(200, { ok: true, calendar });
    } catch (error: unknown) {
      tools.sendError(400, { code: "calendar-entry-invalid", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const calendarDelete = /^calendar\/([^/]+)$/.exec(rest);
  if (calendarDelete && method === "DELETE") {
    tools.sendJson(200, { ok: true, calendar: await deleteCalendarEntry(channelId, calendarDelete[1]) });
    return;
  }

  if (rest === "stories") {
    if (method === "GET") {
      const stories = await listStories(channelId);
      const rows = [];
      for (const story of stories) {
        const cost = await loadStoryCost(channelId, story.id);
        rows.push(storyRow(story, cost.totalUsd));
      }
      tools.sendJson(200, { ok: true, stories: rows });
      return;
    }
    if (method === "POST") {
      const body = await tools.readBody();
      const channel = await loadStoryChannel(channelId);
      try {
        const story = await createStory(channel, {
          id: String(body.id ?? ""),
          title: String(body.title ?? ""),
          niche: optionalString(body.niche),
          subNiche: optionalString(body.subNiche),
          targetDurationMinutes: optionalNumber(body.targetDurationMinutes),
          tone: optionalString(body.tone),
          mode: optionalString(body.mode),
        });
        tools.sendJson(200, { ok: true, story, status: deriveStoryStatus(story) });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists|required|must match/i.test(message)) {
          tools.sendError(400, { code: "story-create-invalid", message });
          return;
        }
        throw error;
      }
      return;
    }
  }

  if (rest === "voice-lab/voices" && method === "GET") {
    const languageCode = url.searchParams.get("languageCode") ?? "es-US";
    tools.sendJson(200, { ok: true, voices: await listVoiceLabVoices(languageCode, config) });
    return;
  }

  if (rest === "voice-lab/sample" && method === "POST") {
    const body = await tools.readBody();
    if (body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: "Generating a voice sample calls the paid Google TTS API.",
        action: "confirm-paid-request",
      });
      return;
    }
    const profile = normalizeTtsProfile({
      voiceName: body.voiceName,
      languageCode: body.languageCode,
      speakingRate: body.speakingRate,
      pitch: body.pitch,
      tier: body.tier,
    });
    if (!profile.voiceName) {
      tools.sendError(400, { code: "voice-required", message: "voiceName is required for a sample." });
      return;
    }
    const sample = await generateVoiceSample(channelId, profile, String(body.text ?? ""), config);
    tools.sendJson(200, {
      ok: true,
      sample: {
        url: `/api/projects/${channelId}/files/${sample.artifact.relativePath}`,
        relativePath: sample.artifact.relativePath,
        durationSeconds: sample.artifact.durationSeconds,
        estimatedCostUsd: sample.estimatedCostUsd,
      },
    });
    return;
  }

  // Canon series entities. Chapters need no routes of their own: a canon
  // chapter is a StoryProject, so the `stories/...` endpoints below already
  // cover its stage runs, artifacts, approvals, AI log, and cost.
  if (rest.startsWith("canon/")) {
    const handled = await routeCanon({
      method,
      rest: rest.slice("canon/".length),
      url,
      seriesId: channelId,
      config,
      tools: canonTools(tools),
    });
    if (handled) return;
  }

  const storyMatch = /^stories\/([a-z0-9-]+)(?:\/(.+))?$/.exec(rest);
  if (storyMatch) {
    const storyId = storyMatch[1];
    const storyRest = storyMatch[2] ?? "";
    await routeStory({ method, storyRest, channelId, storyId, config, tools });
    return;
  }

  tools.sendError(404, { code: "not-found", message: "Story factory route not found." });
}

async function routeStory(options: {
  method: string;
  storyRest: string;
  channelId: string;
  storyId: string;
  config: StudioConfig;
  tools: StoryFactoryTools;
}): Promise<void> {
  const { method, storyRest, channelId, storyId, config, tools } = options;

  let story: StoryProject;
  try {
    story = await loadStory(channelId, storyId);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      tools.sendError(404, { code: "story-not-found", message: `Story ${storyId} does not exist on this channel.` });
      return;
    }
    throw error;
  }

  if (storyRest === "" && method === "GET") {
    const cost = await loadStoryCost(channelId, storyId);
    tools.sendJson(200, {
      ok: true,
      story,
      status: deriveStoryStatus(story),
      totalCostUsd: cost.totalUsd,
      artifacts: artifactPaths(story),
    });
    return;
  }

  if (storyRest === "analytics" && method === "GET") {
    const analytics = await loadAnalytics(channelId, storyId);
    if (!analytics) {
      tools.sendError(404, { code: "analytics-missing", message: "No analytics snapshots exist for this story yet." });
      return;
    }
    tools.sendJson(200, { ok: true, analytics });
    return;
  }

  if (storyRest === "" && method === "PATCH") {
    const body = await tools.readBody();
    const updated = await updateStory(channelId, storyId, {
      title: optionalString(body.title),
      subNiche: optionalString(body.subNiche),
      targetDurationMinutes: optionalNumber(body.targetDurationMinutes),
      tone: optionalString(body.tone),
      mode: optionalString(body.mode),
      maxCostPerStoryUsd: optionalNumber(body.maxCostPerStoryUsd),
    });
    tools.sendJson(200, { ok: true, story: updated, status: deriveStoryStatus(updated) });
    return;
  }

  if (storyRest === "sections" && method === "GET") {
    const sections = await listSections(channelId, storyId);
    tools.sendJson(200, {
      ok: true,
      sections: sections.map((section) => ({
        index: section.index,
        title: section.title,
        wordCount: section.wordCount,
      })),
    });
    return;
  }

  const sectionMatch = /^sections\/(\d+)$/.exec(storyRest);
  if (sectionMatch) {
    const index = Number(sectionMatch[1]);
    if (method === "GET") {
      const section = await readSection(channelId, storyId, index);
      if (!section) {
        tools.sendError(404, { code: "section-not-found", message: `Section ${index} does not exist.` });
        return;
      }
      tools.sendJson(200, { ok: true, section });
      return;
    }
    if (method === "PUT") {
      const body = await tools.readBody();
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        tools.sendError(400, { code: "section-text-required", message: "text is required." });
        return;
      }
      try {
        const { section, invalidated } = await editSectionText(channelId, storyId, index, text);
        tools.sendJson(200, { ok: true, section, invalidated });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          tools.sendError(404, { code: "section-not-found", message });
          return;
        }
        throw error;
      }
      return;
    }
  }

  const artifactMatch = /^artifacts\/([a-z-]+)$/.exec(storyRest);
  if (artifactMatch) {
    const stage = artifactMatch[1];
    if (!isStoryStageId(stage)) {
      tools.sendError(404, { code: "unknown-stage", message: `Unknown stage ${stage}.` });
      return;
    }
    if (method === "GET") {
      const artifact = await readStageArtifact(channelId, storyId, stage);
      if (artifact === null) {
        tools.sendError(404, { code: "artifact-missing", message: `Stage ${stage} has produced no artifact yet.` });
        return;
      }
      tools.sendJson(200, { ok: true, artifact });
      return;
    }
    if (method === "PUT") {
      if (!EDITABLE_STAGES.includes(stage)) {
        tools.sendError(400, {
          code: "stage-not-editable",
          message: `Stage ${stage} is machine-owned. Editable stages: ${EDITABLE_STAGES.join(", ")}.`,
        });
        return;
      }
      const body = await tools.readBody();
      // Edits go through the same write path as generation, so the artifact
      // hash updates and every hash-bound approval on it goes stale honestly.
      const { story: updated } = await writeStageArtifact(channelId, storyId, stage, body);
      const invalidated = invalidateDependents(updated, stage);
      await saveStory(updated);
      tools.sendJson(200, { ok: true, artifact: body, invalidated });
      return;
    }
  }

  if (storyRest === "pipeline/run" && method === "POST") {
    const body = await tools.readBody();
    if (body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: "A full pipeline run calls paid LLM, TTS, and image APIs.",
        action: "confirm-paid-request",
      });
      return;
    }
    const toStage = optionalString(body.toStage);
    if (toStage !== undefined && !isStoryStageId(toStage)) {
      tools.sendError(400, { code: "unknown-stage", message: `Unknown toStage ${toStage}.` });
      return;
    }
    await tools.startChannelJob("story-pipeline", async ({ signal, update }) => {
      const outcome = await runStoryPipeline(channelId, storyId, buildDeps(config, signal, update), {
        toStage: toStage as StoryStageId | undefined,
      });
      return outcome.paused
        ? { paused: outcome.paused, status: deriveStoryStatus(outcome.story) }
        : { completed: true, status: deriveStoryStatus(outcome.story) };
    }, storyId);
    return;
  }

  const stageRunMatch = /^stages\/([a-z-]+)\/run$/.exec(storyRest);
  if (stageRunMatch && method === "POST") {
    const stage = stageRunMatch[1];
    if (!isStoryStageId(stage) || stage === "export" || stage === "publish") {
      tools.sendError(404, { code: "unknown-stage", message: `Unknown runnable stage ${stage}.` });
      return;
    }
    const body = await tools.readBody();
    if (stageNeedsPaidConfirmation(stage, config) && body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: `Stage ${stage} calls a paid API.`,
        action: "confirm-paid-request",
      });
      return;
    }
    const sectionIndex = optionalNumber(body.sectionIndex);
    await tools.startChannelJob("story-stage", async ({ signal, update }) => {
      const outcome = await runSingleStage(channelId, storyId, stage, buildDeps(config, signal, update), {
        regenerate: body.regenerate === true,
        sectionIndex,
      });
      return { completed: outcome.completed, paused: outcome.paused, status: deriveStoryStatus(outcome.story) };
    }, storyId);
    return;
  }

  if (storyRest === "publish" && method === "POST") {
    const body = await tools.readBody();
    const input: YouTubePublishInput = {
      sourceKind: "story",
      sourceId: storyId,
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      thumbnailPath: typeof body.thumbnailPath === "string" ? body.thumbnailPath : undefined,
      exportPath: typeof body.exportPath === "string" ? body.exportPath : undefined,
      privacyStatus: body.privacyStatus as YouTubePublishInput["privacyStatus"],
      publishAt: typeof body.publishAt === "string" ? body.publishAt : undefined,
    };
    try {
      const job = await (tools.startYouTubePublish ?? ((series, publishInput) => startYouTubePublish(series, publishInput)))(channelId, input);
      tools.sendJson(202, { ok: true, job });
    } catch (error: unknown) {
      const typed = error as { code?: string; action?: string; matrix?: unknown };
      tools.sendError(typed.code === "source-not-found" ? 404 : 409, {
        code: typed.code ?? "youtube-publish-failed",
        message: error instanceof Error ? error.message : "YouTube publish failed.",
        ...(typed.action ? { action: typed.action } : {}),
        ...(typed.matrix ? { details: { matrix: typed.matrix } } : {}),
      });
    }
    return;
  }

  const chunkRetryMatch = /^tts\/chunks\/(\d+)\/retry$/.exec(storyRest);
  if (chunkRetryMatch && method === "POST") {
    const body = await tools.readBody();
    if (body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: "Retrying a narration chunk calls the paid Google TTS API.",
        action: "confirm-paid-request",
      });
      return;
    }
    const chunkIndex = Number(chunkRetryMatch[1]);
    await tools.startChannelJob("story-stage", async ({ signal, update }) => {
      const outcome = await runSingleStage(channelId, storyId, "tts", buildDeps(config, signal, update), {
        chunkIndex,
      });
      return { completed: outcome.completed, status: deriveStoryStatus(outcome.story) };
    }, storyId);
    return;
  }

  const imageRetryMatch = /^images\/([A-Za-z0-9-]+)\/retry$/.exec(storyRest);
  if (imageRetryMatch && method === "POST") {
    const body = await tools.readBody();
    if (body.confirmedPaidRequest !== true) {
      tools.sendError(409, {
        code: "paid-confirmation-required",
        message: "Retrying a scene image calls the paid image API.",
        action: "confirm-paid-request",
      });
      return;
    }
    const sceneId = imageRetryMatch[1];
    await tools.startChannelJob("story-stage", async ({ signal, update }) => {
      const outcome = await runSingleStage(channelId, storyId, "images", buildDeps(config, signal, update), {
        sceneId,
      });
      return { completed: outcome.completed, status: deriveStoryStatus(outcome.story) };
    }, storyId);
    return;
  }

  // Canon-specific chapter verbs the generic story routes have no notion of.
  if (storyRest === "lock" || storyRest === "unlock" || storyRest === "publish-variants") {
    const handled = await routeCanonChapter({
      method,
      rest: storyRest,
      seriesId: channelId,
      chapterId: storyId,
      tools: canonTools(tools),
    });
    if (handled) return;
  }

  const approveMatch = /^approve\/(script|media|final|canon)$/.exec(storyRest);
  if (approveMatch && method === "POST") {
    const body = await tools.readBody();
    try {
      const updated = await approveStoryStage(
        channelId,
        storyId,
        approveMatch[1] as StoryApprovalStage,
        optionalString(body.note) ?? "",
      );
      tools.sendJson(200, { ok: true, story: updated, status: deriveStoryStatus(updated) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no completed artifact/.test(message)) {
        tools.sendError(409, { code: "approval-anchor-missing", message });
        return;
      }
      throw error;
    }
    return;
  }

  if (storyRest === "export" && method === "POST") {
    try {
      const exported = await exportStoryPackage(channelId, storyId);
      tools.sendJson(200, { ok: true, exported });
    } catch (error: unknown) {
      if (error instanceof StoryApprovalRequiredError) {
        tools.sendError(409, {
          code: "approval-required",
          message: error.message,
          details: { missing: error.missing },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (storyRest === "ai-log" && method === "GET") {
    tools.sendJson(200, { ok: true, entries: await readAiLog(channelId, storyId) });
    return;
  }

  if (storyRest === "cost" && method === "GET") {
    tools.sendJson(200, {
      ok: true,
      cost: await loadStoryCost(channelId, storyId),
      channelTotals: await loadChannelCosts(channelId),
    });
    return;
  }

  tools.sendError(404, { code: "not-found", message: "Story route not found." });
}

function buildDeps(
  config: StudioConfig,
  signal: AbortSignal,
  update: (progress: number, message: string) => Promise<void>,
): StoryPipelineDeps {
  // Sub-stage messages arrive without a progress number; keep the last one so
  // the bar never jumps backwards.
  let lastProgress = 0;
  return {
    config,
    confirmedPaidRequest: true,
    signal,
    update: async (progress, message) => {
      if (progress >= 0) lastProgress = progress;
      await update(lastProgress, message);
    },
  };
}

/** Stages that spend money: LLM stages on paid endpoints, plus TTS and images. */
function stageNeedsPaidConfirmation(stage: StoryStageId, config: StudioConfig): boolean {
  const role = STAGE_ROLES[stage];
  if (role) {
    return config.storyFactory.models[role].paid;
  }
  return stage === "tts" || stage === "images" || stage === "thumbnail";
}

function storyRow(story: StoryProject, totalCostUsd: number): Record<string, unknown> {
  return {
    id: story.id,
    channelId: story.channelId,
    title: story.title,
    niche: story.config.niche,
    subNiche: story.config.subNiche,
    language: story.config.language,
    locale: story.config.locale,
    mode: story.config.mode,
    targetDurationMinutes: story.config.targetDurationMinutes,
    status: deriveStoryStatus(story),
    totalCostUsd,
    updatedAt: story.updatedAt,
  };
}

/** Stage → channel-relative artifact path, for the existing project files route. */
function artifactPaths(story: StoryProject): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [stage, file] of Object.entries(STAGE_ARTIFACT_FILES)) {
    if (story.stages[stage as StoryStageId]?.artifactHash) {
      result[stage] = storyRelativePath(story.id, file);
    }
  }
  return result;
}

/**
 * The canon routes need one capability the story tools do not carry: the list
 * of project ids, so a series can discover which channels publish it.
 */
function canonTools(tools: StoryFactoryTools): CanonRouteTools {
  return {
    sendJson: tools.sendJson,
    sendError: tools.sendError,
    readBody: tools.readBody,
    startChannelJob: tools.startChannelJob,
    listProjectIds,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(number) ? number : undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
