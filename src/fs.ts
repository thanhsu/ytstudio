import { existsSync, readdirSync } from "node:fs";
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

/**
 * Bridges the operator's configured download folder into the env var the
 * store already honors. An explicit YT_STUDIO_SOURCES_DIR always wins, so
 * tests and power users keep their override.
 */
export function applySourcesDownloadDir(downloadDir: string): void {
  if (!downloadDir.trim() || process.env.YT_STUDIO_SOURCES_DIR) return;
  process.env.YT_STUDIO_SOURCES_DIR = resolve(downloadDir.trim());
}

export function projectDir(projectId: string): string {
  return join(projectsRoot(), projectId);
}

export async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Looks for a bundled binary (ffmpeg or ffprobe) inside the `tools/<name>/`
 * directory relative to the process working directory. Returns the first
 * executable found, or undefined if none exist. Allows the studio to work
 * without ffmpeg on the system PATH when a self-contained build is checked in.
 */
export function bundledBinaryPath(name: "ffmpeg" | "ffprobe"): string | undefined {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const toolsDir = join(process.cwd(), "tools", name);
  if (!existsSync(toolsDir)) return undefined;
  try {
    for (const entry of readdirSync(toolsDir)) {
      const candidate = join(toolsDir, entry, "bin", exe);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore read errors */ }
  return undefined;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
