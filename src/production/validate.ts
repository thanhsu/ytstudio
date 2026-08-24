import type {
  EditSegment,
  ProductionAsset,
  ProductionProject,
  ProductionWorkflowType,
} from "./types.ts";

const WORKFLOW_TYPES: readonly ProductionWorkflowType[] = ["review-recap", "audio-story", "subtitle-render", "licensed-source"];
const FORMATS = ["shorts", "longform"] as const;
const MEDIA_TYPES = ["image", "video", "audio"] as const;
const RIGHTS_STATUSES = ["owned", "licensed", "user-confirmed", "generated", "unknown"] as const;
const ASSET_ROLES = ["source-clip", "generated-background", "story-image", "cover", "diagram", "caption-card", "music", "logo"] as const;

export function validateProductionProject(project: ProductionProject): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const candidate = project as unknown as Record<string, unknown>;
  if (candidate.version !== 1) errors.push("Unsupported production project version; expected 1.");
  if (!isNonEmptyString(candidate.projectId)) errors.push("Project id is required.");
  if (!WORKFLOW_TYPES.includes(candidate.workflowType as ProductionWorkflowType)) errors.push("Workflow type is invalid.");
  if (!FORMATS.includes(candidate.format as (typeof FORMATS)[number])) errors.push("Production format is invalid.");

  const content = isRecord(candidate.content) ? candidate.content : undefined;
  if (!content) {
    errors.push("Content artifact is required.");
  } else {
    if (!isNonEmptyString(content.title)) errors.push("Content title is required.");
    if (!isNonEmptyString(content.summary)) errors.push("Content summary is required.");
    if (!isNonEmptyString(content.sourceHash)) errors.push("Content source hash is required.");
    validateRelativePathList(content.sourcePaths, "content source path", errors);
    if (content.scriptPath !== undefined) validateRelativePath(content.scriptPath, "script path", errors);
  }

  if (candidate.narration !== undefined) validateTrack(candidate.narration, "narration", ["wav", "mp3"], errors);
  if (candidate.captions !== undefined) validateTrack(candidate.captions, "captions", ["srt"], errors);

  const assets = Array.isArray(candidate.assets) ? candidate.assets : [];
  if (!Array.isArray(candidate.assets)) errors.push("Assets must be an array.");
  const assetIds = new Set<string>();
  assets.forEach((value, index) => validateAsset(value, index, assetIds, errors));

  const timeline = isRecord(candidate.timeline) ? candidate.timeline : undefined;
  if (!timeline) {
    errors.push("Edit timeline is required.");
  } else {
    validateTimeline(timeline, assets, errors);
  }

  const publish = isRecord(candidate.publish) ? candidate.publish : undefined;
  if (!publish) {
    errors.push("Publish metadata is required.");
  } else {
    if (!isNonEmptyString(publish.title)) errors.push("Publish title is required.");
    if (typeof publish.description !== "string") errors.push("Publish description must be a string.");
    if (!Array.isArray(publish.tags) || publish.tags.some((tag) => typeof tag !== "string")) errors.push("Publish tags must be strings.");
    if (!isNonEmptyString(publish.language)) errors.push("Publish language is required.");
    if (publish.thumbnailAssetId !== undefined && typeof publish.thumbnailAssetId !== "string") errors.push("Thumbnail asset id must be a string.");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidProductionProject(project: unknown): asserts project is ProductionProject {
  const result = validateProductionProject(project as ProductionProject);
  if (!result.valid) throw new Error(`Invalid production project: ${result.errors.join("; ")}`);
}

function validateTrack(value: unknown, label: string, formats: readonly string[], errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${label} track must be an object.`);
    return;
  }
  validateRelativePath(value.relativePath, `${label} relative path`, errors);
  if (!formats.includes(String(value.format))) errors.push(`${label} format is invalid.`);
  if (!isNonEmptyString(value.sourceHash)) errors.push(`${label} source hash is required.`);
  if (label === "narration" && !isFiniteNonNegative(value.durationSeconds)) errors.push("narration duration must be finite and non-negative.");
  if (label === "captions" && (!Number.isInteger(value.cueCount) || Number(value.cueCount) < 0)) errors.push("Captions cue count must be a non-negative integer.");
}

function validateAsset(value: unknown, index: number, ids: Set<string>, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`Asset ${index} must be an object.`);
    return;
  }
  const id = value.id;
  if (!isNonEmptyString(id)) errors.push(`Asset ${index} id is required.`);
  else if (ids.has(id)) errors.push(`Asset id is duplicated: ${id}.`);
  else ids.add(id);
  validateRelativePath(value.relativePath, `asset ${String(id)} relative path`, errors);
  if (!MEDIA_TYPES.includes(value.mediaType as (typeof MEDIA_TYPES)[number])) errors.push(`Asset ${String(id)} media type is invalid.`);
  if (!ASSET_ROLES.includes(value.role as (typeof ASSET_ROLES)[number])) errors.push(`Asset ${String(id)} role is invalid.`);
  if (!isNonEmptyString(value.sourceHash)) errors.push(`Asset ${String(id)} source hash is required.`);
  if (!RIGHTS_STATUSES.includes(value.rightsStatus as (typeof RIGHTS_STATUSES)[number])) errors.push(`Asset ${String(id)} rights status is invalid.`);
  if (!isNonEmptyString(value.usagePurpose)) errors.push(`Asset ${String(id)} usage purpose is required.`);
  if (value.durationSeconds !== undefined && !isFiniteNonNegative(value.durationSeconds)) errors.push(`Asset ${String(id)} duration must be finite and non-negative.`);
  if (value.sourceStartSeconds !== undefined && !isFiniteNonNegative(value.sourceStartSeconds)) errors.push(`Asset ${String(id)} source start must be finite and non-negative.`);
}

function validateTimeline(timeline: Record<string, unknown>, assets: unknown[], errors: string[]): void {
  if (timeline.version !== 1) errors.push("Unsupported edit timeline version; expected 1.");
  if (!isFiniteNonNegative(timeline.durationSeconds) || Number(timeline.durationSeconds) <= 0) errors.push("Timeline duration must be positive and finite.");
  if (!Array.isArray(timeline.segments)) {
    errors.push("Timeline segments must be an array.");
    return;
  }
  const assetMap = new Map(assets.filter(isRecord).map((asset) => [asset.id, asset]));
  const ids = new Set<string>();
  const segments: EditSegment[] = [];
  timeline.segments.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`Timeline segment ${index} must be an object.`);
      return;
    }
    if (!isNonEmptyString(value.id)) errors.push(`Timeline segment ${index} id is required.`);
    else if (ids.has(value.id)) errors.push(`Timeline segment id is duplicated: ${value.id}.`);
    else ids.add(value.id);
    if (!isFiniteNonNegative(value.startSeconds) || !isFiniteNonNegative(value.endSeconds) || Number(value.startSeconds) >= Number(value.endSeconds)) {
      errors.push(`Timeline segment ${String(value.id)} has an invalid time range.`);
    }
    if (Number(value.endSeconds) > Number(timeline.durationSeconds)) errors.push(`Timeline segment ${String(value.id)} exceeds timeline duration.`);
    if (value.fitMode !== "cover" && value.fitMode !== "contain") errors.push(`Timeline segment ${String(value.id)} fit mode is invalid.`);
    if (typeof value.muteSourceAudio !== "boolean") errors.push(`Timeline segment ${String(value.id)} muteSourceAudio must be boolean.`);
    if (value.assetId !== undefined) {
      const asset = assetMap.get(value.assetId);
      if (!asset) errors.push(`Timeline segment ${String(value.id)} has a missing asset reference.`);
      else if (asset.mediaType === "video" && Number(value.endSeconds) - Number(value.startSeconds) > 5) errors.push(`Timeline segment ${String(value.id)} exceeds the five-second video limit.`);
    }
    if (value.sourceStartSeconds !== undefined && !isFiniteNonNegative(value.sourceStartSeconds)) errors.push(`Timeline segment ${String(value.id)} source start must be non-negative.`);
    segments.push(value as unknown as EditSegment);
  });
  segments.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].endSeconds) errors.push(`Timeline segments overlap: ${segments[index - 1].id} and ${segments[index].id}.`);
  }
}

function validateRelativePathList(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} list must be an array.`);
    return;
  }
  value.forEach((entry) => validateRelativePath(entry, label, errors));
}

function validateRelativePath(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim() || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]+/).includes("..")) {
    errors.push(`${label} must be a relative path inside the project.`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
