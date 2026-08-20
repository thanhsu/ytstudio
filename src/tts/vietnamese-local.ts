import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { probeDuration } from "../media.ts";
import { resolveProjectPath } from "../project-paths.ts";
import { runProcess } from "../process.ts";
import { saveTtsArtifact, ttsCacheKey } from "./cache.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "./types.ts";

export type VietnameseLocalConfig = {
  pythonPath: string;
  appPath: string;
  prefixArgs?: string[];
  probeDuration?: (filePath: string) => Promise<number>;
};

export function createVietnameseLocalProvider(config: VietnameseLocalConfig): TtsProvider {
  return {
    name: "vietnamese-local",
    async generate(request: TtsRequest, signal?: AbortSignal): Promise<TtsArtifact> {
      await access(config.appPath);

      const cacheKey = ttsCacheKey({ ...request, provider: "vietnamese-local" });
      const workRelativeDir = `workspace/voice/local-vietnamese/${cacheKey}`;
      const inputRelativePath = `${workRelativeDir}/input.txt`;
      const outputRelativeDir = `${workRelativeDir}/output`;
      const inputPath = resolveProjectPath(request.projectId, inputRelativePath);
      const outputDir = resolveProjectPath(request.projectId, outputRelativeDir);
      const finalRelativePath = `workspace/voice/${cacheKey}.${request.format}`;
      const finalPath = resolveProjectPath(request.projectId, finalRelativePath);

      await mkdir(dirname(inputPath), { recursive: true });
      await mkdir(outputDir, { recursive: true });
      await mkdir(dirname(finalPath), { recursive: true });
      await writeFile(inputPath, request.text, "utf8");

      await runProcess(config.pythonPath, [
        ...(config.prefixArgs ?? []),
        config.appPath,
        "--file",
        inputPath,
        "--out",
        outputDir,
        "--format",
        request.format,
        "--speed",
        String(request.speed),
        "--name",
        "voice",
        ...(request.voice && request.voice !== "default" ? ["--voice", request.voice] : []),
      ], { signal });

      const producedPath = join(outputDir, `voice.${request.format}`);
      await copyFile(producedPath, finalPath);

      const durationSeconds = await (config.probeDuration ?? probeDuration)(finalPath);
      const artifact: TtsArtifact = {
        provider: "vietnamese-local",
        cacheKey,
        relativePath: finalRelativePath,
        durationSeconds,
        createdAt: new Date().toISOString(),
        metadata: {
          voice: request.voice,
          format: request.format,
          speed: request.speed,
          appPath: resolve(config.appPath),
        },
      };
      await saveTtsArtifact(request.projectId, artifact);
      return artifact;
    },
  };
}
