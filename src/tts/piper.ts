import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { probeDuration } from "../media.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { runProcess } from "../process.ts";
import { saveTtsArtifact, ttsCacheKey } from "./cache.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "./types.ts";

export type PiperConfig = {
  executable: string;
  modelPath: string;
  prefixArgs?: string[];
  speaker?: number;
  probeDuration?: (filePath: string) => Promise<number>;
};

export function createPiperProvider(config: PiperConfig): TtsProvider {
  return {
    name: "piper",
    async generate(request: TtsRequest, signal?: AbortSignal): Promise<TtsArtifact> {
      await access(config.modelPath);

      const cacheKey = ttsCacheKey({ ...request, provider: "piper" });
      const relativePath = `workspace/voice/${cacheKey}.${request.format}`;
      const outputPath = resolveProjectPath(request.projectId, relativePath);
      await mkdir(dirname(outputPath), { recursive: true });

      const args = [
        ...(config.prefixArgs ?? []),
        "--model",
        config.modelPath,
        "--output_file",
        outputPath,
      ];
      if (config.speaker !== undefined) {
        args.push("--speaker", String(config.speaker));
      }

      await runProcess(config.executable, args, {
        input: request.text,
        signal,
      });

      const durationSeconds = await (config.probeDuration ?? probeDuration)(outputPath);
      const artifact: TtsArtifact = {
        provider: "piper",
        cacheKey,
        relativePath,
        durationSeconds,
        createdAt: new Date().toISOString(),
        metadata: {
          voice: request.voice,
          format: request.format,
          speed: request.speed,
          modelPath: config.modelPath,
        },
      };
      await saveTtsArtifact(request.projectId, artifact);
      return artifact;
    },
  };
}
