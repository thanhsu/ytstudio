export type ParsedSourceScore = {
  value: number;
  angle: string;
  hooks: string[];
  risks: string[];
  reason: string;
};

/**
 * Validates a model response before it is written beside a candidate. A model
 * that answers in prose, omits the angle, or returns a value outside the scale
 * fails here rather than leaving an unreadable score on disk.
 */
export function parseSourceScore(raw: string): ParsedSourceScore {
  const payload = parseJsonObject(raw);

  return {
    value: requireScore(payload.value),
    angle: requireText(payload.angle, "angle"),
    hooks: requireStringArray(payload.hooks, "hooks"),
    risks: requireStringArray(payload.risks, "risks"),
    reason: requireText(payload.reason, "reason"),
  };
}

function requireScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Score value must be a number from 0 to 100, received ${JSON.stringify(value)}.`);
  }
  return Math.round(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Score response needs a non-empty ${field}.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Score response needs ${field} as an array of strings.`);
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(raw).trim());
  } catch {
    throw new Error("Score response was not JSON. Configure a model that can return a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Score response was not a JSON object.");
  }
  return value as Record<string, unknown>;
}

// Local models frequently wrap JSON in a markdown fence even when asked not to.
function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
  return fenced ? fenced[1] : raw;
}
