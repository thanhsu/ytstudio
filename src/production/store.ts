import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectPath } from "../project-paths.ts";
import { assertValidProductionProject } from "./validate.ts";
import type { ProductionProject } from "./types.ts";

export const PRODUCTION_PROJECT_RELATIVE_PATH = "workspace/production/production-project.json";

export async function saveProductionProject(project: ProductionProject): Promise<void> {
  assertValidProductionProject(project);
  const path = resolveProjectPath(project.projectId, PRODUCTION_PROJECT_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function loadProductionProject(projectId: string): Promise<ProductionProject> {
  const path = resolveProjectPath(projectId, PRODUCTION_PROJECT_RELATIVE_PATH);
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Unable to parse production project at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    assertValidProductionProject(parsed);
  } catch (error: unknown) {
    throw new Error(`Invalid production project at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

export async function loadProductionProjectOrNull(projectId: string): Promise<ProductionProject | null> {
  try {
    return await loadProductionProject(projectId);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
