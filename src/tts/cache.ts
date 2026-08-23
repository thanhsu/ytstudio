import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectPath } from "../project-paths.ts";
import { sha256 } from "../project-state.ts";
import type { TtsArtifact, TtsRequest } from "./types.ts";

export function ttsCacheKey(request: TtsRequest): string {
  return sha256(
    JSON.stringify({
      provider: request.provider,
      text: request.text,
      voice: request.voice,
      format: request.format,
      speed: request.speed,
      instructions: request.instructions,
      confirmedPaidRequest: request.confirmedPaidRequest,
      // Undefined values vanish from JSON.stringify, so requests that never set
      // these fields hash to the same key they did before the fields existed —
      // existing cached audio stays reachable.
      languageCode: request.languageCode,
      pitch: request.pitch,
      model: request.model,
    }),
  );
}

export async function saveTtsArtifact(projectId: string, artifact: TtsArtifact): Promise<void> {
  const path = cacheRecordPath(projectId, artifact.cacheKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function findCachedVoice(projectId: string, key: string): Promise<TtsArtifact | null> {
  try {
    const raw = await readFile(cacheRecordPath(projectId, key), "utf8");
    const artifact = JSON.parse(raw) as TtsArtifact;
    await access(resolveProjectPath(projectId, artifact.relativePath));
    return artifact;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function cacheRecordPath(projectId: string, key: string): string {
  return resolveProjectPath(projectId, "workspace", "voice", `${key}.json`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
