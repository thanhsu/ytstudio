import type { Metadata, ScenePlan } from "../types.ts";

export type ParsedScript = {
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

/**
 * Validates a model response before anything is written to the project. A model
 * that answers in prose, omits a field, or invents a scene without a duration
 * fails here, so a bad response can never leave a half-written project.
 */
export function parseScriptGeneration(raw: string, projectId: string): ParsedScript {
  const payload = parseJsonObject(raw);
  const metadataValue = requireObject(payload.metadata, "metadata");

  const metadata: Metadata = {
    projectId,
    titles: requireStringArray(metadataValue.titles, "metadata.titles"),
    description: requireText(metadataValue.description, "metadata.description"),
    hashtags: requireStringArray(metadataValue.hashtags, "metadata.hashtags"),
    pinnedComment: requireText(metadataValue.pinnedComment, "metadata.pinnedComment"),
  };

  const scenes = requireArray(payload.scenePlan, "scenePlan").map((scene, index) => {
    const value = requireObject(scene, `scenePlan[${index}]`);
    return {
      label: requireText(value.label, `scenePlan[${index}].label`),
      durationSeconds: requirePositiveNumber(value.durationSeconds, `scenePlan[${index}].durationSeconds`),
      purpose: requireText(value.purpose, `scenePlan[${index}].purpose`),
      visualDirection: requireText(value.visualDirection, `scenePlan[${index}].visualDirection`),
    };
  });

  const scenePlan: ScenePlan = { projectId, scenes };
  return { script: requireText(payload.script, "script"), metadata, scenePlan };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(raw).trim());
  } catch {
    throw new Error("Model response was not JSON. Configure a model that can return a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model response was not JSON object.");
  }
  return value as Record<string, unknown>;
}

// Local models frequently wrap JSON in a markdown fence even when asked not to.
function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
  return fenced ? fenced[1] : raw;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Model response field ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Model response field ${field} must be a non-empty array.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Model response field ${field} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  const items = requireArray(value, field);
  return items.map((item, index) => requireText(item, `${field}[${index}]`));
}

function requirePositiveNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Model response field ${field} must be a positive number.`);
  }
  return number;
}
