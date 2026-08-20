import { readFile, writeFile } from "node:fs/promises";

export type StudioConfig = {
  script: {
    provider: "dry-run";
    model: string;
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
    defaultProvider: "piper" | "openai" | "vietnamese-local";
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
  };
  render: {
    ffmpegPath: string;
    ffprobePath: string;
    shortsWidth: number;
    shortsHeight: number;
  };
};

const CONFIG_PATH = "studio.config.json";

export const DEFAULT_STUDIO_CONFIG: StudioConfig = {
  script: {
    provider: "dry-run",
    model: "local-template",
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
  },
  render: {
    ffmpegPath: "",
    ffprobePath: "",
    shortsWidth: 1080,
    shortsHeight: 1920,
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
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function normalizeStudioConfig(value: unknown): StudioConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<StudioConfig>) : {};
  return {
    script: {
      provider: "dry-run",
      model: stringValue(candidate.script?.model, DEFAULT_STUDIO_CONFIG.script.model),
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
      defaultProvider: enumValue(candidate.tts?.defaultProvider, ["piper", "openai", "vietnamese-local"], "piper"),
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
    },
    render: {
      ffmpegPath: stringValue(candidate.render?.ffmpegPath, ""),
      ffprobePath: stringValue(candidate.render?.ffprobePath, ""),
      shortsWidth: numberValue(candidate.render?.shortsWidth, 1080),
      shortsHeight: numberValue(candidate.render?.shortsHeight, 1920),
    },
  };
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!base || typeof base !== "object" || !override || typeof override !== "object") {
    return override ?? base;
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

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
