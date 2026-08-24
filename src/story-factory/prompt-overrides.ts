import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureProjectDir, writeJson } from "../fs.ts";
import { resolveProjectPath, validateProjectId } from "../project-paths.ts";
import { interpolate } from "./prompts/template.ts";

export type PromptOverrideEntry = { system: string; updatedAt: string };
export type PromptOverrides = { version: 1; entries: Record<string, PromptOverrideEntry> };
export type PromptCatalogEntry = { name: string; version: string; template: string; variables: string[] };

const PROMPT_FILE = "story-channel/prompt-overrides.json";

export const PROMPT_CATALOG: PromptCatalogEntry[] = [
  { name: "story.idea", version: "idea-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.hook", version: "hook-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.outline", version: "outline-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.bible", version: "bible-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.section", version: "section-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.continuity-qa", version: "continuity-qa-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.naturalize", version: "naturalize-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.originality-qa", version: "originality-qa-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.scenes", version: "scenes-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
  { name: "story.metadata", version: "metadata-v1", template: "{{context}}\n{{jsonRule}}", variables: ["context", "jsonRule"] },
];

export async function loadPromptOverrides(channelId: string): Promise<PromptOverrides> {
  const id = validateProjectId(channelId);
  try {
    const value = JSON.parse(await readFile(resolveProjectPath(id, PROMPT_FILE), "utf8")) as Partial<PromptOverrides>;
    return normalizePromptOverrides(value);
  } catch (error: unknown) {
    if (isNotFound(error)) return { version: 1, entries: {} };
    throw error;
  }
}

export async function savePromptOverride(channelId: string, name: string, system: string): Promise<PromptOverrides> {
  const id = validateProjectId(channelId);
  const catalog = promptDefinition(name);
  const normalized = system.trim();
  if (normalized) validateTemplateVariables(normalized, catalog.variables);

  const current = await loadPromptOverrides(id);
  if (normalized) current.entries[name] = { system: normalized, updatedAt: new Date().toISOString() };
  else delete current.entries[name];
  await ensureProjectDir(id);
  const path = resolveProjectPath(id, PROMPT_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, current);
  return current;
}

export function resolvePromptSystem(
  overrides: PromptOverrides | undefined,
  name: string,
  defaultTemplate: string,
  defaultVersion: string,
  variables: Record<string, string>,
): { system: string; version: string } {
  const override = overrides?.entries[name];
  const system = interpolate(override?.system ?? defaultTemplate, variables);
  return override
    ? { system, version: `${defaultVersion}+custom.${createHash("sha256").update(override.system).digest("hex").slice(0, 8)}` }
    : { system, version: defaultVersion };
}

export function resolvePromptVersion(overrides: PromptOverrides | undefined, name: string, defaultVersion: string): string {
  const override = overrides?.entries[name];
  return override
    ? `${defaultVersion}+custom.${createHash("sha256").update(override.system).digest("hex").slice(0, 8)}`
    : defaultVersion;
}

function promptDefinition(name: string): PromptCatalogEntry {
  const entry = PROMPT_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown prompt ${name}.`);
  return entry;
}

function validateTemplateVariables(system: string, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const seen = system.match(/\{\{([a-zA-Z0-9_.-]+)\}\}/g) ?? [];
  for (const token of seen) {
    const name = token.slice(2, -2);
    if (!allowedSet.has(name)) throw new Error(`Unknown variable {{${name}}} in prompt override.`);
  }
}

function normalizePromptOverrides(value: Partial<PromptOverrides>): PromptOverrides {
  const entries: Record<string, PromptOverrideEntry> = {};
  if (value && typeof value.entries === "object" && value.entries !== null) {
    for (const [name, entry] of Object.entries(value.entries)) {
      if (!PROMPT_CATALOG.some((candidate) => candidate.name === name)) continue;
      if (!entry || typeof entry.system !== "string" || !entry.system.trim()) continue;
      try {
        validateTemplateVariables(entry.system, promptDefinition(name).variables);
      } catch {
        continue;
      }
      entries[name] = { system: entry.system, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString() };
    }
  }
  return { version: 1, entries };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
