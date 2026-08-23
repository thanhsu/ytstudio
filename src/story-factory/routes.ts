import type { JobKind } from "../jobs.ts";
import { loadStudioConfig, type StudioConfig } from "../config.ts";
import { readAiLog } from "./ai-log.ts";
import { loadChannelCosts, loadStoryCost } from "./cost.ts";
import { exportStoryPackage, StoryApprovalRequiredError } from "./export.ts";
import { loadStoryChannel, saveStoryChannel, normalizeTtsProfile } from "./channel.ts";
import { runSingleStage, runStoryPipeline, type StoryPipelineDeps } from "./pipeline.ts";
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
  updateStory,
  writeStageArtifact,
  STAGE_ARTIFACT_FILES,
} from "./story-project.ts";
import { storyRelativePath } from "./paths.ts";
import { generateVoiceSample, listVoiceLabVoices } from "./voice-lab.ts";
import { isStoryStageId, type StoryApprovalStage, type StoryProject, type StoryStageId } from "./types.ts";

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
  startChannelJob: (kind: JobKind, operation: (context: {
    signal: AbortSignal;
    update: (progress: number, message: string) => Promise<void>;
  }) => Promise<unknown>) => Promise<void>;
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
    });
    return;
  }

  const stageRunMatch = /^stages\/([a-z-]+)\/run$/.exec(storyRest);
  if (stageRunMatch && method === "POST") {
    const stage = stageRunMatch[1];
    if (!isStoryStageId(stage) || stage === "export") {
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
    });
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
    });
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
    });
    return;
  }

  const approveMatch = /^approve\/(script|media|final)$/.exec(storyRest);
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
