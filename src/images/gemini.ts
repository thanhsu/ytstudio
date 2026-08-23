import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StudioConfig } from "../config.ts";
import { redact } from "../redact.ts";
import type { ImageArtifact, ImageProvider, ImageRequest } from "./types.ts";

/**
 * Google Gemini image generation over plain REST. The key travels as a header,
 * never in the URL. A response that carries no image — a text-only refusal or
 * a safety block — is thrown with an excerpt, never papered over with a
 * placeholder: template output presented as model output is this codebase's
 * cardinal failure mode, and a black frame presented as a generated scene is
 * the image-shaped version of it.
 */

export type GeminiImageConfig = {
  apiKey: string;
  /** The env var the key was read from, so a missing key names the exact variable. */
  apiKeyEnv: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash-image";

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: unknown;
    content?: { parts?: Array<{ text?: unknown; inlineData?: { mimeType?: unknown; data?: unknown } }> };
  }>;
  promptFeedback?: unknown;
};

export function createGeminiImageProvider(config: GeminiImageConfig): ImageProvider {
  const model = config.model ?? DEFAULT_MODEL;
  return {
    name: "gemini",
    async generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageArtifact> {
      if (!request.confirmedPaidRequest) {
        throw new Error("Gemini image generation requires explicit confirmed paid request.");
      }
      if (!config.apiKey) {
        throw new Error(
          `No API key: the ${config.apiKeyEnv || "GEMINI_API_KEY"} environment variable named by images.gemini.apiKeyEnv is empty. Set it in the shell that starts the studio.`,
        );
      }

      const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const endpoint = `${base}/models/${model}:generateContent`;
      const response = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: request.aspectRatio },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Gemini image request failed with status ${response.status}: ${excerpt(redact(body))}`);
      }

      let payload: GeminiResponse;
      try {
        payload = (await response.json()) as GeminiResponse;
      } catch (error: unknown) {
        throw new Error(`Gemini image response was not JSON: ${messageOf(error)}`);
      }

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find(
        (part) => part.inlineData && typeof part.inlineData.data === "string" && part.inlineData.data,
      );
      if (!imagePart?.inlineData || typeof imagePart.inlineData.data !== "string") {
        const finishReason = payload.candidates?.[0]?.finishReason;
        const label = typeof finishReason === "string" && finishReason ? ` (finishReason ${finishReason})` : "";
        throw new Error(
          `Gemini returned no image for this prompt${label}: ${excerpt(redact(JSON.stringify(payload)))}`,
        );
      }

      await mkdir(dirname(request.outputPath), { recursive: true });
      await writeFile(request.outputPath, Buffer.from(imagePart.inlineData.data, "base64"));

      return {
        provider: "gemini",
        model,
        mimeType:
          typeof imagePart.inlineData.mimeType === "string" && imagePart.inlineData.mimeType
            ? imagePart.inlineData.mimeType
            : "image/png",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * The configured image provider, with a throwing default: "disabled" loads
 * fine everywhere, but a stage that actually needs an image refuses to run and
 * names the setting to change.
 */
export function createConfiguredImageProvider(config: StudioConfig, fetchImpl?: typeof fetch): ImageProvider {
  switch (config.images.provider) {
    case "gemini":
      return createGeminiImageProvider({
        apiKey: config.images.gemini.apiKeyEnv ? (process.env[config.images.gemini.apiKeyEnv] ?? "") : "",
        apiKeyEnv: config.images.gemini.apiKeyEnv,
        baseUrl: config.images.gemini.baseUrl,
        model: config.images.gemini.model,
        fetch: fetchImpl,
      });
    case "disabled":
      throw new Error(
        "Image generation is disabled. Set images.provider to \"gemini\" in the studio config to generate scene visuals and thumbnails.",
      );
    default:
      throw new Error(`Unknown images.provider ${JSON.stringify(config.images.provider)}. Valid values are disabled, gemini.`);
  }
}

const MAX_EXCERPT = 400;

function excerpt(value: string): string {
  const collapsed = value.trim();
  if (!collapsed) return "(empty body)";
  return collapsed.length > MAX_EXCERPT ? `${collapsed.slice(0, MAX_EXCERPT)}… (truncated)` : collapsed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
