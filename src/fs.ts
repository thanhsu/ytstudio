import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROJECTS_DIR = "projects";

export function projectDir(projectId: string): string {
  return join(PROJECTS_DIR, projectId);
}

export async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
