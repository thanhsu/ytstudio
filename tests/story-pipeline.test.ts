import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STUDIO_CONFIG, normalizeStudioConfig, type StudioConfig } from "../src/config.ts";
import type { ChatMessage, ChatResult, OpenAiCompatibleConfig } from "../src/llm/chat.ts";
import type { ImageProvider, ImageRequest } from "../src/images/types.ts";
import { ttsCacheKey } from "../src/tts/cache.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "../src/tts/types.ts";
import { loadStoryChannel, saveStoryChannel } from "../src/story-factory/channel.ts";
import { readAiLog } from "../src/story-factory/ai-log.ts";
import { loadStoryCost } from "../src/story-factory/cost.ts";
import { minhashSignature } from "../src/story-factory/fingerprint.ts";
import { upsertStoryFingerprints } from "../src/story-factory/fingerprint-index.ts";
import { runSingleStage, runStoryPipeline, type StoryPipelineDeps } from "../src/story-factory/pipeline.ts";
import type { ChatFn } from "../src/story-factory/stage-llm.ts";
import { resolveProjectPath } from "../src/project-paths.ts";
import {
  approveStoryStage,
  createStory,
  deriveStoryStatus,
  loadStory,
  readStageArtifact,
} from "../src/story-factory/story-project.ts";
import type { NaturalizedScript } from "../src/story-factory/types.ts";
import { makeFakeExecutable } from "./helpers.ts";

const IDEA_LOGLINE = "El ascensor del hospital abandonado baja solo cada madrugada.";
const IDEA_PREMISE =
  "Marisol trabaja el turno de noche en un hospital cerrado hace años. Cada madrugada, el ascensor baja " +
  "solo al sótano sellado. Las cámaras muestran a una niña que nadie más ve. Marisol descubre que la niña " +
  "aparece siempre a la misma hora, y que el sótano guarda la razón.";

const SECTION_TEXT =
  "Marisol recorrió el pasillo del hospital con la linterna temblando. El ascensor esperaba abierto al final, " +
  "aunque nadie lo había llamado. Bajó la mirada al registro: tercera noche seguida, misma hora exacta. " +
  "Detrás del cristal de seguridad, la pantalla mostró a la niña otra vez, quieta, mirando hacia la cámara.";

function fakeResponses(): Record<string, unknown> {
  return {
    "idea generator": { logline: IDEA_LOGLINE, premise: IDEA_PREMISE, themes: ["miedo"], whyItWorks: "Fits the niche." },
    "opening 15-30 seconds": {
      hookText: "A las 3:17, el ascensor se abrió solo. No había nadie adentro.",
      altHooks: ["Alt uno.", "Alt dos."],
      estimatedSeconds: 22,
    },
    "You outline audio stories": {
      sections: [
        { title: "La primera noche", goal: "Setup", beats: ["b1", "b2", "b3"], targetWords: 120 },
        { title: "El sótano", goal: "Escalation", beats: ["b1", "b2"], targetWords: 120 },
        { title: "La niña", goal: "Climax", beats: ["b1", "b2"], targetWords: 120 },
      ],
    },
    "You build the story bible": {
      setting: "Un hospital abandonado en las afueras de Monterrey, 2019.",
      characters: [{ name: "Marisol", role: "guardia nocturna", description: "34 años, metódica", arc: "de escéptica a testigo" }],
      timeline: ["Noche 1: el ascensor baja solo"],
      locations: [{ name: "Hospital San Rafael", description: "seis pisos, sótano sellado" }],
      supernaturalRules: ["La niña solo aparece en cámaras"],
      knownFacts: ["El sótano lleva sellado nueve años"],
      openQuestions: ["¿Quién es la niña?"],
      endingConstraints: ["La niña queda explicada sin romper sus reglas"],
    },
    "You write one section": {
      title: "Sección",
      text: SECTION_TEXT,
      bibleUpdates: { knownFacts: ["La hora exacta es las 3:17"] },
    },
    "You are a continuity checker": { issues: [], pass: true },
    "script doctor for": { text: SECTION_TEXT, notes: ["rhythm"] },
    "You are the final editorial reviewer": { score: 0.95, issues: [], safetyIssues: [], publishable: true },
    "You extract visual scenes": {
      scenes: [
        { summary: "corridor", imagePrompt: "dark corridor, cinematic horror", continuityRefs: ["Marisol"] },
        { summary: "elevator", imagePrompt: "open elevator at night", continuityRefs: [] },
        { summary: "camera girl", imagePrompt: "security monitor with a girl", continuityRefs: [] },
      ],
    },
    "You write YouTube metadata": {
      titles: Array.from({ length: 5 }, (_, i) => ({ title: `Título ${i + 1}`, score: 0.8 - i * 0.1, rationale: "r" })),
      chosenTitle: "Título 1",
      description: "Una historia original de terror.\n\nEsta historia es una obra de ficción.",
      tags: ["terror", "paranormal"],
      thumbnailText: "NO ESTABA SOLA",
      thumbnailConcept: "an empty hospital elevator with doors half open",
    },
  };
}

type FakeChat = ChatFn & { calls: string[] };

function createFakeChat(overrides: Partial<Record<string, unknown | ((count: number) => unknown)>> = {}): FakeChat {
  const responses = { ...fakeResponses(), ...overrides };
  const calls: string[] = [];
  const perKeyCounts = new Map<string, number>();
  const fn = async (_config: OpenAiCompatibleConfig, messages: ChatMessage[]): Promise<ChatResult> => {
    const system = messages[0]?.content ?? "";
    const key = Object.keys(responses).find((marker) => system.includes(marker));
    if (!key) {
      throw new Error(`No fake response matches this prompt: ${system.slice(0, 80)}`);
    }
    calls.push(key);
    const count = (perKeyCounts.get(key) ?? 0) + 1;
    perKeyCounts.set(key, count);
    const value = responses[key];
    const resolved = typeof value === "function" ? (value as (count: number) => unknown)(count) : value;
    if (resolved instanceof Error) {
      throw resolved;
    }
    return {
      content: JSON.stringify(resolved),
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    };
  };
  const fake = Object.assign(fn, { calls });
  return fake;
}

function createFakeTts(channelId: string): TtsProvider & { calls: number } {
  const provider = {
    name: "google",
    calls: 0,
    async generate(request: TtsRequest): Promise<TtsArtifact> {
      provider.calls += 1;
      const key = ttsCacheKey(request);
      const relativePath = `workspace/voice/${key}.mp3`;
      const path = resolveProjectPath(channelId, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "audio", "utf8");
      return {
        provider: "google",
        cacheKey: key,
        relativePath,
        durationSeconds: request.text.length / 15,
        createdAt: new Date().toISOString(),
        metadata: {},
      };
    },
  };
  return provider;
}

function createFakeImages(): ImageProvider & { calls: number } {
  const provider = {
    name: "gemini",
    calls: 0,
    async generate(request: ImageRequest) {
      provider.calls += 1;
      await mkdir(dirname(request.outputPath), { recursive: true });
      await writeFile(request.outputPath, "png", "utf8");
      return { provider: "gemini", model: "fake", mimeType: "image/png", createdAt: new Date().toISOString() };
    },
  };
  return provider;
}

async function withStory<T>(
  fn: (helpers: {
    deps: StoryPipelineDeps;
    chat: FakeChat;
    tts: ReturnType<typeof createFakeTts>;
    images: ReturnType<typeof createFakeImages>;
    config: StudioConfig;
  }) => Promise<T>,
  overrides: { qaProvider?: "openai-compatible" | "anthropic" | "gemini" } = {},
): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-story-pipeline-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    const config = normalizeStudioConfig({
      ...DEFAULT_STUDIO_CONFIG,
      storyFactory: {
        enabled: true,
        models: {
          planner: { baseUrl: "http://fake", model: "fake-model", apiKeyEnv: "", paid: false, temperature: 0.8, maxOutputTokens: 8000 },
          writer: { baseUrl: "http://fake", model: "fake-model", apiKeyEnv: "", paid: false, temperature: 0.8, maxOutputTokens: 8000 },
          qa: {
            baseUrl: "http://fake",
            model: "fake-model",
            apiKeyEnv: "",
            paid: false,
            temperature: 0.8,
            maxOutputTokens: 8000,
            ...(overrides.qaProvider ? { provider: overrides.qaProvider } : {}),
          },
        },
        llmPricing: [{ modelPattern: "fake-model", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }],
        duplicateSimilarityThreshold: 0.6,
        defaultMaxCostPerStoryUsd: 5,
      },
      images: { provider: "gemini" },
    });
    await saveStoryChannel("es-horror", {
      enabled: true,
      ttsProfile: {
        provider: "google",
        tier: "economy",
        voiceName: "es-US-Standard-A",
        languageCode: "es-US",
        speakingRate: 0.95,
        pitch: 0,
      },
    });
    const channel = await loadStoryChannel("es-horror");
    await createStory(channel, { id: "story-001", title: "La habitación 307", targetDurationMinutes: 5 });

    const chat = createFakeChat();
    const tts = createFakeTts("es-horror");
    const images = createFakeImages();
    const fakeFfmpeg = await makeFakeExecutable("process.exit(0);");
    const deps: StoryPipelineDeps = {
      config,
      chat,
      ttsProvider: tts,
      imageProvider: images,
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
      probeDuration: async () => 300,
      confirmedPaidRequest: true,
    };
    return await fn({ deps, chat, tts, images, config });
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("an assisted run generates everything, auto-passes QA gates, and stops before export", async () => {
  await withStory(async ({ deps, chat, tts, images }) => {
    const outcome = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(outcome.completed, true);

    const story = outcome.story;
    for (const stage of ["idea", "hook", "outline", "bible", "sections", "continuity-qa", "naturalize", "originality-qa", "tts-normalize", "tts", "scenes", "images", "bgm", "render", "thumbnail", "metadata", "final-qa"] as const) {
      assert.equal(story.stages[stage]?.status, "done", `${stage} should be done`);
    }
    // Export is a human click, never part of the pipeline.
    assert.equal(story.stages.export, undefined);
    assert.equal(deriveStoryStatus(story), "IN_PROGRESS");

    // Assisted mode auto-granted the two QA-backed approvals, not the final one.
    assert.equal(Boolean(story.approvals.script), true);
    assert.equal(Boolean(story.approvals.media), true);
    assert.equal(story.approvals.final, undefined);

    // 3 sections + 3 naturalize + 8 single-call stages = 14 LLM calls.
    assert.equal(chat.calls.length, 14);
    assert.ok(tts.calls > 0);
    assert.equal(images.calls, 4, "3 scene images + 1 thumbnail background");

    // Measured usage flowed into the ledger and the AI log.
    const cost = await loadStoryCost("es-horror", "story-001");
    assert.ok(cost.llmUsd > 0);
    assert.ok(cost.ttsUsd > 0);
    assert.ok(cost.imageUsd > 0);
    const log = await readAiLog("es-horror", "story-001");
    assert.equal(log.length, 14);
    assert.ok(log.every((entry) => entry.ok && entry.usage?.promptTokens === 1000 && entry.promptVersion));
  });
});

test("naturalize provenance records the qa role's configured provider, not a hardcoded one", async () => {
  await withStory(
    async ({ deps }) => {
      const outcome = await runStoryPipeline("es-horror", "story-001", deps);
      assert.equal(outcome.completed, true);

      const artifact = await readStageArtifact<NaturalizedScript>("es-horror", "story-001", "naturalize");
      assert.equal(artifact?.provenance.provider, "anthropic");
    },
    { qaProvider: "anthropic" },
  );
});

test("a second run over a finished story calls no provider at all", async () => {
  await withStory(async ({ deps, chat, tts, images }) => {
    await runStoryPipeline("es-horror", "story-001", deps);
    const llmCalls = chat.calls.length;
    const ttsCalls = tts.calls;
    const imageCalls = images.calls;

    const outcome = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(outcome.completed, true);
    assert.equal(chat.calls.length, llmCalls);
    assert.equal(tts.calls, ttsCalls);
    assert.equal(images.calls, imageCalls);
  });
});

test("manual mode pauses at the script gate, then the media gate, then finishes", async () => {
  await withStory(async ({ deps }) => {
    const { updateStory } = await import("../src/story-factory/story-project.ts");
    await updateStory("es-horror", "story-001", { mode: "manual" });

    const first = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(first.completed, false);
    assert.deepEqual(first.paused, { stage: "tts-normalize", approval: "script" });
    assert.equal(first.story.stages["tts-normalize"]?.status, "awaiting-approval");
    assert.equal(deriveStoryStatus(first.story), "AWAITING_APPROVAL");

    await approveStoryStage("es-horror", "story-001", "script", "read and approved");
    const second = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(second.completed, false);
    assert.deepEqual(second.paused, { stage: "render", approval: "media" });

    await approveStoryStage("es-horror", "story-001", "media", "images reviewed");
    const third = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(third.completed, true);
    assert.equal(third.story.stages["final-qa"]?.status, "done");
  });
});

test("a provider failure is classified, recorded, and resume continues from that stage", async () => {
  await withStory(async ({ deps }) => {
    let failNext = true;
    const chat = createFakeChat({
      "You are a continuity checker": () => {
        if (failNext) {
          failNext = false;
          return new Error("429 rate limit from upstream");
        }
        return { issues: [], pass: true };
      },
    });
    const failingDeps = { ...deps, chat };

    await assert.rejects(() => runStoryPipeline("es-horror", "story-001", failingDeps), /rate limit/);
    let story = await loadStory("es-horror", "story-001");
    assert.equal(story.stages["continuity-qa"]?.status, "failed");
    assert.equal(story.stages["continuity-qa"]?.lastError?.classification, "quota");
    assert.equal(story.stages["continuity-qa"]?.attemptCount, 1);
    assert.equal(deriveStoryStatus(story), "FAILED");
    const ideaCallsBefore = chat.calls.filter((key) => key === "idea generator").length;

    const outcome = await runStoryPipeline("es-horror", "story-001", failingDeps);
    assert.equal(outcome.completed, true);
    story = outcome.story;
    assert.equal(story.stages["continuity-qa"]?.status, "done");
    assert.equal(story.stages["continuity-qa"]?.attemptCount, 2);
    // The resume never regenerated the earlier stages.
    assert.equal(chat.calls.filter((key) => key === "idea generator").length, ideaCallsBefore);
  });
});

test("the budget guard pauses the pipeline instead of silently spending on", async () => {
  await withStory(async ({ deps }) => {
    const { updateStory } = await import("../src/story-factory/story-project.ts");
    // Each fake LLM call costs 0.001 + 0.001 = 0.002; a one-thousandth budget
    // lets the idea stage run and stops the pipeline before the hook stage.
    await updateStory("es-horror", "story-001", { maxCostPerStoryUsd: 0.001 });

    await assert.rejects(() => runStoryPipeline("es-horror", "story-001", deps), /budget/i);
    const story = await loadStory("es-horror", "story-001");
    assert.equal(story.stages.idea?.status, "done");
    assert.equal(story.stages.hook?.status, "failed");
    assert.equal(story.stages.hook?.lastError?.classification, "budget");
    assert.equal(deriveStoryStatus(story), "BUDGET_PAUSED");
  });
});

test("a duplicate idea is rejected after one retry, with the collision named", async () => {
  await withStory(async ({ deps, chat }) => {
    await upsertStoryFingerprints("es-horror", {
      version: 1,
      storyId: "story-000",
      title: "La misma historia",
      logline: IDEA_LOGLINE,
      ideaSignature: minhashSignature(`${IDEA_LOGLINE} ${IDEA_PREMISE}`),
    });

    await assert.rejects(() => runStoryPipeline("es-horror", "story-001", deps), /story-000/);
    const story = await loadStory("es-horror", "story-001");
    assert.equal(story.stages.idea?.status, "failed");
    assert.equal(story.stages.idea?.lastError?.classification, "content");
    // Exactly two attempts: the original and one regeneration.
    assert.equal(chat.calls.filter((key) => key === "idea generator").length, 2);
  });
});

test("regenerating the script cascades staleness but cached media is never repaid", async () => {
  await withStory(async ({ deps, tts, images }) => {
    await runStoryPipeline("es-horror", "story-001", deps);
    const ttsCalls = tts.calls;
    const imageCalls = images.calls;

    const outcome = await runSingleStage("es-horror", "story-001", "sections", deps, { regenerate: true });
    assert.equal(outcome.completed, true);
    let story = outcome.story;
    for (const stage of ["continuity-qa", "naturalize", "tts", "scenes", "images", "render", "final-qa"] as const) {
      assert.equal(story.stages[stage]?.status, "stale", `${stage} should be stale`);
    }

    const rerun = await runStoryPipeline("es-horror", "story-001", deps);
    assert.equal(rerun.completed, true);
    story = rerun.story;
    assert.equal(story.stages["final-qa"]?.status, "done");
    // The fake writer reproduced identical text, so every TTS chunk hit the
    // cache and every image survived by unchanged prompt: zero new spend.
    assert.equal(tts.calls, ttsCalls);
    assert.equal(images.calls, imageCalls);
  });
});
