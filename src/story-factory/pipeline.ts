import type { StudioConfig } from "../config.ts";
import { createConfiguredImageProvider } from "../images/gemini.ts";
import type { ImageProvider } from "../images/types.ts";
import { probeDuration as probeDurationDefault } from "../media.ts";
import { runProcess } from "../process.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { createGoogleTtsProvider } from "../tts/google.ts";
import type { TtsProvider } from "../tts/types.ts";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadStoryChannel } from "./channel.ts";
import { assertWithinBudget, addStoryCost, BudgetExceededError, estimateGoogleTtsCost } from "./cost.ts";
import { StoryContentError } from "./errors.ts";
import type { RenderStageArtifact } from "./export.ts";
import { storyPath, storyRelativePath } from "./paths.ts";
import { buildBgmPlan } from "./bgm.ts";
import { renderStoryVideo, buildStorySegments } from "./render-story.ts";
import type { ChatFn } from "./stage-llm.ts";
import { STAGE_ROLES } from "./stage-llm.ts";
import { runBibleStage } from "./stages/bible.ts";
import { runContinuityStage } from "./stages/continuity-qa.ts";
import type { StageContext } from "./stages/context.ts";
import { runFinalQaStage } from "./stages/final-qa.ts";
import { runHookStage } from "./stages/hook.ts";
import { runIdeaStage } from "./stages/idea.ts";
import { runMetadataStage } from "./stages/metadata.ts";
import { runNaturalizeStage } from "./stages/naturalize.ts";
import { runOriginalityStage } from "./stages/originality-qa.ts";
import { runOutlineStage } from "./stages/outline.ts";
import { runScenesStage } from "./stages/scenes.ts";
import { runSectionsStage } from "./stages/sections.ts";
import {
  approvalState,
  approveStoryStage,
  emptyStageRun,
  writeStageArtifact,
  invalidateDependents,
  loadStory,
  readStageArtifact,
  saveStageRun,
  saveStory,
} from "./story-project.ts";
import { generateThumbnail } from "./thumbnail.ts";
import { buildTtsNormalizedText } from "./tts-normalize.ts";
import {
  buildChunkCaptionsSrt,
  buildChunkManifest,
  buildConcatList,
  buildMergeArgs,
  synthesizeChunks,
} from "./tts-chunking.ts";
import { googleTtsConfigFromStudio } from "./voice-lab.ts";
import type {
  ImageManifest,
  NaturalizedScript,
  SceneList,
  StageErrorClassification,
  StoryApprovalStage,
  StoryMetadataArtifact,
  StoryProject,
  StoryStageId,
  TtsChunkManifest,
  TtsNormalizedText,
} from "./types.ts";
import { STORY_STAGES } from "./types.ts";

/**
 * The resumable orchestrator. "Generate Full Story" runs every stage in order,
 * skipping the ones already done and non-stale, pausing at human gates in
 * manual mode, and failing with a classification the operator can act on.
 * Export is deliberately NOT in the pipeline: packaging for publish is always
 * a human click, per the studio's approval rule.
 */

export const PIPELINE_STAGES: StoryStageId[] = STORY_STAGES.filter((stage) => stage !== "export");

export type StoryPipelineDeps = {
  config: StudioConfig;
  chat?: ChatFn;
  ttsProvider?: TtsProvider;
  imageProvider?: ImageProvider;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  probeDuration?: (filePath: string) => Promise<number>;
  confirmedPaidRequest: boolean;
  signal?: AbortSignal;
  update?: (progress: number, message: string) => Promise<void>;
};

export type PipelineOutcome = {
  story: StoryProject;
  /** Set when a human gate stopped the run — the job still succeeded. */
  paused?: { stage: StoryStageId; approval: StoryApprovalStage };
  completed: boolean;
};

export function classifyError(error: unknown): StageErrorClassification {
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof StoryContentError) return "content";
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|rate limit|429/i.test(message)) return "quota";
  if (/status 5\d\d|unreachable|econn|etimedout|network|abort/i.test(message)) return "retryable";
  return "provider";
}

export type SingleStageOptions = {
  regenerate?: boolean;
  sectionIndex?: number;
  chunkIndex?: number;
  sceneId?: string;
};

export async function runStoryPipeline(
  channelId: string,
  storyId: string,
  deps: StoryPipelineDeps,
  options: { toStage?: StoryStageId } = {},
): Promise<PipelineOutcome> {
  for (const [index, stage] of PIPELINE_STAGES.entries()) {
    const story = await loadStory(channelId, storyId);
    const run = story.stages[stage] ?? emptyStageRun();
    if (run.status !== "done") {
      const gate = gateFor(stage);
      if (gate) {
        const passed = await ensureGate(channelId, storyId, gate, stage, deps);
        if (!passed) {
          return { story: await loadStory(channelId, storyId), paused: { stage, approval: gate }, completed: false };
        }
      }
      await deps.update?.(
        Math.round((index / PIPELINE_STAGES.length) * 100),
        `Stage ${stage} (${index + 1}/${PIPELINE_STAGES.length})...`,
      );
      await executeGuarded(channelId, storyId, stage, deps, {});
    }
    if (options.toStage === stage) {
      break;
    }
  }
  await deps.update?.(100, "Pipeline finished.");
  return { story: await loadStory(channelId, storyId), completed: true };
}

/** Run exactly one stage; regenerate resets it and marks dependents stale first. */
export async function runSingleStage(
  channelId: string,
  storyId: string,
  stage: StoryStageId,
  deps: StoryPipelineDeps,
  options: SingleStageOptions = {},
): Promise<PipelineOutcome> {
  if (stage === "export") {
    throw new Error("Export is packaged through its own endpoint after approvals, never as a pipeline stage.");
  }
  if (options.regenerate) {
    const story = await loadStory(channelId, storyId);
    story.stages[stage] = emptyStageRun();
    invalidateDependents(story, stage);
    await saveStory(story);
  }
  const gate = gateFor(stage);
  if (gate) {
    const passed = await ensureGate(channelId, storyId, gate, stage, deps);
    if (!passed) {
      return { story: await loadStory(channelId, storyId), paused: { stage, approval: gate }, completed: false };
    }
  }
  await executeGuarded(channelId, storyId, stage, deps, options);
  return { story: await loadStory(channelId, storyId), completed: true };
}

/** Which approval must be in place before a stage may run. */
function gateFor(stage: StoryStageId): StoryApprovalStage | null {
  if (stage === "tts-normalize") return "script";
  if (stage === "render") return "media";
  return null;
}

/**
 * Gate resolution: an existing fresh approval passes; assisted mode grants the
 * approval automatically when the matching QA actually passed; otherwise the
 * gated stage is parked awaiting-approval and the pipeline stops cleanly.
 */
async function ensureGate(
  channelId: string,
  storyId: string,
  approval: StoryApprovalStage,
  gatedStage: StoryStageId,
  deps: StoryPipelineDeps,
): Promise<boolean> {
  const story = await loadStory(channelId, storyId);
  if (approvalState(story, approval) === "approved") {
    return true;
  }
  if (story.config.mode === "assisted" && (await gateQaPassed(channelId, storyId, approval))) {
    await approveStoryStage(channelId, storyId, approval, "Auto-approved: assisted mode, QA passed.");
    return true;
  }
  await saveStageRun(channelId, storyId, gatedStage, { status: "awaiting-approval" });
  await deps.update?.(0, `Paused for ${approval} approval.`);
  return false;
}

async function gateQaPassed(channelId: string, storyId: string, approval: StoryApprovalStage): Promise<boolean> {
  if (approval === "script") {
    const report = await readStageArtifact<{ publishable?: boolean }>(channelId, storyId, "originality-qa");
    return report?.publishable === true;
  }
  if (approval === "media") {
    const images = await readStageArtifact<ImageManifest>(channelId, storyId, "images");
    return Boolean(images && images.images.length > 0 && images.images.every((image) => image.status === "done"));
  }
  return false;
}

/** Mark running, execute, mark done/failed with classification — one place. */
async function executeGuarded(
  channelId: string,
  storyId: string,
  stage: StoryStageId,
  deps: StoryPipelineDeps,
  options: SingleStageOptions,
): Promise<void> {
  const story = await loadStory(channelId, storyId);
  const previous = story.stages[stage] ?? emptyStageRun();
  await saveStageRun(channelId, storyId, stage, {
    status: "running",
    attemptCount: previous.attemptCount + 1,
    startedAt: new Date().toISOString(),
    lastError: undefined,
    ...(STAGE_ROLES[stage] ? { model: deps.config.storyFactory.models[STAGE_ROLES[stage]].model } : {}),
  });
  const ctx = await buildStageContext(channelId, storyId, deps);
  try {
    // The budget guard runs inside the guarded block so a blocked stage is
    // recorded as failed(budget) on the stage itself — that is what derives
    // the BUDGET_PAUSED story status. LLM stages check with a zero estimate
    // (spend is only known after the call); media stages add concrete
    // estimates of their own before spending.
    await assertWithinBudget(channelId, storyId, story.config.budget.maxCostPerStoryUsd, 0);
    await executeStage(stage, ctx, options);
  } catch (error: unknown) {
    await saveStageRun(channelId, storyId, stage, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      lastError: {
        message: error instanceof Error ? error.message : String(error),
        classification: classifyError(error),
      },
    });
    throw error;
  }
  await saveStageRun(channelId, storyId, stage, { status: "done", finishedAt: new Date().toISOString() });
}

async function buildStageContext(channelId: string, storyId: string, deps: StoryPipelineDeps): Promise<StageContext> {
  return {
    channelId,
    storyId,
    channel: await loadStoryChannel(channelId),
    story: await loadStory(channelId, storyId),
    config: deps.config,
    chat: deps.chat,
    ttsProvider: deps.ttsProvider,
    imageProvider: deps.imageProvider,
    ffmpegPath: deps.ffmpegPath,
    ffmpegPrefixArgs: deps.ffmpegPrefixArgs,
    probeDuration: deps.probeDuration,
    confirmedPaidRequest: deps.confirmedPaidRequest,
    signal: deps.signal,
    update: async (message) => deps.update?.(-1, message),
  };
}

async function executeStage(stage: StoryStageId, ctx: StageContext, options: SingleStageOptions): Promise<void> {
  switch (stage) {
    case "idea":
      await runIdeaStage(ctx);
      return;
    case "hook":
      await runHookStage(ctx);
      return;
    case "outline":
      await runOutlineStage(ctx);
      return;
    case "bible":
      await runBibleStage(ctx);
      return;
    case "sections":
      await runSectionsStage(ctx, {
        regenerateIndex: options.sectionIndex,
        // A whole-stage regenerate must not silently reuse the section files on
        // disk — that would "regenerate" into an identical script.
        regenerateAll: options.regenerate === true && options.sectionIndex === undefined,
      });
      return;
    case "continuity-qa":
      await runContinuityStage(ctx);
      return;
    case "naturalize":
      await runNaturalizeStage(ctx);
      return;
    case "originality-qa":
      await runOriginalityStage(ctx);
      return;
    case "tts-normalize":
      await runTtsNormalizeStage(ctx);
      return;
    case "tts":
      await runTtsStage(ctx, options.chunkIndex);
      return;
    case "scenes":
      await runScenesStage(ctx);
      return;
    case "images":
      await runImagesStage(ctx, options.sceneId);
      return;
    case "bgm":
      await runBgmStage(ctx);
      return;
    case "render":
      await runRenderStage(ctx);
      return;
    case "thumbnail":
      await runThumbnailStage(ctx);
      return;
    case "metadata":
      await runMetadataStage(ctx);
      return;
    case "final-qa":
      await runFinalQaStage(ctx);
      return;
    default:
      throw new Error(`Stage ${stage} has no executor.`);
  }
}

// ---------------------------------------------------------------------------
// Media stages — they orchestrate the provider modules built in earlier layers.
// ---------------------------------------------------------------------------

async function runTtsNormalizeStage(ctx: StageContext): Promise<void> {
  const naturalized = await readStageArtifact<NaturalizedScript>(ctx.channelId, ctx.storyId, "naturalize");
  if (!naturalized) {
    throw new Error("TTS normalization needs a completed naturalized script.");
  }
  const artifact = buildTtsNormalizedText(
    naturalized.fullText,
    ctx.channel.pronunciations,
    ctx.story.config.locale,
  );
  await writeStageArtifact(ctx.channelId, ctx.storyId, "tts-normalize", artifact);
}

async function runTtsStage(ctx: StageContext, onlyChunkIndex?: number): Promise<void> {
  const normalized = await readStageArtifact<TtsNormalizedText>(ctx.channelId, ctx.storyId, "tts-normalize");
  if (!normalized) {
    throw new Error("TTS needs the normalized narration text.");
  }
  const googleConfig = ctx.config.tts.google;
  const profile = ctx.story.config.ttsProfile;
  if (!profile.voiceName) {
    throw new Error(
      "The story's TTS profile has no voiceName. Pick a voice in the Voice Lab and set it as the channel default.",
    );
  }

  const manifest = buildChunkManifest(normalized.text, profile, {
    limits: { minChars: googleConfig.chunkMinChars, maxChars: googleConfig.chunkMaxChars },
    audioEncoding: googleConfig.audioEncoding,
    mergedPath: storyRelativePath(ctx.storyId, "workspace", "voice", "narration.m4a"),
    captionsPath: storyRelativePath(ctx.storyId, "workspace", "voice", "narration-captions.srt"),
  });
  // Resume: chunks already synthesized under the same cache key keep their state.
  const existing = await readStageArtifact<TtsChunkManifest>(ctx.channelId, ctx.storyId, "tts");
  if (existing) {
    const byKey = new Map(existing.chunks.map((chunk) => [chunk.cacheKey, chunk]));
    for (const chunk of manifest.chunks) {
      const match = byKey.get(chunk.cacheKey);
      if (match && match.status === "done") {
        chunk.status = "done";
        chunk.durationSeconds = match.durationSeconds;
        chunk.relativePath = match.relativePath;
      } else if (match) {
        chunk.attemptCount = match.attemptCount;
        chunk.lastError = match.lastError;
      }
    }
  }

  const pendingChars = manifest.chunks
    .filter((chunk) => chunk.status !== "done")
    .reduce((sum, chunk) => sum + chunk.chars, 0);
  const estimate = estimateGoogleTtsCost(pendingChars, profile.tier, googleConfig.pricing);
  await assertWithinBudget(ctx.channelId, ctx.storyId, ctx.story.config.budget.maxCostPerStoryUsd, estimate.totalUsd);

  const persist = async (value: TtsChunkManifest) => {
    await writeStageArtifact(ctx.channelId, ctx.storyId, "tts", value);
  };
  const provider = ctx.ttsProvider ?? createGoogleTtsProvider(googleTtsConfigFromStudio(ctx.config));
  const perChar = googleConfig.pricing[profile.tier] / 1_000_000;
  await synthesizeChunks(ctx.channelId, manifest, provider, {
    persist,
    signal: ctx.signal,
    update: async (completed, total) => ctx.update?.(`Narration chunk ${completed}/${total} ready.`),
    onlyIndex: onlyChunkIndex,
    onGenerated: async (chunk) => {
      await addStoryCost(ctx.channelId, ctx.storyId, { kind: "tts", usd: chunk.chars * perChar });
    },
  });

  // Merge + loudness normalize, then measure the real total duration.
  const mergedAbsolute = resolveProjectPath(ctx.channelId, manifest.mergedPath);
  await mkdir(dirname(mergedAbsolute), { recursive: true });
  const concatPath = storyPath(ctx.channelId, ctx.storyId, "workspace", "voice", "concat.txt");
  await writeFile(
    concatPath,
    buildConcatList(manifest.chunks.map((chunk) => resolveProjectPath(ctx.channelId, chunk.relativePath))),
    "utf8",
  );
  const ffmpeg = resolveFfmpeg(ctx);
  await runProcess(ffmpeg, [...(ctx.ffmpegPrefixArgs ?? []), ...buildMergeArgs(concatPath, mergedAbsolute)], {
    signal: ctx.signal,
  });
  manifest.totalDurationSeconds = await (ctx.probeDuration ?? probeDurationDefault)(mergedAbsolute);
  manifest.loudnormApplied = true;

  const captionsAbsolute = resolveProjectPath(ctx.channelId, manifest.captionsPath);
  await writeFile(captionsAbsolute, buildChunkCaptionsSrt(manifest.chunks), "utf8");
  await persist(manifest);
}

async function runImagesStage(ctx: StageContext, onlySceneId?: string): Promise<void> {
  const scenes = await readStageArtifact<SceneList>(ctx.channelId, ctx.storyId, "scenes");
  if (!scenes || scenes.scenes.length === 0) {
    throw new Error("Image generation needs extracted scenes.");
  }
  const provider = ctx.imageProvider ?? createConfiguredImageProvider(ctx.config);
  const usdPerImage = ctx.config.images.gemini.usdPerImage;
  const existing = await readStageArtifact<ImageManifest>(ctx.channelId, ctx.storyId, "images");
  const byScene = new Map((existing?.images ?? []).map((image) => [image.sceneId, image]));
  const manifest: ImageManifest = {
    version: 1,
    provider: provider.name,
    model: ctx.config.images.gemini.model,
    images: scenes.scenes.map((scene) => {
      const match = byScene.get(scene.sceneId);
      // A done image survives only while its prompt is unchanged.
      if (match && match.status === "done" && match.prompt === scene.imagePrompt) {
        return match;
      }
      return {
        sceneId: scene.sceneId,
        prompt: scene.imagePrompt,
        relativePath: storyRelativePath(ctx.storyId, "workspace", "images", `${scene.sceneId}.png`),
        status: "pending" as const,
        attemptCount: match?.attemptCount ?? 0,
        lastError: match?.lastError,
        costUsd: match?.costUsd ?? 0,
      };
    }),
  };
  const persist = async () => {
    await writeStageArtifact(ctx.channelId, ctx.storyId, "images", manifest);
  };
  await persist();

  for (const image of manifest.images) {
    if (onlySceneId && image.sceneId !== onlySceneId) continue;
    if (image.status === "done") continue;
    await assertWithinBudget(ctx.channelId, ctx.storyId, ctx.story.config.budget.maxCostPerStoryUsd, usdPerImage);
    try {
      await provider.generate(
        {
          prompt: image.prompt,
          aspectRatio: "16:9",
          outputPath: resolveProjectPath(ctx.channelId, image.relativePath),
          confirmedPaidRequest: ctx.confirmedPaidRequest,
        },
        ctx.signal,
      );
      image.status = "done";
      image.costUsd = usdPerImage;
      image.lastError = undefined;
      await addStoryCost(ctx.channelId, ctx.storyId, { kind: "image", usd: usdPerImage });
    } catch (error: unknown) {
      // One failed image retries alone; the ones already generated stay done.
      image.status = "failed";
      image.attemptCount += 1;
      image.lastError = error instanceof Error ? error.message : String(error);
      await persist();
      throw error;
    }
    await persist();
    await ctx.update?.(`Image ${image.sceneId} ready.`);
  }

  const unfinished = manifest.images.filter((image) => image.status !== "done");
  if (!onlySceneId && unfinished.length > 0) {
    throw new Error(`${unfinished.length} scene image(s) still missing: ${unfinished.map((i) => i.sceneId).join(", ")}.`);
  }
}

async function runBgmStage(ctx: StageContext): Promise<void> {
  const tts = await readStageArtifact<TtsChunkManifest>(ctx.channelId, ctx.storyId, "tts");
  if (!tts || tts.totalDurationSeconds <= 0) {
    throw new Error("The BGM plan needs the merged narration duration.");
  }
  const plan = await buildBgmPlan(ctx.channel, tts.totalDurationSeconds);
  await writeStageArtifact(ctx.channelId, ctx.storyId, "bgm", plan);
}

async function runRenderStage(ctx: StageContext): Promise<void> {
  const scenes = await readStageArtifact<SceneList>(ctx.channelId, ctx.storyId, "scenes");
  const images = await readStageArtifact<ImageManifest>(ctx.channelId, ctx.storyId, "images");
  const tts = await readStageArtifact<TtsChunkManifest>(ctx.channelId, ctx.storyId, "tts");
  const bgm = await readStageArtifact<{ version: 1; tracks: [] }>(ctx.channelId, ctx.storyId, "bgm");
  if (!scenes || !images || !tts || !bgm) {
    throw new Error("Rendering needs scenes, images, narration, and a bgm plan.");
  }
  const actualDuration = tts.totalDurationSeconds;
  if (actualDuration <= 0) {
    throw new Error("Rendering needs a merged narration with a measured duration.");
  }
  // Scene timings were estimated from word count; stretch them onto the real audio.
  const estimatedEnd = scenes.scenes[scenes.scenes.length - 1]?.endSeconds ?? 0;
  const scale = estimatedEnd > 0 ? actualDuration / estimatedEnd : 1;
  const imagePaths = new Map(
    images.images
      .filter((image) => image.status === "done")
      .map((image) => [image.sceneId, resolveProjectPath(ctx.channelId, image.relativePath)]),
  );
  const segments = buildStorySegments(
    scenes.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startSeconds: scene.startSeconds * scale,
      endSeconds: scene.endSeconds * scale,
    })),
    imagePaths,
  );

  const width = ctx.config.render.longformWidth;
  const height = ctx.config.render.longformHeight;
  const outputPath = storyPath(ctx.channelId, ctx.storyId, "workspace", "render", "story.mp4");
  await renderStoryVideo({
    segments,
    narrationPath: resolveProjectPath(ctx.channelId, tts.mergedPath),
    bgm,
    outputPath,
    durationSeconds: actualDuration,
    width,
    height,
    ffmpegPath: resolveFfmpeg(ctx),
    ffmpegPrefixArgs: ctx.ffmpegPrefixArgs,
    signal: ctx.signal,
    update: async (completed, total) => ctx.update?.(`Rendered segment ${completed}/${total}.`),
    transition: { kind: ctx.config.render.storyTransition, seconds: ctx.config.render.storyTransitionSeconds },
  });

  const artifact: RenderStageArtifact = {
    version: 1,
    videoPath: storyRelativePath(ctx.storyId, "workspace", "render", "story.mp4"),
    durationSeconds: actualDuration,
    width,
    height,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "render", artifact);
}

async function runThumbnailStage(ctx: StageContext): Promise<void> {
  const metadata = await readStageArtifact<StoryMetadataArtifact>(ctx.channelId, ctx.storyId, "metadata");
  if (!metadata) {
    throw new Error("The thumbnail needs completed metadata (overlay text and concept).");
  }
  const provider = ctx.imageProvider ?? createConfiguredImageProvider(ctx.config);
  let generatedImages = 0;
  const countingProvider = {
    name: provider.name,
    generate: async (request: Parameters<ImageProvider["generate"]>[0], signal?: AbortSignal) => {
      await assertWithinBudget(
        ctx.channelId,
        ctx.storyId,
        ctx.story.config.budget.maxCostPerStoryUsd,
        ctx.config.images.gemini.usdPerImage,
      );
      const artifact = await provider.generate(request, signal);
      generatedImages += 1;
      return artifact;
    },
  };
  const artifact = await generateThumbnail({
    channelId: ctx.channelId,
    storyId: ctx.storyId,
    concept: metadata.thumbnailConcept,
    overlayText: metadata.thumbnailText,
    style: ctx.story.config.visualStyleProfile,
    imageProvider: countingProvider,
    ffmpegPath: resolveFfmpeg(ctx),
    ffmpegPrefixArgs: ctx.ffmpegPrefixArgs,
    signal: ctx.signal,
  });
  if (generatedImages > 0) {
    await addStoryCost(ctx.channelId, ctx.storyId, {
      kind: "image",
      usd: generatedImages * ctx.config.images.gemini.usdPerImage,
    });
  }
  await writeStageArtifact(ctx.channelId, ctx.storyId, "thumbnail", artifact);
}

function resolveFfmpeg(ctx: StageContext): string {
  return ctx.ffmpegPath ?? (ctx.config.render.ffmpegPath || undefined) ?? process.env.FFMPEG_PATH ?? "ffmpeg";
}
