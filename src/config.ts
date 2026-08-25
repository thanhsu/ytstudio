import { readFile, writeFile } from "node:fs/promises";

export const SCRIPT_PROVIDERS = ["dry-run", "openai-compatible"] as const;

export type ScriptProvider = (typeof SCRIPT_PROVIDERS)[number];

export const STORY_RENDER_ENGINES = ["ffmpeg", "hyperframes"] as const;

export type StoryRenderEngine = (typeof STORY_RENDER_ENGINES)[number];

export function isKnownScriptProvider(value: unknown): value is ScriptProvider {
  return typeof value === "string" && (SCRIPT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * One wording for the two places that refuse an unknown provider: saving new
 * operator input, and selecting the provider that will actually run.
 */
export function unknownScriptProviderError(value: unknown): Error {
  return new Error(
    `Unknown script.provider ${JSON.stringify(value)}. Valid values are ${SCRIPT_PROVIDERS.join(", ")}.`,
  );
}

/**
 * One OpenAI-compatible endpoint. The story factory names three of these
 * (planner/writer/qa) so cheap stages can run on a cheap model while the writer
 * and the QA passes use a stronger one. Same field meanings as `script`.
 */
export type LlmEndpointConfig = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  paid: boolean;
  temperature: number;
  maxOutputTokens: number;
  // Which transport carries this endpoint's calls. "openai-compatible" covers
  // Ollama, LM Studio, OpenAI, DeepSeek, Groq, and OpenRouter; "anthropic" and
  // "gemini" call those providers' native APIs directly. baseUrl still names
  // the actual host — this only selects the wire format.
  provider: "openai-compatible" | "anthropic" | "gemini";
};

export type StudioConfig = {
  script: {
    // An unrecognized value survives a load so it can be shown and repaired; it
    // is refused when a provider is selected, not when the file is read.
    provider: ScriptProvider | (string & {});
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    paid: boolean;
    temperature: number;
    maxOutputTokens: number;
  };
  translation: {
    provider: "prompt-only" | "openai" | "gemini";
    model: string;
    defaultTarget: "vi" | "en-au" | "en-gb" | "pt-br" | "de";
    defaultGenre: "cultivation" | "fantasy-system" | "modern-drama";
  };
  asr: {
    provider: "disabled" | "faster-whisper" | "whisper-cpp";
    executablePath: string;
    model: string;
    modelPath: string;
    language: string;
  };
  tts: {
    defaultProvider: "piper" | "openai" | "vietnamese-local" | "google";
    openai: {
      model: string;
      voice: string;
      apiKeyEnv: string;
    };
    piper: {
      executablePath: string;
      modelPath: string;
      voice: string;
    };
    vietnameseLocal: {
      pythonPath: string;
      appPath: string;
      voice: string;
    };
    google: {
      apiKeyEnv: string;
      baseUrl: string;
      audioEncoding: "MP3" | "LINEAR16";
      chunkMinChars: number;
      chunkMaxChars: number;
      // USD per one million characters, by quality tier. Seeded with
      // approximate published prices; provider pricing drifts, so these are
      // operator-editable and never trusted as exact.
      pricing: {
        economy: number;
        standard: number;
        premium: number;
      };
      // Which Google voice-name families count as which tier, e.g. a voice
      // named "es-US-Neural2-B" matches the "Neural2" prefix.
      tierVoicePrefixes: {
        economy: string[];
        standard: string[];
        premium: string[];
      };
    };
  };
  images: {
    // "disabled" loads fine but any stage that needs an image refuses to run,
    // naming this setting — never a silent placeholder image.
    provider: "disabled" | "gemini";
    gemini: {
      apiKeyEnv: string;
      baseUrl: string;
      model: string;
      // Approximate, operator-editable; feeds the cost ledger.
      usdPerImage: number;
    };
  };
  storyFactory: {
    enabled: boolean;
    models: {
      planner: LlmEndpointConfig;
      writer: LlmEndpointConfig;
      qa: LlmEndpointConfig;
    };
    // USD per million tokens by model-name substring; first match wins. Empty
    // means costs record as 0 with usage still logged.
    llmPricing: Array<{ modelPattern: string; inputUsdPerMTok: number; outputUsdPerMTok: number }>;
    duplicateSimilarityThreshold: number;
    defaultMaxCostPerStoryUsd: number;
  };
  render: {
    ffmpegPath: string;
    ffprobePath: string;
    shortsWidth: number;
    shortsHeight: number;
    longformWidth: number;
    longformHeight: number;
    // "fade": current behavior, per-segment fade in/out, stitched with the
    // concat demuxer. "xfade": segments are padded by the transition overlap
    // and blended in one filtergraph pass — see render-story.ts.
    storyTransition: "fade" | "xfade";
    storyTransitionSeconds: number;
    storyEngine: StoryRenderEngine;
    hyperframesCommand: string;
    hyperframesArgs: string[];
    hyperframesTimeoutMinutes: number;
  };
  youtube: {
    clientIdEnv: string;
    clientSecretEnv: string;
    scopes: string[];
  };
  sources: {
    ytDlpPath: string;
    // Prepended to every invocation. Configuration is operator-owned, which is why
    // this lives here and never in a request body: a path plus arguments taken over
    // HTTP would turn a same-origin POST into arbitrary command execution.
    ytDlpArgs: string[];
    format: string;
    /** Root folder for downloaded sources; empty keeps ./sources (or the env override). */
    downloadDir: string;
    subtitleLanguages: string[];
    defaultSearchPlatform: "youtube" | "bilibili" | "tiktok" | "douyin" | "facebook";
    searchLimit: number;
    searchPrefixes: {
      youtube: string;
      bilibili: string;
      tiktok: string;
      douyin: string;
      facebook: string;
    };
  };
};

const CONFIG_PATH = "studio.config.json";

export const DEFAULT_STUDIO_CONFIG: StudioConfig = {
  script: {
    provider: "dry-run",
    model: "local-template",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 4000,
  },
  translation: {
    provider: "prompt-only",
    model: "manual-review",
    defaultTarget: "vi",
    defaultGenre: "cultivation",
  },
  asr: {
    provider: "disabled",
    executablePath: "",
    model: "small",
    modelPath: "",
    language: "zh",
  },
  tts: {
    defaultProvider: "piper",
    openai: {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    piper: {
      executablePath: "",
      modelPath: "",
      voice: "default",
    },
    vietnameseLocal: {
      pythonPath: "python",
      appPath: "",
      voice: "piper:Minh Quân (Vbee):model",
    },
    google: {
      apiKeyEnv: "GOOGLE_TTS_API_KEY",
      baseUrl: "https://texttospeech.googleapis.com/v1",
      audioEncoding: "MP3",
      chunkMinChars: 2000,
      chunkMaxChars: 4500,
      pricing: {
        economy: 4,
        standard: 16,
        premium: 30,
      },
      tierVoicePrefixes: {
        economy: ["Standard"],
        standard: ["Neural2", "Wavenet"],
        premium: ["Chirp3", "Studio"],
      },
    },
  },
  images: {
    provider: "disabled",
    gemini: {
      apiKeyEnv: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-image",
      usdPerImage: 0.039,
    },
  },
  storyFactory: {
    enabled: false,
    models: {
      planner: defaultLlmEndpoint(),
      writer: defaultLlmEndpoint(),
      qa: defaultLlmEndpoint(),
    },
    llmPricing: [],
    duplicateSimilarityThreshold: 0.6,
    defaultMaxCostPerStoryUsd: 5,
  },
  render: {
    ffmpegPath: "",
    ffprobePath: "",
    shortsWidth: 1080,
    shortsHeight: 1920,
    longformWidth: 1920,
    longformHeight: 1080,
    storyTransition: "fade",
    storyTransitionSeconds: 0.5,
    storyEngine: "ffmpeg",
    hyperframesCommand: "node",
    hyperframesArgs: ["./node_modules/hyperframes/bin/hyperframes.mjs"],
    hyperframesTimeoutMinutes: 90,
  },
  youtube: {
    clientIdEnv: "YOUTUBE_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_CLIENT_SECRET",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
  },
  sources: {
    ytDlpPath: "",
    ytDlpArgs: [],
    format: "bv*+ba/b",
    downloadDir: "",
    subtitleLanguages: ["en"],
    defaultSearchPlatform: "youtube",
    searchLimit: 8,
    searchPrefixes: {
      youtube: "ytsearch",
      bilibili: "bilisearch",
      tiktok: "",
      douyin: "",
      facebook: "",
    },
  },
};

export async function loadStudioConfig(path = CONFIG_PATH): Promise<StudioConfig> {
  let fileConfig: unknown = {};
  try {
    fileConfig = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  return normalizeStudioConfig(deepMerge(DEFAULT_STUDIO_CONFIG, fileConfig));
}

export async function saveStudioConfig(config: unknown, path = CONFIG_PATH): Promise<StudioConfig> {
  const normalized = normalizeStudioConfig(config);
  // Operator input is validated at the boundary, before it reaches the file.
  // Refusing to read a file that already holds a bad value would be a different
  // thing entirely, and would lock the operator out of the screen that repairs it.
  if (!isKnownScriptProvider(normalized.script.provider)) {
    throw unknownScriptProviderError(normalized.script.provider);
  }
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function normalizeStudioConfig(value: unknown): StudioConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<StudioConfig>) : {};
  return {
    script: {
      provider: scriptProviderValue(candidate.script?.provider),
      model: stringValue(candidate.script?.model, DEFAULT_STUDIO_CONFIG.script.model),
      baseUrl: stringValue(candidate.script?.baseUrl, DEFAULT_STUDIO_CONFIG.script.baseUrl),
      apiKeyEnv: stringValue(candidate.script?.apiKeyEnv, DEFAULT_STUDIO_CONFIG.script.apiKeyEnv),
      paid: booleanValue(candidate.script?.paid, DEFAULT_STUDIO_CONFIG.script.paid),
      temperature: rangeValue(candidate.script?.temperature, DEFAULT_STUDIO_CONFIG.script.temperature, 0, 2),
      maxOutputTokens: numberValue(candidate.script?.maxOutputTokens, DEFAULT_STUDIO_CONFIG.script.maxOutputTokens),
    },
    translation: {
      provider: enumValue(candidate.translation?.provider, ["prompt-only", "openai", "gemini"], "prompt-only"),
      model: stringValue(candidate.translation?.model, DEFAULT_STUDIO_CONFIG.translation.model),
      defaultTarget: enumValue(candidate.translation?.defaultTarget, ["vi", "en-au", "en-gb", "pt-br", "de"], "vi"),
      defaultGenre: enumValue(
        candidate.translation?.defaultGenre,
        ["cultivation", "fantasy-system", "modern-drama"],
        "cultivation",
      ),
    },
    asr: {
      provider: enumValue(candidate.asr?.provider, ["disabled", "faster-whisper", "whisper-cpp"], "disabled"),
      executablePath: stringValue(candidate.asr?.executablePath, ""),
      model: stringValue(candidate.asr?.model, DEFAULT_STUDIO_CONFIG.asr.model),
      modelPath: stringValue(candidate.asr?.modelPath, ""),
      language: stringValue(candidate.asr?.language, DEFAULT_STUDIO_CONFIG.asr.language),
    },
    tts: {
      defaultProvider: enumValue(candidate.tts?.defaultProvider, ["piper", "openai", "vietnamese-local", "google"], "piper"),
      openai: {
        model: stringValue(candidate.tts?.openai?.model, DEFAULT_STUDIO_CONFIG.tts.openai.model),
        voice: stringValue(candidate.tts?.openai?.voice, DEFAULT_STUDIO_CONFIG.tts.openai.voice),
        apiKeyEnv: stringValue(candidate.tts?.openai?.apiKeyEnv, DEFAULT_STUDIO_CONFIG.tts.openai.apiKeyEnv),
      },
      piper: {
        executablePath: stringValue(candidate.tts?.piper?.executablePath, ""),
        modelPath: stringValue(candidate.tts?.piper?.modelPath, ""),
        voice: stringValue(candidate.tts?.piper?.voice, DEFAULT_STUDIO_CONFIG.tts.piper.voice),
      },
      vietnameseLocal: {
        pythonPath: stringValue(candidate.tts?.vietnameseLocal?.pythonPath, "python"),
        appPath: stringValue(candidate.tts?.vietnameseLocal?.appPath, DEFAULT_STUDIO_CONFIG.tts.vietnameseLocal.appPath),
        voice: stringValue(candidate.tts?.vietnameseLocal?.voice, DEFAULT_STUDIO_CONFIG.tts.vietnameseLocal.voice),
      },
      google: {
        apiKeyEnv: stringValue(candidate.tts?.google?.apiKeyEnv, DEFAULT_STUDIO_CONFIG.tts.google.apiKeyEnv),
        baseUrl: stringValue(candidate.tts?.google?.baseUrl, DEFAULT_STUDIO_CONFIG.tts.google.baseUrl),
        audioEncoding: enumValue(candidate.tts?.google?.audioEncoding, ["MP3", "LINEAR16"], "MP3"),
        chunkMinChars: rangeValue(
          candidate.tts?.google?.chunkMinChars,
          DEFAULT_STUDIO_CONFIG.tts.google.chunkMinChars,
          200,
          4800,
        ),
        // Google's synthesize endpoint refuses inputs past 5000 bytes, so the
        // ceiling stays under it even when the operator asks for more.
        chunkMaxChars: rangeValue(
          candidate.tts?.google?.chunkMaxChars,
          DEFAULT_STUDIO_CONFIG.tts.google.chunkMaxChars,
          500,
          4800,
        ),
        pricing: {
          economy: numberValue(candidate.tts?.google?.pricing?.economy, DEFAULT_STUDIO_CONFIG.tts.google.pricing.economy),
          standard: numberValue(
            candidate.tts?.google?.pricing?.standard,
            DEFAULT_STUDIO_CONFIG.tts.google.pricing.standard,
          ),
          premium: numberValue(
            candidate.tts?.google?.pricing?.premium,
            DEFAULT_STUDIO_CONFIG.tts.google.pricing.premium,
          ),
        },
        tierVoicePrefixes: {
          economy: stringArrayValue(
            candidate.tts?.google?.tierVoicePrefixes?.economy,
            DEFAULT_STUDIO_CONFIG.tts.google.tierVoicePrefixes.economy,
          ),
          standard: stringArrayValue(
            candidate.tts?.google?.tierVoicePrefixes?.standard,
            DEFAULT_STUDIO_CONFIG.tts.google.tierVoicePrefixes.standard,
          ),
          premium: stringArrayValue(
            candidate.tts?.google?.tierVoicePrefixes?.premium,
            DEFAULT_STUDIO_CONFIG.tts.google.tierVoicePrefixes.premium,
          ),
        },
      },
    },
    images: {
      provider: enumValue(candidate.images?.provider, ["disabled", "gemini"], "disabled"),
      gemini: {
        apiKeyEnv: stringValue(candidate.images?.gemini?.apiKeyEnv, DEFAULT_STUDIO_CONFIG.images.gemini.apiKeyEnv),
        baseUrl: stringValue(candidate.images?.gemini?.baseUrl, DEFAULT_STUDIO_CONFIG.images.gemini.baseUrl),
        model: stringValue(candidate.images?.gemini?.model, DEFAULT_STUDIO_CONFIG.images.gemini.model),
        usdPerImage: numberValue(candidate.images?.gemini?.usdPerImage, DEFAULT_STUDIO_CONFIG.images.gemini.usdPerImage),
      },
    },
    storyFactory: {
      enabled: booleanValue(candidate.storyFactory?.enabled, DEFAULT_STUDIO_CONFIG.storyFactory.enabled),
      models: {
        planner: llmEndpointValue(candidate.storyFactory?.models?.planner),
        writer: llmEndpointValue(candidate.storyFactory?.models?.writer),
        qa: llmEndpointValue(candidate.storyFactory?.models?.qa),
      },
      llmPricing: llmPricingValue(candidate.storyFactory?.llmPricing),
      duplicateSimilarityThreshold: rangeValue(
        candidate.storyFactory?.duplicateSimilarityThreshold,
        DEFAULT_STUDIO_CONFIG.storyFactory.duplicateSimilarityThreshold,
        0,
        1,
      ),
      defaultMaxCostPerStoryUsd: rangeValue(
        candidate.storyFactory?.defaultMaxCostPerStoryUsd,
        DEFAULT_STUDIO_CONFIG.storyFactory.defaultMaxCostPerStoryUsd,
        0,
        10000,
      ),
    },
    render: {
      ffmpegPath: stringValue(candidate.render?.ffmpegPath, ""),
      ffprobePath: stringValue(candidate.render?.ffprobePath, ""),
      shortsWidth: numberValue(candidate.render?.shortsWidth, 1080),
      shortsHeight: numberValue(candidate.render?.shortsHeight, 1920),
      longformWidth: numberValue(candidate.render?.longformWidth, 1920),
      longformHeight: numberValue(candidate.render?.longformHeight, 1080),
      storyTransition: enumValue(
        candidate.render?.storyTransition,
        ["fade", "xfade"],
        DEFAULT_STUDIO_CONFIG.render.storyTransition,
      ),
      storyTransitionSeconds: rangeValue(
        candidate.render?.storyTransitionSeconds,
        DEFAULT_STUDIO_CONFIG.render.storyTransitionSeconds,
        0.1,
        2,
      ),
      storyEngine: enumValue(candidate.render?.storyEngine, STORY_RENDER_ENGINES, DEFAULT_STUDIO_CONFIG.render.storyEngine),
      hyperframesCommand: stringValue(
        candidate.render?.hyperframesCommand,
        DEFAULT_STUDIO_CONFIG.render.hyperframesCommand,
      ),
      hyperframesArgs: stringArrayValue(candidate.render?.hyperframesArgs, DEFAULT_STUDIO_CONFIG.render.hyperframesArgs),
      hyperframesTimeoutMinutes: rangeValue(
        candidate.render?.hyperframesTimeoutMinutes,
        DEFAULT_STUDIO_CONFIG.render.hyperframesTimeoutMinutes,
        1,
        360,
      ),
    },
    youtube: {
      clientIdEnv: stringValue(candidate.youtube?.clientIdEnv, DEFAULT_STUDIO_CONFIG.youtube.clientIdEnv),
      clientSecretEnv: stringValue(candidate.youtube?.clientSecretEnv, DEFAULT_STUDIO_CONFIG.youtube.clientSecretEnv),
      scopes: stringArrayValue(candidate.youtube?.scopes, DEFAULT_STUDIO_CONFIG.youtube.scopes),
    },
    sources: {
      ytDlpPath: stringValue(candidate.sources?.ytDlpPath, ""),
      ytDlpArgs: stringArrayValue(candidate.sources?.ytDlpArgs, DEFAULT_STUDIO_CONFIG.sources.ytDlpArgs),
      format: stringValue(candidate.sources?.format, DEFAULT_STUDIO_CONFIG.sources.format),
      downloadDir: stringValue(candidate.sources?.downloadDir, DEFAULT_STUDIO_CONFIG.sources.downloadDir),
      subtitleLanguages: stringArrayValue(
        candidate.sources?.subtitleLanguages,
        DEFAULT_STUDIO_CONFIG.sources.subtitleLanguages,
      ),
      defaultSearchPlatform: enumValue(
        candidate.sources?.defaultSearchPlatform,
        ["youtube", "bilibili", "tiktok", "douyin", "facebook"],
        DEFAULT_STUDIO_CONFIG.sources.defaultSearchPlatform,
      ),
      searchLimit: rangeValue(candidate.sources?.searchLimit, DEFAULT_STUDIO_CONFIG.sources.searchLimit, 1, 25),
      searchPrefixes: {
        youtube: stringValue(
          candidate.sources?.searchPrefixes?.youtube,
          DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.youtube,
        ) || DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.youtube,
        bilibili: stringValue(
          candidate.sources?.searchPrefixes?.bilibili,
          DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.bilibili,
        ) || DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.bilibili,
        tiktok: stringValue(
          candidate.sources?.searchPrefixes?.tiktok,
          DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.tiktok,
        ),
        douyin: stringValue(
          candidate.sources?.searchPrefixes?.douyin,
          DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.douyin,
        ),
        facebook: stringValue(
          candidate.sources?.searchPrefixes?.facebook,
          DEFAULT_STUDIO_CONFIG.sources.searchPrefixes.facebook,
        ),
      },
    },
  };
}

function defaultLlmEndpoint(): LlmEndpointConfig {
  return {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    apiKeyEnv: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 8000,
    provider: "openai-compatible",
  };
}

function llmEndpointValue(value: unknown): LlmEndpointConfig {
  const fallback = defaultLlmEndpoint();
  const candidate = value && typeof value === "object" ? (value as Partial<LlmEndpointConfig>) : {};
  return {
    baseUrl: stringValue(candidate.baseUrl, fallback.baseUrl),
    model: stringValue(candidate.model, fallback.model),
    apiKeyEnv: stringValue(candidate.apiKeyEnv, fallback.apiKeyEnv),
    paid: booleanValue(candidate.paid, fallback.paid),
    temperature: rangeValue(candidate.temperature, fallback.temperature, 0, 2),
    maxOutputTokens: numberValue(candidate.maxOutputTokens, fallback.maxOutputTokens),
    provider: enumValue(candidate.provider, ["openai-compatible", "anthropic", "gemini"], fallback.provider),
  };
}

function llmPricingValue(value: unknown): StudioConfig["storyFactory"]["llmPricing"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: StudioConfig["storyFactory"]["llmPricing"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { modelPattern?: unknown; inputUsdPerMTok?: unknown; outputUsdPerMTok?: unknown };
    const modelPattern = typeof candidate.modelPattern === "string" ? candidate.modelPattern.trim() : "";
    const input = Number(candidate.inputUsdPerMTok);
    const output = Number(candidate.outputUsdPerMTok);
    if (!modelPattern || !Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      continue;
    }
    entries.push({ modelPattern, inputUsdPerMTok: input, outputUsdPerMTok: output });
  }
  return entries;
}

function stringArrayValue(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length ? entries : [...fallback];
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!base || typeof base !== "object" || !override || typeof override !== "object") {
    return override ?? base;
  }
  // A configured list replaces the default outright. Merging element by element
  // would splice a two-entry default into a one-entry setting and leave the
  // operator with a value nobody wrote.
  if (Array.isArray(base) || Array.isArray(override)) {
    return override;
  }
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function rangeValue(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

/**
 * Preserved exactly as written, even when unrecognized. Loading the config must
 * never fail: every unrelated stage reads it, and the Config screen is the only
 * in-studio repair path for a hand-edited value. Rewriting an unknown value to
 * "dry-run" here is what let a typo generate template output and report success,
 * so the value survives instead and createConfiguredProvider refuses it.
 */
function scriptProviderValue(value: unknown): StudioConfig["script"]["provider"] {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_STUDIO_CONFIG.script.provider;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
