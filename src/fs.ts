import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_PROJECTS_DIR = "projects";
const DEFAULT_SOURCES_DIR = "sources";

/**
 * Absolute root for all project folders. Resolved per call so the working
 * directory stays authoritative by default, while YT_STUDIO_PROJECTS_DIR can
 * point the studio at a library that lives outside the checkout.
 */
export function projectsRoot(): string {
  const configured = process.env.YT_STUDIO_PROJECTS_DIR;
  return configured ? resolve(configured) : resolve(process.cwd(), DEFAULT_PROJECTS_DIR);
}

/**
 * Absolute root for downloaded source material. A sibling of the projects root,
 * never nested inside it: one download is meant to serve several projects, so it
 * cannot live inside any one of them.
 */
export function sourcesRoot(): string {
  const configured = process.env.YT_STUDIO_SOURCES_DIR;
  return configured ? resolve(configured) : resolve(process.cwd(), DEFAULT_SOURCES_DIR);
}

export function projectDir(projectId: string): string {
  return join(projectsRoot(), projectId);
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
