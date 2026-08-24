import type { AssetRecord } from "./assets.ts";

export type ZoomEffect = "none" | "slow-in" | "slow-out";
export type TransitionEffect = "cut" | "fade";
export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type SegmentColorEffects = {
  brightness: number; // -1..1, default 0
  contrast: number; // 0..2, default 1
  saturation: number; // 0..2, default 1
  grayscale: number; // 0..1, default 0
};

export type SegmentWatermarkEffect = {
  assetId: string;
  position: WatermarkPosition;
  scale: number; // 0.05..0.5 relative to video width, default 0.12
  opacity: number; // 0..1, default 0.2
};

export type SegmentEffects = {
  version: 1;
  speed: number; // 0.5..2.0, default 1
  zoom: ZoomEffect;
  transitionIn: TransitionEffect;
  transitionOut: TransitionEffect;
  color: SegmentColorEffects;
  blur: number; // 0..40, default 0
  watermark?: SegmentWatermarkEffect;
};

export const DEFAULT_SEGMENT_EFFECTS: SegmentEffects = {
  version: 1,
  speed: 1,
  zoom: "none",
  transitionIn: "cut",
  transitionOut: "cut",
  color: { brightness: 0, contrast: 1, saturation: 1, grayscale: 0 },
  blur: 0,
};

const SPEED_RANGE = [0.5, 2.0] as const;
const BRIGHTNESS_RANGE = [-1, 1] as const;
const CONTRAST_RANGE = [0, 2] as const;
const SATURATION_RANGE = [0, 2] as const;
const GRAYSCALE_RANGE = [0, 1] as const;
const BLUR_RANGE = [0, 40] as const;
export const WATERMARK_SCALE_RANGE = [0.05, 0.5] as const;
export const WATERMARK_OPACITY_RANGE = [0, 1] as const;

const ZOOM_VALUES: readonly ZoomEffect[] = ["none", "slow-in", "slow-out"];
const TRANSITION_VALUES: readonly TransitionEffect[] = ["cut", "fade"];
const WATERMARK_POSITIONS: readonly WatermarkPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const ELIGIBLE_WATERMARK_RIGHTS_STATUSES = new Set(["owned", "licensed", "generated"]);

export function isEligibleWatermarkAsset(asset: AssetRecord): boolean {
  return asset.role === "logo" && !!asset.rightsStatus && ELIGIBLE_WATERMARK_RIGHTS_STATUSES.has(asset.rightsStatus);
}

export function validateSegmentEffects(value: unknown, assets?: AssetRecord[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  collectEffectsErrors(value, assets, errors);
  return { valid: errors.length === 0, errors };
}

export function normalizeSegmentEffects(value: unknown): SegmentEffects {
  return patchSegmentEffects(undefined, value ?? {});
}

export function patchSegmentEffects(current: SegmentEffects | undefined, patch: unknown): SegmentEffects {
  const base = current ? cloneEffects(current) : cloneEffects(DEFAULT_SEGMENT_EFFECTS);
  if (patch === undefined || patch === null) {
    return base;
  }
  if (!isRecord(patch)) {
    throw new Error("Segment effects patch must be an object.");
  }

  const merged = mergeEffectsPatch(base, patch);
  const errors: string[] = [];
  collectEffectsErrors(merged, undefined, errors);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
  return finalizeEffects(merged);
}

function mergeEffectsPatch(base: SegmentEffects, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...patch };

  if ("color" in patch) {
    merged.color = isRecord(patch.color) ? { ...base.color, ...patch.color } : patch.color;
  } else {
    merged.color = { ...base.color };
  }

  if ("watermark" in patch) {
    if (patch.watermark === null) {
      merged.watermark = undefined;
    } else if (isRecord(patch.watermark)) {
      merged.watermark = { ...(base.watermark ?? {}), ...patch.watermark };
    } else {
      merged.watermark = patch.watermark;
    }
  } else {
    merged.watermark = base.watermark ? { ...base.watermark } : undefined;
  }

  return merged;
}

function collectEffectsErrors(value: unknown, assets: AssetRecord[] | undefined, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("Segment effects must be an object.");
    return;
  }

  if (value.version !== 1) {
    errors.push("version must be 1.");
  }

  validateRange(errors, "speed", value.speed, SPEED_RANGE);
  validateEnum(errors, "zoom", value.zoom, ZOOM_VALUES);
  validateEnum(errors, "transitionIn", value.transitionIn, TRANSITION_VALUES);
  validateEnum(errors, "transitionOut", value.transitionOut, TRANSITION_VALUES);

  if (!isRecord(value.color)) {
    errors.push("color must be an object.");
  } else {
    validateRange(errors, "color.brightness", value.color.brightness, BRIGHTNESS_RANGE);
    validateRange(errors, "color.contrast", value.color.contrast, CONTRAST_RANGE);
    validateRange(errors, "color.saturation", value.color.saturation, SATURATION_RANGE);
    validateRange(errors, "color.grayscale", value.color.grayscale, GRAYSCALE_RANGE);
  }

  validateRange(errors, "blur", value.blur, BLUR_RANGE);

  if (value.watermark !== undefined) {
    if (!isRecord(value.watermark)) {
      errors.push("watermark must be an object.");
    } else {
      const watermark = value.watermark;
      if (typeof watermark.assetId !== "string" || !watermark.assetId.trim()) {
        errors.push("watermark.assetId is required.");
      } else if (assets) {
        const asset = assets.find((candidate) => candidate.id === watermark.assetId);
        if (!asset) {
          errors.push(`watermark.assetId references a missing asset: ${watermark.assetId}.`);
        } else if (!isEligibleWatermarkAsset(asset)) {
          errors.push(`watermark.assetId ${watermark.assetId} is not an eligible logo asset for watermarking.`);
        }
      }
      validateEnum(errors, "watermark.position", watermark.position, WATERMARK_POSITIONS);
      validateRange(errors, "watermark.scale", watermark.scale, WATERMARK_SCALE_RANGE);
      validateRange(errors, "watermark.opacity", watermark.opacity, WATERMARK_OPACITY_RANGE);
    }
  }
}

function finalizeEffects(candidate: Record<string, unknown>): SegmentEffects {
  const color = candidate.color as SegmentColorEffects;
  const watermark = candidate.watermark as SegmentWatermarkEffect | undefined;
  return {
    version: 1,
    speed: candidate.speed as number,
    zoom: candidate.zoom as ZoomEffect,
    transitionIn: candidate.transitionIn as TransitionEffect,
    transitionOut: candidate.transitionOut as TransitionEffect,
    color: { brightness: color.brightness, contrast: color.contrast, saturation: color.saturation, grayscale: color.grayscale },
    blur: candidate.blur as number,
    ...(watermark ? { watermark: { assetId: watermark.assetId, position: watermark.position, scale: watermark.scale, opacity: watermark.opacity } } : {}),
  };
}

function cloneEffects(effects: SegmentEffects): SegmentEffects {
  return {
    ...effects,
    color: { ...effects.color },
    ...(effects.watermark ? { watermark: { ...effects.watermark } } : {}),
  };
}

function validateRange(errors: string[], field: string, value: unknown, [min, max]: readonly [number, number]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number.`);
    return;
  }
  if (value < min || value > max) {
    errors.push(`${field} must be between ${min} and ${max}.`);
  }
}

function validateEnum<T extends string>(errors: string[], field: string, value: unknown, allowed: readonly T[]): void {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
