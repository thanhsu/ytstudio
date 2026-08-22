import { sep, resolve } from "node:path";
import { projectsRoot } from "./fs.ts";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function validateProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid project id. Use 3-81 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

export function resolveProjectPath(projectId: string, ...segments: string[]): string {
  const safeProjectId = validateProjectId(projectId);
  const projectRoot = resolve(projectsRoot(), safeProjectId);
  const resolvedPath = resolve(projectRoot, ...segments);

  if (resolvedPath !== projectRoot && !resolvedPath.startsWith(`${projectRoot}${sep}`)) {
    throw new Error("Resolved path is outside projects directory.");
  }

  return resolvedPath;
}
